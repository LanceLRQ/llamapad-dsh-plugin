import type { PanelClient } from "./panel-client";

/**
 * 切换门：把「确保某模型在跑」收敛为进程内串行队列。
 * - llamapad 是单模型运行时：start 自带停旧起新，这里不感知旧模型
 * - 同目标并发 ensure 合流到进行中的那一次（两把请求只触发一次 start）
 * - 前序失败不阻断后续排队者（tail 永远吞错续链）
 * - abort 只取消「等待就绪」，已发出的 start 不撤回（服务端语义如此，见调研文档）
 */

export type EnsureErrorCode =
  | "MODEL_NOT_FOUND" | "MODEL_FILES_MISSING" | "AUTH" | "PANEL_UNREACHABLE" | "START_TIMEOUT" | "ABORTED"
  // 聊天路由（routing.ts）判定为"无可用运行中模型"时抛出，走本文件既有的 EnsureError → LlmError 映射链
  | "MODEL_NOT_RUNNING";

export class EnsureError extends Error {
  constructor(message: string, readonly code: EnsureErrorCode) { super(message); this.name = "EnsureError"; }
}

export interface EnsureOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** auto-switch 档切换时可选：让服务端等待在途推理排空后再停旧起新 */
  drain?: boolean;
  drainTimeoutMs?: number;
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
    const drainOptions = options.drain !== undefined || options.drainTimeoutMs !== undefined
      ? {
          ...(options.drain !== undefined ? { drain: options.drain } : {}),
          ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
        }
      : undefined;
    try {
      await client.startModel(model, drainOptions);
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
