import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { createFakePanel } from "./fake-panel-server.mjs";
import { LlamapadAdapter } from "../../src/adapter";
import { createPanelClient } from "../../src/panel-client";
import { createModelGate } from "../../src/switching";

let server: ReturnType<typeof createFakePanel>["server"];
let state: ReturnType<typeof createFakePanel>["state"];
let baseUrl: string;

beforeAll(async () => {
  ({ server, state } = createFakePanel({ loadMs: 50 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

// 假面板的既有 4 条基线用例沿用旧版「选谁起谁」语义，显式钉住 auto-switch 档；
// chatBehavior 新默认值 strict 的行为由下面新增的用例单独覆盖。
function makeAdapter() {
  const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
  return new LlamapadAdapter({
    client, gate: createModelGate(client), token: "lp_e2e", mode: "proxy",
    chatBehavior: "auto-switch", pollIntervalMs: 20,
  });
}

async function drain(adapter: LlamapadAdapter, model: string) {
  const chunks = [];
  for await (const c of adapter.stream({
    provider: "llamapad", model,
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "北京天气" }], source: {} }],
  } as any)) chunks.push(c);
  return chunks;
}

describe("LlamapadAdapter E2E（假面板）", () => {
  it("冷启动：ensure 触发 start → 等就绪 → 流式翻译符合协议（BlockAssembler 收口）", async () => {
    const chunks = await drain(makeAdapter(), "qwen-small");
    expect(state.starts).toEqual(["qwen-small"]);
    // BlockAssembler 真实 API（assembler.d.ts）：new 无参 / push(chunk) / blocks() 方法 / usage·finish getter
    const assembler = new BlockAssembler();
    for (const c of chunks) assembler.push(c);
    const blocks = assembler.blocks();
    expect(blocks.map((b: any) => b.type)).toEqual(["reasoning", "text", "tool-call"]);
    expect(blocks[2]).toEqual({ type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"北京"}' });
    expect(assembler.usage).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(assembler.finish).toEqual({ kind: "tool-calls" });
    expect(state.chatRequests[0]!.model).toBe("qwen-small");
    expect(state.chatRequests[0]!.stream).toBe(true);
  });

  it("切换：换模型触发第二次 start，请求体 model 跟随", async () => {
    await drain(makeAdapter(), "qwen-big");
    expect(state.starts).toEqual(["qwen-small", "qwen-big"]);
    expect(state.chatRequests.at(-1)!.model).toBe("qwen-big");
  });

  it("合流：同模型并发两条流只 start 一次", async () => {
    state.running = null;
    const adapter = makeAdapter();
    await Promise.all([drain(adapter, "qwen-small"), drain(adapter, "qwen-small")]);
    // state 跨用例累积：test1（冷启动）贡献 1 次 qwen-small，本例合流后仅再贡献 1 次，共 2 次
    expect(state.starts.filter((s: string) => s === "qwen-small")).toHaveLength(2);
  });

  it("模型不存在 → LlmError MODEL_NOT_FOUND", async () => {
    await expect(drain(makeAdapter(), "nope")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("resolveModel：contextWindow 取自面板 /effective 的 merged.server.ctx_size（真实 HTTP 接线，非 mock）", async () => {
    const resolved = await makeAdapter().resolveModel("llamapad", "qwen-small");
    expect(resolved).toMatchObject({ context: { contextWindow: 131072 } });
  });

  it("strict 档：请求非运行中模型 → MODEL_NOT_RUNNING，且假面板没有收到任何新的 start 请求", async () => {
    // 先用 auto-switch 把 qwen-small 稳定跑起来，确定下面 strict 场景的前置条件
    await drain(makeAdapter(), "qwen-small");
    const startsBefore = state.starts.length;
    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const strictAdapter = new LlamapadAdapter({
      client, gate: createModelGate(client), token: "lp_e2e", mode: "proxy", chatBehavior: "strict",
    });
    await expect(drain(strictAdapter, "qwen-big")).rejects.toMatchObject({ code: "MODEL_NOT_RUNNING" });
    // 本次改造的核心保证：strict 档聊天路径完全不触发 start，在途流不会被杀
    expect(state.starts).toHaveLength(startsBefore);
  });
});
