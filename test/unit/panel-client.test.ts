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

  it("getModel：404→null，200→行", async () => {
    const miss = fakeFetch([{ status: 404, body: { error: "no" } }]);
    await expect(createPanelClient({ ...base, fetch: miss.fn as any }).getModel("x")).resolves.toBeNull();
    const hit = fakeFetch([{ body: { name: "x", displayName: "X", namespace: "main", overrides: { server: { ctx_size: 8192 } } } }]);
    await expect(createPanelClient({ ...base, fetch: hit.fn as any }).getModel("x")).resolves.toMatchObject({ name: "x" });
  });
});
