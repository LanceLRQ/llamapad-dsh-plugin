# llamapad-dsh-plugin A 形态（LLM 适配器）实施计划

> **For Claude:** 使用 executing-plans 模式逐任务实施本计划；本项目约定为 subagent 驱动（每任务派发
> 实现 subagent，主会话审查后提交）。

**Goal:** 为 DeepSeek Harness（dsh）实现 `llamapad` provider 的 LLM 适配器插件——dsh 里按模型名选择
llamapad 管的本地模型，适配器自动「停旧起新 + 等就绪 + 转发推理流量」，llamapad 侧零改动。

**Architecture:** 控制面（列模型/启停/状态/就绪探测）走 llamapad REST API（Bearer lp_ token）；数据面
（/v1/chat/completions SSE）双模式——`proxy` 走面板反代（默认，llama.cpp 端口不暴露）或 `direct` 直连
llama.cpp。核心分层：panel-client（REST 封装）→ switching（串行门 + 就绪轮询）→ openai-wire（请求
构造）/ translate（SSE→StreamChunk 翻译）→ adapter（LlmAdapter 组装）→ index（插件入口）。
**等待期不注入提示文本**（会成为历史上下文，调研见 docs/research）；不做空闲停（用户边界：只连接与调度）。

**Tech Stack:** TypeScript（ESM 源码即插件，dev 期 dsh 以绝对路径加载 TS，无需构建）、Vitest、
`@deepseek-ai/cordis@4.0.1` / `@deepseek-ai/dsh-llm@0.0.1-rc.1` / `@deepseek-ai/schemastery@3.18.1`
（**全部钉精确版本**——dsh 是 v0.1 技术预览）。

**环境约束（每个任务都适用）：**
- 所有 npm/网络命令先导出代理：`export HTTP_PROXY=http://127.0.0.1:20171 HTTPS_PROXY=http://127.0.0.1:20171 NO_PROXY=localhost,127.0.0.1`
- 提交信息：中文 Conventional Commits，一任务一提交
- 契约核对源：`node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts`（真实类型以包为准，文档可能滞后）
- llamapad API 参照：`/Volumes/Data/github/projects/llamapad/src/app/api/v1/`（只读参照，不改它）

---

## Task 0: 仓库脚手架

**Files:** Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `vitest.e2e.config.ts`, `src/.gitkeep`, `test/unit/.gitkeep`, `test/e2e/.gitkeep`

**Step 1: 写 package.json**

```json
{
  "name": "llamapad-dsh-plugin",
  "version": "0.0.1",
  "private": true,
  "type": "module",
  "description": "DeepSeek Harness LLM adapter plugin backed by llamapad-managed llama.cpp containers",
  "scripts": {
    "test": "vitest run",
    "test:e2e": "vitest run --config vitest.e2e.config.ts",
    "typecheck": "tsc --noEmit"
  }
}
```

**Step 2: 写 tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": false,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts", "vitest.e2e.config.ts"]
}
```

**Step 3: 写 vitest.config.ts / vitest.e2e.config.ts**

```ts
// vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/unit/**/*.test.ts"], environment: "node", testTimeout: 10_000 },
});

// vitest.e2e.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { include: ["test/e2e/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 10_000 },
});
```

**Step 4: 安装依赖（带代理）**

```bash
export HTTP_PROXY=http://127.0.0.1:20171 HTTPS_PROXY=http://127.0.0.1:20171 NO_PROXY=localhost,127.0.0.1
npm install --save-exact @deepseek-ai/cordis@4.0.1 @deepseek-ai/dsh-llm@0.0.1-rc.1 @deepseek-ai/schemastery@3.18.1
npm install --save-dev typescript vitest @types/node
```

Expected: package.json 出现 dependencies（三个精确版本）与 devDependencies。

**Step 5: 验证空测试可跑**

Run: `npm test` → Expected: `No test files found`（退出码非零属正常，脚手架阶段）

**Step 6: Commit** `chore: 脚手架（依赖钉版本 + vitest 双配置）`

---

## Task 1: panel-client（控制面 REST 封装）

**Files:** Create: `src/panel-client.ts`, Test: `test/unit/panel-client.test.ts`

**Step 1: 写失败测试**

```ts
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
```

**Step 2: 跑测试确认失败** — `npm test` → FAIL（模块不存在）

**Step 3: 实现 src/panel-client.ts**

```ts
/**
 * llamapad 面板控制面 REST 客户端（列模型 / 启停 / 状态 / 就绪探测）。
 * 推理数据面不走这里（见 adapter.ts 的 proxy/direct 双模式）。
 * 失败一律抛 PanelError，code 为稳定机器码：
 * AUTH | MODEL_NOT_FOUND | MODEL_FILES_MISSING | PANEL_HTTP | PANEL_UNREACHABLE
 */

export interface PanelClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class PanelError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "PanelError";
  }
}

/** GET /api/v1/models 行（llamapad ModelView 的插件侧投影） */
export interface PanelModelView {
  name: string; displayName: string; namespace: string;
  quant: string | null; sizeBytes: number; hostPort: number; status: string;
}

export interface PanelModelDetail {
  name: string; displayName: string; namespace: string; overrides?: unknown;
}

export interface PanelRuntimeStatus {
  running: { model: string; displayName?: string; hostPort?: number } | null;
}

export interface PanelClient {
  readonly baseUrl: string;
  listModels(): Promise<PanelModelView[]>;
  getModel(name: string): Promise<PanelModelDetail | null>;
  runtimeStatus(): Promise<PanelRuntimeStatus>;
  startModel(name: string): Promise<void>;
  llamaHealth(): Promise<boolean>;
}

export function createPanelClient(options: PanelClientOptions): PanelClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new PanelError(`llamapad 面板不可达: ${base}`, "PANEL_UNREACHABLE");
    }
  }

  async function readError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string };
      return body.error ?? res.statusText;
    } catch {
      return res.statusText;
    }
  }

  function codeFor(res: Response): string {
    return res.status === 401 ? "AUTH" : "PANEL_HTTP";
  }

  return {
    baseUrl: base,
    async listModels() {
      const res = await request("/api/v1/models");
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      const body = (await res.json()) as { models: PanelModelView[] };
      return body.models;
    },
    async getModel(name) {
      const res = await request(`/api/v1/models/${encodeURIComponent(name)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return (await res.json()) as PanelModelDetail;
    },
    async runtimeStatus() {
      const res = await request("/api/v1/runtime/status");
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return (await res.json()) as PanelRuntimeStatus;
    },
    async startModel(name) {
      const res = await request(`/api/v1/models/${encodeURIComponent(name)}/start`, { method: "POST" });
      if (res.ok) return;
      if (res.status === 404) throw new PanelError(`模型不存在: ${name}`, "MODEL_NOT_FOUND", 404);
      if (res.status === 422) throw new PanelError(await readError(res), "MODEL_FILES_MISSING", 422);
      if (res.status === 401) throw new PanelError("llamapad token 无效或未授权", "AUTH", 401);
      throw new PanelError(`启动失败: ${await readError(res)}`, "PANEL_HTTP", res.status);
    },
    async llamaHealth() {
      try {
        const res = await doFetch(`${base}/api/v1/proxy/llama/health`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
```

**Step 4: 跑测试确认通过** — `npm test` → PASS（7 例）

**Step 5: Commit** `feat: llamapad 控制面 REST 客户端（鉴权/错误码映射/健康探测）`

---

## Task 2: switching（切换串行门 + 就绪轮询）

**Files:** Create: `src/switching.ts`, Test: `test/unit/switching.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { createModelGate, EnsureError } from "../../src/switching";
import type { PanelClient } from "../../src/panel-client";

function fakeClient(overrides: Partial<PanelClient> = {}): PanelClient & {
  starts: string[]; setRunning: (m: string | null) => void; setHealthy: (b: boolean) => void;
} {
  let running: string | null = null;
  let healthy = true;
  const starts: string[] = [];
  const client = {
    baseUrl: "http://panel",
    starts,
    setRunning: (m: string | null) => { running = m; },
    setHealthy: (b: boolean) => { healthy = b; },
    listModels: async () => [],
    getModel: async () => null,
    runtimeStatus: async () => ({ running: running ? { model: running } : null }),
    startModel: async (name: string) => { starts.push(name); running = name; },
    llamaHealth: async () => healthy,
    ...overrides,
  } as any;
  return client;
}

describe("createModelGate", () => {
  it("快路径：目标已在跑 → 不调 startModel", async () => {
    const client = fakeClient(); client.setRunning("a");
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual([]);
  });

  it("冷启动：未运行 → start + 健康即通过", async () => {
    const client = fakeClient();
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual(["a"]);
  });

  it("切换：跑着别的 → start 目标（停旧由 llamapad 语义负责）", async () => {
    const client = fakeClient(); client.setRunning("b");
    await createModelGate(client).ensure("a");
    expect(client.starts).toEqual(["a"]);
  });

  it("超时：健康一直 false → START_TIMEOUT", async () => {
    const client = fakeClient(); client.setHealthy(false);
    await expect(
      createModelGate(client).ensure("a", { timeoutMs: 30, pollIntervalMs: 10 }),
    ).rejects.toMatchObject({ code: "START_TIMEOUT" });
  });

  it("取消：轮询中 abort → ABORTED", async () => {
    const client = fakeClient(); client.setHealthy(false);
    const controller = new AbortController();
    const gate = createModelGate(client);
    const p = gate.ensure("a", { timeoutMs: 5_000, pollIntervalMs: 1_000 });
    setTimeout(() => controller.abort(), 20);
    await expect(gate.ensure("a", { signal: controller.signal, timeoutMs: 5_000, pollIntervalMs: 50 })).rejects.toMatchObject({ code: "ABORTED" });
    p.catch(() => {});
  });

  it("串行：不同模型的 ensure 排队执行，顺序不交叉", async () => {
    const client = fakeClient();
    const order: string[] = [];
    const slow = async (name: string) => { order.push(`start:${name}`); await new Promise(r => setTimeout(r, 30)); client.setRunning(name); order.push(`done:${name}`); };
    (client as any).startModel = async (n: string) => { starts_push(client.starts, n); await slow(n); };
    const gate = createModelGate(client);
    await Promise.all([gate.ensure("a"), gate.ensure("b")]);
    expect(order).toEqual(["start:a", "done:a", "start:b", "done:b"]);
    expect(client.starts).toEqual(["a", "b"]);
  });

  it("合流：同模型并发 ensure 只 start 一次", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    await Promise.all([gate.ensure("a"), gate.ensure("a"), gate.ensure("a")]);
    expect(client.starts).toEqual(["a"]);
  });

  it("前序失败不阻断后续排队者", async () => {
    const client = fakeClient();
    let calls = 0;
    (client as any).startModel = async (n: string) => { calls++; if (calls === 1) { starts_push(client.starts, n); throw new PanelLikeError("模型不存在: a", "MODEL_NOT_FOUND"); } starts_push(client.starts, n); client.setRunning(n); };
    const gate = createModelGate(client);
    await expect(gate.ensure("a")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
    await expect(gate.ensure("b")).resolves.toBeUndefined();
  });
});

// 测试内小工具
class PanelLikeError extends Error { constructor(message: string, readonly code: string) { super(message); } }
function starts_push(arr: string[], v: string) { arr.push(v); }
```

**Step 2: 跑测试确认失败** — `npm test` → FAIL

**Step 3: 实现 src/switching.ts**

```ts
import type { PanelClient } from "./panel-client";

/**
 * 切换门：把「确保某模型在跑」收敛为进程内串行队列。
 * - llamapad 是单模型运行时：start 自带停旧起新，这里不感知旧模型
 * - 同目标并发 ensure 合流到进行中的那一次（两把请求只触发一次 start）
 * - 前序失败不阻断后续排队者（tail 永远吞错续链）
 * - abort 只取消「等待就绪」，已发出的 start 不撤回（服务端语义如此，见调研文档）
 */

export type EnsureErrorCode =
  | "MODEL_NOT_FOUND" | "MODEL_FILES_MISSING" | "AUTH" | "PANEL_UNREACHABLE" | "START_TIMEOUT" | "ABORTED";

export class EnsureError extends Error {
  constructor(message: string, readonly code: EnsureErrorCode) { super(message); this.name = "EnsureError"; }
}

export interface EnsureOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface ModelGate {
  ensure(model: string, options?: EnsureOptions): Promise<void>;
  lastStarted(): string | null;
}

export function createModelGate(client: PanelClient): ModelGate {
  let tail: Promise<void> = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();
  let last: string | null = null;

  async function ensureOnce(model: string, options: EnsureOptions): Promise<void> {
    const status = await client.runtimeStatus();
    if (status.running?.model === model) return;
    try {
      await client.startModel(model);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === "MODEL_NOT_FOUND" || code === "MODEL_FILES_MISSING" || code === "AUTH") {
        throw new EnsureError((error as Error).message, code);
      }
      if (code === "PANEL_UNREACHABLE" || code === "PANEL_HTTP") {
        throw new EnsureError((error as Error).message, "PANEL_UNREACHABLE");
      }
      throw error;
    }
    last = model;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollMs = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) throw new EnsureError(`等待 ${model} 就绪时被取消`, "ABORTED");
      if (await client.llamaHealth()) return;
      if (Date.now() + pollMs > deadline) throw new EnsureError(`等待 ${model} 就绪超时（${timeoutMs}ms）`, "START_TIMEOUT");
      await sleep(pollMs, options.signal);
    }
  }

  function sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(done, ms);
      function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
      function onAbort() { clearTimeout(timer); reject(new EnsureError("切换等待被取消", "ABORTED")); }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  return {
    ensure(model, options = {}) {
      const existing = inflight.get(model);
      if (existing) return existing;  // 合流：跟随首个发起者的超时/信号（文档化取舍）
      const run = tail.then(() => ensureOnce(model, options));
      tail = run.then(() => undefined, () => undefined);
      const tracked = run.finally(() => { if (inflight.get(model) === tracked) inflight.delete(model); });
      inflight.set(model, tracked);
      return tracked;
    },
    lastStarted: () => last,
  };
}
```

**Step 4: 跑测试确认通过** — `npm test` → PASS

**Step 5: Commit** `feat: 模型切换门（串行队列 + 同目标合流 + 就绪轮询/超时/取消）`

---

## Task 3: openai-wire（GenerateOptions → OpenAI 请求体）

**Files:** Create: `src/openai-wire.ts`, Test: `test/unit/openai-wire.test.ts`

**Step 0: 先核对真实类型（必做）**

打开 `node_modules/@deepseek-ai/dsh-llm/lib/types/content.d.ts` 与 `types.d.ts`，确认
`ToolResultBlock`（工具结果块的字段名——预期形如 `callId` + 内容）与 `ToolSchema`（预期
`{ name, description, parameters }`）。下方映射代码按预期形状写，**若字段名不同以包为准调整**
并在提交信息里注明。

**Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { buildChatBody } from "../../src/openai-wire";
import { CallId } from "@deepseek-ai/dsh-llm";

function msg(role: any, content: any[], id = "m1"): any {
  return { id, role, content, source: {} };
}

describe("buildChatBody", () => {
  it("system 提示置于首位；user 文本合入 content", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a", system: "你是助手",
      messages: [msg("user", [{ type: "text", text: "你好" }])],
    } as any);
    expect(body.model).toBe("a");
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body.messages).toEqual([
      { role: "system", content: "你是助手" },
      { role: "user", content: "你好" },
    ]);
  });

  it("assistant 的 text + tool-call 块 → content + tool_calls；reasoning 块不回传", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("assistant", [
        { type: "reasoning", text: "思考…" },
        { type: "text", text: "我查一下" },
        { type: "tool-call", id: CallId("call_1"), name: "get_weather", arguments: '{"city":"北京"}' },
      ])],
    } as any);
    const assistant = body.messages[0];
    expect(assistant.role).toBe("assistant");
    expect(assistant.content).toBe("我查一下");
    expect(assistant.tool_calls).toEqual([
      { id: "call_1", type: "function", function: { name: "get_weather", arguments: '{"city":"北京"}' } },
    ]);
  });

  it("user 消息里的 tool-result 块拆成 role:tool（OpenAI 形态）", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "tool-result", callId: CallId("call_1"), content: "晴，25 度" }])],
    } as any);
    expect(body.messages).toEqual([
      { role: "tool", tool_call_id: "call_1", content: "晴，25 度" },
    ]);
  });

  it("可选参数透传：temperature/maxTokens/stop/tools", () => {
    const body = buildChatBody({
      provider: "llamapad", model: "a",
      messages: [msg("user", [{ type: "text", text: "hi" }])],
      temperature: 0.2, maxTokens: 512, stop: ["\n\n"],
      tools: [{ name: "t", description: "d", parameters: { type: "object", properties: {} } }] as any,
    } as any);
    expect(body.temperature).toBe(0.2);
    expect(body.max_tokens).toBe(512);
    expect(body.stop).toEqual(["\n\n"]);
    expect(body.tools).toEqual([{ type: "function", function: { name: "t", description: "d", parameters: { type: "object", properties: {} } } }]);
  });

  it("未提供的可选字段不出现", () => {
    const body = buildChatBody({ provider: "llamapad", model: "a", messages: [] } as any);
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("stop");
  });
});
```

**Step 2: 跑测试确认失败**

**Step 3: 实现 src/openai-wire.ts**

```ts
import type { GenerateOptions } from "@deepseek-ai/dsh-llm";

/**
 * dsh GenerateOptions → llama.cpp（OpenAI 兼容）chat/completions 请求体。
 * 决策记录：assistant 历史里的 reasoning 块不回传（llama.cpp 推理内容不进后续请求）。
 */

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

export function buildChatBody(options: GenerateOptions): Record<string, unknown> {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) messages.push(...mapMessage(message));
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop && options.stop.length > 0) body.stop = options.stop;
  return body;
}

function mapMessage(message: GenerateOptions["messages"][number]): OpenAiMessage[] {
  if (message.role === "system") {
    return [{ role: "system", content: message.content.filter(isText).map((b) => b.text).join("") }];
  }
  if (message.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    for (const block of message.content) {
      if (isText(block)) textParts.push(block.text);
      else if (block.type === "tool-call") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
      }
      // reasoning 块：跳过（见文件头决策）
    }
    return [{ role: "assistant", content: textParts.join("") || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
  }
  // user：text 块合入一条 user；tool-result 块各拆一条 role:"tool"（字段名以 content.d.ts 核对为准）
  const out: OpenAiMessage[] = [];
  const textParts: string[] = [];
  for (const block of message.content as Array<any>) {
    if (isText(block)) textParts.push(block.text);
    else if (block.type === "tool-result") {
      out.push({ role: "tool", tool_call_id: String(block.callId), content: renderToolResult(block) });
    }
  }
  if (textParts.length > 0) out.unshift({ role: "user", content: textParts.join("") });
  return out;
}

function isText(block: any): block is { type: "text"; text: string } {
  return block.type === "text";
}

function renderToolResult(block: any): string {
  // ToolResultBlock 内容形态以 content.d.ts 为准：字符串直接用，块数组拼文本
  if (typeof block.content === "string") return block.content;
  if (Array.isArray(block.content)) {
    return block.content.filter((b: any) => b?.type === "text").map((b: any) => b.text).join("");
  }
  return "";
}
```

**Step 4: 跑测试确认通过**（若 Step 0 发现字段名差异，同步修测试与实现）

**Step 5: Commit** `feat: GenerateOptions 到 OpenAI 请求体的构造（消息/工具/参数映射）`

---

## Task 4: translate（OpenAI SSE → StreamChunk 翻译）

**Files:** Create: `src/translate.ts`, Test: `test/unit/translate.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it } from "vitest";
import { translateOpenAiSse } from "../../src/translate";
import { isHarnessError } from "@deepseek-ai/dsh-llm";

function sseStream(lines: string[], splitAt: number[] = []): ReadableStream<Uint8Array> {
  // splitAt：模拟网络分帧（把整体 buffer 在给定偏移处切开推送）
  const payload = lines.map((l) => `data: ${l}\n\n`).join("");
  const cuts = [0, ...splitAt, payload.length].sort((a, b) => a - b);
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= cuts.length - 1) { controller.close(); return; }
      controller.enqueue(encoder.encode(payload.slice(cuts[i]!, cuts[i + 1]!));
      i++;
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>) {
  const chunks = [];
  for await (const c of translateOpenAiSse(stream)) chunks.push(c);
  return chunks;
}

describe("translateOpenAiSse", () => {
  it("纯文本：start/delta/end/finish 且 block-end 带全文", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"你"}}]}`,
      `{"choices":[{"delta":{"content":"好"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `{"usage":{"prompt_tokens":3,"completion_tokens":2}}`,
      `[DONE]`,
    ]));
    expect(chunks.map((c) => c.type)).toEqual(["block-start", "text-delta", "text-delta", "block-end", "usage", "finish"]);
    expect(chunks[3]).toMatchObject({ block: { type: "text", text: "你好" } });
    expect(chunks[4]).toMatchObject({ usage: { inputTokens: 3, outputTokens: 2 } });
    expect(chunks[5]).toMatchObject({ reason: { kind: "stop" } });
  });

  it("reasoning_content → reasoning 块；index 按首现递增", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"reasoning_content":"想"}}]}`,
      `{"choices":[{"delta":{"reasoning_content":"想2"}}]}`,
      `{"choices":[{"delta":{"content":"答"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
      `[DONE]`,
    ]));
    expect(chunks[0]).toMatchObject({ type: "block-start", index: 0, blockType: "reasoning" });
    expect(chunks[3]).toMatchObject({ type: "block-start", index: 1, blockType: "text" });
    const ends = chunks.filter((c) => c.type === "block-end");
    expect(ends[0]).toMatchObject({ index: 0, block: { type: "reasoning", text: "想想2" } });
    expect(ends[1]).toMatchObject({ index: 1, block: { type: "text", text: "答" } });
  });

  it("工具调用：跨帧 arguments 增量拼接，finish 为 tool-calls", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":"}}]}}]}`,
      `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"北京\\"}"}}]}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
      `[DONE]`,
    ]));
    const deltas = chunks.filter((c) => c.type === "tool-call-delta");
    expect(deltas[0]).toMatchObject({ index: 0, id: "call_1", name: "get_weather", argumentsDelta: "" });
    expect(deltas[1]!.argumentsDelta).toBe('{"city":');
    const end = chunks.find((c) => c.type === "block-end")!;
    expect(end.block).toEqual({ type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"北京"}' });
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: "tool-calls" } });
  });

  it("finish_reason length → max-tokens", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"x"}}]}`,
      `{"choices":[{"delta":{},"finish_reason":"length"}]}`,
      `[DONE]`,
    ]));
    expect(chunks.at(-1)).toMatchObject({ reason: { kind: "max-tokens" } });
  });

  it("error 帧 → throw LlmError(PROVIDER_HTTP_ERROR)", async () => {
    const stream = sseStream([`{"error":{"message":"model unloaded"}}`, `[DONE]`]);
    await expect(collect(stream)).rejects.toSatisfy((e: any) => isHarnessError(e) && e.code === "PROVIDER_HTTP_ERROR");
  });

  it("空响应（无任何内容块）→ EMPTY_RESPONSE", async () => {
    const stream = sseStream([`{"choices":[{"delta":{},"finish_reason":"stop"}]}`, `[DONE]`]);
    await expect(collect(stream)).rejects.toSatisfy((e: any) => isHarnessError(e) && e.code === "EMPTY_RESPONSE");
  });

  it("缺 [DONE]（流直接结束）也有完整收尾", async () => {
    const chunks = await collect(sseStream([`{"choices":[{"delta":{"content":"hi"}}]}`]));
    expect(chunks.map((c) => c.type)).toEqual(["block-start", "text-delta", "block-end", "finish"]);
  });

  it("网络分帧切割 JSON 帧也能拼回", async () => {
    const chunks = await collect(sseStream([
      `{"choices":[{"delta":{"content":"分帧"}}]}`,
      `[DONE]`,
    ], [12, 25]));
    expect(chunks.some((c) => c.type === "text-delta" && c.text === "分帧")).toBe(true);
    expect(chunks.at(-1)!.type).toBe("finish");
  });
});
```

**Step 2: 跑测试确认失败**

**Step 3: 实现 src/translate.ts**

```ts
import { CallId, LlmError, EMPTY_RESPONSE_CODE } from "@deepseek-ai/dsh-llm";
import type { ContentBlock, StreamChunk, TokenUsage } from "@deepseek-ai/dsh-llm";

/**
 * llama.cpp（OpenAI 兼容）流式响应 → dsh StreamChunk。
 * 协议义务（cookbook 陷阱清单）：usage 在 finish 前且其后无块；block-start/end 配对；
 * index 按流中首现分配；tool-call 的 arguments 全程保持原始 JSON 字符串。
 * 错误统一走 throw LlmError（运行时会归一化为终态 error finish）。
 * 注：llama.cpp 的 prompt_tokens 含缓存命中，无法按 DISJOINT 语义拆 cacheRead——M4 真机校准。
 */

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string | null;
      reasoning_content?: string | null;
      tool_calls?: Array<{ index: number; id?: string; type?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
  error?: { message?: string; type?: string } | string;
}

export async function* translateOpenAiSse(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = 0;
  let textIndex: number | null = null;
  let reasoningIndex: number | null = null;
  const textParts: string[] = [];
  const reasoningParts: string[] = [];
  const openBlocks: Array<{ index: number; kind: "text" | "reasoning" | "tool-call" }> = [];
  const openAiToolToBlock = new Map<number, number>();
  const toolAcc = new Map<number, { id: string; name: string; args: string }>();
  let finishKind: "stop" | "tool-calls" | "max-tokens" = "stop";
  let usage: TokenUsage | null = null;

  function* handleChunk(chunk: OpenAiStreamChunk): Generator<StreamChunk> {
    if (chunk.error !== undefined) {
      const message = typeof chunk.error === "string" ? chunk.error : chunk.error.message ?? "未知错误";
      throw new LlmError(`llama.cpp 流内错误: ${message}`, "PROVIDER_HTTP_ERROR");
    }
    if (chunk.usage) {
      usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
    }
    const choice = chunk.choices?.[0];
    if (!choice) return;
    if (choice.finish_reason) {
      finishKind = choice.finish_reason === "tool_calls" ? "tool-calls"
        : choice.finish_reason === "length" ? "max-tokens" : "stop";
    }
    const delta = choice.delta ?? {};
    if (typeof delta.content === "string" && delta.content !== "") {
      if (textIndex === null) {
        textIndex = nextIndex++;
        openBlocks.push({ index: textIndex, kind: "text" });
        yield { type: "block-start", index: textIndex, blockType: "text" };
      }
      textParts.push(delta.content);
      yield { type: "text-delta", index: textIndex, text: delta.content };
    }
    if (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "") {
      if (reasoningIndex === null) {
        reasoningIndex = nextIndex++;
        openBlocks.push({ index: reasoningIndex, kind: "reasoning" });
        yield { type: "block-start", index: reasoningIndex, blockType: "reasoning" };
      }
      reasoningParts.push(delta.reasoning_content);
      yield { type: "reasoning-delta", index: reasoningIndex, text: delta.reasoning_content };
    }
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        let blockIdx = openAiToolToBlock.get(tc.index);
        if (blockIdx === undefined) {
          blockIdx = nextIndex++;
          openAiToolToBlock.set(tc.index, blockIdx);
          toolAcc.set(blockIdx, { id: tc.id ?? `call-${blockIdx}`, name: tc.function?.name ?? "", args: "" });
          openBlocks.push({ index: blockIdx, kind: "tool-call" });
          yield { type: "block-start", index: blockIdx, blockType: "tool-call" };
        }
        const acc = toolAcc.get(blockIdx)!;
        if (tc.id) acc.id = tc.id;
        if (tc.function?.name && !acc.name) acc.name = tc.function.name;
        const argsDelta = tc.function?.arguments ?? "";
        if (argsDelta !== "") acc.args += argsDelta;
        yield { type: "tool-call-delta", index: blockIdx, id: CallId(acc.id), name: acc.name, argumentsDelta: argsDelta };
      }
    }
  }

  function* emitTail(): Generator<StreamChunk> {
    if (openBlocks.length === 0) {
      throw new LlmError("llama.cpp 返回了空响应（无任何内容块）", EMPTY_RESPONSE_CODE);
    }
    for (const b of openBlocks) {
      const block: ContentBlock = b.kind === "text"
        ? { type: "text", text: textParts.join("") }
        : b.kind === "reasoning"
          ? { type: "reasoning", text: reasoningParts.join("") }
          : (() => {
              const acc = toolAcc.get(b.index)!;
              return { type: "tool-call", id: CallId(acc.id), name: acc.name, arguments: acc.args };
            })();
      yield { type: "block-end", index: b.index, block };
    }
    if (usage) yield { type: "usage", usage };
    yield { type: "finish", reason: { kind: finishKind } };
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.indexOf("\n\n")) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        for (const line of rawEvent.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (data === "") continue;
          if (data === "[DONE]") {
            yield* emitTail();
            return;
          }
          let parsed: OpenAiStreamChunk;
          try {
            parsed = JSON.parse(data) as OpenAiStreamChunk;
          } catch {
            throw new LlmError(`无法解析 SSE 数据帧: ${data.slice(0, 120)}`, "PROVIDER_PROTOCOL");
          }
          yield* handleChunk(parsed);
        }
      }
    }
    yield* emitTail();  // 防御：流结束但没有 [DONE]
  } finally {
    reader.releaseLock();
  }
}
```

**Step 4: 跑测试确认通过** — `npm test` → PASS

**Step 5: Commit** `feat: OpenAI SSE 到 StreamChunk 的翻译层（文本/推理/工具/用量/错误路径）`

---

## Task 5: adapter（LlamapadAdapter 组装）

**Files:** Create: `src/adapter.ts`, Test: `test/unit/adapter.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { LlamapadAdapter } from "../../src/adapter";
import { isHarnessError } from "@deepseek-ai/dsh-llm";

function sseResponse(lines: string[], status = 200): Response {
  const payload = lines.map((l) => `data: ${l}\n\n`).join("");
  return new Response(new TextEncoder().encode(payload), {
    status, headers: { "content-type": "text/event-stream" },
  });
}

function makeAdapter(over: Record<string, unknown> = {}) {
  const ensure = vi.fn(async () => {});
  const fetchImpl = vi.fn(async () => sseResponse([
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
    await expect(async () => {
      for await (const _ of adapter.stream(opts({ reasoningEffort: "high" as any }))) { /* drain */ }
    }).rejects.toSatisfy((e: any) => isHarnessError(e) && e.code === "UNSUPPORTED");
    expect(ensure).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("stream：先 ensure（透传 signal/timeout）再 POST；proxy 模式带鉴权与 UA", async () => {
    const { adapter, ensure, fetchImpl } = makeAdapter();
    const signal = new AbortController().signal;
    const chunks = [];
    for await (const c of adapter.stream(opts({ signal }))) chunks.push(c);
    expect(ensure).toHaveBeenCalledWith("a", expect.objectContaining({ signal }));
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://panel:8080/api/v1/proxy/llama/v1/chat/completions");
    expect((init.headers as any).authorization).toBe("Bearer lp_t");
    expect(String((init.headers as any)["user-agent"])).toContain("/");
    expect(JSON.parse(init.body).model).toBe("a");
    expect(chunks.at(-1)).toMatchObject({ type: "finish", reason: { kind: "stop" } });
  });

  it("direct 模式：URL 直连 llama.cpp 且不带面板鉴权头", async () => {
    const { adapter, fetchImpl } = makeAdapter({ mode: "direct", llamaBaseUrl: "http://gpu:18080" });
    const it = adapter.stream(opts());
    await it.next(); await it.return?.(undefined as any);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://gpu:18080/v1/chat/completions");
    expect((init.headers as any).authorization).toBeUndefined();
  });

  it("非 2xx → LlmError PROVIDER_HTTP_ERROR（带 status）", async () => {
    const fetchImpl = vi.fn(async () => sseResponse([`{}`], 502));
    const { adapter } = makeAdapter({ fetchImpl });
    await expect(async () => {
      for await (const _ of adapter.stream(opts())) { /* drain */ }
    }).rejects.toSatisfy((e: any) => isHarnessError(e) && e.code === "PROVIDER_HTTP_ERROR" && e.failure?.status === 502);
  });

  it("EnsureError → LlmError 同码；signal 已 abort → AbortError", async () => {
    const ensure = vi.fn(async () => { throw Object.assign(new Error("等待 a 就绪超时"), { code: "START_TIMEOUT", name: "EnsureError" }); });
    const { adapter } = makeAdapter({ gate: { ensure, lastStarted: () => null } });
    await expect(async () => {
      for await (const _ of adapter.stream(opts())) { /* drain */ }
    }).rejects.toSatisfy((e: any) => isHarnessError(e) && e.code === "START_TIMEOUT");

    const controller = new AbortController(); controller.abort();
    const ensure2 = vi.fn(async () => { throw Object.assign(new Error("x"), { code: "ABORTED", name: "EnsureError" }); });
    const { adapter: a2 } = makeAdapter({ gate: { ensure: ensure2, lastStarted: () => null } });
    await expect(async () => {
      for await (const _ of a2.stream(opts({ signal: controller.signal }))) { /* drain */ }
    }).rejects.toSatisfy((e: any) => e instanceof DOMException && e.name === "AbortError");
  });
});
```

**Step 2: 跑测试确认失败**

**Step 3: 实现 src/adapter.ts**

```ts
import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { PanelClient } from "./panel-client";
import type { ModelGate } from "./switching";
import { buildChatBody } from "./openai-wire";
import { translateOpenAiSse } from "./translate";

export interface LlamapadAdapterOptions {
  client: PanelClient;
  gate: ModelGate;
  token: string;
  mode: "proxy" | "direct";
  llamaBaseUrl?: string;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  defaultContextWindow?: number;
  fetchImpl?: typeof fetch;
}

export class LlamapadAdapter extends LlmAdapter {
  constructor(private readonly options: LlamapadAdapterOptions) { super(); }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "llamapad 本地模型" };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.options.client.listModels();
    return models.map((m) => ({
      provider,
      id: m.name,
      name: m.displayName || m.name,
      description: `${m.namespace}${m.quant ? ` · ${m.quant}` : ""}`,
    }));
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const detail = await this.options.client.getModel(model).catch(() => null);
    const contextWindow = readCtxSize(detail?.overrides) ?? this.options.defaultContextWindow;
    return {
      provider,
      id: model,
      name: detail?.displayName || model,
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
      // reasoning 刻意省略：llama.cpp 无 reasoning-effort 控制（契约：省略 = 无此能力）
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined) {
      throw new LlmError("llamapad/llama.cpp 不支持 reasoning effort 控制", "UNSUPPORTED");
    }
    try {
      await this.options.gate.ensure(options.model, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.options.startTimeoutMs !== undefined ? { timeoutMs: this.options.startTimeoutMs } : {}),
        ...(this.options.pollIntervalMs !== undefined ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
      });
    } catch (error) {
      throw mapEnsureError(error, options.signal?.aborted === true);
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = this.options.mode === "direct"
      ? `${this.options.llamaBaseUrl}/v1/chat/completions`
      : `${this.options.client.baseUrl}/api/v1/proxy/llama/v1/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json", ...attributionHeaders() };
    if (this.options.mode === "proxy") headers.authorization = `Bearer ${this.options.token}`;
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildChatBody(options)),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        `llama.cpp 请求失败: ${response.status} ${text.slice(0, 200)}`,
        response.status === 401 ? "AUTH" : "PROVIDER_HTTP_ERROR",
        { status: response.status },
      );
    }
    yield* translateOpenAiSse(response.body);
  }
}

function mapEnsureError(error: unknown, signalAborted: boolean): Error {
  if (signalAborted) return new DOMException("切换等待被取消", "AbortError");  // 运行时据此归类 aborted
  const code = (error as { code?: string }).code;
  if (code === "MODEL_NOT_FOUND" || code === "MODEL_FILES_MISSING" || code === "AUTH"
    || code === "PANEL_UNREACHABLE" || code === "START_TIMEOUT" || code === "ABORTED") {
    return new LlmError((error as Error).message, code);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readCtxSize(overrides: unknown): number | undefined {
  // llamapad overrides JSON：{ server?: { ctx_size?: number }, docker?: {...} }
  if (overrides === null || typeof overrides !== "object") return undefined;
  const server = (overrides as { server?: { ctx_size?: unknown } }).server;
  if (server === null || typeof server !== "object") return undefined;
  const ctx = (server as { ctx_size?: unknown }).ctx_size;
  return typeof ctx === "number" && ctx > 0 ? ctx : undefined;
}
```

**Step 4: 跑测试 + typecheck** — `npm test && npm run typecheck` → PASS

**Step 5: Commit** `feat: LlamapadAdapter（ensure→转发→翻译组装，UNSUPPORTED/错误映射）`

---

## Task 6: 插件入口（apply + Config + 注册）

**Files:** Create: `src/index.ts`, `examples/cordis.yml`, Test: `test/unit/index.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { apply, Config, name, inject } from "../../src/index";

function fakeCtx() {
  return { llm: { registerAdapter: vi.fn() } } as any;
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

  it("Config 默认值", () => {
    const parsed = Config(valid) as any;
    expect(parsed.mode).toBe("proxy");
    expect(parsed.startTimeoutMs).toBe(300000);
    expect(parsed.pollIntervalMs).toBe(2000);
    expect(parsed.requestTimeoutMs).toBe(30000);
  });
});
```

**Step 2: 跑测试确认失败**

**Step 3: 实现 src/index.ts**

```ts
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { LlamapadAdapter } from "./adapter";
import { createPanelClient } from "./panel-client";
import { createModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
  provider: string;
  mode: string;
  llamaBaseUrl?: string;
  startTimeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  defaultContextWindow?: number;
}

export const Config: Schema<Config> = Schema.object({
  panelUrl: Schema.string().required().description("llamapad 面板地址，如 http://192.168.1.10:8080"),
  token: Schema.string().required().role("secret").description("llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）"),
  provider: Schema.string().default("llamapad").description("provider 路由名（agent 配置的 provider 字段）"),
  mode: Schema.string().default("proxy").description("推理通道：proxy=走面板反代（默认，llama.cpp 端口无需暴露）；direct=直连 llama.cpp（需 llamaBaseUrl）"),
  llamaBaseUrl: Schema.string().description("direct 模式下 llama.cpp 基地址，如 http://192.168.1.10:18080"),
  startTimeoutMs: Schema.number().default(300000).description("切换后等待模型就绪的超时（毫秒）"),
  pollIntervalMs: Schema.number().default(2000).description("就绪探测轮询间隔（毫秒）"),
  requestTimeoutMs: Schema.number().default(30000).description("面板控制面单请求超时（毫秒）"),
  defaultContextWindow: Schema.number().description("模型未配置 ctx_size 时 resolveModel 的兜底上下文窗口"),
});

export const name = "llamapad-dsh-plugin";
export const inject = ["llm"];

export function apply(ctx: Context, config: Config) {
  if (config.mode !== "proxy" && config.mode !== "direct") {
    throw new Error(`mode 必须是 proxy 或 direct，当前: ${config.mode}`);
  }
  if (config.mode === "direct" && !config.llamaBaseUrl) {
    throw new Error("direct 模式需要配置 llamaBaseUrl");
  }
  const client = createPanelClient({
    baseUrl: config.panelUrl,
    token: config.token,
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  });
  const gate = createModelGate(client);
  ctx.llm.registerAdapter([config.provider], new LlamapadAdapter({
    client,
    gate,
    token: config.token,
    mode: config.mode,
    ...(config.llamaBaseUrl ? { llamaBaseUrl: config.llamaBaseUrl } : {}),
    ...(config.startTimeoutMs ? { startTimeoutMs: config.startTimeoutMs } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    ...(config.defaultContextWindow ? { defaultContextWindow: config.defaultContextWindow } : {}),
  }));
}

export { LlamapadAdapter, createPanelClient, createModelGate };
```

**Step 4: 写 examples/cordis.yml**

```yaml
# 挂载示例（绝对路径按实际位置修改；在 dsh 仓库内执行）：
#   LLAMAPAD_TOKEN=lp_xxx pnpm dsh web --patch /path/to/llamapad-dsh-plugin/examples/cordis.yml
- id: llamapad
  name: '/absolute/path/to/llamapad-dsh-plugin/src/index.ts'
  config:
    panelUrl: http://192.168.1.10:8080
    token: !!js process.env.LLAMAPAD_TOKEN
    # 远程/端口不暴露时用默认 proxy 模式；同机低延迟可改 direct：
    # mode: direct
    # llamaBaseUrl: http://192.168.1.10:18080

# 让 agent 使用 llamapad 模型（provider 对应上面配置的 provider，model 为面板里的模型配置名）：
- id: agent-loop
  name: '@deepseek-ai/dsh-agent-loop'
  config:
    agents:
      - id: main
        provider: llamapad
        model: qwen3-8b-q4
```

**Step 5: 跑测试确认通过** — `npm test && npm run typecheck` → PASS

**Step 6: Commit** `feat: 插件入口（schemastery 配置 + provider 注册）与挂载示例`

---

## Task 7: E2E——假面板 + 协议一致性（BlockAssembler 收口）

**Files:** Create: `test/e2e/fake-panel-server.mjs`, Test: `test/e2e/adapter-e2e.test.ts`

**Step 0: 核对 BlockAssembler API**

打开 `node_modules/@deepseek-ai/dsh-llm/lib/types/assembler.d.ts`，确认喂块方法名（预期
`push/feed(chunk)` 与 `blocks()/message()/usage` 读取器）。测试断言以其为准。

**Step 1: 写失败测试（含假面板服务）**

`test/e2e/fake-panel-server.mjs`：

```js
import { createServer } from "node:http";

/**
 * llamapad 假面板：实现插件用到的 5 个控制面端点 + llama.cpp 反代（health + chat SSE）。
 * 状态机：start 置 running + readyAt；health 在 readyAt 前回 503。
 */
export function createFakePanel({ loadMs = 100 } = {}) {
  const state = { running: null, readyAt: 0, starts: [], chatRequests: [] };
  const MODELS = [
    { name: "qwen-small", displayName: "Qwen 小", namespace: "main", ggufFile: "main/a.gguf", mmprojFile: null, status: "stopped", quant: "Q4_K_M", sizeBytes: 100, fileCount: 1, hostPort: 18080 },
    { name: "qwen-big", displayName: "Qwen 大", namespace: "main", ggufFile: "main/b.gguf", mmprojFile: null, status: "stopped", quant: "Q8_0", sizeBytes: 200, fileCount: 1, hostPort: 18080 },
  ];
  const server = createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!/^Bearer lp_/.test(req.headers.authorization ?? "")) return json(401, { error: "unauthorized" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/models") return json(200, { models: MODELS });
    if (req.method === "GET" && url.pathname === "/api/v1/runtime/status") {
      return json(200, { running: state.running ? { model: state.running, hostPort: 18080 } : null });
    }
    const startMatch = /^\/api\/v1\/models\/([^/]+)\/start$/.exec(url.pathname);
    if (req.method === "POST" && startMatch) {
      const name = decodeURIComponent(startMatch[1]!);
      if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
      state.starts.push(name);
      state.running = name;
      state.readyAt = Date.now() + loadMs;
      return json(200, { id: `cid-${state.starts.length}` });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/proxy/llama/health") {
      return Date.now() >= state.readyAt && state.running ? json(200, { status: "ok" }) : json(503, { status: "loading" });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/proxy/llama/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        state.chatRequests.push(parsed);
        if (parsed.model !== state.running) return json(409, { error: `running=${state.running}` });
        const frames = [
          `{"choices":[{"delta":{"reasoning_content":"思考"}}]}`,
          `{"choices":[{"delta":{"content":"你好"}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"北京\\"}"}}]}}]}`,
          `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
          `{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}`,
          `[DONE]`,
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const f of frames) res.write(`data: ${f}\n\n`);
        res.end();
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return { server, state };
}
```

`test/e2e/adapter-e2e.test.ts`：

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BlockAssembler } from "@deepseek-ai/dsh-llm";
import { createFakePanel } from "./fake-panel-server.mjs";
import { LlamapadAdapter } from "../../src/adapter";
import { createPanelClient } from "../../src/panel-client";
import { createModelGate } from "../../src/switching";

let server: ReturnType<typeof createFakePanel>["server"];
let state: ReturnType<typeof createFakePanel>["state"];
let baseUrl: string;

beforeAll(async () => {
  ({ server, state } = createFakePanel({ loadMs: 50 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

function makeAdapter() {
  const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
  return new LlamapadAdapter({ client, gate: createModelGate(client), token: "lp_e2e", mode: "proxy", pollIntervalMs: 20 });
}

async function drain(adapter: LlamapadAdapter, model: string) {
  const chunks = [];
  for await (const c of adapter.stream({
    provider: "llamapad", model,
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "北京天气" }], source: {} }],
  } as any)) chunks.push(c);
  return chunks;
}

describe("LlamapadAdapter E2E（假面板）", () => {
  it("冷启动：ensure 触发 start → 等就绪 → 流式翻译符合协议（BlockAssembler 收口）", async () => {
    const chunks = await drain(makeAdapter(), "qwen-small");
    expect(state.starts).toEqual(["qwen-small"]);
    const assembler = new BlockAssembler();
    for (const c of chunks) assembler.push(c);   // 方法名以 assembler.d.ts 为准
    const blocks = assembler.blocks();
    expect(blocks.map((b: any) => b.type)).toEqual(["reasoning", "text", "tool-call"]);
    expect(blocks[2]).toEqual({ type: "tool-call", id: "call_1", name: "get_weather", arguments: '{"city":"北京"}' });
    expect(assembler.usage()).toEqual({ inputTokens: 12, outputTokens: 34 });
    expect(state.chatRequests[0]!.model).toBe("qwen-small");
    expect(state.chatRequests[0]!.stream).toBe(true);
  });

  it("切换：换模型触发第二次 start，请求体 model 跟随", async () => {
    await drain(makeAdapter(), "qwen-big");
    expect(state.starts).toEqual(["qwen-small", "qwen-big"]);
    expect(state.chatRequests.at(-1)!.model).toBe("qwen-big");
  });

  it("合流：同模型并发两条流只 start 一次", async () => {
    state.running = null;
    const adapter = makeAdapter();
    await Promise.all([drain(adapter, "qwen-small"), drain(adapter, "qwen-small")]);
    expect(state.starts.filter((s) => s === "qwen-small")).toHaveLength(2 + 1);  // 前两例各 1 + 本例合流 1
  });

  it("模型不存在 → LlmError MODEL_NOT_FOUND", async () => {
    await expect(drain(makeAdapter(), "nope")).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });
});
```

**Step 2: 跑 E2E 确认失败** — `npm run test:e2e` → FAIL

**Step 3: 修正实现直到通过（本任务主要是接线验证；如 BlockAssembler API 与预期不同，修测试侧调用）**

Run: `npm run test:e2e` → PASS（4 例）

**Step 4: 全量回归** — `npm test && npm run test:e2e && npm run typecheck` → 全绿

**Step 5: Commit** `test: 假面板 E2E（冷启动/切换/合流/404）与 BlockAssembler 协议一致性`

---

## Task 8: README + 手工冒烟手册

**Files:** Create: `docs/manual-smoke.md`, Modify: `README.md`

**Step 1: 写 docs/manual-smoke.md**（内容要点）

- 前置：克隆 dsh 仓库 + 面板侧创建 API token（设置页 → API Token）
- 步骤：改 `examples/cordis.yml` 绝对路径与 panelUrl → `LLAMAPAD_TOKEN=lp_xxx pnpm dsh web --patch ...` → Web UI :3080 → 模型选择器应出现 llamapad 模型 → 对话验证（冷启动等待 = 模型加载时间）
- 已知边界：切换等待静默（决策依据链到调研文档）；M4 前仅假面板/无 GPU 验证

**Step 2: 完善 README.md**（项目定位、架构图一段、配置表、开发命令（带代理）、测试、文档索引）

**Step 3: Commit** `docs: 手工冒烟手册与 README 完善`

---

## Task 9: 验收与收尾

**Step 1: 全量验证**

```bash
npm test && npm run test:e2e && npm run typecheck
```

Expected: 全部通过。

**Step 2: 验收清单核对**

- [ ] 单测（panel-client / switching / openai-wire / translate / adapter / index）全绿
- [ ] E2E（假面板：冷启动/切换/合流/404 + BlockAssembler 协议一致性）全绿
- [ ] `npm run typecheck` 无错误
- [ ] 依赖均为精确版本（`npm ls --depth=0` 无 `^`）
- [ ] examples/cordis.yml 与 README 配置表一致
- [ ] 一任务一提交，提交信息为中文 Conventional Commits
- [ ] 真机相关项已标注 M4：usage 计数校准、reasoning_content 实测、切换延迟体验

**Step 3: 收尾 Commit（如有零星修正）** `chore: A 形态验收收尾`

---

## 明确不做（本计划范围外）

- 空闲自动停（用户边界：插件只做连接与调度，不接管服务端）
- 等待期文本注入（调研结论：必然污染历史上下文，且协议无旁路）
- B 形态工具插件（设计稿见 docs/design/b-form-tools-design.md，A 落地后再细化）
- dsh Web UI 内嵌控制面板（分期决策见调研文档 §6）
- 发布 npm / 打包（dev 期以 TS 源码绝对路径挂载；发布流程另立计划）
