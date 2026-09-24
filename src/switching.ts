import { findRunning, isRunning, runningModels, type PanelClient } from "./panel-client";

/**
 * 切换门：把「确保某模型在跑」收敛为进程内串行队列。
 * - 面板多模型分支下 start 只保证目标模型在跑，不会替这里停掉别的模型——这与插件
 *   既有用户边界一致（只做连接与调度，不接管服务端），显存不够时的收拾交给用户自己
 *   去面板操作（见 START_TIMEOUT 文案）
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
 * 踩坑记录（P0-1）：面板多模型分支下 `running` 字段是**默认模型**，不是「唯一在跑的
 * 模型」——请求的是非默认模型时，`running` 全程指向别人，永远对不上目标。必须在
 * 运行集合（findRunning，兼容新旧两种面板形状）里按名字找目标项，否则会把明明已经
 * 起来的目标误判成「未就绪」，一路轮询到 startTimeoutMs 才假超时，而目标其实早就在
 * 跑、还占着显存。
 */
async function probeReady(client: PanelClient, model: string): Promise<boolean> {
  const target = findRunning(await client.runtimeStatus(), model);
  if (target === undefined) return false;
  if (target.ready === undefined) return client.llamaHealth();
  return target.ready;
}

/**
 * START_TIMEOUT 文案的唯一出处，抽成纯函数便于单测两种形态。多模型面板下超时大多
 * 不是「模型坏了」而是「显存不够、目标一直没被调度起来」，把当前还占着资源的模型
 * 点出来，比一句干巴巴的超时更能指路——但这只是提示，绝不代为停掉它们（见文件头）。
 */
export function formatStartTimeoutMessage(model: string, timeoutMs: number, otherRunning: string[]): string {
  const base = `等待 ${model} 就绪超时（${timeoutMs}ms）`;
  if (otherRunning.length === 0) return base;
  return `${base}。当前面板还在运行：${otherRunning.join("、")}；显存不足时可在面板停掉不用的模型再试`;
}

/** 超时文案要点名「别人」，得再查一次状态；这次查询只是为了把话说清楚，不是主流程
 *  的一部分——查询本身失败时吞掉，退回不带后半句的基础文案，不能让「查文案用的请求
 *  失败」盖过真正的错误（START_TIMEOUT）。 */
async function otherRunningModels(client: PanelClient, model: string): Promise<string[]> {
  try {
    return runningModels(await client.runtimeStatus())
      .map((m) => m.model)
      .filter((name) => name !== model);
  } catch {
    return [];
  }
}

export function createModelGate(client: PanelClient): ModelGate {
  return gateOver(() => client);
}

/** 门的实现。client 每轮 ensure 现取：sharedModelGate 会在配置热更时换掉它（见下）。 */
function gateOver(currentClient: () => PanelClient): ModelGate {
  let tail: Promise<void> = Promise.resolve();
  const inflight = new Map<string, Promise<void>>();
  let last: string | null = null;

  async function ensureOnce(model: string, options: EnsureOptions): Promise<void> {
    const client = currentClient();
    const status = await client.runtimeStatus();
    if (isRunning(status, model)) return;
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
      if (Date.now() + pollMs > deadline) {
        const others = await otherRunningModels(client, model);
        throw new EnsureError(formatStartTimeoutMessage(model, timeoutMs, others), "START_TIMEOUT");
      }
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

const sharedGates = new Map<string, { gate: ModelGate; client: PanelClient }>();

/**
 * 门的包级单例：A 形态入口（provider）与 B 形态的 start 工具必须共用同一把锁，
 * 否则单模型运行时下会出现"一边起一边停"。按 client.baseUrl 分键——门保护的是
 * "某个面板的运行时"这个物理资源，两个不同面板本就该是两把锁。
 *
 * 锁的身份按 baseUrl 共享，但门调用面板用的 client 是**最近一次传入的那个**：
 * 面板地址不变、只改了 token（设置卡片保存连接）时，index.ts 会带着新 client 再调
 * 一次这里。早先的实现是「同一 baseUrl 先到者胜」，门永远绑着第一个 client，结果
 * 改 token 后列模型用新 token、启停却还拿旧 token 撞 401（2026-09-24 真机冒烟发现）。
 * 代价是 A、B 两个入口各配一份不同的 requestTimeoutMs 时，以后调用的那份为准。
 */
export function sharedModelGate(client: PanelClient): ModelGate {
  const key = client.baseUrl;
  const existing = sharedGates.get(key);
  if (existing) {
    existing.client = client;
    return existing.gate;
  }
  const entry = { client, gate: undefined as unknown as ModelGate };
  entry.gate = gateOver(() => entry.client);
  sharedGates.set(key, entry);
  return entry.gate;
}
