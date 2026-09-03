import { describe, expect, it, vi } from "vitest";
import { startDirectoryRefresh } from "../../src/directory-refresh";
import { PanelError, type PanelClient, type PanelRuntimeStatus } from "../../src/panel-client";

/** 与生产代码约定一致的最小 Context 假件：effect 直接执行 execute 并转发其返回的 disposer。 */
function fakeCtx() {
  const emit = vi.fn();
  const effect = vi.fn((execute: () => () => void) => execute());
  return { ctx: { emit, effect } as any, emit, effect };
}

/** 假定时器：只暴露"取出最近一次排定的回调并触发"，测试不真的等待。 */
function fakeTimers() {
  let nextHandle = 1;
  const pending = new Map<number, () => void>();
  const setTimeoutImpl = vi.fn((callback: () => void, _ms: number) => {
    const handle = nextHandle++;
    pending.set(handle, callback);
    return handle;
  });
  const clearTimeoutImpl = vi.fn((handle: unknown) => {
    pending.delete(handle as number);
  });
  async function fire(): Promise<void> {
    const entries = [...pending.entries()];
    const last = entries.at(-1);
    if (!last) throw new Error("没有待触发的定时器");
    const [handle, callback] = last;
    pending.delete(handle);
    callback();
    // tick() 内部只有一次 await（client.runtimeStatus()），多刷几轮微任务确保其后的同步逻辑
    // （含 finally 里排下一轮）跑完，不使用真实等待。
    for (let i = 0; i < 5; i++) await Promise.resolve();
  }
  return { setTimeoutImpl, clearTimeoutImpl, fire, pending };
}

function fakeClient(runtimeStatus: PanelClient["runtimeStatus"]): PanelClient {
  return {
    baseUrl: "http://panel:8080",
    listModels: async () => [],
    getModel: async () => null,
    getEffectiveConfig: async () => null,
    runtimeStatus,
    startModel: async () => {},
    stopModel: async () => ({ ok: true }),
    getReasoningInfo: async () => null,
    llamaHealth: async () => true,
    getEvents: async () => [],
    streamEvents: () => () => {},
  };
}

function runningStatus(model: string | null): PanelRuntimeStatus {
  return { running: model ? { model } : null };
}

describe("startDirectoryRefresh", () => {
  it("intervalMs<=0 不启动定时器，也不注册清理", () => {
    const { ctx, effect } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl } = fakeTimers();
    startDirectoryRefresh({
      ctx, client: () => fakeClient(async () => runningStatus(null)), intervalMs: 0, setTimeoutImpl, clearTimeoutImpl,
    });
    expect(setTimeoutImpl).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("负数 intervalMs 同样不启动", () => {
    const { ctx, effect } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl } = fakeTimers();
    startDirectoryRefresh({
      ctx, client: () => fakeClient(async () => runningStatus(null)), intervalMs: -1000, setTimeoutImpl, clearTimeoutImpl,
    });
    expect(setTimeoutImpl).not.toHaveBeenCalled();
    expect(effect).not.toHaveBeenCalled();
  });

  it("首轮只定基线，不 emit", async () => {
    const { ctx, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, fire } = fakeTimers();
    const runtimeStatus = vi.fn(async () => runningStatus("a"));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    await fire();
    expect(runtimeStatus).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
  });

  it("运行中模型变化时 emit llm/adapters-updated（无参数）", async () => {
    const { ctx, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, fire } = fakeTimers();
    let model: string | null = "a";
    const runtimeStatus = vi.fn(async () => runningStatus(model));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    await fire(); // 首轮：基线 = a，不 emit
    model = "b";
    await fire(); // 第二轮：b != a → emit
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("llm/adapters-updated");
  });

  it("运行中模型不变时不 emit", async () => {
    const { ctx, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, fire } = fakeTimers();
    const runtimeStatus = vi.fn(async () => runningStatus("a"));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    await fire();
    await fire();
    await fire();
    expect(emit).not.toHaveBeenCalled();
  });

  it("从有模型变为无模型运行、或反过来，都算变化", async () => {
    const { ctx, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, fire } = fakeTimers();
    let model: string | null = "a";
    const runtimeStatus = vi.fn(async () => runningStatus(model));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    await fire(); // 基线 a
    model = null;
    await fire(); // a → null，变化
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("探测失败：吞掉异常、不 emit、保持上一次基线，循环继续", async () => {
    const { ctx, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, fire } = fakeTimers();
    let call = 0;
    const runtimeStatus = vi.fn(async () => {
      call++;
      if (call === 1) return runningStatus("a");
      if (call === 2) throw new PanelError("llamapad 面板不可达", "PANEL_UNREACHABLE");
      return runningStatus("b");
    });
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    await fire(); // 基线 a
    await expect(fire()).resolves.toBeUndefined(); // 第二轮报错：不抛出、循环不终止
    expect(emit).not.toHaveBeenCalled();
    await fire(); // 第三轮 b：与基线 a（未被失败那轮更新）不同 → emit
    expect(emit).toHaveBeenCalledTimes(1);
    expect(call).toBe(3);
  });

  it("卸载后清理定时器：ctx.effect 返回的 disposer 调用 clearTimeoutImpl", () => {
    const { ctx, effect } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl } = fakeTimers();
    startDirectoryRefresh({
      ctx, client: () => fakeClient(async () => runningStatus(null)), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl,
    });
    expect(effect).toHaveBeenCalledTimes(1);
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);
    const disposer = effect.mock.results[0]!.value as () => void;
    disposer();
    expect(clearTimeoutImpl).toHaveBeenCalledTimes(1);
  });

  it("卸载与到期擦肩而过：tick 挂起于 await 期间被卸载，finally 也不会再排一轮", async () => {
    const { ctx, effect } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, pending } = fakeTimers();
    const runtimeStatus = vi.fn(async () => runningStatus("a"));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    const disposer = effect.mock.results[0]!.value as () => void;
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1);

    // 手动触发已排定的回调（模拟到期），tick() 卡在第一个 await（client.runtimeStatus()）
    // 尚未落地时，同步调用 disposer——这是"处置与到期擦肩而过"的竞态。
    const [handle, callback] = [...pending.entries()].at(-1)!;
    pending.delete(handle);
    callback();
    disposer();

    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(setTimeoutImpl).toHaveBeenCalledTimes(1); // finally 里 stopped=true，没有再排一轮
  });

  it("卸载与到期擦肩而过：await 期间被卸载时不再 emit（ctx 已释放）", async () => {
    const { ctx, effect, emit } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl, pending } = fakeTimers();
    let answer: string | null = "a";
    const runtimeStatus = vi.fn(async () => runningStatus(answer));
    startDirectoryRefresh({ ctx, client: () => fakeClient(runtimeStatus), intervalMs: 1000, setTimeoutImpl, clearTimeoutImpl });
    const disposer = effect.mock.results[0]!.value as () => void;

    // 第一轮定基线 a
    const fire = () => { const [h, cb] = [...pending.entries()].at(-1)!; pending.delete(h); cb(); };
    fire();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();

    // 第二轮读到变化，但 tick 卡在 await 期间就被卸载 —— 不该再往已释放的 ctx 上 emit
    answer = "b";
    fire();
    disposer();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(emit).not.toHaveBeenCalled();
  });

  it("intervalMs 缺省（绕过 schemastery 直接调用）不启动定时器，不退化成 0 毫秒死循环", () => {
    const { ctx, effect } = fakeCtx();
    const { setTimeoutImpl, clearTimeoutImpl } = fakeTimers();
    startDirectoryRefresh({
      ctx, client: () => fakeClient(async () => runningStatus(null)),
      intervalMs: undefined as unknown as number, setTimeoutImpl, clearTimeoutImpl,
    });
    expect(effect).not.toHaveBeenCalled();
    expect(setTimeoutImpl).not.toHaveBeenCalled();
  });
});
