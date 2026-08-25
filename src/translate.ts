import { CallId, LlmError, EMPTY_RESPONSE_CODE } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";

/**
 * llama.cpp（OpenAI 兼容）流式响应 → dsh StreamChunk。
 * 协议义务（cookbook 陷阱清单）：usage 在 finish 前且其后无块；block-start/end 配对；
 * index 按流中首现分配；tool-call 的 arguments 全程保持原始 JSON 字符串。
 * 错误统一走 throw LlmError（运行时会归一化为终态 error finish）。
 * 注：llama.cpp 的 prompt_tokens 含缓存命中，无法按 DISJOINT 语义拆 cacheRead——M4 真机校准。
 */

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string } | string;
}

export async function* translateOpenAiSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = 0;
  let textIndex: number | null = null;
  let reasoningIndex: number | null = null;
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const openBlocks: Array<{ index: number; kind: "text" | "reasoning" | "tool-call" }> = [];
  const openAiToolToBlock = new Map<number, number>();
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let finishKind: "stop" | "tool-calls" | "max-tokens" = "stop";
  let usage: TokenUsage | null = null;

  function* handleChunk(chunk: OpenAiStreamChunk): Generator<StreamChunk> {
    if (chunk.error !== undefined) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "未知错误";
      throw new LlmError(`llama.cpp 流内错误: ${message}`, "PROVIDER_HTTP_ERROR");
    }
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishKind = choice.finish_reason === "tool_calls" ? "tool-calls"
        : choice.finish_reason === "length" ? "max-tokens" : "stop";
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      if (textIndex === null) {
        textIndex = nextIndex++;
        openBlocks.push({ index: textIndex, kind: "text" });
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      textParts.push(delta.content);
      yield { type: "text-delta", index: textIndex, text: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      if (reasoningIndex === null) {
        reasoningIndex = nextIndex++;
        openBlocks.push({ index: reasoningIndex, kind: "reasoning" });
        yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
      }
      reasoningParts.push(delta.reasoning_content);
      yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning_content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let blockIdx = openAiToolToBlock.get(tc.index);
        if (blockIdx === undefined) {
          blockIdx = nextIndex++;
          openAiToolToBlock.set(tc.index, blockIdx);
          toolAcc.set(blockIdx, { id: tc.id ?? `call-${blockIdx}`, name: tc.function?.name ?? "", args: "" });
          openBlocks.push({ index: blockIdx, kind: "tool-call" });
          yield { type: "block-start", index: blockIdx, blockType: "tool-call" };
        }
        const acc = toolAcc.get(blockIdx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name && !acc.name) acc.name = tc.function.name;
        const argsDelta = tc.function?.arguments ?? "";
        if (argsDelta !== "") acc.args += argsDelta;
        yield { type: "tool-call-delta", index: blockIdx, id: CallId(acc.id), name: acc.name, argumentsDelta: argsDelta };
      }
    }
  }

  function* emitTail(): Generator<StreamChunk> {
    if (openBlocks.length === 0) {
      throw new LlmError("llama.cpp 返回了空响应（无任何内容块）", EMPTY_RESPONSE_CODE);
    }
    for (const b of openBlocks) {
      const block: ContentBlock = b.kind === "text"
        ? { type: "text", text: textParts.join("") }
        : b.kind === "reasoning"
          ? { type: "reasoning", text: reasoningParts.join("") }
          : (() => {
              const acc = toolAcc.get(b.index)!;
              return { type: "tool-call", id: CallId(acc.id), name: acc.name, arguments: acc.args };
            })();
      yield { type: "block-end", index: b.index, block };
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: finishKind } };
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "") continue;
          if (data === "[DONE]") {
            yield* emitTail();
            return;
          }
          let parsed: OpenAiStreamChunk;
          try {
            parsed = JSON.parse(data) as OpenAiStreamChunk;
          } catch {
            throw new LlmError(`无法解析 SSE 数据帧: ${data.slice(0, 120)}`, "PROVIDER_PROTOCOL");
          }
          yield* handleChunk(parsed);
        }
      }
    }
    yield* emitTail();  // 防御：流结束但没有 [DONE]
  } finally {
    reader.releaseLock();
  }
}
