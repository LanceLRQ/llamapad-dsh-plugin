import { describe, expect, it, vi } from "vitest";
import { LlamapadAdapter, describeModel, filterModelsForSelector } from "../../src/adapter";
import type { PanelModelView } from "../../src/panel-client";

function sseResponse(lines: string[], status = 200): Response {
  const payload = lines.map((l) => `data: ${l}\n\n`).join("");
  return new Response(new TextEncoder().encode(payload), {
    status, headers: { "content-type": "text/event-stream" },
  });
}

function makeAdapter(over: Record<string, unknown> = {}) {
  const ensure = vi.fn(async (_model: string, _options?: Record<string, unknown>) => {});
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([
    `{"choices":[{"delta":{"content":"ok"}}]}`,
    `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `[DONE]`,
  ]));
  const client = { baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null, getEffectiveConfig: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
  const adapter = new LlamapadAdapter({
    client, gate: { ensure, lastStarted: () => null }, token: "lp_t", mode: "proxy", fetchImpl,
    ...over,
  } as any);
  return { adapter, ensure, fetchImpl };
}

const opts = (over: Record<string, unknown> = {}) => ({
  provider: "llamapad", model: "a",
  messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: {} }],
  ...over,
}) as any;

/** 把流拉完；对抛错的流透传 rejection */
async function drain(stream: AsyncIterable<unknown>): Promise<unknown[]> {
  const chunks: unknown[] = [];
  for await (const c of stream) chunks.push(c);
  return chunks;
}

describe("describeModel", () => {
  const base: PanelModelView = {
    name: "a", displayName: "模型A", namespace: "main", quant: "Q4_K_M", sizeBytes: 1, hostPort: 1, status: "ready",
  };

  it("ready → 不加任何标记", () => {
    expect(describeModel({ ...base, status: "ready" })).toEqual({ name: "模型A", description: "main · Q4_K_M" });
  });

  it("missing-file → description 末尾追加「文件缺失（面板文件页可自动寻找）」，name 不加前缀", () => {
    expect(describeModel({ ...base, status: "missing-file" })).toEqual({ name: "模型A", description: "main · Q4_K_M · 文件缺失（面板文件页可自动寻找）" });
  });

  it("missing-mmproj → description 末尾追加「mmproj 缺失（面板文件页可自动寻找）」", () => {
    expect(describeModel({ ...base, status: "missing-mmproj" })).toEqual({ name: "模型A", description: "main · Q4_K_M · mmproj 缺失（面板文件页可自动寻找）" });
  });

  it("displayName 缺失时用 name 兜底，前缀加在兜底名前", () => {
    expect(describeModel({ ...base, displayName: "", status: "running" })).toEqual({ name: "▶︎ a", description: "main · Q4_K_M" });
  });

  it("running + configStale → ▶︎ 前缀之外追加「配置已改，重启后生效」", () => {
    expect(describeModel({ ...base, status: "running", configStale: true })).toEqual({
      name: "▶︎ 模型A", description: "main · Q4_K_M · 配置已改，重启后生效",
    });
  });

  it("configStale 缺席（老面板）或为 false → 不追加", () => {
    expect(describeModel({ ...base, status: "running" }).description).toBe("main · Q4_K_M");
    expect(describeModel({ ...base, status: "running", configStale: false }).description).toBe("main · Q4_K_M");
  });

  it("quant 为 null 时 description 不带量化分段", () => {
    expect(describeModel({ ...base, quant: null, status: "ready" })).toEqual({ name: "模型A", description: "main" });
  });
});

describe("LlamapadAdapter", () => {
  it("providerInfo id 等于 provider", () => {
    expect(makeAdapter().adapter.providerInfo("llamapad")).toEqual({ id: "llamapad", name: expect.any(String) });
  });

  it("listModels 映射面板模型行：ready 不加标记", async () => {
    const client = { baseUrl: "x", listModels: async () => [
      { name: "a", displayName: "模型A", namespace: "main", quant: "Q4_K_M", sizeBytes: 1, hostPort: 1, status: "ready" },
    ], getModel: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    const models = await adapter.listModels("llamapad");
    expect(models).toEqual([{ provider: "llamapad", id: "a", name: "模型A", description: "main · Q4_K_M" }]);
  });

  it("listModels：运行中模型带 ▶︎ 前缀，缺件模型 description 追加提示，互不干扰", async () => {
    const client = { baseUrl: "x", listModels: async () => [
      { name: "a", displayName: "模型A", namespace: "main", quant: "Q4_K_M", sizeBytes: 1, hostPort: 1, status: "running" },
      { name: "b", displayName: "模型B", namespace: "main", quant: null, sizeBytes: 1, hostPort: 1, status: "missing-file" },
    ], getModel: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    const models = await adapter.listModels("llamapad");
    expect(models).toEqual([
      { provider: "llamapad", id: "a", name: "▶︎ 模型A", description: "main · Q4_K_M" },
      { provider: "llamapad", id: "b", name: "模型B", description: "main · 文件缺失（面板文件页可自动寻找）" },
    ]);
  });

  it("resolveModel：/effective 不可用时回退读 overrides.server.ctx_size，缺省省略", async () => {
    const client = { baseUrl: "x", listModels: async () => [], getModel: async (n: string) => n === "a" ? { name: "a", displayName: "A", namespace: "main", overrides: { server: { ctx_size: 8192 } } } : null, getEffectiveConfig: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.toMatchObject({ context: { contextWindow: 8192 } });
    await expect(adapter.resolveModel("llamapad", "b")).resolves.not.toHaveProperty("context");
  });

  it("resolveModel：/effective 的 merged.server.ctx_size 优先于模型级 overrides（修既有偏差：未覆盖 ctx_size 的模型也能报出面板默认值）", async () => {
    const client = {
      baseUrl: "x", listModels: async () => [],
      getModel: async () => ({ name: "a", displayName: "A", namespace: "main", overrides: {} }),
      getEffectiveConfig: async () => ({ merged: { docker: {}, server: { ctx_size: 131072 } } }),
      runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true,
    };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.toMatchObject({ context: { contextWindow: 131072 } });
  });

  it("resolveModel：merged.docker.args_override 非空数组时不上报 context（回退链短路，即使 ctx_size 处处都有值）", async () => {
    const client = {
      baseUrl: "x", listModels: async () => [],
      getModel: async () => ({ name: "a", displayName: "A", namespace: "main", overrides: { server: { ctx_size: 8192 } } }),
      getEffectiveConfig: async () => ({ merged: { docker: { args_override: ["--foo"] }, server: { ctx_size: 131072 } } }),
      runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true,
    };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.not.toHaveProperty("context");
  });

  it("resolveModel：/effective 返回 null（端点不可用）→ 回退读模型级 overrides.server.ctx_size", async () => {
    const client = {
      baseUrl: "x", listModels: async () => [],
      getModel: async () => ({ name: "a", displayName: "A", namespace: "main", overrides: { server: { ctx_size: 4096 } } }),
      getEffectiveConfig: async () => null,
      runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true,
    };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.toMatchObject({ context: { contextWindow: 4096 } });
  });

  it("resolveModel：/effective 不可用且模型级 overrides.docker.args_override 存在 → 不上报 context", async () => {
    const client = {
      baseUrl: "x", listModels: async () => [],
      getModel: async () => ({ name: "a", displayName: "A", namespace: "main", overrides: { server: { ctx_size: 4096 }, docker: { args_override: ["--foo"] } } }),
      getEffectiveConfig: async () => null,
      runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true,
    };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.not.toHaveProperty("context");
  });

  // 宿主 dsh-llm 0.1.x 的派发路径无条件 `await adapter.prepareCall(...)`，而 0.0.1-rc.1 的
  // LlmAdapter 基类没有这个方法——钉旧版时每次对话都会在进入 stream() 之前抛 TypeError。
  // 本条守住"基类默认实现始终继承得到且能派发"，避免依赖再次落后于宿主。
  it("prepareCall：基类默认实现可用，stream 委托回适配器", async () => {
    const { adapter } = makeAdapter();
    expect(typeof adapter.prepareCall).toBe("function");
    const prepared = await adapter.prepareCall("llamapad", "a");
    expect(prepared.model).toMatchObject({ provider: "llamapad", id: "a" });
    const spy = vi.spyOn(adapter, "stream");
    prepared.stream(opts()); // 生成器惰性，取迭代器不触发任何 IO
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("proxy 模式：reasoningEffort 原样进请求体，交给面板中转层改写", async () => {
    // makeAdapter 的 over 在 client 之后展开，可整体替换掉它默认的空 client
    const { adapter, fetchImpl } = makeAdapter({
      chatBehavior: "passthrough",
      client: {
        baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null,
        getEffectiveConfig: async () => null, getReasoningInfo: async () => null,
        runtimeStatus: async () => ({ running: { model: "a", ready: true } }),
        startModel: async () => {}, llamaHealth: async () => true,
      },
    });
    await drain(adapter.stream(opts({ reasoningEffort: "max" })));
    const sent = JSON.parse(String((fetchImpl.mock.calls[0]![1] as RequestInit).body));
    expect(sent.reasoning_effort).toBe("max");
  });

  it("direct 模式：reasoningEffort 仍拒绝，且先于任何 IO", async () => {
    const { adapter, ensure, fetchImpl } = makeAdapter({
      mode: "direct", llamaBaseUrl: "http://llama:18080", chatBehavior: "passthrough",
      client: {
        baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null,
        getEffectiveConfig: async () => null, getReasoningInfo: async () => null,
        runtimeStatus: async () => ({ running: { model: "a", ready: true } }),
        startModel: async () => {}, llamaHealth: async () => true,
      },
    });
    await expect(drain(adapter.stream(opts({ reasoningEffort: "max" })))).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    // 拒绝必须先于任何 IO：既不该触发启停，也不该发出推理请求。proxy 改为透传后，
    // 原「reasoningEffort → UNSUPPORTED（先于任何 IO）」那条旧用例的这层语义只剩
    // direct 模式还需要，不能随那条用例一起丢掉
    expect(ensure).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stream：auto-switch 档先 ensure（透传 signal/timeout）再 POST；proxy 模式带鉴权与 UA", async () => {
    const { adapter, ensure, fetchImpl } = makeAdapter({ chatBehavior: "auto-switch" });
    const signal = new AbortController().signal;
    const chunks = await drain(adapter.stream(opts({ signal })));
    expect(ensure).toHaveBeenCalledWith("a", expect.objectContaining({ signal }));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://panel:8080/api/v1/proxy/llama/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBe("Bearer lp_t");
    expect(String((init!.headers as Record<string, string>)["user-agent"])).toContain("/");
    expect(JSON.parse(init!.body as string).model).toBe("a");
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it("direct 模式：URL 直连 llama.cpp 且不带面板鉴权头", async () => {
    const { adapter, fetchImpl } = makeAdapter({ chatBehavior: "auto-switch", mode: "direct", llamaBaseUrl: "http://gpu:18080" });
    await drain(adapter.stream(opts()));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://gpu:18080/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("非 2xx → LlmError PROVIDER_HTTP_ERROR（带 status）", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([`{}`], 502));
    const { adapter } = makeAdapter({ chatBehavior: "auto-switch", fetchImpl });
    await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR", failure: { status: 502 } });
  });

  it("EnsureError → LlmError 同码；signal 已 abort → AbortError", async () => {
    const ensure = vi.fn(async () => { throw Object.assign(new Error("等待 a 就绪超时"), { code: "START_TIMEOUT", name: "EnsureError" }); });
    const { adapter } = makeAdapter({ chatBehavior: "auto-switch", gate: { ensure, lastStarted: () => null } });
    await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "START_TIMEOUT" });

    const controller = new AbortController(); controller.abort();
    const ensure2 = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "ABORTED", name: "EnsureError" }); });
    const { adapter: a2 } = makeAdapter({ chatBehavior: "auto-switch", gate: { ensure: ensure2, lastStarted: () => null } });
    const caught = await drain(a2.stream(opts({ signal: controller.signal }))).then(
      () => { throw new Error("应当抛出 AbortError"); },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });

  describe("chatBehavior 路由", () => {
    function clientWithRunning(model: string | null, hostPort?: number) {
      return {
        baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null,
        runtimeStatus: async () => ({ running: model ? { model, ...(hostPort !== undefined ? { hostPort } : {}) } : null }),
        startModel: async () => {}, llamaHealth: async () => true,
      };
    }

    it("默认档是 strict：无模型在跑 → MODEL_NOT_RUNNING，且不调用 ensure/fetch", async () => {
      const { adapter, ensure, fetchImpl } = makeAdapter();
      await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "MODEL_NOT_RUNNING" });
      expect(ensure).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("strict：运行中==请求 → 不调用 ensure，直接转发", async () => {
      const { adapter, ensure, fetchImpl } = makeAdapter({ client: clientWithRunning("a") });
      await drain(adapter.stream(opts()));
      expect(ensure).not.toHaveBeenCalled();
      expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).model).toBe("a");
    });

    it("strict：运行中!=请求 → MODEL_NOT_RUNNING，文案带双方模型名，且不调用 ensure/fetch", async () => {
      const { adapter, ensure, fetchImpl } = makeAdapter({ client: clientWithRunning("qwen3-8b") });
      const error = await drain(adapter.stream(opts({ model: "llama3-8b" }))).then(
        () => { throw new Error("应当抛出错误"); },
        (e: unknown) => e as Error,
      );
      expect((error as { code?: string }).code).toBe("MODEL_NOT_RUNNING");
      expect(error.message).toContain("qwen3-8b");
      expect(error.message).toContain("llama3-8b");
      expect(ensure).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    });

    it("passthrough：无模型在跑 → MODEL_NOT_RUNNING", async () => {
      const { adapter } = makeAdapter({ chatBehavior: "passthrough" });
      await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "MODEL_NOT_RUNNING" });
    });

    it("passthrough：运行中!=请求 → 照发给运行中的模型（不调用 ensure）", async () => {
      const { adapter, ensure, fetchImpl } = makeAdapter({ chatBehavior: "passthrough", client: clientWithRunning("a") });
      await drain(adapter.stream(opts({ model: "b" })));
      expect(ensure).not.toHaveBeenCalled();
      expect(JSON.parse(fetchImpl.mock.calls[0]![1]!.body as string).model).toBe("a");
    });

    it("auto-switch 触发 start 时默认带 drain（drainOnSwitch 默认 true，drainTimeoutMs 默认 60000）", async () => {
      const { adapter, ensure } = makeAdapter({ chatBehavior: "auto-switch" });
      await drain(adapter.stream(opts()));
      expect(ensure).toHaveBeenCalledWith("a", expect.objectContaining({ drain: true, drainTimeoutMs: 60000 }));
    });

    it("drainOnSwitch=false 时 start 不带 drain 参数", async () => {
      const { adapter, ensure } = makeAdapter({ chatBehavior: "auto-switch", drainOnSwitch: false });
      await drain(adapter.stream(opts()));
      const callOptions = ensure.mock.calls[0]![1] as Record<string, unknown>;
      expect(callOptions).not.toHaveProperty("drain");
      expect(callOptions).not.toHaveProperty("drainTimeoutMs");
    });

    it("drainTimeoutMs 可覆盖默认值", async () => {
      const { adapter, ensure } = makeAdapter({ chatBehavior: "auto-switch", drainTimeoutMs: 90000 });
      await drain(adapter.stream(opts()));
      expect(ensure).toHaveBeenCalledWith("a", expect.objectContaining({ drain: true, drainTimeoutMs: 90000 }));
    });

    it("strict/passthrough 查询 runtimeStatus 时带 busy=1；auto-switch 不带（省一次开销）", async () => {
      const calls: Array<{ busy?: boolean } | undefined> = [];
      const client = {
        baseUrl: "x", listModels: async () => [], getModel: async () => null,
        runtimeStatus: async (o?: { busy?: boolean }) => { calls.push(o); return { running: { model: "a" } }; },
        startModel: async () => {}, llamaHealth: async () => true,
      };
      await drain(makeAdapter({ client, chatBehavior: "strict" }).adapter.stream(opts()));
      await drain(makeAdapter({ client, chatBehavior: "auto-switch" }).adapter.stream(opts()));
      expect(calls[0]).toEqual({ busy: true });
      expect(calls[1]).toBeUndefined();
    });

    it("busy.inferring===true 时，strict 的报错文案追加忙碌提示", async () => {
      const client = {
        baseUrl: "x", listModels: async () => [], getModel: async () => null,
        runtimeStatus: async () => ({ running: { model: "a" }, busy: { inferring: true, slotsRunning: 1 } }),
        startModel: async () => {}, llamaHealth: async () => true,
      };
      const { adapter } = makeAdapter({ client });
      const error = await drain(adapter.stream(opts({ model: "b" }))).then(
        () => { throw new Error("应当抛出错误"); },
        (e: unknown) => e as Error,
      );
      expect(error.message).toContain("目标机器正在推理中");
    });

    it("auto-switch × proxy：start 后不再为拼 URL 多查一次 runtimeStatus（反代不看 hostPort）", async () => {
      const runtimeStatus = vi.fn(async () => ({ running: null as { model: string } | null }));
      const client = { ...clientWithRunning(null), runtimeStatus };
      const { adapter } = makeAdapter({ chatBehavior: "auto-switch", mode: "proxy", client });
      await drain(adapter.stream(opts()));
      expect(runtimeStatus).toHaveBeenCalledTimes(1); // 只有路由判定那一次
    });

    it("direct：llamaBaseUrl 带路径前缀时只换端口，不吞掉路径", async () => {
      const { adapter, fetchImpl } = makeAdapter({
        chatBehavior: "passthrough", mode: "direct", llamaBaseUrl: "http://gpu:9999/llama",
        client: clientWithRunning("a", 18080),
      });
      await drain(adapter.stream(opts()));
      expect(fetchImpl.mock.calls[0]![0]).toBe("http://gpu:18080/llama/v1/chat/completions");
    });

    it("direct：面板给 hostPort:null（模型行已删）→ 回落到静态 llamaBaseUrl，不拼出 :null", async () => {
      const client = {
        ...clientWithRunning("a"),
        runtimeStatus: async () => ({ running: { model: "a", hostPort: null } }),
      };
      const { adapter, fetchImpl } = makeAdapter({
        chatBehavior: "passthrough", mode: "direct", llamaBaseUrl: "http://gpu:18080", client,
      });
      await drain(adapter.stream(opts()));
      expect(fetchImpl.mock.calls[0]![0]).toBe("http://gpu:18080/v1/chat/completions");
    });

    it("passthrough × direct：主机名取 llamaBaseUrl，端口取运行中模型的 hostPort", async () => {
      const { adapter, fetchImpl } = makeAdapter({
        chatBehavior: "passthrough", mode: "direct", llamaBaseUrl: "http://gpu:18080",
        client: clientWithRunning("a", 18081),
      });
      await drain(adapter.stream(opts({ model: "b" })));
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("http://gpu:18081/v1/chat/completions");
    });

    it("direct 模式拿不到 hostPort 时回落到静态 llamaBaseUrl", async () => {
      const { adapter, fetchImpl } = makeAdapter({
        chatBehavior: "passthrough", mode: "direct", llamaBaseUrl: "http://gpu:18080",
        client: clientWithRunning("a"),
      });
      await drain(adapter.stream(opts({ model: "a" })));
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("http://gpu:18080/v1/chat/completions");
    });

    it("auto-switch × direct：切换后重新查询 hostPort，避免静态端口指向已停掉的旧容器", async () => {
      let callCount = 0;
      const client = {
        baseUrl: "x", listModels: async () => [], getModel: async () => null,
        runtimeStatus: async () => {
          callCount++;
          return callCount === 1 ? { running: null } : { running: { model: "a", hostPort: 18099 } };
        },
        startModel: async () => {}, llamaHealth: async () => true,
      };
      const { adapter, fetchImpl } = makeAdapter({ chatBehavior: "auto-switch", mode: "direct", llamaBaseUrl: "http://gpu:18080", client });
      await drain(adapter.stream(opts({ model: "a" })));
      const [url] = fetchImpl.mock.calls[0]!;
      expect(url).toBe("http://gpu:18099/v1/chat/completions");
      expect(callCount).toBe(2);
    });
  });

  it("gate 抛 RUNTIME_BUSY 时映射为同码 LlmError，文案不被替换成「面板不可达」", async () => {
    const client = {
      baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null,
      getEffectiveConfig: async () => null,
      runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true,
    };
    const ensure = vi.fn(async () => {
      throw Object.assign(new Error("运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试"), { code: "RUNTIME_BUSY" });
    });
    const adapter = new LlamapadAdapter({
      client, gate: { ensure, lastStarted: () => null }, token: "t", mode: "proxy",
      chatBehavior: "auto-switch", fetchImpl: async () => null as any,
    } as any);
    await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({
      code: "RUNTIME_BUSY",
      message: "运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试",
    });
  });
});

describe("resolveModel：思考强度上报", () => {
  function clientWith(over: Record<string, unknown> = {}) {
    return {
      baseUrl: "http://panel:8080",
      listModels: async () => [],
      getModel: async () => ({ name: "a", displayName: "模型A", namespace: "main" }),
      getEffectiveConfig: async () => ({ merged: { server: { ctx_size: 4096 } } }),
      runtimeStatus: async () => ({ running: { model: "a", ready: true } }),
      getReasoningInfo: async () => ({ supported: true, levels: ["xhigh", "low"] }),
      startModel: async () => {},
      llamaHealth: async () => true,
      ...over,
    };
  }
  const build = (client: unknown, over: Record<string, unknown> = {}) => new LlamapadAdapter({
    client, gate: { ensure: async () => {}, lastStarted: () => null },
    token: "t", mode: "proxy", fetchImpl: async () => null as any, ...over,
  } as any);

  it("proxy + 请求的就是运行中模型 → 上报面板给的真实档位", async () => {
    const resolved = await build(clientWith()).resolveModel("llamapad", "a");
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(["xhigh", "low"]);
    expect(resolved.context).toEqual({ contextWindow: 4096 });
  });

  it("proxy + 模型未运行 → 不去问面板（问了也是别人的档位），退回完整枚举", async () => {
    const getReasoningInfo = vi.fn(async () => ({ supported: true, levels: ["xhigh"] }));
    const client = clientWith({ runtimeStatus: async () => ({ running: { model: "b", ready: true } }), getReasoningInfo });
    const resolved = await build(client).resolveModel("llamapad", "a");
    expect(getReasoningInfo).not.toHaveBeenCalled();
    expect(resolved.reasoning?.efforts.map((e) => e.id))
      .toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
  });

  it("proxy + 面板明说不支持 → 不上报 reasoning", async () => {
    const client = clientWith({ getReasoningInfo: async () => ({ supported: false, levels: null }) });
    expect((await build(client).resolveModel("llamapad", "a")).reasoning).toBeUndefined();
  });

  it("direct 模式 → 一律不上报 reasoning，也不打这两条查询", async () => {
    const getReasoningInfo = vi.fn(async () => ({ supported: true, levels: ["low"] }));
    const runtimeStatus = vi.fn(async () => ({ running: { model: "a", ready: true } }));
    const client = clientWith({ getReasoningInfo, runtimeStatus });
    const resolved = await build(client, { mode: "direct", llamaBaseUrl: "http://llama:18080" })
      .resolveModel("llamapad", "a");
    expect(resolved.reasoning).toBeUndefined();
    expect(getReasoningInfo).not.toHaveBeenCalled();
    expect(runtimeStatus).not.toHaveBeenCalled();
  });

  it("面板查询失败不拖垮 resolveModel：仍返回身份与上下文，档位退回完整枚举", async () => {
    const client = clientWith({
      runtimeStatus: async () => { throw new Error("boom"); },
      getReasoningInfo: async () => { throw new Error("boom"); },
    });
    const resolved = await build(client).resolveModel("llamapad", "a");
    expect(resolved.name).toBe("模型A");
    expect(resolved.reasoning?.efforts).toHaveLength(6);
  });
});

function view(name: string, status: string): PanelModelView {
  return { name, displayName: name, namespace: "main", quant: "Q4_K_M",
           sizeBytes: 0, hostPort: 18080, status };
}

describe("filterModelsForSelector：选择器可见模型过滤", () => {
  const models = [view("a", "ready"), view("b", "running"), view("c", "missing-file")];

  it("runningOnly=false 时原样返回全部（默认行为不变）", () => {
    expect(filterModelsForSelector(models, false).map((m) => m.name)).toEqual(["a", "b", "c"]);
  });

  it("runningOnly=true 时只留 status==='running' 的那一个", () => {
    expect(filterModelsForSelector(models, true).map((m) => m.name)).toEqual(["b"]);
  });

  it("runningOnly=true 且无模型在跑时返回空数组（选择器会空，是预期代价）", () => {
    expect(filterModelsForSelector([view("a", "ready")], true)).toEqual([]);
  });

  it("不修改传入数组（纯函数）", () => {
    const input = [view("a", "ready"), view("b", "running")];
    filterModelsForSelector(input, true);
    expect(input).toHaveLength(2);
  });
});

describe("describeModel：运行标记用实心播放三角", () => {
  it("running → name 前缀为 ▶︎ 加一个空格", () => {
    expect(describeModel(view("qwen3-4b", "running")).name).toBe("▶︎ qwen3-4b");
  });

  it("非 running 不加任何前缀", () => {
    expect(describeModel(view("qwen3-4b", "ready")).name).toBe("qwen3-4b");
  });

  it("前缀带 U+FE0E 变体选择符，强制文本形态而非彩色 emoji", () => {
    expect(describeModel(view("x", "running")).name.codePointAt(1)).toBe(0xfe0e);
  });
});
