import { describe, expect, it, vi } from "vitest";
import { apply, Config, name, inject } from "../../src/index";
import { RPC_CONTRIBUTION, RPC_PACKAGE } from "../../src/rpc-contract";

function fakeCtx() {
  const ctx: any = {
    llm: { registerAdapter: vi.fn() },
    effect: vi.fn(),
    emit: vi.fn(),
    // PanelGateway 是 cordis Service（经 TypertRemoteService），构造时自注册要用到
    // ctx.reflect.provide。
    reflect: { provide: vi.fn() },
    // typert.register 是真机上唯一能让网关认领端点的通路（@Remote 装饰器写进的是
    // dsh-typert-protocol 的模块级 WeakMap，第三方插件与宿主各解析一份该包，两张
    // WeakMap 互不可见——见 index.ts 里 ctx.inject(["typert"], …) 那段注释），必须
    // 桩出来才能断言到调用。
    typert: { register: vi.fn() },
  };
  // 按依赖名分派：请求 "typert" 时真的回调（本次会话已挂载该服务），其余依赖
  // （如 "settings"）视为未挂载、不回调——与 installSettingsSection 自身文档描述的
  // 降级行为一致，也维持了改动前对 settings 分支的假设不变。
  ctx.inject = vi.fn((deps: string[], callback: (c: any) => void) => {
    if (deps.includes("typert")) callback(ctx);
  });
  return ctx;
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

  it("apply：向 typert 注册 host 描述符（绕开 @Remote 模块级 WeakMap 跨实例分裂）", () => {
    const ctx = fakeCtx();
    apply(ctx, Config(valid) as any);
    expect(ctx.typert.register).toHaveBeenCalledTimes(1);
    const [registration] = ctx.typert.register.mock.calls[0]!;
    expect(registration.package).toBe(RPC_PACKAGE);
    expect(registration.face).toBe("host");
    // 直接用同一个引用：index.ts 原样透传 RPC_CONTRIBUTION.descriptors，不做拷贝，
    // 契约的唯一出处仍是 rpc-contract.ts。
    expect(registration.invocations).toBe(RPC_CONTRIBUTION.descriptors);
  });

  it("缺 panelUrl/token 提前 return：不向 typert 注册描述符", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({}) as any);
    expect(ctx.typert.register).not.toHaveBeenCalled();
  });
});
