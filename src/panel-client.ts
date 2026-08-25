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
