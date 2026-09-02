import { describe, expect, it } from "vitest";
import { buildChatBody } from "../../src/openai-wire";
import { CallId } from "@deepseek-ai/dsh-llm";

function msg(role: any, content: any[], id = "m1"): any {
  return { id, role, content, source: {} };
}

describe("buildChatBody", () => {
  it("system 提示置于首位；user 文本合入 content", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a", system: "你是助手",
      messages: [msg("user", [{ type: "text", text: "你好" }])],
    } as any);
    expect(body.model).toBe("a");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ]);
  });

  it("assistant 的 text + tool-call 块 → content + tool_calls；reasoning 块不回传", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("assistant", [
        { type: "reasoning", text: "思考…" },
        { type: "text", text: "我查一下" },
        { type: "tool-call", id: CallId("call_1"), name: "get_weather", arguments: '{"city":"北京"}' },
      ])],
    } as any);
    const assistant = (body.messages as any[])[0]!;
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("我查一下");
    expect(assistant.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
    ]);
  });

  it("user 消息里的 tool-result 块拆成 role:tool（OpenAI 形态；字段名以 dsh-llm 为准：toolCallId + 块数组）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{
        type: "tool-result",
        toolCallId: CallId("call_1"),
        content: [{ type: "text", text: "晴，25 度" }],
      }])],
    } as any);
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "晴，25 度" },
    ]);
  });

  it("可选参数透传：temperature/maxTokens/stop/tools", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "text", text: "hi" }])],
      temperature: 0.2, maxTokens: 512, stop: ["\n\n"],
      tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] as any,
    } as any);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
    expect(body.stop).toEqual(["\n\n"]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
  });

  it("未提供的可选字段不出现", () => {
    const body = buildChatBody({ provider: "llamapad", model: "a", messages: [] } as any);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stop");
  });

  it("reasoningEffort 落成请求体的 reasoning_effort 字段", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a", reasoningEffort: "xhigh",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: {} }],
    } as any);
    expect(body.reasoning_effort).toBe("xhigh");
  });

  it("未指定 reasoningEffort 时请求体里没有这个键（不发空值污染上游判定）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: {} }],
    } as any);
    expect("reasoning_effort" in body).toBe(false);
  });
});
