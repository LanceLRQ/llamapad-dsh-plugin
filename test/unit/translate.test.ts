import { describe, expect, it } from "vitest";
import { translateOpenAiSse } from "../../src/translate";
import type { StreamChunk } from "@deepseek-ai/dsh-llm";

function sseStream(lines: string[], splitAt: number[] = []): ReadableStream<Uint8Array> {
  // splitAt：模拟网络分帧（把整体 buffer 在给定偏移处切开推送）
  const payload = lines.map((l) => `data: ${l}\n\n`).join("");
  const cuts = [0, ...splitAt, payload.length].sort((a, b) => a - b);
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= cuts.length - 1) { controller.close(); return; }
      controller.enqueue(encoder.encode(payload.slice(cuts[i]!, cuts[i + 1]!)));
      i++;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of translateOpenAiSse(stream)) chunks.push(c);
  return chunks;
}

describe("translateOpenAiSse", () => {
  it("纯文本：start/delta/end/finish 且 block-end 带全文", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"你"}}]}`,
      `{"choices":[{"delta":{"content":"好"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `{"usage":{"prompt_tokens":3,"completion_tokens":2}}`,
      `[DONE]`,
    ]));
    expect(chunks.map((c) => c.type)).toEqual(["block-start", "text-delta", "text-delta", "block-end", "usage", "finish"]);
    expect(chunks[3]).toMatchObject({ block: { type: "text", text: "你好" } });
    expect(chunks[4]).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } });
    expect(chunks[5]).toMatchObject({ reason: { kind: "stop" } });
  });

  it("reasoning_content → reasoning 块；index 按首现递增", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"reasoning_content":"想"}}]}`,
      `{"choices":[{"delta":{"reasoning_content":"想2"}}]}`,
      `{"choices":[{"delta":{"content":"答"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `[DONE]`,
    ]));
    expect(chunks[0]).toMatchObject({ type: "block-start", index: 0, blockType: "reasoning" });
    expect(chunks[3]).toMatchObject({ type: "block-start", index: 1, blockType: "text" });
    const ends = chunks.filter((c) => c.type === "block-end");
    expect(ends[0]).toMatchObject({ index: 0, block: { type: "reasoning", text: "想想2" } });
    expect(ends[1]).toMatchObject({ index: 1, block: { type: "text", text: "答" } });
  });

  it("工具调用：跨帧 arguments 增量拼接，finish 为 tool-calls", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
      `[DONE]`,
    ]));
    const deltas = chunks.filter((c): c is Extract<StreamChunk, { type: "tool-call-delta" }> => c.type === "tool-call-delta");
    expect(deltas[0]).toMatchObject({ index: 0, id: "call_1", name: "get_weather", argumentsDelta: "" });
    expect(deltas[1]!.argumentsDelta).toBe('{"city":');
    const end = chunks.find((c) => c.type === "block-end")!;
    expect(end).toMatchObject({ block: { type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"北京"}' } });
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: "tool-calls" } });
  });

  it("finish_reason length → max-tokens", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"x"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"length"}]}`,
      `[DONE]`,
    ]));
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: "max-tokens" } });
  });

  it("error 帧 → throw LlmError(PROVIDER_HTTP_ERROR)", async () => {
    const stream = sseStream([`{"error":{"message":"model unloaded"}}`, `[DONE]`]);
    await expect(collect(stream)).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR" });
  });

  it("空响应（无任何内容块）→ EMPTY_RESPONSE", async () => {
    const stream = sseStream([`{"choices":[{"delta":{},"finish_reason":"stop"}]}`, `[DONE]`]);
    await expect(collect(stream)).rejects.toMatchObject({ code: "EMPTY_RESPONSE" });
  });

  it("缺 [DONE]（流直接结束）也有完整收尾", async () => {
    const chunks = await collect(sseStream([`{"choices":[{"delta":{"content":"hi"}}]}`]));
    expect(chunks.map((c) => c.type)).toEqual(["block-start", "text-delta", "block-end", "finish"]);
  });

  it("网络分帧切割 JSON 帧也能拼回", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"分帧"}}]}`,
      `[DONE]`,
    ], [12, 25]));
    expect(chunks.some((c) => c.type === "text-delta" && c.text === "分帧")).toBe(true);
    expect(chunks.at(-1)!.type).toBe("finish");
  });
});
