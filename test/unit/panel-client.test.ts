import { describe, expect, it, vi } from "vitest";
import { createPanelClient, PanelError } from "../../src/panel-client";

/** 记录型 fetch 替身：按序返回预设响应 */
function fakeFetch(responses: Array<{ status?: number; body?: unknown; reject?: Error }>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    const next = responses.shift();
    if (!next) throw new Error("没有更多预设响应");
    if (next.reject) throw next.reject;
    return new Response(next.body === undefined ? "{}" : JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });
  return { fn, calls };
}

const base = { baseUrl: "http://panel:8080/", token: "lp_test" };  // 尾斜杠：实现要剥掉

describe("createPanelClient", () => {
  it("listModels 发 Bearer 头并解包 {models:[]}", async () => {
    const { fn, calls } = fakeFetch([{ body: { models: [{ name: "a", displayName: "A", namespace: "main", quant: null, sizeBytes: 1, hostPort: 18080, status: "stopped" }] } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    const models = await client.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]!.name).toBe("a");
    expect(calls[0]!.url).toBe("http://panel:8080/api/v1/models");
    expect((calls[0]!.init.headers as any).authorization).toBe("Bearer lp_test");
  });

  it("startModel 状态码映射：404→MODEL_NOT_FOUND、401→AUTH", async () => {
    for (const [status, code] of [[404, "MODEL_NOT_FOUND"], [401, "AUTH"]] as const) {
      const { fn } = fakeFetch([{ status, body: { error: "x" } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      await expect(client.startModel("a")).rejects.toMatchObject({ code });
    }
  });

  it("startModel 成功路径不抛", async () => {
    const { fn } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.startModel("a")).resolves.toBeUndefined();
  });

  it("llamaHealth：200→true，503→false，网络错误→false", async () => {
    const ok = fakeFetch([{ body: { status: "ok" } }]);
    await expect(createPanelClient({ ...base, fetch: ok.fn as any }).llamaHealth()).resolves.toBe(true);
    const loading = fakeFetch([{ status: 503, body: {} }]);
    await expect(createPanelClient({ ...base, fetch: loading.fn as any }).llamaHealth()).resolves.toBe(false);
    const down = fakeFetch([{ reject: new Error("fetch failed") }]);
    await expect(createPanelClient({ ...base, fetch: down.fn as any }).llamaHealth()).resolves.toBe(false);
  });

  it("网络失败 → PANEL_UNREACHABLE", async () => {
    const { fn } = fakeFetch([{ reject: new TypeError("fetch failed") }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.listModels()).rejects.toMatchObject({ code: "PANEL_UNREACHABLE" });
  });

  it("runtimeStatus 透传解包", async () => {
    const { fn } = fakeFetch([{ body: { running: { model: "a" } } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.runtimeStatus()).resolves.toEqual({ running: { model: "a" } });
  });

  it("runtimeStatus() 不带 busy 时不追加 query", async () => {
    const { fn, calls } = fakeFetch([{ body: { running: null } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await client.runtimeStatus();
    expect(calls[0]!.url).toBe("http://panel:8080/api/v1/runtime/status");
  });

  it("runtimeStatus({busy:true}) 追加 ?busy=1 并透传 busy 字段（null 代表不可知）", async () => {
    const { fn, calls } = fakeFetch([{ body: { running: null, busy: { inferring: true, slotsRunning: 2 } } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    const result = await client.runtimeStatus({ busy: true });
    expect(calls[0]!.url).toBe("http://panel:8080/api/v1/runtime/status?busy=1");
    expect(result.busy).toEqual({ inferring: true, slotsRunning: 2 });
  });

  it("startModel 不带 drain 选项时不发请求体（向后兼容旧假面板）", async () => {
    const { fn, calls } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await client.startModel("a");
    expect(calls[0]!.init.body).toBeUndefined();
  });

  it("startModel 带 drain 选项时发 JSON 请求体", async () => {
    const { fn, calls } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await client.startModel("a", { drain: true, drainTimeoutMs: 60000 });
    expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ drain: true, drainTimeoutMs: 60000 });
    expect((calls[0]!.init.headers as any)["content-type"]).toBe("application/json");
  });

  it("startModel 不带 drainTimeoutMs 时用默认 requestTimeoutMs 做单次请求超时", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { fn } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
    await client.startModel("a");
    expect(spy).toHaveBeenCalledWith(5000);
    spy.mockRestore();
  });

  it("startModel 带 drainTimeoutMs 时超时覆盖为 max(requestTimeoutMs, drainTimeoutMs+10000)（避免排空未完客户端先 abort）", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { fn } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
    await client.startModel("a", { drain: true, drainTimeoutMs: 60000 });
    expect(spy).toHaveBeenCalledWith(70000);
    spy.mockRestore();
  });

  it("startModel 只传 drain 不传 drainTimeoutMs → 仍按服务端默认 60s 放宽超时（否则客户端会先 abort）", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const { fn } = fakeFetch([{ body: { id: "cid" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
    await client.startModel("a", { drain: true });
    expect(spy).toHaveBeenCalledWith(70000);
    spy.mockRestore();
  });

  it("getModel：404→null，200→行", async () => {
    const miss = fakeFetch([{ status: 404, body: { error: "no" } }]);
    await expect(createPanelClient({ ...base, fetch: miss.fn as any }).getModel("x")).resolves.toBeNull();
    const hit = fakeFetch([{ body: { name: "x", displayName: "X", namespace: "main", overrides: { server: { ctx_size: 8192 } } } }]);
    await expect(createPanelClient({ ...base, fetch: hit.fn as any }).getModel("x")).resolves.toMatchObject({ name: "x" });
  });

  it("listModels：mmprojFile 三态原样透传——路径 / null / 缺席（老面板不可知）", async () => {
    const { fn } = fakeFetch([{ body: { models: [
      { name: "vl", displayName: "VL", namespace: "main", quant: null, sizeBytes: 1, hostPort: 18080, status: "ready", mmprojFile: "main/vl-mmproj.gguf" },
      { name: "txt", displayName: "T", namespace: "main", quant: null, sizeBytes: 1, hostPort: 18080, status: "ready", mmprojFile: null },
      { name: "old", displayName: "O", namespace: "main", quant: null, sizeBytes: 1, hostPort: 18080, status: "ready" },
    ] } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    const models = await client.listModels();
    // 列表行的字段名就是驼峰 mmprojFile，直接透传；绝不把缺席归一成 null——
    // 那会把「老面板不可知」塌缩成「明确文本模型」，三态语义就丢了
    expect(models[0]!.mmprojFile).toBe("main/vl-mmproj.gguf");
    expect(models[1]!.mmprojFile).toBeNull();
    expect(models[2]!.mmprojFile).toBeUndefined();
  });

  it("getModel：详情行的 mmproj_file（snake_case）映射为 mmprojFile，缺席时保持 undefined", async () => {
    const hit = fakeFetch([{ body: { name: "vl", displayName: "VL", namespace: "main", mmproj_file: "main/vl-mmproj.gguf", overrides: {} } }]);
    const detail = await createPanelClient({ ...base, fetch: hit.fn as any }).getModel("vl");
    expect(detail).toMatchObject({ name: "vl", namespace: "main", mmprojFile: "main/vl-mmproj.gguf", overrides: {} });
    expect(detail).not.toHaveProperty("mmproj_file");  // 投影统一驼峰，蛇形原键不外泄

    const bare = fakeFetch([{ body: { name: "txt", displayName: "T", namespace: "main" } }]);
    const bareDetail = await createPanelClient({ ...base, fetch: bare.fn as any }).getModel("txt");
    expect(bareDetail).toMatchObject({ name: "txt" });
    expect(bareDetail!.mmprojFile).toBeUndefined();
  });

  it("getModel：详情行 display_name（snake_case，真机契约）优先于驼峰，两者皆无回落 name", async () => {
    // 真机详情是 StoredModel 原样（display_name 蛇形）；驼峰只有假面板/旧单测在喂。
    // 双读保两条路都活，修复「真机上展示名恒回落到模型 id」的既有偏差
    const snake = fakeFetch([{ body: { name: "a", display_name: "真机名", namespace: "main" } }]);
    await expect(createPanelClient({ ...base, fetch: snake.fn as any }).getModel("a"))
      .resolves.toMatchObject({ name: "a", displayName: "真机名" });

    const camel = fakeFetch([{ body: { name: "a", displayName: "驼峰名", namespace: "main" } }]);
    await expect(createPanelClient({ ...base, fetch: camel.fn as any }).getModel("a"))
      .resolves.toMatchObject({ name: "a", displayName: "驼峰名" });

    const neither = fakeFetch([{ body: { name: "a", namespace: "main" } }]);
    await expect(createPanelClient({ ...base, fetch: neither.fn as any }).getModel("a"))
      .resolves.toMatchObject({ name: "a", displayName: "a" });
  });

  it("getEffectiveConfig：404→null，200→返回体，非 ok→PanelError", async () => {
    const miss = fakeFetch([{ status: 404, body: { error: "no" } }]);
    await expect(createPanelClient({ ...base, fetch: miss.fn as any }).getEffectiveConfig("x")).resolves.toBeNull();
    const hit = fakeFetch([{ body: { merged: { server: { ctx_size: 131072 } } } }]);
    await expect(createPanelClient({ ...base, fetch: hit.fn as any }).getEffectiveConfig("x")).resolves.toEqual({ merged: { server: { ctx_size: 131072 } } });
    const err = fakeFetch([{ status: 500, body: { error: "boom" } }]);
    await expect(createPanelClient({ ...base, fetch: err.fn as any }).getEffectiveConfig("x")).rejects.toMatchObject({ code: "PANEL_HTTP" });
  });

  describe("stopModel", () => {
    it("不带 drain 选项时不发请求体，走默认 requestTimeoutMs", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const { fn, calls } = fakeFetch([{ body: { ok: true } }]);
      const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
      const result = await client.stopModel("a");
      expect(calls[0]!.url).toBe("http://panel:8080/api/v1/models/a/stop");
      expect(calls[0]!.init.method).toBe("POST");
      expect(calls[0]!.init.body).toBeUndefined();
      expect(result).toEqual({ ok: true });
      expect(spy).toHaveBeenCalledWith(5000);
      spy.mockRestore();
    });

    it("带 drain 选项时发 JSON 请求体，并透传响应里的 drain 字段", async () => {
      const { fn, calls } = fakeFetch([{ body: { ok: true, drain: { drained: true, reason: "idle" } } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      const result = await client.stopModel("a", { drain: true, drainTimeoutMs: 60000 });
      expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ drain: true, drainTimeoutMs: 60000 });
      expect((calls[0]!.init.headers as any)["content-type"]).toBe("application/json");
      expect(result).toEqual({ ok: true, drain: { drained: true, reason: "idle" } });
    });

    it("超时覆盖计算与 startModel 一致：max(requestTimeoutMs, drainTimeoutMs+10000)", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const { fn } = fakeFetch([{ body: { ok: true } }]);
      const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
      await client.stopModel("a", { drain: true, drainTimeoutMs: 60000 });
      expect(spy).toHaveBeenCalledWith(70000);
      spy.mockRestore();
    });

    it("只传 drain 不传 drainTimeoutMs → 仍按服务端默认 60s 放宽超时（与 startModel 同一套换算）", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const { fn } = fakeFetch([{ body: { ok: true } }]);
      const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
      await client.stopModel("a", { drain: true });
      expect(spy).toHaveBeenCalledWith(70000);
      spy.mockRestore();
    });

    it("404 → MODEL_NOT_FOUND", async () => {
      const { fn } = fakeFetch([{ status: 404, body: { error: "模型不存在: a" } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      await expect(client.stopModel("a")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    });

    it("401 → AUTH", async () => {
      const { fn } = fakeFetch([{ status: 401, body: { error: "unauthorized" } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      await expect(client.stopModel("a")).rejects.toMatchObject({ code: "AUTH" });
    });

    it("其余非 2xx → PANEL_HTTP", async () => {
      const { fn } = fakeFetch([{ status: 500, body: { error: "boom" } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      await expect(client.stopModel("a")).rejects.toMatchObject({ code: "PANEL_HTTP" });
    });
  });

  describe("外部取消 signal（超时与取消的合并）", () => {
    it("startModel 带 signal：fetch 收到合并 signal，外部 abort 后在途请求被取消", async () => {
      const controller = new AbortController();
      // 挂起型 fetch：只在收到的 signal abort 时才落牌，模拟服务端排空期间的在途等待
      const fn = vi.fn((_url: any, init?: any) =>
        new Promise<Response>((_, reject) => {
          init.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        }));
      const client = createPanelClient({ ...base, fetch: fn as any });

      const pending = client.startModel("a", { signal: controller.signal });
      pending.catch(() => {}); // 断言前先挂上兜底，避免未处理拒绝噪声
      controller.abort();

      await expect(pending).rejects.toMatchObject({ code: "PANEL_UNREACHABLE" });
      // 不是裸透传外部 signal——超时层仍然在（外层还有 AbortSignal.timeout 包着）
      expect((fn.mock.calls[0]![1] as any).signal).not.toBe(controller.signal);
    });

    it("stopModel 带 signal：请求带上的合并 signal 跟随外部 signal abort", async () => {
      const controller = new AbortController();
      const { fn, calls } = fakeFetch([{ body: { ok: true } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });

      await client.stopModel("a", { signal: controller.signal });

      const signal = calls[0]!.init.signal as AbortSignal;
      expect(signal).not.toBe(controller.signal);
      controller.abort();
      expect(signal.aborted).toBe(true);
    });

    it("带 signal 时单请求超时仍然生效（合并不会吞掉 AbortSignal.timeout 那一层）", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const { fn } = fakeFetch([{ body: { ok: true } }]);
      const client = createPanelClient({ ...base, fetch: fn as any, requestTimeoutMs: 5000 });
      await client.stopModel("a", { signal: new AbortController().signal });
      expect(spy).toHaveBeenCalledWith(5000);
      spy.mockRestore();
    });
  });

  it("startModel 409 → RUNTIME_BUSY，透传面板 message", async () => {
    const { fn } = fakeFetch([{
      status: 409,
      body: { error: "运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试" },
    }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.startModel("a")).rejects.toMatchObject({
      code: "RUNTIME_BUSY",
      status: 409,
      message: "运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试",
    });
  });

  it("stopModel 409 → RUNTIME_BUSY", async () => {
    const { fn } = fakeFetch([{ status: 409, body: { error: "运行时忙：正在停止模型 qwen3，请等待当前操作完成后再试" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.stopModel("a")).rejects.toMatchObject({ code: "RUNTIME_BUSY", status: 409 });
  });

  it("startModel 422 且 message 含「模型文件缺失」→ MODEL_FILES_MISSING", async () => {
    const { fn } = fakeFetch([{ status: 422, body: { error: "模型文件缺失: main/qwen3-Q4_K_M.gguf" } }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.startModel("a")).rejects.toMatchObject({
      code: "MODEL_FILES_MISSING",
      message: "模型文件缺失: main/qwen3-Q4_K_M.gguf",
    });
  });

  it("startModel 422 其余成因（思考强度非法）→ START_REJECTED，原文照传", async () => {
    const { fn } = fakeFetch([{
      status: 422,
      body: { error: '思考强度 "max" 不被该模型的 chat template 接受（允许值：xhigh、medium、low）' },
    }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.startModel("a")).rejects.toMatchObject({
      code: "START_REJECTED",
      message: '思考强度 "max" 不被该模型的 chat template 接受（允许值：xhigh、medium、low）',
    });
  });

  it("getReasoningInfo 打中转 /v1/models 并解析 x_llamapad", async () => {
    const { fn, calls } = fakeFetch([{
      body: { object: "list", data: [{ id: "qwen3", x_llamapad: { reasoning_effort: { supported: true, levels: ["xhigh", "low"] } } }] },
    }]);
    const client = createPanelClient({ ...base, fetch: fn as any });
    await expect(client.getReasoningInfo()).resolves.toEqual({ supported: true, levels: ["xhigh", "low"] });
    expect(calls[0]!.url).toBe("http://panel:8080/api/v1/proxy/llama/v1/models");
    expect((calls[0]!.init.headers as any).authorization).toBe("Bearer lp_test");
  });

  it("getReasoningInfo：503（无模型在跑）与网络失败都归 null，不抛错", async () => {
    const { fn: fn503 } = fakeFetch([{ status: 503, body: { error: "没有运行中的模型" } }]);
    await expect(createPanelClient({ ...base, fetch: fn503 as any }).getReasoningInfo()).resolves.toBeNull();
    const { fn: fnErr } = fakeFetch([{ reject: new Error("ECONNREFUSED") }]);
    await expect(createPanelClient({ ...base, fetch: fnErr as any }).getReasoningInfo()).resolves.toBeNull();
  });
});
