import { describe, expect, it } from "vitest";
import { buildChatBody, collectImages } from "../../src/openai-wire";
import { CallId } from "@deepseek-ai/dsh-llm";

function msg(role: any, content: any[], id = "m1"): any {
  return { id, role, content, source: {} };
}

// 两个内容不同的图片引用（形状对齐 ImageAttachmentRef；测试只用到字段子集）
const pngRef: any = { attachmentId: "att_png", mediaType: "image/png", bytes: 3, width: 2, height: 1 };
const jpegRef: any = { attachmentId: "att_jpeg", mediaType: "image/jpeg", bytes: 4, width: 2, height: 2 };

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

describe("collectImages", () => {
  it("收集 user 顶层与 tool-result 嵌套 content 里的全部图片引用", () => {
    const refs = collectImages({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "image", attachment: pngRef },
        { type: "tool-result", toolCallId: CallId("call_1"), content: [
          { type: "text", text: "结果" },
          { type: "image", attachment: jpegRef },
        ] },
      ])],
    } as any);
    expect(refs).toEqual([pngRef, jpegRef]);
  });

  it("无图会话 → 空数组（调用方可据此跳过整个预解析）", () => {
    expect(collectImages({
      provider: "llamapad", model: "a",
      messages: [
        msg("user", [{ type: "text", text: "hi" }]),
        msg("assistant", [{ type: "text", text: "hello" }]),
        msg("user", [{ type: "tool-result", toolCallId: CallId("c"), content: [{ type: "text", text: "r" }] }]),
      ],
    } as any)).toEqual([]);
  });

  it("同一 ref 对象多处出现只收集一次（预解析不重复读盘）", () => {
    const refs = collectImages({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "image", attachment: pngRef },
        { type: "image", attachment: pngRef },
      ])],
    } as any);
    expect(refs).toEqual([pngRef]);
  });
});

describe("buildChatBody：图片 wire 通道", () => {
  const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");

  it("user 消息 text+图 → content 数组形态：text 块在前，image_url 按序在后（base64 data URL）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "text", text: "看这张" },
        { type: "image", attachment: pngRef },
        { type: "image", attachment: jpegRef },
      ])],
    } as any, new Map<any, any>([
      [pngRef, { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
      [jpegRef, { data: new Uint8Array([4, 5]), mediaType: "image/jpeg" }],
    ]));
    const user = (body.messages as any[])[0]!;
    expect(user.role).toBe("user");
    expect(user.content).toEqual([
      { type: "text", text: "看这张" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64([1, 2, 3])}` } },
      { type: "image_url", image_url: { url: `data:image/jpeg;base64,${b64([4, 5])}` } },
    ]);
  });

  it("消息原本无文本时只有 image_url 块，不造空 text 块", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "image", attachment: pngRef }])],
    } as any, new Map<any, any>([
      [pngRef, { data: new Uint8Array([1]), mediaType: "image/png" }],
    ]));
    const user = (body.messages as any[])[0]!;
    expect(user.content).toEqual([
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64([1])}` } },
    ]);
  });

  it("解析结果为 null（读失败/服务缺席）→ 该图降级为占位文本，content 保持 string", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "text", text: "看" },
        { type: "image", attachment: jpegRef },
      ])],
    } as any, new Map<any, any>([[jpegRef, null]]));
    const user = (body.messages as any[])[0]!;
    expect(typeof user.content).toBe("string");
    expect(user.content).toBe("看[image attachment unavailable]");
  });

  it("同一条消息里成功与失败混排：成功进 image_url，失败的占位并入 text 块", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "text", text: "两张：" },
        { type: "image", attachment: pngRef },
        { type: "image", attachment: jpegRef },
      ])],
    } as any, new Map<any, any>([
      [pngRef, { data: new Uint8Array([1, 2, 3]), mediaType: "image/png" }],
      [jpegRef, null],
    ]));
    const user = (body.messages as any[])[0]!;
    expect(user.content).toEqual([
      { type: "text", text: "两张：[image attachment unavailable]" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64([1, 2, 3])}` } },
    ]);
  });

  it("resolved 传了但缺该 ref 的键（防御路径）→ 同 null 处理，占位", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "image", attachment: jpegRef }])],
    } as any, new Map<any, any>([]));
    const user = (body.messages as any[])[0]!;
    expect(user.content).toBe("[image attachment unavailable]");
  });

  it("纯文本消息即使传了 resolved 也保持 string content（数组形态只因图而生）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "text", text: "hi" }])],
    } as any, new Map<any, any>([[pngRef, { data: new Uint8Array([1]), mediaType: "image/png" }]]));
    expect((body.messages as any[])[0]!.content).toBe("hi");
  });

  it("resolved 缺省（第二参不传）→ 与旧行为完全一致：user 图静默忽略", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [
        { type: "text", text: "看" },
        { type: "image", attachment: pngRef },
      ])],
    } as any);
    expect(body.messages).toEqual([{ role: "user", content: "看" }]);
  });

  it("tool-result 嵌套 content 里的 image → 占位文本进 tool 消息（OpenAI tool 通道只收 string；无论解析成败）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{
        type: "tool-result",
        toolCallId: CallId("call_1"),
        content: [{ type: "text", text: "截屏：" }, { type: "image", attachment: pngRef }],
      }])],
    } as any, new Map<any, any>([
      [pngRef, { data: new Uint8Array([1]), mediaType: "image/png" }],
    ]));
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "截屏：[image attachment unavailable]" },
    ]);
  });

  it("system 消息遇到 image → 占位（类型上可能、实际不会；显式优于静默丢）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("system", [{ type: "image", attachment: pngRef }])],
    } as any, new Map<any, any>([
      [pngRef, { data: new Uint8Array([1]), mediaType: "image/png" }],
    ]));
    expect((body.messages as any[])[0]!.content).toBe("[image attachment unavailable]");
  });

  it("assistant 消息遇到 image → 占位并入 content（实际不会有，防御显式化）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("assistant", [
        { type: "text", text: "收到" },
        { type: "image", attachment: pngRef },
      ])],
    } as any, new Map<any, any>([]));
    expect((body.messages as any[])[0]!.content).toBe("收到[image attachment unavailable]");
  });
});
