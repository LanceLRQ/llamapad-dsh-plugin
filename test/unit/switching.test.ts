import { describe, expect, it, vi } from "vitest";
import { createModelGate, EnsureError, sharedModelGate } from "../../src/switching";
import type { PanelClient } from "../../src/panel-client";

function fakeClient(overrides: Partial<PanelClient> = {}): PanelClient & {
  starts: string[]; setRunning: (m: string | null) => void; setHealthy: (b: boolean) => void;
} {
  let running: string | null = null;
  let healthy = true;
  const starts: string[] = [];
  const client = {
    baseUrl: "http://panel",
    starts,
    setRunning: (m: string | null) => { running = m; },
    setHealthy: (b: boolean) => { healthy = b; },
    listModels: async () => [],
    getModel: async () => null,
    runtimeStatus: async () => ({ running: running ? { model: running } : null }),
    startModel: async (name: string) => { starts.push(name); running = name; },
    llamaHealth: async () => healthy,
    ...overrides,
  } as any;
  return client;
}

describe("createModelGate", () => {
  it("快路径：目标已在跑 → 不调 startModel", async () => {
    const client = fakeClient(); client.setRunning("a");
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual([]);
  });

  it("冷启动：未运行 → start + 健康即通过", async () => {
    const client = fakeClient();
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual(["a"]);
  });

  it("切换：跑着别的 → start 目标（停旧由 llamapad 语义负责）", async () => {
    const client = fakeClient(); client.setRunning("b");
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual(["a"]);
  });

  it("超时：健康一直 false → START_TIMEOUT", async () => {
    const client = fakeClient(); client.setHealthy(false);
    await expect(
      createModelGate(client).ensure("a", { timeoutMs: 30, pollIntervalMs: 10 }),
    ).rejects.toMatchObject({ code: "START_TIMEOUT" });
  });

  it("取消：轮询中 abort → ABORTED", async () => {
    const client = fakeClient(); client.setHealthy(false);
    const controller = new AbortController();
    const gate = createModelGate(client);
    const p = gate.ensure("a", { signal: controller.signal, timeoutMs: 5_000, pollIntervalMs: 50 });
    setTimeout(() => controller.abort(), 30);
    await expect(p).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("串行：不同模型的 ensure 排队执行，顺序不交叉", async () => {
    const client = fakeClient();
    const order: string[] = [];
    const slow = async (name: string) => { order.push(`start:${name}`); await new Promise(r => setTimeout(r, 30)); client.setRunning(name); order.push(`done:${name}`); };
    (client as any).startModel = async (n: string) => { starts_push(client.starts, n); await slow(n); };
    const gate = createModelGate(client);
    await Promise.all([gate.ensure("a"), gate.ensure("b")]);
    expect(order).toEqual(["start:a", "done:a", "start:b", "done:b"]);
    expect(client.starts).toEqual(["a", "b"]);
  });

  it("合流：同模型并发 ensure 只 start 一次", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    await Promise.all([gate.ensure("a"), gate.ensure("a"), gate.ensure("a")]);
    expect(client.starts).toEqual(["a"]);
  });

  it("前序失败不阻断后续排队者", async () => {
    const client = fakeClient();
    let calls = 0;
    (client as any).startModel = async (n: string) => { calls++; if (calls === 1) { starts_push(client.starts, n); throw new PanelLikeError("模型不存在: a", "MODEL_NOT_FOUND"); } starts_push(client.starts, n); client.setRunning(n); };
    const gate = createModelGate(client);
    await expect(gate.ensure("a")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(gate.ensure("b")).resolves.toBeUndefined();
  });

  it("排空参数透传：ensure 的 drain/drainTimeoutMs 原样带进 startModel", async () => {
    const client = fakeClient();
    const startModel = vi.fn(async (name: string) => { client.starts.push(name); client.setRunning(name); });
    (client as any).startModel = startModel;
    await createModelGate(client).ensure("a", { drain: true, drainTimeoutMs: 60000 });
    expect(startModel).toHaveBeenCalledWith("a", { drain: true, drainTimeoutMs: 60000 });
  });

  it("不传排空参数时 startModel 第二个参数为 undefined（向后兼容）", async () => {
    const client = fakeClient();
    const startModel = vi.fn(async (name: string) => { client.starts.push(name); client.setRunning(name); });
    (client as any).startModel = startModel;
    await createModelGate(client).ensure("a");
    expect(startModel).toHaveBeenCalledWith("a", undefined);
  });

  it("waitReady:false：start 发出即返回，不做就绪轮询", async () => {
    const client = fakeClient(); client.setHealthy(false);
    const health = vi.spyOn(client, "llamaHealth");
    await createModelGate(client).ensure("a", { waitReady: false });
    expect(client.starts).toEqual(["a"]);
    expect(health).not.toHaveBeenCalled();
  });
});

describe("sharedModelGate", () => {
  it("同一 baseUrl → 返回同一个 Gate 实例", () => {
    const gateA = sharedModelGate(fakeClient({ baseUrl: "http://shared-a" }));
    const gateB = sharedModelGate(fakeClient({ baseUrl: "http://shared-a" }));
    expect(gateA).toBe(gateB);
  });

  it("不同 baseUrl → 返回不同 Gate 实例", () => {
    const gateA = sharedModelGate(fakeClient({ baseUrl: "http://shared-b1" }));
    const gateB = sharedModelGate(fakeClient({ baseUrl: "http://shared-b2" }));
    expect(gateA).not.toBe(gateB);
  });
});

// 测试内小工具
class PanelLikeError extends Error { constructor(message: string, readonly code: string) { super(message); } }
function starts_push(arr: string[], v: string) { arr.push(v); }
