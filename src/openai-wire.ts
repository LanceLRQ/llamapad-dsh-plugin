import type { ContentBlock, GenerateOptions } from "@deepseek-ai/dsh-llm";

/**
 * dsh GenerateOptions → llama.cpp（OpenAI 兼容）chat/completions 请求体。
 * 决策记录：assistant 历史里的 reasoning 块不回传（llama.cpp 推理内容不进后续请求）。
 */

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function buildChatBody(options: GenerateOptions): Record<string, unknown> {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) messages.push(...mapMessage(message));
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop && options.stop.length > 0) body.stop = options.stop;
  return body;
}

function mapMessage(message: GenerateOptions["messages"][number]): OpenAiMessage[] {
  if (message.role === "system") {
    return [{ role: "system", content: message.content.filter(isText).map((b) => b.text).join("") }];
  }
  if (message.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    for (const block of message.content) {
      if (isText(block)) textParts.push(block.text);
      else if (block.type === "tool-call") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
      }
      // reasoning 块：跳过（见文件头决策）
    }
    return [{ role: "assistant", content: textParts.join("") || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
  }
  // user：text 块合入一条 user；tool-result 块各拆一条 role:"tool"
  // （ToolResultBlock 字段以包为准：toolCallId + content: ContentBlock[]）
  const out: OpenAiMessage[] = [];
  const textParts: string[] = [];
  for (const block of message.content) {
    if (isText(block)) textParts.push(block.text);
    else if (block.type === "tool-result") {
      out.push({ role: "tool", tool_call_id: block.toolCallId, content: renderToolResult(block.content) });
    }
  }
  if (textParts.length > 0) out.unshift({ role: "user", content: textParts.join("") });
  return out;
}

function isText(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text";
}

function renderToolResult(content: ContentBlock[]): string {
  // content 恒为 ContentBlock[]（types.d.ts 核对）：拼 text 块文本；image 等其它块对 llama.cpp 文本通道不可表达，忽略
  return content.filter(isText).map((b) => b.text).join("");
}
