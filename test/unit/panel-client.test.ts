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

  it("startModel 状态码映射：404→MODEL_NOT_FOUND、422→MODEL_FILES_MISSING、401→AUTH", async () => {
    for (const [status, code] of [[404, "MODEL_NOT_FOUND"], [422, "MODEL_FILES_MISSING"], [401, "AUTH"]] as const) {
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
});
