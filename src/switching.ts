import type { PanelClient } from "./panel-client";

/**
 * 切换门：把「确保某模型在跑」收敛为进程内串行队列。
 * - llamapad 是单模型运行时：start 自带停旧起新，这里不感知旧模型
 * - 同目标并发 ensure 合流到进行中的那一次（两把请求只触发一次 start）
 * - 前序失败不阻断后续排队者（tail 永远吞错续链）
 * - abort 取消「等待就绪」与在途的 start POST（客户端 fetch 层面掐断等待）；
 *   服务端若已收下 start 则不撤回（服务端语义如此，见调研文档）
 */

export type EnsureErrorCode =
  | "MODEL_NOT_FOUND" | "MODEL_FILES_MISSING" | "AUTH" | "PANEL_UNREACHABLE" | "START_TIMEOUT" | "ABORTED"
  // 聊天路由（routing.ts）判定为"无可用运行中模型"时抛出，走本文件既有的 EnsureError → LlmError 映射链
  | "MODEL_NOT_RUNNING"
  // 同上，routing.ts 判定为"容器在跑但 llama-server 还没监听"时抛出
  | "MODEL_NOT_READY"
  // 面板启停互斥（409）：上一个启停请求尚未结束。是可重试的瞬态冲突，不是网络故障，
  // 因此绝不能并进 PANEL_UNREACHABLE——那会把"稍等再试"说成"面板连不上"
  | "RUNTIME_BUSY"
  // 面板拒绝启动（422 中非文件缺失的成因，当前为思考强度取值不被模板接受）
  | "START_REJECTED";

export class EnsureError extends Error {
  constructor(message: string, readonly code: EnsureErrorCode) { super(message); this.name = "EnsureError"; }
}

export interface EnsureOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** 默认 true；false 表示乐观启动——start 发出即返回，不做就绪轮询 */
  waitReady?: boolean;
  /** auto-switch 档切换时可选：让服务端等待在途推理排空后再停旧起新 */
  drain?: boolean;
  drainTimeoutMs?: number;
}

export interface ModelGate {
  ensure(model: string, options?: EnsureOptions): Promise<void>;
  lastStarted(): string | null;
}

/**
 * 一轮就绪判定：优先读 runtime/status 的 ready（面板 12cfd84 起返回，面板侧带 2s 缓存
 * 与防惊群，比插件自己打一次 /health 更省），字段缺席（老面板）才回退 llamaHealth()。
 *
 * 判定的是「目标模型是否已就绪」而不只是「有没有东西就绪」：运行的不是目标模型时一律
 * 未就绪——这时候就绪的是别人，继续等自己的。
 */
async function probeReady(client: PanelClient, model: string): Promise<boolean> {
  const running = (await client.runtimeStatus()).running;
  if (running?.model !== model) return false;
  if (running.ready === undefined) return client.llamaHealth();
  return running.ready;
}

export function createModelGate(client: PanelClient): ModelGate {
  let tail: Promise<void> = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();
  let last: string | null = null;

  async function ensureOnce(model: string, options: EnsureOptions): Promise<void> {
    const status = await client.runtimeStatus();
    if (status.running?.model === model) return;
    // signal 并进 startModel 的 options：取消手势要能掐断在途 POST 本身（排空等待
    // 最长 60s+），而不只是后面的就绪轮询——否则「取消」之后还得干等请求自己回来。
    // 与 drain 字段同住一个对象：两者都缺席时保持第二参数 undefined（向后兼容）。
    const hasDrainFields = options.drain !== undefined || options.drainTimeoutMs !== undefined;
    const startOptions = hasDrainFields || options.signal !== undefined
      ? {
          ...(options.drain !== undefined ? { drain: options.drain } : {}),
          ...(options.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        }
      : undefined;
    try {
      await client.startModel(model, startOptions);
    } catch (error) {
      // 在途 POST 被外部 signal 掐断时，request() 已把 AbortError 折成
      // PANEL_UNREACHABLE——但面板并没有不可达，是调用方主动放弃，必须还原成
      // ABORTED，否则聊天路径会把「用户取消」当「面板挂了」处理。
      if (options.signal?.aborted) throw new EnsureError(`启动 ${model} 时被取消`, "ABORTED");
      const code = (error as { code?: string }).code;
      if (code === "MODEL_NOT_FOUND" || code === "MODEL_FILES_MISSING" || code === "AUTH"
        || code === "RUNTIME_BUSY" || code === "START_REJECTED") {
        throw new EnsureError((error as Error).message, code);
      }
      if (code === "PANEL_UNREACHABLE" || code === "PANEL_HTTP") {
        throw new EnsureError((error as Error).message, "PANEL_UNREACHABLE");
      }
      throw error;
    }
    last = model;
    // 乐观启动：start 发出即算完成，不做就绪轮询。不能改用 timeoutMs:0 表达同一件事——
    // 同目标 ensure 会合流，0ms 预算会被聊天路径等其他等待者继承而立刻 START_TIMEOUT，
    // 本次调用也会错把别人预算下的超时当成自己的结果。
    if (options.waitReady === false) return;
    const timeoutMs = options.timeoutMs ?? 300_000;
    const pollMs = options.pollIntervalMs ?? 2_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (options.signal?.aborted) throw new EnsureError(`等待 ${model} 就绪时被取消`, "ABORTED");
      if (await probeReady(client, model)) return;
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

const sharedGates = new Map<string, ModelGate>();

/**
 * 门的包级单例：A 形态入口（provider）与 B 形态的 start 工具必须共用同一把锁，
 * 否则单模型运行时下会出现"一边起一边停"。按 client.baseUrl 分键——门保护的是
 * "某个面板的单模型运行时"这个物理资源，两个不同面板本就该是两把锁。
 *
 * 取舍：同一 baseUrl 下先到者胜。第一次调用传入的 client 决定这把门实际绑定的
 * 面板控制面语义（含该 client 构造期的 requestTimeoutMs 等设置），后续同 baseUrl
 * 的调用即便传入配置不同的 client（例如 A、B 两个入口各自的 startTimeoutMs /
 * pollIntervalMs 默认值不同），也复用第一次创建的 Gate 实例，不会重新绑定——
 * 门保护的是同一个物理资源，不应该因为谁先注册就开两把锁。
 */
export function sharedModelGate(client: PanelClient): ModelGate {
  const key = client.baseUrl;
  const existing = sharedGates.get(key);
  if (existing) return existing;
  const gate = createModelGate(client);
  sharedGates.set(key, gate);
  return gate;
}
