import { describe, expect, it, vi } from "vitest";
import { createModelGate, EnsureError, formatStartTimeoutMessage, sharedModelGate } from "../../src/switching";
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

  it("signal 透传：ensureOnce 把 signal 并进 startModel 的 options（取消不再只作用于就绪等待）", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    const startModel = vi.fn(async (name: string) => { client.starts.push(name); client.setRunning(name); });
    (client as any).startModel = startModel;
    await createModelGate(client).ensure("a", { signal: controller.signal, waitReady: false });
    expect(startModel).toHaveBeenCalledWith("a", { signal: controller.signal });
  });

  it("signal 与排空参数并存时一起进 startModel 的 options", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    const startModel = vi.fn(async (name: string) => { client.starts.push(name); client.setRunning(name); });
    (client as any).startModel = startModel;
    await createModelGate(client).ensure("a", {
      signal: controller.signal, drain: true, drainTimeoutMs: 60000, waitReady: false,
    });
    expect(startModel).toHaveBeenCalledWith("a", { drain: true, drainTimeoutMs: 60000, signal: controller.signal });
  });

  it("startModel 在途时外部 abort：折成 ABORTED 而不是 PANEL_UNREACHABLE（面板没挂，是调用方放弃）", async () => {
    const client = fakeClient();
    const controller = new AbortController();
    (client as any).startModel = async () => {
      controller.abort(); // 模拟 fetch 被取消后 request() 折出的 PANEL_UNREACHABLE
      throw Object.assign(new Error("llamapad 面板不可达: http://panel"), { code: "PANEL_UNREACHABLE" });
    };
    const gate = createModelGate(client);
    await expect(
      gate.ensure("a", { signal: controller.signal, waitReady: false }),
    ).rejects.toMatchObject({ code: "ABORTED" });
  });

  it("waitReady:false：start 发出即返回，不做就绪轮询", async () => {
    const client = fakeClient(); client.setHealthy(false);
    const health = vi.spyOn(client, "llamaHealth");
    await createModelGate(client).ensure("a", { waitReady: false });
    expect(client.starts).toEqual(["a"]);
    expect(health).not.toHaveBeenCalled();
  });

  it("start 抛 RUNTIME_BUSY 时原样传导，不压成 PANEL_UNREACHABLE", async () => {
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => ({ running: null }),
      startModel: async () => {
        throw Object.assign(new Error("运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试"), {
          code: "RUNTIME_BUSY",
        });
      },
      llamaHealth: async () => true,
    } as any;
    const gate = createModelGate(client);
    await expect(gate.ensure("a")).rejects.toMatchObject({
      code: "RUNTIME_BUSY",
      message: "运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试",
    });
  });

  it("start 抛 START_REJECTED 时原样传导", async () => {
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => ({ running: null }),
      startModel: async () => {
        throw Object.assign(new Error('思考强度 "max" 不被该模型的 chat template 接受（允许值：xhigh、medium、low）'), {
          code: "START_REJECTED",
        });
      },
      llamaHealth: async () => true,
    } as any;
    const gate = createModelGate(client);
    await expect(gate.ensure("a")).rejects.toMatchObject({ code: "START_REJECTED" });
  });

  it("就绪轮询优先读 runtime/status 的 ready，不再打 llamaHealth", async () => {
    let statusCalls = 0;
    const llamaHealth = vi.fn(async () => true);
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => {
        statusCalls += 1;
        // 第 1 次：门自己的「是否已在跑」前置检查；第 2 次起：就绪轮询
        return statusCalls === 1
          ? { running: null }
          : { running: { model: "a", ready: statusCalls >= 3 } };
      },
      startModel: async () => {},
      llamaHealth,
    } as any;
    const gate = createModelGate(client);
    await gate.ensure("a", { pollIntervalMs: 1 });
    expect(llamaHealth).not.toHaveBeenCalled();
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it("ready 缺席（老面板）时回退 llamaHealth，不会永远等下去", async () => {
    let statusCalls = 0;
    const llamaHealth = vi.fn(async () => true);
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => {
        statusCalls += 1;
        // 第 1 次是门的「是否已在跑」前置检查，必须返回 null 才会触发 start；
        // 之后返回目标模型在跑但**不带 ready 字段**，模拟老面板
        return statusCalls === 1 ? { running: null } : { running: { model: "a" } };
      },
      startModel: async () => {},
      llamaHealth,
    } as any;
    const gate = createModelGate(client);
    await gate.ensure("a", { pollIntervalMs: 1 });
    expect(llamaHealth).toHaveBeenCalled();
  });

  it("目标是非默认模型时仍能判定就绪（P0-1 回归：running 是默认模型，不是唯一在跑的模型）", async () => {
    let statusCalls = 0;
    const llamaHealth = vi.fn(async () => true);
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => {
        statusCalls += 1;
        // 默认模型 a 全程在跑、running/defaultModel 恒为 a；目标 b 在第 1 次前置检查时
        // 还没起（models 里没有它），此后才出现在运行集合里且逐步变 ready——
        // 旧实现按 running.model !== "b" 判定会永远为 true，一直轮询到超时
        if (statusCalls === 1) {
          return { running: { model: "a" }, defaultModel: "a", models: [{ model: "a", ready: true }] };
        }
        return {
          running: { model: "a" },
          defaultModel: "a",
          models: [{ model: "a", ready: true }, { model: "b", ready: statusCalls >= 3 }],
        };
      },
      startModel: async () => {},
      llamaHealth,
    } as any;
    const gate = createModelGate(client);
    await gate.ensure("b", { pollIntervalMs: 1 });
    expect(llamaHealth).not.toHaveBeenCalled();
    expect(statusCalls).toBeGreaterThanOrEqual(3);
  });

  it("超时错误文案列出当前其他在跑模型", async () => {
    const client = {
      baseUrl: "http://panel:8080",
      // 目标 b 从未出现在运行集合里：前置检查、就绪轮询、超时后的补查全部走这一份数据
      runtimeStatus: async () => ({
        running: { model: "a" },
        defaultModel: "a",
        models: [{ model: "a", ready: true }, { model: "c", ready: true }],
      }),
      startModel: async () => {},
      llamaHealth: async () => false,
    } as any;
    const gate = createModelGate(client);
    await expect(
      gate.ensure("b", { timeoutMs: 0, pollIntervalMs: 10 }),
    ).rejects.toMatchObject({
      code: "START_TIMEOUT",
      message: "等待 b 就绪超时（0ms）。当前面板还在运行：a、c；显存不足时可在面板停掉不用的模型再试",
    });
  });

  it("超时后补查其他在跑模型失败时，退回不带后半句的基础文案", async () => {
    let statusCalls = 0;
    const client = {
      baseUrl: "http://panel:8080",
      runtimeStatus: async () => {
        statusCalls += 1;
        // 第 1 次前置检查、第 2 次就绪轮询都正常返回；第 3 次是超时后为了成文而补查
        // 「当前其他在跑模型」的那一次，模拟这次补查本身失败
        if (statusCalls <= 2) return { running: { model: "a" }, defaultModel: "a", models: [{ model: "a", ready: true }] };
        throw new Error("面板连不上");
      },
      startModel: async () => {},
      llamaHealth: async () => false,
    } as any;
    const gate = createModelGate(client);
    await expect(
      gate.ensure("b", { timeoutMs: 0, pollIntervalMs: 10 }),
    ).rejects.toMatchObject({
      code: "START_TIMEOUT",
      message: "等待 b 就绪超时（0ms）",
    });
  });
});

describe("formatStartTimeoutMessage", () => {
  it("有其他在跑模型时，基础文案后附上列表与显存提示", () => {
    expect(formatStartTimeoutMessage("b", 300_000, ["a", "c"])).toBe(
      "等待 b 就绪超时（300000ms）。当前面板还在运行：a、c；显存不足时可在面板停掉不用的模型再试",
    );
  });

  it("没有其他在跑模型时，只返回基础文案", () => {
    expect(formatStartTimeoutMessage("b", 300_000, [])).toBe("等待 b 就绪超时（300000ms）");
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

  it("同一 baseUrl 换了 client（如设置卡片改了 token）→ 同一把门改用最新的 client", async () => {
    const stale = fakeClient({ baseUrl: "http://shared-c" });
    const fresh = fakeClient({ baseUrl: "http://shared-c" });
    const gate = sharedModelGate(stale);
    expect(sharedModelGate(fresh)).toBe(gate);
    await gate.ensure("m1");
    expect(fresh.starts).toEqual(["m1"]);
    expect(stale.starts).toEqual([]);
  });
});

// 测试内小工具
class PanelLikeError extends Error { constructor(message: string, readonly code: string) { super(message); } }
function starts_push(arr: string[], v: string) { arr.push(v); }
