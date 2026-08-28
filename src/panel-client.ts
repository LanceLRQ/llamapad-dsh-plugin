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
  /** startedAt 是运行中容器的启动时刻（ISO 8601），面板一直有返回，这里只是补齐类型 */
  running: { model: string; displayName?: string; hostPort?: number | null; startedAt?: string | null } | null;
  /** 仅 runtimeStatus({ busy: true }) 时返回；null 代表"不可知"，不代表"不忙" */
  busy?: { inferring: boolean; slotsRunning: number } | null;
}

/** 排空等待的默认上限（毫秒），与服务端 runtime.ts 的 DEFAULT_DRAIN_TIMEOUT_MS 对齐。
 *  放在本文件（最底层、无同级依赖）供 adapter 与 index 的 schema 默认值共用，
 *  不让同一个数字散落三处各写一遍。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/** POST .../start 的可选排空参数（服务端支持时才真正生效） */
export interface StartModelOptions {
  drain?: boolean;
  drainTimeoutMs?: number;
}

/** POST .../stop 的可选排空参数，形状与 StartModelOptions 一致（服务端契约同构） */
export interface StopModelOptions {
  drain?: boolean;
  drainTimeoutMs?: number;
}

export interface StopModelResult {
  ok: true;
  /** 仅传了 drain/drainTimeoutMs 时服务端才会返回 */
  drain?: { drained: boolean; reason: "idle" | "timeout" | "unavailable" | "skipped" };
}

export interface PanelClient {
  readonly baseUrl: string;
  listModels(): Promise<PanelModelView[]>;
  getModel(name: string): Promise<PanelModelDetail | null>;
  runtimeStatus(options?: { busy?: boolean }): Promise<PanelRuntimeStatus>;
  startModel(name: string, options?: StartModelOptions): Promise<void>;
  stopModel(name: string, options?: StopModelOptions): Promise<StopModelResult>;
  llamaHealth(): Promise<boolean>;
}

/**
 * start/stop 共用的排空请求组装：请求体与超时覆盖的换算逻辑完全一致，只写一份。
 *
 * 排空最长可能要等 drainTimeoutMs（默认 60s）才返回，而单请求默认超时只有 30s
 * （requestTimeoutMs）——不覆盖的话客户端会在服务端排空完成前自己先 abort 掉这次
 * 调用。取 max(默认超时, drainTimeoutMs + 10s) 作为这次调用的超时：+10s 是留给
 * 网络往返与服务端收尾的缓冲，避免排空刚好卡线时客户端抢先掐断。只传 drain 不传
 * drainTimeoutMs 时服务端会用它自己的 60s 默认值，客户端必须按同一个数字放宽，
 * 否则照样在服务端排空完成前先 abort——所以这里对齐 DEFAULT_DRAIN_TIMEOUT_MS
 * 而不是留空。
 */
function buildDrainRequest(
  options: { drain?: boolean; drainTimeoutMs?: number } | undefined,
  defaultTimeoutMs: number,
): { body?: string; timeoutOverride?: number } {
  const hasDrainFields = options?.drain !== undefined || options?.drainTimeoutMs !== undefined;
  const body = hasDrainFields
    ? JSON.stringify({
        ...(options?.drain !== undefined ? { drain: options.drain } : {}),
        ...(options?.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
      })
    : undefined;
  const effectiveDrainMs = options?.drainTimeoutMs
    ?? (options?.drain === true ? DEFAULT_DRAIN_TIMEOUT_MS : undefined);
  const timeoutOverride = effectiveDrainMs !== undefined
    ? Math.max(defaultTimeoutMs, effectiveDrainMs + 10_000)
    : undefined;
  return { body, timeoutOverride };
}

export function createPanelClient(options: PanelClientOptions): PanelClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  async function request(path: string, init: RequestInit = {}, timeoutOverrideMs?: number): Promise<Response> {
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: AbortSignal.timeout(timeoutOverrideMs ?? timeoutMs),
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
    async runtimeStatus(options) {
      const res = await request(`/api/v1/runtime/status${options?.busy ? "?busy=1" : ""}`);
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return (await res.json()) as PanelRuntimeStatus;
    },
    async startModel(name, startOptions) {
      const { body, timeoutOverride } = buildDrainRequest(startOptions, timeoutMs);
      const res = await request(
        `/api/v1/models/${encodeURIComponent(name)}/start`,
        { method: "POST", ...(body !== undefined ? { body } : {}) },
        timeoutOverride,
      );
      if (res.ok) return;
      if (res.status === 404) throw new PanelError(`模型不存在: ${name}`, "MODEL_NOT_FOUND", 404);
      if (res.status === 422) throw new PanelError(await readError(res), "MODEL_FILES_MISSING", 422);
      if (res.status === 401) throw new PanelError("llamapad token 无效或未授权", "AUTH", 401);
      throw new PanelError(`启动失败: ${await readError(res)}`, "PANEL_HTTP", res.status);
    },
    async stopModel(name, stopOptions) {
      const { body, timeoutOverride } = buildDrainRequest(stopOptions, timeoutMs);
      const res = await request(
        `/api/v1/models/${encodeURIComponent(name)}/stop`,
        { method: "POST", ...(body !== undefined ? { body } : {}) },
        timeoutOverride,
      );
      if (res.ok) return (await res.json()) as StopModelResult;
      if (res.status === 404) throw new PanelError(`模型不存在: ${name}`, "MODEL_NOT_FOUND", 404);
      if (res.status === 401) throw new PanelError("llamapad token 无效或未授权", "AUTH", 401);
      throw new PanelError(`停止失败: ${await readError(res)}`, "PANEL_HTTP", res.status);
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
