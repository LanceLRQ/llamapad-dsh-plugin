import { describe, expect, it, vi } from "vitest";
import {
  createEventRing,
  createFleetCache,
  startStatusWatch,
  type EventRing,
  type FleetCacheHandle,
} from "../../src/status-watch";
import {
  PanelError,
  type PanelClient,
  type PanelEvent,
  type PanelRuntimeStatus,
  type StreamEventsHandler,
} from "../../src/panel-client";

/* ------------------------------------------------------------------ *
 * 假件
 * ------------------------------------------------------------------ */

/** 与生产代码约定一致的最小 Context 假件：effect 直接执行 execute 并转发其返回的 disposer。 */
function fakeCtx() {
  const emit = vi.fn();
  const effect = vi.fn((execute: () => () => void) => execute());
  return { ctx: { emit, effect } as any, emit, effect };
}

/**
 * 假定时器 + 假时钟（一套）：watcher 的宽限期判定读注入的 nowImpl，定时器读注入的
 * setTimeout/clearTimeout——都指向这里，测试就能不真等 30s 而「拨表」。
 *
 * fireAll 触发「当前这一轮」已排定的全部回调（本轮执行中新排的留给下一轮）——
 * watcher 同时最多挂着两三个定时器（看门狗/退避/轮询表），逐个点名太脆，按轮推进
 * 与真实时间流的语义一致。每发一个回调都推进假时钟到它的到期时刻。
 */
function fakeWorld() {
  let clock = 0;
  let nextHandle = 1;
  const pending = new Map<number, { callback: () => void; dueAt: number }>();
  const setTimeoutImpl = vi.fn((callback: () => void, ms: number) => {
    const handle = nextHandle++;
    pending.set(handle, { callback, dueAt: clock + ms });
    return handle;
  });
  const clearTimeoutImpl = vi.fn((handle: unknown) => {
    pending.delete(handle as number);
  });
  async function flush(rounds = 12): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
  }
  async function fireAll(): Promise<void> {
    const entries = [...pending.entries()];
    pending.clear();
    for (const [, { callback, dueAt }] of entries) {
      clock = Math.max(clock, dueAt);
      callback();
      // 每个回调后刷微任务，让 async 主体（探测的 allSettled、看门狗的 getEvents）落地
      await flush();
    }
  }
  return {
    setTimeoutImpl, clearTimeoutImpl, fireAll, flush, pending,
    now: () => clock,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/**
 * 可驱动的假面板 client：runtimeStatus 的返回由 setRunning 控制；streamEvents 记录
 * 每条流的 handler 供测试手动喂事件/报错（真 streamEvents 的回调本来就是异步到达的，
 * 手动调用即模拟网络侧推送）。
 */
function fakePanel() {
  let running: string | null = null;
  const models = [
    { name: "a", displayName: "A", namespace: "main", quant: null, sizeBytes: 1, hostPort: 1, status: "stopped" },
    { name: "b", displayName: "B", namespace: "main", quant: "Q4", sizeBytes: 2, hostPort: 1, status: "stopped" },
  ];
  const runtimeStatus = vi.fn(async (): Promise<PanelRuntimeStatus> => ({
    running: running ? { model: running } : null,
  }));
  const listModels = vi.fn(async () => models.map((m) => ({ ...m, status: m.name === running ? "running" : "stopped" })));
  const getEvents = vi.fn(async (): Promise<PanelEvent[]> => []);
  const streams: Array<{ handler: StreamEventsHandler; stopped: boolean }> = [];
  const streamEvents = vi.fn((handler: StreamEventsHandler) => {
    const stream = { handler, stopped: false };
    streams.push(stream);
    return () => {
      stream.stopped = true;
    };
  });
  const client: PanelClient = {
    baseUrl: "http://panel:8080",
    listModels,
    getModel: async () => null,
    getEffectiveConfig: async () => null,
    runtimeStatus,
    startModel: async () => {},
    stopModel: async () => ({ ok: true }),
    getReasoningInfo: async () => null,
    llamaHealth: async () => true,
    getEvents,
    streamEvents,
  };
  return {
    client, runtimeStatus, listModels, getEvents, streamEvents, streams,
    setRunning: (value: string | null) => {
      running = value;
    },
  };
}

const unreachable = () => new PanelError("llamapad 面板不可达", "PANEL_UNREACHABLE");
const evt = (id: number, kind = "model.stop"): PanelEvent =>
  ({ id, ts: 1_700_000_000_000 + id, kind, message: `事件 ${id}` });

/**
 * 组装一个完整接线的 watcher：假 ctx + 假时钟 + 假面板 + 真环/真缓存。
 * running / getEvents 必须在启动前就位——启动探测与水位线对表在 startStatusWatch
 * 返回前就已同步发出（各自 await 在微任务里落地），事后改 mock 只影响后续轮次。
 */
function startWatch(overrides: {
  intervalMs?: number;
  running?: string | null;
  getEvents?: PanelEvent[];
  getEventsRejects?: boolean;
  client?: () => PanelClient;
} = {}) {
  const { ctx, emit, effect } = fakeCtx();
  const world = fakeWorld();
  const panel = fakePanel();
  if (overrides.running !== undefined) panel.setRunning(overrides.running);
  if (overrides.getEvents !== undefined) panel.getEvents.mockResolvedValue(overrides.getEvents);
  if (overrides.getEventsRejects === true) panel.getEvents.mockRejectedValue(unreachable());
  const eventRing: EventRing = createEventRing();
  const fleetCache: FleetCacheHandle = createFleetCache();
  startStatusWatch({
    ctx,
    client: overrides.client ?? (() => panel.client),
    intervalMs: overrides.intervalMs ?? 1000,
    fleetCache,
    eventRing,
    setTimeoutImpl: world.setTimeoutImpl,
    clearTimeoutImpl: world.clearTimeoutImpl,
    nowImpl: world.now,
  });
  return {
    ctx, emit, effect, world, panel, eventRing, fleetCache,
    dispose: () => {
      (effect.mock.results[0]!.value as () => void)();
    },
  };
}

/** 把 watcher 打入降级轮询：连续 3 次建连失败（前两次之间让退避定时器落地重连）。 */
async function fallToPolling(h: ReturnType<typeof startWatch>): Promise<void> {
  for (let i = 0; i < 2; i++) {
    h.panel.streams.at(-1)!.handler.onError!(unreachable());
    await h.world.fireAll();
  }
  h.panel.streams.at(-1)!.handler.onError!(unreachable()); // 第 3 次 → enterPolling，轮询表已排未发
}

/* ------------------------------------------------------------------ *
 * createEventRing / createFleetCache
 * ------------------------------------------------------------------ */

describe("createEventRing", () => {
  it("默认容量 8：新事件进尾，超出裁头，保留最近 8 条（时间升序）", () => {
    const ring = createEventRing();
    for (let i = 1; i <= 10; i++) ring.push(evt(i));
    expect(ring.snapshot().map((e) => e.id)).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("容量可自定义", () => {
    const ring = createEventRing(2);
    ring.push(evt(1));
    ring.push(evt(2));
    ring.push(evt(3));
    expect(ring.snapshot().map((e) => e.id)).toEqual([2, 3]);
  });

  it("snapshot 返回副本：外部改动不回写环内状态", () => {
    const ring = createEventRing();
    ring.push(evt(1));
    ring.snapshot().push(evt(99));
    ring.snapshot().length = 0;
    expect(ring.snapshot().map((e) => e.id)).toEqual([1]);
  });
});

describe("createFleetCache", () => {
  it("初始 get 为 null（还没探测过），update 后读回同一份记录", () => {
    const cache = createFleetCache();
    expect(cache.get()).toBeNull();
    const patch = {
      running: "a",
      models: [{ name: "a", displayName: "A", quant: null }],
      fetchedAt: 123,
    };
    cache.update(patch);
    expect(cache.get()).toEqual(patch);
    cache.update({ running: null, models: [], fetchedAt: 456 });
    expect(cache.get()).toEqual({ running: null, models: [], fetchedAt: 456 });
  });
});

/* ------------------------------------------------------------------ *
 * startStatusWatch
 * ------------------------------------------------------------------ */

describe("startStatusWatch：开关与启动", () => {
  it("intervalMs=0 / 负数 / 缺省：不连 SSE、不排定时器、不注册 effect（0 的语义是不打扰面板）", () => {
    for (const intervalMs of [0, -1000, undefined as unknown as number]) {
      // 直接调 startStatusWatch 而不经 startWatch 的 intervalMs 默认值兜底——
      // 那里的 ?? 1000 恰好会掩盖「缺省值放行」这个要测的缺陷
      const { ctx, effect } = fakeCtx();
      const world = fakeWorld();
      const panel = fakePanel();
      startStatusWatch({
        ctx, client: () => panel.client, intervalMs,
        setTimeoutImpl: world.setTimeoutImpl, clearTimeoutImpl: world.clearTimeoutImpl, nowImpl: world.now,
      });
      expect(effect).not.toHaveBeenCalled();
      expect(panel.streamEvents).not.toHaveBeenCalled();
      expect(world.setTimeoutImpl).not.toHaveBeenCalled();
    }
  });

  it("启动即探测定运行基线（不 emit）并填充 fleetCache，随后连 SSE、排看门狗", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();

    expect(h.panel.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled(); // 首轮只定基线
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(1);
    expect(h.panel.getEvents).toHaveBeenCalledWith({ limit: 1 }); // 启动对表
    expect(h.fleetCache.get()).toEqual({
      running: "a",
      // models 投影只取三字段（M5 消费者要的形状），status/namespace 等被裁掉
      models: [
        { name: "a", displayName: "A", quant: null },
        { name: "b", displayName: "B", quant: "Q4" },
      ],
      fetchedAt: expect.any(Number),
    });
    expect(h.world.pending.size).toBe(1); // 只有看门狗在跑
  });
});

describe("startStatusWatch：SSE 事件驱动", () => {
  it("model.* 新事件 + 运行模型变化 → emit llm/adapters-updated（无参数），事件入环、缓存更新", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();

    h.panel.setRunning("b");
    h.panel.streams[0]!.handler.onEvent(evt(1, "model.start"));
    await h.world.flush();

    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.emit).toHaveBeenCalledWith("llm/adapters-updated");
    expect(h.eventRing.snapshot().map((e) => e.id)).toEqual([1]);
    expect(h.fleetCache.get()?.running).toBe("b");
  });

  it("model.* 新事件但运行模型未变 → 探测照做（缓存刷新），不 emit", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();

    h.panel.streams[0]!.handler.onEvent(evt(1, "model.start"));
    await h.world.flush();

    expect(h.panel.runtimeStatus).toHaveBeenCalledTimes(2); // 启动 + 事件触发
    expect(h.emit).not.toHaveBeenCalled();
  });

  it("非 model.* 事件（download.* 等）入环但不触发探测", async () => {
    const h = startWatch();
    await h.world.flush();

    h.panel.streams[0]!.handler.onEvent(evt(1, "download.complete"));
    h.panel.streams[0]!.handler.onEvent(evt(2, "download.progress"));
    await h.world.flush();

    expect(h.eventRing.snapshot().map((e) => e.id)).toEqual([1, 2]);
    expect(h.panel.runtimeStatus).toHaveBeenCalledTimes(1); // 只有启动那一次
  });

  it("snapshot 历史重放（id ≤ 启动对表的水位线）不入环、不触发探测；更高 id 才算新", async () => {
    const h = startWatch({ running: "a", getEvents: [{ id: 20, ts: 1, kind: "x", message: "" }] });
    await h.world.flush();
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(1);

    // 连接建立后的 snapshot：最近 20 条历史按 ts 倒序推来
    h.panel.streams[0]!.handler.onEvent(evt(20, "model.stop"));
    h.panel.streams[0]!.handler.onEvent(evt(18, "model.start"));
    await h.world.flush();
    expect(h.eventRing.snapshot()).toEqual([]);
    expect(h.panel.runtimeStatus).toHaveBeenCalledTimes(1);
    expect(h.emit).not.toHaveBeenCalled();

    // 水位线之后的新事件照常入环 + 触发
    h.panel.setRunning(null);
    h.panel.streams[0]!.handler.onEvent(evt(21, "model.stop"));
    await h.world.flush();
    expect(h.eventRing.snapshot().map((e) => e.id)).toEqual([21]);
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("启动对表失败时：流上首条事件定水位线（不入环），其后更低 id 视为历史、更高 id 为新", async () => {
    const h = startWatch({ getEventsRejects: true });
    await h.world.flush();
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(1); // 对表失败不挡连接

    h.panel.streams[0]!.handler.onEvent(evt(20, "model.stop")); // snapshot 首条 = 最大 id
    h.panel.streams[0]!.handler.onEvent(evt(19, "model.start"));
    await h.world.flush();
    expect(h.eventRing.snapshot()).toEqual([]);

    h.panel.streams[0]!.handler.onEvent(evt(21, "model.stop"));
    await h.world.flush();
    expect(h.eventRing.snapshot().map((e) => e.id)).toEqual([21]);
  });

  it("惰性 client：退避重连时现取 client()，配置热更后新连接打向新 client", async () => {
    const panelA = fakePanel();
    const panelB = fakePanel();
    let current: PanelClient = panelA.client;
    const { ctx, effect } = fakeCtx();
    const world = fakeWorld();
    startStatusWatch({
      ctx, client: () => current, intervalMs: 1000,
      setTimeoutImpl: world.setTimeoutImpl, clearTimeoutImpl: world.clearTimeoutImpl, nowImpl: world.now,
    });
    await world.flush();
    expect(panelA.streamEvents).toHaveBeenCalledTimes(1);

    current = panelB.client; // 模拟 index.ts 原地改写 adapterOptions.client
    panelA.streams[0]!.handler.onError!(unreachable());
    await world.fireAll(); // 退避落地 → 重连

    expect(panelB.streamEvents).toHaveBeenCalledTimes(1);
    (effect.mock.results[0]!.value as () => void)(); // 清理
  });
});

describe("startStatusWatch：降级轮询", () => {
  it("onError 连续 3 次（期间无成功事件）→ 降级轮询：探测变化 emit、缓存更新；前两次按 2s/5s 退避重连", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();

    h.panel.streams.at(-1)!.handler.onError!(unreachable());
    expect(h.world.setTimeoutImpl).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    await h.world.fireAll(); // 退避落地 → 重连出第 2 条流
    h.panel.streams.at(-1)!.handler.onError!(unreachable());
    expect(h.world.setTimeoutImpl).toHaveBeenLastCalledWith(expect.any(Function), 5_000);
    await h.world.fireAll(); // → 第 3 条流
    h.panel.streams.at(-1)!.handler.onError!(unreachable()); // 第 3 次 → 降级

    // 轮询表已排（intervalMs 节拍），第 3 条流被收掉
    expect(h.world.setTimeoutImpl).toHaveBeenLastCalledWith(expect.any(Function), 1_000);
    expect(h.panel.streams[2]!.stopped).toBe(true);

    h.panel.setRunning("b");
    await h.world.fireAll(); // 第 1 轮轮询：探测 + SSE 恢复试探（出第 4 条流）
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.fleetCache.get()?.running).toBe("b");
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(4);
  });

  it("成功事件清零失败计数与退避档位：2 次失败 + 1 个事件 + 再失败 → 仍按 2s 重连而非降级", async () => {
    const h = startWatch();
    await h.world.flush();

    h.panel.streams.at(-1)!.handler.onError!(unreachable());
    await h.world.fireAll();
    h.panel.streams.at(-1)!.handler.onError!(unreachable());
    await h.world.fireAll();
    h.panel.streams.at(-1)!.handler.onEvent(evt(1, "model.start")); // 成功事件 → 双清零
    await h.world.flush();
    h.panel.streams.at(-1)!.handler.onError!(unreachable()); // 计数重新从 1 起步

    expect(h.world.setTimeoutImpl).toHaveBeenLastCalledWith(expect.any(Function), 2_000);
    await h.world.fireAll();
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(4); // 仍在 SSE 模式重连，没进轮询
  });

  it("探测异常被吞：不 emit、保持上一份基线与缓存，循环继续", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush(); // 基线 a

    await fallToPolling(h);
    h.panel.runtimeStatus.mockRejectedValueOnce(unreachable()); // 第 2 次探测失败
    await h.world.fireAll();
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.fleetCache.get()?.running).toBe("a"); // 缓存保持上一份完整快照

    h.panel.setRunning("b");
    await h.world.fireAll(); // 失败那轮没动基线，本轮 b ≠ a → emit
    expect(h.emit).toHaveBeenCalledTimes(1);
  });

  it("降级后 SSE 恢复：试探连接收到事件 → 立即切回，停轮询表（看门狗接管）", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();
    await fallToPolling(h);

    await h.world.fireAll(); // 第 1 轮轮询：探测 + 恢复试探（第 4 条流挂着）
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(4);

    h.panel.setRunning("b");
    h.panel.streams[3]!.handler.onEvent(evt(5, "model.start")); // 事件到达 = 恢复铁证
    await h.world.flush();
    expect(h.emit).toHaveBeenCalledTimes(1); // 切回的同时没漏掉这次变化的探测

    const statusCalls = h.panel.runtimeStatus.mock.calls.length;
    const eventCalls = h.panel.streamEvents.mock.calls.length;
    await h.world.fireAll();
    await h.world.fireAll();
    // 轮询已停（runtimeStatus 不再每轮 +1），SSE 也不再重连；看门狗在跑（getEvents +2）
    expect(h.panel.runtimeStatus.mock.calls.length).toBe(statusCalls);
    expect(h.panel.streamEvents.mock.calls.length).toBe(eventCalls);
    expect(h.panel.getEvents.mock.calls.length).toBeGreaterThanOrEqual(3);
  });

  it("宽限期切回：试探连接挂满 30s 无 onError → 切回（该轮不再探测）；29s 时还不切", async () => {
    const h = startWatch();
    await h.world.flush();
    await fallToPolling(h);

    await h.world.fireAll(); // 第 1 轮轮询：恢复试探连接挂上（deadline = 现在 + 30s）
    h.world.advance(29_999);
    await h.world.fireAll(); // 第 2 轮：宽限未满 → 仍在轮询，本轮照常探测
    expect(h.panel.runtimeStatus.mock.calls.length).toBe(3); // 启动 + 两轮轮询

    h.world.advance(2);
    await h.world.fireAll(); // 第 3 轮：宽限期满 → 切回，本轮探测跳过
    expect(h.panel.runtimeStatus.mock.calls.length).toBe(3);
    await h.world.fireAll(); // 看门狗接管断流检测
    expect(h.panel.getEvents.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("防抖动：宽限期内 onError → 不切回，继续轮询并在下轮重新试探", async () => {
    const h = startWatch();
    await h.world.flush();
    await fallToPolling(h);

    await h.world.fireAll(); // 恢复试探连接挂上
    h.world.advance(10_000);
    h.panel.streams.at(-1)!.handler.onError!(unreachable()); // 宽限期内失败
    h.world.advance(25_000); // 即便过了 deadline，也不切回
    const streamsBefore = h.panel.streamEvents.mock.calls.length;
    await h.world.fireAll();

    expect(h.panel.streamEvents.mock.calls.length).toBe(streamsBefore + 1); // 重新试探（新流）
    expect(h.panel.runtimeStatus.mock.calls.length).toBe(3); // 轮询探测照常 → 仍在轮询模式
  });

  it("轮询链的 ABA 防护：tick 挂起期间切回 SSE 又再次降级，旧链不复活（不会双倍轮询）", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();
    await fallToPolling(h); // P1 已排未发

    // 手动发出 P1 且不刷微任务：pollTick 挂起在 await probe() 上（微任务未落地）
    const entries = [...h.world.pending.entries()];
    h.world.pending.clear();
    entries[0]![1].callback();

    // 挂起期间经历一次模式往返：试探连接送来事件 → 切回 SSE；随后连续 3 次报错 → 再降级
    h.panel.streams.at(-1)!.handler.onEvent(evt(1, "model.start"));
    for (let i = 0; i < 3; i++) h.panel.streams.at(-1)!.handler.onError!(unreachable());
    await h.world.flush();

    // 旧 P1 链的 finally 因世代不符退场：只挂着新轮询链的一张表（双链会让这里是 2）
    expect(h.world.pending.size).toBe(1);

    h.panel.setRunning("b");
    await h.world.fireAll(); // 新链的一轮：探测 + 恢复试探
    expect(h.emit).toHaveBeenCalledTimes(1);
  });
});

describe("startStatusWatch：看门狗（断流检测）", () => {
  it("面板漏推事件（最新 id 超过水位线）→ 回收重连，漏掉的事件经重连 snapshot 补入环", async () => {
    const h = startWatch({ running: "a", getEvents: [{ id: 5, ts: 1, kind: "x", message: "" }] });
    await h.world.flush();

    await h.world.fireAll(); // 看门狗第 1 轮：最新 id = 5 = 水位线 → 健康，不动流
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(1);

    h.panel.getEvents.mockResolvedValue([{ id: 8, ts: 1, kind: "x", message: "" }]); // 面板已有 8，流没送到
    await h.world.fireAll(); // 看门狗第 2 轮 → 回收重连
    expect(h.panel.streams[0]!.stopped).toBe(true);
    expect(h.panel.streamEvents).toHaveBeenCalledTimes(2);

    h.panel.setRunning(null);
    h.panel.streams[1]!.handler.onEvent(evt(6, "download.start")); // 重连 snapshot 补齐漏掉的事件
    h.panel.streams[1]!.handler.onEvent(evt(7, "model.stop"));
    h.panel.streams[1]!.handler.onEvent(evt(8, "model.stop"));
    await h.world.flush();
    expect(h.eventRing.snapshot().map((e) => e.id)).toEqual([6, 7, 8]);
    expect(h.emit).toHaveBeenCalledTimes(1); // a → null 的变化被补刷
  });

  it("看门狗探针连续失败 3 次 → 同样降级轮询", async () => {
    const h = startWatch({ running: "a", getEventsRejects: true });
    await h.world.flush();

    for (let i = 0; i < 3; i++) await h.world.fireAll(); // 3 轮看门狗失败（含退避重连）

    h.panel.setRunning("b");
    await h.world.fireAll(); // 轮询第 1 轮
    expect(h.emit).toHaveBeenCalledTimes(1);
    expect(h.fleetCache.get()?.running).toBe("b");
  });

  it("看门狗链的 ABA 防护：tick 挂起期间降级又切回，旧看门狗链不复活（不会双倍探针）", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush();
    expect(h.world.pending.size).toBe(1); // 只有启动排下的看门狗 W1

    // 接管 getEvents：让手动发出的 W1 挂在一个可控的 Promise 上
    let release!: (events: PanelEvent[]) => void;
    h.panel.getEvents.mockImplementation(() => new Promise<PanelEvent[]>((resolve) => {
      release = resolve;
    }));

    // 手动发出 W1 且不刷微任务：watchdogTick 挂起在探针的 await 上
    let entries = [...h.world.pending.entries()];
    h.world.pending.clear();
    entries[0]![1].callback();

    // 挂起期间经历一次模式往返：3 次建连失败降级（排下 P1）→ 手动发出 P1（挂起在
    // probe 上并已建好恢复试探流）→ 试探流送来事件切回 SSE（排下新看门狗 W2）
    for (let i = 0; i < 3; i++) h.panel.streams.at(-1)!.handler.onError!(unreachable());
    entries = [...h.world.pending.entries()];
    h.world.pending.clear();
    entries[0]![1].callback();
    h.panel.streams.at(-1)!.handler.onEvent(evt(1, "model.start"));

    release([]); // W1 的探针落地：面板活着、无漏事件
    await h.world.flush();

    // 旧 W1 链的 finally 因世代不符退场，只剩新起的 W2（双链会让这里是 2）
    expect(h.world.pending.size).toBe(1);
  });
});

describe("startStatusWatch：卸载", () => {
  it("disposer：停掉常驻流、取消全部定时器，此后 fireAll 无事发生", async () => {
    const h = startWatch();
    await h.world.flush();
    h.dispose();

    expect(h.panel.streams[0]!.stopped).toBe(true);
    expect(h.world.pending.size).toBe(0);
    const timers = h.world.setTimeoutImpl.mock.calls.length;
    await h.world.fireAll();
    expect(h.world.setTimeoutImpl.mock.calls.length).toBe(timers); // 没有回调再排新表
  });

  it("卸载与事件探测擦肩而过：probe 挂起于 await 期间被卸载 → 不 emit、不再排表", async () => {
    const h = startWatch({ running: "a" });
    await h.world.flush(); // 基线 a

    h.panel.setRunning("b");
    h.panel.streams[0]!.handler.onEvent(evt(1, "model.start")); // probe 出发，卡在 await
    h.dispose(); // 卸载先落地
    await h.world.flush();

    expect(h.emit).not.toHaveBeenCalled();
    const timers = h.world.setTimeoutImpl.mock.calls.length;
    await h.world.fireAll();
    expect(h.world.setTimeoutImpl.mock.calls.length).toBe(timers);
  });
});
