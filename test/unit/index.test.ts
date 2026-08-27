import { describe, expect, it, vi } from "vitest";
import { apply, Config, name, inject } from "../../src/index";

function fakeCtx() {
  return { llm: { registerAdapter: vi.fn() }, effect: vi.fn(), emit: vi.fn() } as any;
}

const valid = {
  panelUrl: "http://panel:8080",
  token: "lp_t",
};

describe("插件入口", () => {
  it("元数据：name/inject", () => {
    expect(name).toBe("llamapad-dsh-plugin");
    expect(inject).toEqual(["llm"]);
  });

  it("apply：默认注册 llamapad provider + LlamapadAdapter 实例", () => {
    const ctx = fakeCtx();
    apply(ctx, Config(valid) as any);
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
    const [providers, adapter] = ctx.llm.registerAdapter.mock.calls[0]!;
    expect(providers).toEqual(["llamapad"]);
    expect(adapter.constructor.name).toBe("LlamapadAdapter");
  });

  it("provider 可配", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({ ...valid, provider: "local" }) as any);
    expect(ctx.llm.registerAdapter.mock.calls[0]![0]).toEqual(["local"]);
  });

  it("非法 mode / direct 缺 llamaBaseUrl → 抛错", () => {
    expect(() => apply(fakeCtx(), Config({ ...valid, mode: "x" }) as any)).toThrow();
    expect(() => apply(fakeCtx(), Config({ ...valid, mode: "direct" }) as any)).toThrow(/llamaBaseUrl/);
  });

  it("非法 chatBehavior → 抛错", () => {
    expect(() => apply(fakeCtx(), Config({ ...valid, chatBehavior: "bogus" }) as any)).toThrow(/chatBehavior/);
  });

  it("Config 默认值", () => {
    const parsed = Config(valid) as any;
    expect(parsed.mode).toBe("proxy");
    expect(parsed.chatBehavior).toBe("strict");
    expect(parsed.startTimeoutMs).toBe(300000);
    expect(parsed.pollIntervalMs).toBe(2000);
    expect(parsed.drainOnSwitch).toBe(true);
    expect(parsed.drainTimeoutMs).toBe(60000);
    expect(parsed.requestTimeoutMs).toBe(30000);
    expect(parsed.statusRefreshMs).toBe(5000);
  });

  it("apply：注册后启动目录刷新器（ctx.effect 被调用一次）", () => {
    const ctx = fakeCtx();
    apply(ctx, Config(valid) as any);
    expect(ctx.effect).toHaveBeenCalledTimes(1);
  });

  it("statusRefreshMs=0 时不启动目录刷新器", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({ ...valid, statusRefreshMs: 0 }) as any);
    expect(ctx.effect).not.toHaveBeenCalled();
  });

  it("缺 panelUrl/token 提前 return：既不注册 adapter 也不启动刷新器", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({}) as any);
    expect(ctx.llm.registerAdapter).not.toHaveBeenCalled();
    expect(ctx.effect).not.toHaveBeenCalled();
  });
});
