import { describe, expect, it, vi } from "vitest";
import { apply, Config, name, inject } from "../../src/index";
import { RPC_CONTRIBUTION, RPC_PACKAGE } from "../../src/rpc-contract";

/**
 * settings 依赖按 `options.settings` 开关是否回调，模拟 installSettingsSection 内部
 * `ctx.inject(["settings"], …)` 的真实降级行为：服务未挂载时该回调根本不会跑。
 * `scopeValue` 暴露成 `ctx.__scopeValue`，供「连接热更新」用例在 apply() 之后
 * 改写 settings 层的解析结果，模拟一次外部写入 settings.yaml。
 * `options.systemPrompt` 同款开关，模拟 `ctx.inject(["systemPrompt"], …)` 在宿主
 * 未装配 systemPrompt 服务（回调不跑）与已装配（回调同步跑一次）两种形态。
 *
 * `fiber.state` 是 installSettingsSection 真实实现（非本文件的桩）里
 * `scope.watch(callback)` 回调体的 isUnloading(ctx) 检查会读的字段——我们在
 * 「连接热更新」用例里手动调用被捕获的 watch 回调时会经过这条判断，缺了这个字段
 * 会在读 `ctx.fiber.state` 时直接抛 TypeError。取一个非 4（FIBER_DISPOSED）/
 * 非 5（FIBER_UNLOADING）的值即可表示「未在卸载」。
 */
function fakeCtx(options: { settings?: boolean; systemPrompt?: boolean } = {}) {
  const scopeValue: { current: any } = { current: null };
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
    // systemPrompt.section 桩出来只为捕获注册参数（name/order/text）；宿主真身的
    // 排序、空分节丢弃等行为不在本文件验证范围。
    systemPrompt: { section: vi.fn(() => () => {}) },
    fiber: { state: 0 },
    // installSettingsSection 会调 ctx.settings.register(ns, schema, {base}) 并拿 scope，
    // 挂载时同步回调一次 setSource + onChange。桩出 register 才能驱动这条链。
    settings: {
      register: vi.fn((_ns: string, _schema: unknown, opts: any) => ({
        get: () => scopeValue.current ?? opts.base,
        watch: vi.fn(),
        update: vi.fn(),
        replace: vi.fn(),
      })),
      update: vi.fn(async () => {}),
    },
  };
  // 按依赖名分派：请求 "typert" 时真的回调（本次会话已挂载该服务）；"settings" 只在
  // 调用方显式要求时才回调，与 installSettingsSection 自身文档描述的降级行为一致；
  // "systemPrompt" 同理由 options.systemPrompt 控制。
  ctx.inject = vi.fn((deps: string[], callback: (c: any) => void) => {
    if (deps.includes("typert")) callback(ctx);
    if (deps.includes("settings") && options.settings === true) callback(ctx);
    if (deps.includes("systemPrompt") && options.systemPrompt === true) callback(ctx);
  });
  return Object.assign(ctx, { __scopeValue: scopeValue });
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
    expect(parsed.statusPromptSection).toBe(true);
  });

  it("apply：注册后启动状态刷新器（ctx.effect 被调用一次）", () => {
    const ctx = fakeCtx();
    apply(ctx, Config(valid) as any);
    expect(ctx.effect).toHaveBeenCalledTimes(1);
  });

  it("statusRefreshMs=0 时不启动状态刷新器（SSE 也不连）", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({ ...valid, statusRefreshMs: 0 }) as any);
    expect(ctx.effect).not.toHaveBeenCalled();
  });

  // 定案 3（见实施计划「阶段二」）：缺配置不再早退——那会让 installSettingsSection
  // 排在早退之后，settings namespace 从未注册，设置页里卡片压根不出现，用户无处
  // 补配置。adapter 与 typert 描述符照常注册，client 换成 createUnconfiguredClient()
  // 这个所有方法都抛指路错误的桩（见「apply：未配置时的降级」）。
  it("缺 panelUrl/token 时仍然注册 adapter 与状态刷新器", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({}) as any);
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
    expect(ctx.effect).toHaveBeenCalledTimes(1);
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

  it("缺 panelUrl/token 时仍然向 typert 注册描述符（网关端点不因未配置而消失）", () => {
    const ctx = fakeCtx();
    apply(ctx, Config({}) as any);
    expect(ctx.typert.register).toHaveBeenCalledTimes(1);
  });
});

describe("apply：未配置时的降级", () => {
  it("缺 panelUrl/token 时仍然注册 settings（否则设置页看不到卡片，无处可填）", () => {
    const ctx = fakeCtx({ settings: true });
    apply(ctx, Config({ panelUrl: "", token: "" }) as any);
    expect(ctx.settings.register).toHaveBeenCalledTimes(1);
  });

  it("缺配置时仍然注册 adapter（选择器里看得见 provider）", () => {
    const ctx = fakeCtx({ settings: true });
    apply(ctx, Config({ panelUrl: "", token: "" }) as any);
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
  });

  it("缺配置时 adapter 拿到的是未配置桩：调用会抛出指路的错误", async () => {
    const ctx = fakeCtx({ settings: true });
    apply(ctx, Config({ panelUrl: "", token: "" }) as any);
    const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
    await expect(adapter.listModels("llamapad")).rejects.toThrow(/面板地址/);
  });

  it("settings 服务未挂载时也能照常起来（不依赖它才能工作）", () => {
    const ctx = fakeCtx({ settings: false });
    apply(ctx, Config(valid) as any);
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
  });
});

describe("apply：连接热更新", () => {
  it("settings 层给出新 panelUrl 时，adapter 换到新 client 而不重新注册", () => {
    const ctx = fakeCtx({ settings: true });
    apply(ctx, Config(valid) as any);
    const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
    const before = (adapter as any).options.client;

    // 模拟 settings 层覆盖：换掉 scope.get() 的返回，再触发一次 onChange
    ctx.__scopeValue.current = Config({ ...valid, panelUrl: "http://other:9090" });
    const watchArg = ctx.settings.register.mock.results[0]!.value.watch.mock.calls[0]?.[0];
    watchArg?.();

    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);  // 没有重复注册
    expect((adapter as any).options.client).not.toBe(before);  // 但 client 换了
  });

  it("配置没变时不换 client（onChange 必须幂等，它每次写入都会被触发）", () => {
    const ctx = fakeCtx({ settings: true });
    apply(ctx, Config(valid) as any);
    const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
    const before = (adapter as any).options.client;

    const watchArg = ctx.settings.register.mock.results[0]!.value.watch.mock.calls[0]?.[0];
    watchArg?.();

    expect((adapter as any).options.client).toBe(before);
  });
});

describe("apply：提示词快照分节（M5）", () => {
  /** 找出携带某依赖的那次 ctx.inject 调用（typert/settings/systemPrompt 各占一次）。 */
  function injectCallWith(ctx: any, dep: string) {
    return ctx.inject.mock.calls.find(([deps]: string[]) => deps?.includes(dep));
  }

  /**
   * 取出 status-watch 注册的 effect 回调并执行。不能无脑用 calls[0]：settings 服务
   * 挂载时 installSettingsSection 会先注册自己的卸载 effect（见其实现），排在
   * watcher 之前；按 startStatusWatch 传入的 label 定位才稳。
   */
  function startStatusWatcher(ctx: any): () => void {
    const call = ctx.effect.mock.calls.find(([, label]: [unknown, string?]) =>
      label === "llamapad-status-watch");
    return call![0]() as () => void;
  }

  it("statusPromptSection=true 且服务在场 → 注册 local-fleet 分节（name/order/函数 text）", () => {
    const ctx = fakeCtx({ systemPrompt: true });
    apply(ctx, Config(valid) as any);
    expect(injectCallWith(ctx, "systemPrompt")).toBeTruthy();
    expect(ctx.systemPrompt.section).toHaveBeenCalledTimes(1);
    const [section] = ctx.systemPrompt.section.mock.calls[0]!;
    expect(section.name).toBe("llamapad:local-fleet");
    expect(section.order).toBe(50); // persona(0) 之后、tool guidance(100-199) 之前
    expect(typeof section.text).toBe("function");
    // 注册时 watcher 尚未探测（fake ctx 的 effect 只记录不执行）→ 内部 fleetCache
    // 为 null，text() 同步求值得到空串；renderPrompt 会丢弃空分节，不撒谎
    expect(section.text({})).toBe("");
  });

  it("statusPromptSection=false → 整段不注册（不注入 systemPrompt 依赖）", () => {
    const ctx = fakeCtx({ systemPrompt: true });
    apply(ctx, Config({ ...valid, statusPromptSection: false }) as any);
    expect(injectCallWith(ctx, "systemPrompt")).toBeUndefined();
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled();
  });

  it("服务缺席时回调不跑、插件照常（动态 inject 的降级语义）", () => {
    const ctx = fakeCtx({ systemPrompt: false });
    apply(ctx, Config(valid) as any);
    // inject 被调（带 systemPrompt 依赖），但 fake ctx 模拟服务未挂载：回调不触发
    expect(injectCallWith(ctx, "systemPrompt")).toBeTruthy();
    expect(ctx.systemPrompt.section).not.toHaveBeenCalled();
    expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
  });

  it("text 每次求值反映 fleetCache 最新状态：探测落库 → 快照同步更新", async () => {
    const ctx = fakeCtx({ systemPrompt: true });
    apply(ctx, Config(valid) as any);
    const section = ctx.systemPrompt.section.mock.calls[0]![0];

    // 配置热更同款通路：把 adapter 的 client 换成假面板（status-watch 的 client
    // thunk 每次调用现取 adapterOptions.client），再手动启动被 fake ctx 记录下来
    // 的 watcher effect——初始探测就会把下面的舰队状态写进 fleetCache。
    const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
    (adapter as any).options.client = {
      runtimeStatus: async () => ({ running: { model: "qwen3-32b" } }),
      listModels: async () => [
        { name: "qwen3-32b", displayName: "Qwen3 32B", quant: "Q4_K_M" },
        { name: "deepseek-r1-0528", displayName: "DeepSeek R1", quant: "Q4_K_M" },
      ],
      getEvents: async () => [],
      streamEvents: () => () => {},
    };
    const disposeWatch = startStatusWatcher(ctx);

    await vi.waitFor(() => expect(section.text({})).toContain("Running: qwen3-32b (Q4_K_M)"));
    expect(section.text({})).toContain("Available to start: deepseek-r1-0528 (Q4_K_M)");

    disposeWatch();
  });

  it("settings 层热关 statusPromptSection → text 立即渲染为空（等同未注册）", async () => {
    const ctx = fakeCtx({ systemPrompt: true, settings: true });
    apply(ctx, Config(valid) as any);
    const section = ctx.systemPrompt.section.mock.calls[0]![0];

    const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
    (adapter as any).options.client = {
      runtimeStatus: async () => ({ running: { model: "qwen3-32b" } }),
      listModels: async () => [{ name: "qwen3-32b", displayName: "Qwen3 32B", quant: "Q4_K_M" }],
      getEvents: async () => [],
      streamEvents: () => () => {},
    };
    const disposeWatch = startStatusWatcher(ctx);
    await vi.waitFor(() => expect(section.text({})).toContain("Running: qwen3-32b"));

    // settings 层写入 statusPromptSection: false 并触发 onChange（连接热更新用例
    // 同款手法）：text 下一次求值就应该是空串，不必重载插件
    ctx.__scopeValue.current = Config({ ...valid, statusPromptSection: false });
    const watchArg = ctx.settings.register.mock.results[0]!.value.watch.mock.calls[0]?.[0];
    watchArg?.();
    expect(section.text({})).toBe("");

    disposeWatch();
  });
});
