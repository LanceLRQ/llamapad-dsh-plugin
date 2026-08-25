import { describe, expect, it, vi } from "vitest";
import { LlamapadAdapter } from "../../src/adapter";

function sseResponse(lines: string[], status = 200): Response {
  const payload = lines.map((l) => `data: ${l}\n\n`).join("");
  return new Response(new TextEncoder().encode(payload), {
    status, headers: { "content-type": "text/event-stream" },
  });
}

function makeAdapter(over: Record<string, unknown> = {}) {
  const ensure = vi.fn(async () => {});
  const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => sseResponse([
    `{"choices":[{"delta":{"content":"ok"}}]}`,
    `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
    `[DONE]`,
  ]));
  const client = { baseUrl: "http://panel:8080", listModels: async () => [], getModel: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
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

describe("LlamapadAdapter", () => {
  it("providerInfo id 等于 provider", () => {
    expect(makeAdapter().adapter.providerInfo("llamapad")).toEqual({ id: "llamapad", name: expect.any(String) });
  });

  it("listModels 映射面板模型行", async () => {
    const client = { baseUrl: "x", listModels: async () => [
      { name: "a", displayName: "模型A", namespace: "main", quant: "Q4_K_M", sizeBytes: 1, hostPort: 1, status: "stopped" },
    ], getModel: async () => null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    const models = await adapter.listModels("llamapad");
    expect(models).toEqual([{ provider: "llamapad", id: "a", name: "模型A", description: "main · Q4_K_M" }]);
  });

  it("resolveModel：overrides.server.ctx_size → context，缺省省略", async () => {
    const client = { baseUrl: "x", listModels: async () => [], getModel: async (n: string) => n === "a" ? { name: "a", displayName: "A", namespace: "main", overrides: { server: { ctx_size: 8192 } } } : null, runtimeStatus: async () => ({ running: null }), startModel: async () => {}, llamaHealth: async () => true };
    const adapter = new LlamapadAdapter({ client, gate: { ensure: async () => {}, lastStarted: () => null }, token: "t", mode: "proxy", fetchImpl: async () => null as any } as any);
    await expect(adapter.resolveModel("llamapad", "a")).resolves.toMatchObject({ context: { contextWindow: 8192 } });
    await expect(adapter.resolveModel("llamapad", "b")).resolves.not.toHaveProperty("context");
  });

  it("reasoningEffort → UNSUPPORTED（先于任何 IO）", async () => {
    const { adapter, ensure, fetchImpl } = makeAdapter();
    await expect(drain(adapter.stream(opts({ reasoningEffort: "high" })))).rejects.toMatchObject({ code: "UNSUPPORTED" });
    expect(ensure).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stream：先 ensure（透传 signal/timeout）再 POST；proxy 模式带鉴权与 UA", async () => {
    const { adapter, ensure, fetchImpl } = makeAdapter();
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
    const { adapter, fetchImpl } = makeAdapter({ mode: "direct", llamaBaseUrl: "http://gpu:18080" });
    await drain(adapter.stream(opts()));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://gpu:18080/v1/chat/completions");
    expect((init!.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it("非 2xx → LlmError PROVIDER_HTTP_ERROR（带 status）", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([`{}`], 502));
    const { adapter } = makeAdapter({ fetchImpl });
    await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "PROVIDER_HTTP_ERROR", failure: { status: 502 } });
  });

  it("EnsureError → LlmError 同码；signal 已 abort → AbortError", async () => {
    const ensure = vi.fn(async () => { throw Object.assign(new Error("等待 a 就绪超时"), { code: "START_TIMEOUT", name: "EnsureError" }); });
    const { adapter } = makeAdapter({ gate: { ensure, lastStarted: () => null } });
    await expect(drain(adapter.stream(opts()))).rejects.toMatchObject({ code: "START_TIMEOUT" });

    const controller = new AbortController(); controller.abort();
    const ensure2 = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "ABORTED", name: "EnsureError" }); });
    const { adapter: a2 } = makeAdapter({ gate: { ensure: ensure2, lastStarted: () => null } });
    const caught = await drain(a2.stream(opts({ signal: controller.signal }))).then(
      () => { throw new Error("应当抛出 AbortError"); },
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe("AbortError");
  });
});
