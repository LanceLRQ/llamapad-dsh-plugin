import { defaultModelOf, findRunning, isRunning, runningModels, type PanelRuntimeStatus } from "./panel-client";

/**
 * 聊天路由三档判定：决定「这次对话请求该直接转发、该先启动模型、还是该报错」。
 * 纯函数、不做任何 IO——副作用（调 gate.ensure / 报错）由调用方（adapter.ts）执行。
 *
 * - strict（默认）：聊天路径完全不触发启停，请求模型必须与运行中一致，否则报错引导用户
 *   去 llamapad 面板操作，在途流因此绝对安全
 * - passthrough：目标模型在跑就发给它；不在跑时发给面板当前默认模型（不是「随便一个在跑
 *   的」——这与面板中转层不带 model 字段时的路由行为一致），没有默认模型时同样报错
 * - auto-switch：保留旧版「选谁起谁」行为，start 自带停旧起新，但只保证目标模型在跑，
 *   绝不为了它去停别的模型（面板多模型分支解除了「同一时刻只运行一个模型」的约束）
 *
 * 三档之前还有一道就绪闸门：面板 runtime/status 报 ready:false（容器在跑但 llama-server
 * 未监听）时直接报 MODEL_NOT_READY，不把请求送进注定 502 的路径。
 *
 * 多模型下「该查谁的 ready」是这里最容易踩坑的地方：
 * - auto-switch 只查目标模型自己（findRunning(status, requestedModel)）。目标没在跑时
 *   不拦——auto-switch 接下来就是去启动它，别的模型是否就绪与这次请求无关；目标在跑但
 *   没就绪时才拦，因为再 start 一次只会把它杀掉重来，帮不上忙。
 * - strict / passthrough 没有「启动」这个动作可做，它们唯一可能落到的模型要么是目标本身
 *   （已在跑），要么是默认模型（mismatch 场景下建议切换的对象、passthrough 场景下实际的
 *   落点）。所以目标没在跑时，改查默认模型是否就绪——默认模型如果还在加载，告诉用户
 *   「正在加载」远比甩给它一句「跟目标不匹配、你切过去」更贴近事实，即便这时候场上恰好
 *   还有别的已就绪模型也一样（那个模型不是默认落点，不能替代默认模型的角色）。
 * 用一句话总结分野：闸门只认「这次请求实际会落到的那个模型」，从不因为运行集合里
 * 有别的模型在加载就误伤一次本该放行的请求。
 */
export type ChatBehavior = "strict" | "passthrough" | "auto-switch";

/**
 * 被拦下的结构化事由。文案不在这里成文——见 route-message.ts 顶部注释。
 */
export interface RouteBlockReason {
  kind: "no-model" | "mismatch" | "not-ready";
  /** 全部在跑模型的配置 key（runningModels() 的原样顺序，按启动时间升序）；一个都没跑时为空数组 */
  runningModels: string[];
  /**
   * 面板当前默认模型；没有可用默认（一个都没跑，或多模型面板显式清空）时为 null。
   * mismatch 文案的「改用哪个」建议、not-ready 判定「到底是谁在加载」都要靠它——
   * 不能从 runningModels 的名字列表反推：列表既不带默认标记，顺序也是按启动时间而非
   * 默认优先
   */
  defaultModel: string | null;
  /** 本次请求的模型配置 key */
  requestedModel: string;
  /** 目标机器是否正在推理；null=不可知，不等于「不忙」 */
  inferring: boolean | null;
}

export type RouteDecision =
  | { action: "proceed"; targetModel: string }
  | { action: "start"; model: string }
  | { action: "error"; code: "MODEL_NOT_RUNNING" | "MODEL_NOT_READY"; reason: RouteBlockReason };

export function decideRoute(
  behavior: ChatBehavior,
  requestedModel: string,
  status: PanelRuntimeStatus,
): RouteDecision {
  const running = runningModels(status);
  const names = running.map((m) => m.model);
  const defaultModel = defaultModelOf(status);
  const target = findRunning(status, requestedModel);
  const inferring = status.busy?.inferring ?? null;

  const blockReason = (kind: RouteBlockReason["kind"]): RouteBlockReason => (
    { kind, runningModels: names, defaultModel, requestedModel, inferring }
  );

  // 就绪闸门（先于三档判定，理由见文件头注释）。auto-switch 只查目标自己；
  // strict/passthrough 目标没在跑时改查默认模型（这次请求实际会落到的对象）。
  // 只拦 ready === false——ready 缺席（老面板没有这个字段，或该模型压根不在跑）
  // 是「不可知」，绝不能因为字段缺席就把请求拦下。
  const gateEntry = behavior === "auto-switch"
    ? target
    : (target ?? (defaultModel !== null ? findRunning(status, defaultModel) : undefined));
  if (gateEntry?.ready === false) {
    return { action: "error", code: "MODEL_NOT_READY", reason: blockReason("not-ready") };
  }

  if (behavior === "auto-switch") {
    if (isRunning(status, requestedModel)) return { action: "proceed", targetModel: requestedModel };
    return { action: "start", model: requestedModel };
  }

  // strict / passthrough：一个都没跑一律报错，聊天路径不会替用户按下启动键
  if (names.length === 0) {
    return { action: "error", code: "MODEL_NOT_RUNNING", reason: blockReason("no-model") };
  }
  if (target !== undefined) {
    return { action: "proceed", targetModel: requestedModel };
  }
  if (behavior === "passthrough") {
    // 新落点：过去发给「唯一在跑的那个」，现在发给默认模型——与面板中转层不带 model
    // 字段时的行为一致。没有默认模型（多模型面板显式清空）时没有落点可发，只能报错
    if (defaultModel !== null) return { action: "proceed", targetModel: defaultModel };
    return { action: "error", code: "MODEL_NOT_RUNNING", reason: blockReason("no-model") };
  }
  // strict + 目标没跑，但别的在跑
  return { action: "error", code: "MODEL_NOT_RUNNING", reason: blockReason("mismatch") };
}
