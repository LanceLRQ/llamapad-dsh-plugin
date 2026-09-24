import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createFakePanel } from "./fake-panel-server.mjs";
import { LlamapadAdapter } from "../../src/adapter";
import { createPanelClient } from "../../src/panel-client";
import { PanelGateway } from "../../src/panel-gateway";
import { createModelGate } from "../../src/switching";

/**
 * 「启动中状态」的假面板 E2E：验证 startRequestTimeoutMs 超时后插件不把「面板仍在
 * 处理」误报成失败——卡片经 CardSnapshot.starting 画出「仍在启动中」，auto-switch
 * 继续轮询直到真正就绪。背景与字段语义见 src/panel-client.ts PanelStartingModel、
 * src/switching.ts EnsureErrorCode 的 START_PENDING 注释。
 *
 * 用假面板的 state.startHoldMs 挂起 start 请求（见 fake-panel-server.mjs 文件头
 * 「start 挂起」段落）：客户端的 startRequestTimeoutMs 配得比挂起时长短得多，
 * 逼真复现「面板首次拉镜像要几分钟，插件等不了那么久」的场景。
 */

/** 与 multi-model-e2e.test.ts 同款拉流小工具：跑完一整条流，只取其副作用（起停/请求体） */
async function drain(adapter: LlamapadAdapter, model: string) {
  const chunks: unknown[] = [];
  for await (const c of adapter.stream({
    provider: "llamapad", model,
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: {} }],
  } as any)) chunks.push(c);
  return chunks;
}

describe("卡片 start：startRequestTimeoutMs 超时后不误报失败", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let releaseStart: ReturnType<typeof createFakePanel>["releaseStart"];
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, state, releaseStart } = createFakePanel({ loadMs: 20 }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("start() 返回的快照无 panelError 且 starting 含该模型；放行后 starting 清空、模型转入 runningModels", async () => {
    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 5_000 });
    const gateway = new PanelGateway(
      { reflect: { provide: vi.fn() } } as unknown as Context,
      // 乐观启动（gateway.start 内部固定 waitReady:false）：极短的 startRequestTimeoutMs
      // 配合假面板的无限期挂起，确保请求一定在面板返回之前就客户端自己超时
      { client, gate: createModelGate(client), panelUrl: baseUrl, token: "lp_e2e", startRequestTimeoutMs: 300 },
      async () => {},
    );

    // 挂起 qwen-small 的 start：面板收到请求、记入 starting，但永远不会自己完成
    state.startHoldMs.set("qwen-small", Number.POSITIVE_INFINITY);

    const pending = await gateway.start("qwen-small");
    // 面板仍在处理不是故障：不画红色横幅（见 panel-gateway.ts start() 对 START_PENDING 的处理）
    expect(pending.panelError).toBeNull();
    expect(pending.starting).toEqual([
      { name: "qwen-small", displayName: "Qwen 小", since: expect.any(String), stage: "pulling", action: "start" },
    ]);
    // 请求还没真正返回，模型自然也还没出现在运行列表里
    expect(pending.runningModels).toEqual([]);

    // 放行挂起的请求：面板这才真正把模型标记为运行中
    releaseStart("qwen-small");

    const next = await gateway.snapshot();
    expect(next.starting).toEqual([]);
    expect(next.runningModels.map((m) => m.name)).toEqual(["qwen-small"]);
    expect(next.panelError).toBeNull();
  });
});

describe("auto-switch：start 请求超时后继续轮询就绪", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, state } = createFakePanel({ loadMs: 30 }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("start 请求自身超时（面板仍在处理），auto-switch 不放弃、继续轮询直到真正就绪，不报 PANEL_UNREACHABLE", async () => {
    // 挂起 500ms 后自动放行（定时挂起，非手动）——比 startRequestTimeoutMs（100ms）长得多，
    // 保证请求一定先在客户端侧超时，再由 pollReady 的轮询把结果等回来
    state.startHoldMs.set("qwen-small", 500);

    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 5_000 });
    const adapter = new LlamapadAdapter({
      client, gate: createModelGate(client), token: "lp_e2e", mode: "proxy",
      chatBehavior: "auto-switch",
      pollIntervalMs: 20,
      // 富余但远小于生产默认值（300000ms）：如果 START_PENDING 被误当成终态失败，
      // 这里会立刻抛错而不是真的等到超时，测试会在断言处失败而非拖满超时才失败
      startTimeoutMs: 5_000,
      startRequestTimeoutMs: 100,
    });

    const chunks = await drain(adapter, "qwen-small");
    expect(chunks.length).toBeGreaterThan(0);
    expect(state.starts).toEqual(["qwen-small"]);
    expect(state.chatRequests.at(-1)!.model).toBe("qwen-small");
  });
});

describe("老面板模式：supportsStarting:false 时不回归既有行为", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, state } = createFakePanel({ loadMs: 20, supportsStarting: false }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("runtime/status 响应体里连 starting 键都不带；卡片快照的 starting 归一为空数组，启停仍正常", async () => {
    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const gateway = new PanelGateway(
      { reflect: { provide: vi.fn() } } as unknown as Context,
      { client, gate: createModelGate(client), panelUrl: baseUrl, token: "lp_e2e" },
      async () => {},
    );

    const rawStatus = await fetch(`${baseUrl}/api/v1/runtime/status`, {
      headers: { authorization: "Bearer lp_e2e" },
    });
    expect(await rawStatus.json()).not.toHaveProperty("starting");

    // 缺席容忍：PanelGateway 的快照仍然是一份合法的空数组，不是 undefined/抛错
    const before = await gateway.snapshot();
    expect(before.starting).toEqual([]);

    // 既有行为不回归：正常启停不受 supportsStarting 影响
    await client.startModel("qwen-small");
    const started = await gateway.snapshot();
    expect(started.starting).toEqual([]);
    expect(started.runningModels.map((m) => m.name)).toEqual(["qwen-small"]);

    await client.stopModel("qwen-small");
    const stopped = await gateway.snapshot();
    expect(stopped.runningModels).toEqual([]);
    expect(state.starts).toEqual(["qwen-small"]);
    expect(state.stops).toEqual(["qwen-small"]);
  });
});
