import { describe, expect, it, vi } from "vitest";
import {
  createPanelClient,
  createSseFrameParser,
  PanelError,
  type PanelEvent,
} from "../../src/panel-client";

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

/** SSE 型 fetch 替身：返回以手动 ReadableStream 为体的 Response。
 *  push 模拟服务端推帧、close 模拟服务端收流；fail 可注入非 ok 响应或网络错误。
 *  push 在流被取消后（停止函数已 reader.cancel）会抛，吞掉——那正是「停止后静默」
 *  要验证的状态，不该让替身自己炸测试。 */
function sseFetch(fail?: { status: number; body?: string } | { reject: Error }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let source: ReadableStreamDefaultController<Uint8Array> | undefined;
  const encoder = new TextEncoder();
  const fn = vi.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), init: init ?? {} });
    if (fail && "reject" in fail) throw fail.reject;
    if (fail) return new Response(fail.body ?? "{}", { status: fail.status });
    const stream = new ReadableStream<Uint8Array>({ start(c) { source = c; } });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  });
  return {
    fn,
    calls,
    push: (chunk: string) => {
      try {
        source?.enqueue(encoder.encode(chunk));
      } catch {
        // 流已取消/已关：静默
      }
    },
    close: () => source?.close(),
  };
}

/** 测试事件工厂 + 两种帧的序列化（与面板 sse.ts 的 wire 格式一致：单行 data JSON） */
const sseEvent = (id: number): PanelEvent =>
  ({ id, ts: 1_700_000_000_000 + id, kind: "model.start", message: `事件 ${id}` });
const snapshotFrame = (events: PanelEvent[]) => `data: ${JSON.stringify({ type: "snapshot", events })}\n\n`;
const eventFrame = (e: PanelEvent) => `data: ${JSON.stringify({ type: "event", ...e })}\n\n`;

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

  describe("getEvents", () => {
    it("limit/kind 拼进 query，带 Bearer 头并解包 {events:[]} 响应", async () => {
      const { fn, calls } = fakeFetch([{ body: { events: [
        { id: 2, ts: 1725350400000, kind: "model.start", message: "启动 qwen3" },
        { id: 1, ts: 1725350300000, kind: "model.stop", message: "停止 qwen3" },
      ] } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      const events = await client.getEvents({ limit: 5, kind: "model.start" });
      expect(calls[0]!.url).toBe("http://panel:8080/api/v1/events?limit=5&kind=model.start");
      expect((calls[0]!.init.headers as any).authorization).toBe("Bearer lp_test");
      expect(events).toEqual([
        { id: 2, ts: 1725350400000, kind: "model.start", message: "启动 qwen3" },
        { id: 1, ts: 1725350300000, kind: "model.stop", message: "停止 qwen3" },
      ]);
    });

    it("limit/kind 缺省时不带 query（服务端用默认 20 条，不在客户端焊死）", async () => {
      const { fn, calls } = fakeFetch([{ body: { events: [] } }]);
      const client = createPanelClient({ ...base, fetch: fn as any });
      await expect(client.getEvents()).resolves.toEqual([]);
      expect(calls[0]!.url).toBe("http://panel:8080/api/v1/events");
    });

    it("非 ok → PanelError（401→AUTH、500→PANEL_HTTP），与其余读路径同一套映射", async () => {
      const unauth = fakeFetch([{ status: 401, body: { error: "unauthorized" } }]);
      await expect(createPanelClient({ ...base, fetch: unauth.fn as any }).getEvents())
        .rejects.toMatchObject({ code: "AUTH", status: 401 });
      const boom = fakeFetch([{ status: 500, body: { error: "boom" } }]);
      await expect(createPanelClient({ ...base, fetch: boom.fn as any }).getEvents())
        .rejects.toMatchObject({ code: "PANEL_HTTP", status: 500 });
    });
  });

  describe("streamEvents", () => {
    it("snapshot 帧的 events 逐条回调、event 帧单条回调（顺序保持），打 /api/v1/events/stream 且带 Bearer 头", async () => {
      const { fn, push, calls } = sseFetch();
      const events: PanelEvent[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: (e) => events.push(e) });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(snapshotFrame([sseEvent(1), sseEvent(2)]));
      await vi.waitFor(() => expect(events).toHaveLength(2));
      push(eventFrame(sseEvent(3)));
      await vi.waitFor(() => expect(events).toHaveLength(3));
      expect(events.map((e) => e.id)).toEqual([1, 2, 3]);
      expect(calls[0]!.url).toBe("http://panel:8080/api/v1/events/stream");
      expect((calls[0]!.init.headers as any).authorization).toBe("Bearer lp_test");
    });

    it("心跳注释行不产生回调（帧内混排也只取 data）", async () => {
      const { fn, push } = sseFetch();
      const events: PanelEvent[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: (e) => events.push(e) });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(`: ping\n\n${snapshotFrame([sseEvent(1)])}`);
      await vi.waitFor(() => expect(events).toHaveLength(1));
      push(`: ping\n\n`);
      await new Promise((r) => setTimeout(r, 20));
      expect(events).toHaveLength(1);  // 心跳不喂事件
    });

    it("停止函数后一切回调静默，且幂等", async () => {
      const { fn, push } = sseFetch();
      const events: PanelEvent[] = [];
      const errors: PanelError[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      const stop = client.streamEvents({
        onEvent: (e) => events.push(e),
        onError: (err) => errors.push(err),
      });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(snapshotFrame([sseEvent(1)]));
      await vi.waitFor(() => expect(events).toHaveLength(1));
      stop();
      stop();  // 幂等：重复调用不炸、不重复副作用
      push(`${snapshotFrame([sseEvent(2)])}${eventFrame(sseEvent(3))}`);
      await new Promise((r) => setTimeout(r, 25));
      expect(events).toHaveLength(1);
      expect(errors).toHaveLength(0);  // 停止不是错误
    });

    it("非 ok 响应（401）→ onError(AUTH)，不抛异常、onEvent 不触发", async () => {
      const { fn } = sseFetch({ status: 401, body: JSON.stringify({ error: "unauthorized" }) });
      const events: PanelEvent[] = [];
      const errors: PanelError[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: (e) => events.push(e), onError: (err) => errors.push(err) });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toMatchObject({ code: "AUTH", status: 401 });
      expect(events).toHaveLength(0);
    });

    it("网络错误（建连失败）→ onError(PANEL_UNREACHABLE)，不产生未处理拒绝", async () => {
      const { fn } = sseFetch({ reject: new TypeError("fetch failed") });
      const errors: PanelError[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: () => {}, onError: (err) => errors.push(err) });
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      expect(errors[0]).toMatchObject({ code: "PANEL_UNREACHABLE" });
    });

    it("服务端正常收流（done）→ 静默退出，不触发 onError（断线重连是调用方职责）", async () => {
      const { fn, push, close } = sseFetch();
      const events: PanelEvent[] = [];
      const errors: PanelError[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: (e) => events.push(e), onError: (err) => errors.push(err) });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(snapshotFrame([sseEvent(1)]));
      await vi.waitFor(() => expect(events).toHaveLength(1));
      close();
      await new Promise((r) => setTimeout(r, 25));
      expect(errors).toHaveLength(0);
    });

    it("常驻连接不设单请求超时：绝不调 AbortSignal.timeout 掐死 SSE", async () => {
      const spy = vi.spyOn(AbortSignal, "timeout");
      const { fn, push } = sseFetch();
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ onEvent: () => {} });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(snapshotFrame([sseEvent(1)]));
      await new Promise((r) => setTimeout(r, 10));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it("外部 signal abort 后静默：fetch 收到合并 signal 且跟随 abort", async () => {
      const controller = new AbortController();
      const { fn, push, calls } = sseFetch();
      const events: PanelEvent[] = [];
      const client = createPanelClient({ ...base, fetch: fn as any });
      client.streamEvents({ signal: controller.signal, onEvent: (e) => events.push(e) });
      await vi.waitFor(() => expect(fn).toHaveBeenCalled());
      push(snapshotFrame([sseEvent(1)]));
      await vi.waitFor(() => expect(events).toHaveLength(1));
      // 不是裸透传外部 signal——与内部停止 signal 合并后交给 fetch
      const signal = calls[0]!.init.signal as AbortSignal;
      expect(signal).not.toBe(controller.signal);
      controller.abort();
      expect(signal.aborted).toBe(true);
      push(eventFrame(sseEvent(2)));
      await new Promise((r) => setTimeout(r, 25));
      expect(events).toHaveLength(1);
    });

    it("传入已 abort 的 signal：不建连（fetch 不被调用），返回的停止函数仍可调", async () => {
      const { fn } = sseFetch();
      const client = createPanelClient({ ...base, fetch: fn as any });
      const controller = new AbortController();
      controller.abort();
      const stop = client.streamEvents({ signal: controller.signal, onEvent: () => {} });
      expect(stop).toBeTypeOf("function");
      stop();
      await new Promise((r) => setTimeout(r, 10));
      expect(fn).not.toHaveBeenCalled();
    });
  });
});

describe("createSseFrameParser（SSE 帧解析纯函数）", () => {
  function collect() {
    const got: unknown[] = [];
    return { got, feed: createSseFrameParser((json) => got.push(json)) };
  }

  it("单帧：完整 data 行解析为 JSON 吐出", () => {
    const { got, feed } = collect();
    feed('data: {"type":"event","id":1,"ts":2,"kind":"model.start","message":"x"}\n\n');
    expect(got).toEqual([{ type: "event", id: 1, ts: 2, kind: "model.start", message: "x" }]);
  });

  it("一个 chunk 里多帧粘连：逐帧吐出", () => {
    const { got, feed } = collect();
    feed('data: {"a":1}\n\ndata: {"b":2}\n\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("跨 chunk 撕裂：载荷与帧分隔符断在任意位置都不丢帧、不半帧吐出", () => {
    const { got, feed } = collect();
    feed('data: {"type":"eve');
    expect(got).toHaveLength(0);  // 未凑齐：绝不吐半帧
    feed('nt"}\n');
    expect(got).toHaveLength(0);  // 分隔符撕一半（\n 到了、\n 没到）
    feed('\ndata: {"b":2}\n');
    feed('\n');
    expect(got).toEqual([{ type: "event" }, { b: 2 }]);
  });

  it("注释行（: 开头，15s 心跳）忽略；帧内注释与 data 混排只取 data", () => {
    const { got, feed } = collect();
    feed(': ping\n\n');
    feed(': keepalive\ndata: {"a":1}\n: another\n\n');
    expect(got).toEqual([{ a: 1 }]);
  });

  it("id:/event:/retry: 等非 data 行忽略；data: 后无空格也能解析", () => {
    const { got, feed } = collect();
    feed('id: 7\nevent: add\nretry: 5000\ndata:{"a":1}\n\n');
    expect(got).toEqual([{ a: 1 }]);
  });

  it("多行 data 以 \\n 拼接后作为整体 JSON 解析", () => {
    const { got, feed } = collect();
    feed('data: {"a":\ndata: 1}\n\n');
    expect(got).toEqual([{ a: 1 }]);
  });

  it("CRLF 行尾容忍，含撕裂在 \\r 与 \\n 之间", () => {
    const { got, feed } = collect();
    feed('data: {"a":1}\r\n\r\n');
    feed('data: {"b":2}\r');  // 撕裂点落在 CRLF 中间
    feed('\n\r\n');
    expect(got).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("无法 JSON 解析的载荷静默丢弃，不炸流", () => {
    const { got, feed } = collect();
    feed('data: not-json\n\n');
    feed('data: {"a":1}\n\n');
    expect(got).toEqual([{ a: 1 }]);
  });

  it("只有注释/空行、无 data 的帧不产生回调", () => {
    const { got, feed } = collect();
    feed('\n\n: only-comment\n\n\n\n');
    expect(got).toEqual([]);
  });
});
