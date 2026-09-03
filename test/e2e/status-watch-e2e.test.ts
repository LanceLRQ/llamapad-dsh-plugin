import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createFakePanel } from "./fake-panel-server.mjs";
import { createPanelClient } from "../../src/panel-client";
import { createEventRing, createFleetCache, startStatusWatch } from "../../src/status-watch";

/**
 * status-watch 的假面板 E2E：真 streamEvents（真 fetch + SSE 解析）+ 真 getEvents/
 * runtimeStatus，只有 ctx 是假件。挂真实 dsh ctx 太重（要拉起整个宿主），而本任务
 * 要验证的链路是「面板 HTTP/SSE → watcher → emit」，fake ctx 的 effect/emit 语义与
 * 真实契约一致（effect 即执行、emit 转发），足以钉住这条链；降级/切回/看门狗等
 * 状态机细节在 test/unit/status-watch.test.ts 用注入假时钟覆盖。
 */
let server: ReturnType<typeof createFakePanel>["server"];
let state: ReturnType<typeof createFakePanel>["state"];
let baseUrl: string;
let client: ReturnType<typeof createPanelClient>;

beforeAll(async () => {
  ({ server, state } = createFakePanel({ loadMs: 10 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
  client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
});
afterAll(() => server.close());

/** 真定时的 watcher 装配：假 ctx（effect 即执行并留 disposer）+ 真 panel client。 */
function watch(intervalMs: number) {
  const emit = vi.fn();
  let disposer: () => void = () => {};
  const ctx = {
    emit,
    effect: (execute: () => () => void) => {
      disposer = execute();
      return disposer;
    },
  } as any;
  const eventRing = createEventRing();
  const fleetCache = createFleetCache();
  const connectionsAtStart = state.eventConnections;
  startStatusWatch({ ctx, client: () => client, intervalMs, fleetCache, eventRing });
  return {
    emit, eventRing, fleetCache,
    dispose: () => disposer(),
    /** 等 watcher 自己的 SSE 订阅建立（重连也会加分，所以断言「至少 +1」） */
    waitForSubscription: () => vi.waitFor(() => {
      expect(state.eventConnections).toBeGreaterThanOrEqual(connectionsAtStart + 1);
    }),
  };
}

describe("status-watch E2E（假面板 + 真 SSE）", () => {
  it("SSE 推 model.stop → 探测到运行模型变化 → emit llm/adapters-updated；事件入环、缓存更新", async () => {
    state.running = "qwen-small";
    state.readyAt = 0;
    const w = watch(150);
    try {
      await w.waitForSubscription();
      // 冷启动基线探测落地：基线 = qwen-small，只定基线不 emit
      await vi.waitFor(() => expect(w.fleetCache.get()?.running).toBe("qwen-small"));
      expect(w.emit).not.toHaveBeenCalled();

      await client.stopModel("qwen-small"); // 面板侧停止 → model.stop 事件 → SSE 推送
      await vi.waitFor(() => expect(w.emit).toHaveBeenCalledWith("llm/adapters-updated"));
      expect(w.fleetCache.get()?.running).toBeNull();
      expect(w.eventRing.snapshot().map((e) => e.kind)).toContain("model.stop");
    } finally {
      w.dispose();
    }
  });

  it("SSE 推 model.start → 无模型 → 有模型的变化同样 emit", async () => {
    state.running = null;
    const w = watch(150);
    try {
      await w.waitForSubscription();
      await vi.waitFor(() => expect(w.fleetCache.get()?.running).toBeNull());
      expect(w.emit).not.toHaveBeenCalled();

      await client.startModel("qwen-small");
      await vi.waitFor(() => expect(w.emit).toHaveBeenCalledWith("llm/adapters-updated"));
      expect(w.fleetCache.get()?.running).toBe("qwen-small");
      expect(w.eventRing.snapshot().map((e) => e.kind)).toContain("model.start");
    } finally {
      w.dispose();
    }
  });

  it("启动时 snapshot 的历史事件不进环（只定 id 基线）、不触发 emit", async () => {
    const w = watch(150);
    try {
      await w.waitForSubscription();
      // 此前用例已累积若干事件，snapshot 帧会重放它们；多等一轮确保帧已推完
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(w.eventRing.snapshot()).toEqual([]);
      expect(w.emit).not.toHaveBeenCalled();
    } finally {
      w.dispose();
    }
  });

  it("intervalMs=0：连 SSE 都不建（eventConnections 不增），effect 也不注册", async () => {
    const effect = vi.fn();
    startStatusWatch({ ctx: { emit: vi.fn(), effect } as any, client: () => client, intervalMs: 0 });
    expect(effect).not.toHaveBeenCalled();
    const connections = state.eventConnections;
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(state.eventConnections).toBe(connections);
  });
});
