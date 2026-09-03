// 卡片的纯逻辑：把一份 CardSnapshot（+ 本地的「动作在途」态）折算成渲染要用的
// 展示值。刻意不掺 React——状态推导本身没有理由依赖运行环境，纯函数才好单测，
// 也让 Card 组件本身只剩"照着 view 摆控件"这一件事。
import type { CardConnection, CardModel, CardSnapshot, RuntimePhase } from "../rpc-contract";

/** 一次启动/停止动作的进行中态：哪个模型、哪种动作。 */
export interface PendingAction {
  readonly model: string;
  readonly kind: "start" | "stop";
}

/**
 * inferring 三态在 UI 上对应的展示态。
 * running 为 null（没有模型在跑）时不产出任何展示态——「是否在推理」这件事
 * 在没有模型运行时没有意义，不能因为 inferring 字段恰好是 false/null 就画出来。
 */
export type InferringBadge = "inferring" | "idle" | "unknown";

/**
 * 推导推理态展示值。
 * @param running 运行中模型的 name；无模型在跑为 null。
 * @param inferring true=推理中，false=空闲，null=不可知（不等于「空闲」，见 rpc-contract.ts）。
 */
export function describeInferring(running: string | null, inferring: boolean | null): InferringBadge | null {
  if (running === null) return null;
  if (inferring === true) return "inferring";
  if (inferring === false) return "idle";
  return "unknown";
}

/** 推理态展示值到 StateDot 四色语义的映射（仅在确有模型运行时调用）。 */
export function inferringDotState(badge: InferringBadge): "done" | "warning" | "ongoing" {
  if (badge === "inferring") return "ongoing";
  if (badge === "unknown") return "warning";
  return "done";
}

/**
 * 加载耗时的两档展示形态：不满 60 秒只给秒数，满 60 秒给分钟 + 秒钟，
 * Card.tsx 按这个形态挑 loadingModel / loadingModelLong 两套文案模板。
 */
export type LoadingElapsed =
  | { readonly unit: "seconds"; readonly seconds: number }
  | { readonly unit: "minutes"; readonly minutes: number; readonly seconds: number };

/**
 * 推导「模型已加载 N 秒」的展示值。
 *
 * now 必须由调用方传入（不用 Date.now()）——这样测试不用挂真实时钟，Card.tsx 的
 * 1 秒 tick 也只是把它自己存的时间戳灌进来，两边不必各写一遍「怎么算耗时」。
 * startedAt 为 null 或解析失败（Date.parse 得到 NaN）时返回 null，卡片退化成不带
 * 耗时的兜底文案；now 早于 startedAt（时钟偏移）按 0 秒处理，不展示负数。
 *
 * @param startedAt 运行中容器的启动时刻（ISO 8601），见 rpc-contract.ts 的注释。
 * @param now 当前时刻的毫秒时间戳，由调用方注入。
 */
export function describeLoadingElapsed(startedAt: string | null, now: number): LoadingElapsed | null {
  if (startedAt === null) return null;
  const startedAtMs = Date.parse(startedAt);
  if (Number.isNaN(startedAtMs)) return null;
  const totalSeconds = Math.max(0, Math.floor((now - startedAtMs) / 1000));
  if (totalSeconds < 60) return { unit: "seconds", seconds: totalSeconds };
  return { unit: "minutes", minutes: Math.floor(totalSeconds / 60), seconds: totalSeconds % 60 };
}

function missingReasonOf(status: string): "missing-file" | "missing-mmproj" | null {
  return status === "missing-file" || status === "missing-mmproj" ? status : null;
}

/** 一行模型的操作按钮描述：动作种类、是否禁用、缺失原因（供文案挑选）、本行是否正在等待这次动作。 */
export interface RowAction {
  readonly kind: "start" | "stop";
  readonly disabled: boolean;
  readonly missingReason: "missing-file" | "missing-mmproj" | null;
  /** true = 本行动作在途：Card.tsx 会把这一行的按钮换成「取消等待」语义 */
  readonly pending: boolean;
}

/**
 * 推导一行模型的操作按钮状态。
 *
 * 有动作在途时：**在途行可点**——按钮此时承担「取消等待」的语义（Card.tsx 拿
 * AbortController 截断在途请求），其余行仍禁用——面板同一时刻只运行一个模型，
 * 允许在途动作时继续点别的行等于给同一面板发互相插队的启停请求。缺文件的行
 * 永远禁用，即便它恰好是在途行（那种组合本身就是异常态，取消入口不值得为它开口子）。
 */
export function rowActionFor(model: CardModel, pending: PendingAction | null): RowAction {
  const missingReason = missingReasonOf(model.status);
  const isPendingRow = pending !== null && pending.model === model.name;
  // 本行有动作在途时，按钮语义取用户实际发起的那个动作，不按 model.status 现推：
  // 启动过程中容器一起来 status 就变成 running，再推导就成了「停止」——用户点的明明
  // 是启动，按钮却显示「停止中…」。轮询提速到 2s 后这个中间态尤其容易被看见。
  const kind: "start" | "stop" = isPendingRow
    ? pending.kind
    : model.status === "running"
      ? "stop"
      : "start";
  const disabled = missingReason !== null || (pending !== null && !isPendingRow);
  return { kind, disabled, missingReason, pending: isPendingRow };
}

export interface CardRowView {
  readonly model: CardModel;
  readonly action: RowAction;
}

/** 一次轮询折算出的完整卡片展示值。 */
export interface CardView {
  readonly rows: readonly CardRowView[];
  readonly runningModel: CardModel | null;
  readonly phase: RuntimePhase;
  readonly inferring: InferringBadge | null;
  readonly openDisabled: boolean;
}

export function buildCardView(snapshot: CardSnapshot, pending: PendingAction | null): CardView {
  const runningModel = snapshot.models.find((model) => model.name === snapshot.running) ?? null;
  // starting 阶段按契约 inferring 必为 null，但这里不依赖上游守规矩——即使它恰好
  // 不是 null，也不该在加载中画「推理状态未知」，那句话在这个阶段是纯噪音，
  // 所以直接跳过 describeInferring，而不是让它认识 phase 这个新概念。
  const inferring = snapshot.phase === "starting" ? null : describeInferring(snapshot.running, snapshot.inferring);
  return {
    rows: snapshot.models.map((model) => ({ model, action: rowActionFor(model, pending) })),
    runningModel,
    phase: snapshot.phase,
    inferring,
    openDisabled: snapshot.openUrl.length === 0,
  };
}

/** 连接表单的两个草稿输入框。 */
export interface ConnectionDraft {
  readonly panelUrl: string;
  readonly token: string;
}

/** token 输入框下方的提示语义：留空保持原值 / 将被覆盖 / 从未配置过。 */
export type TokenHint = "keep" | "replace" | "unset";

export interface ConnectionFormState {
  readonly canSave: boolean;
  /** canSave 为 false 且原因值得说明时给出；null = 单纯没改动，不必提示 */
  readonly blockedReason: "urlRequired" | null;
  readonly tokenHint: TokenHint;
}

/**
 * 连接表单能不能保存。
 *
 * 「地址没变 + token 留空」意味着这次保存什么都不会写，直接禁用按钮而不是让用户点一次
 * 空操作。地址被清空则是另一回事：那不是「没改动」而是「改坏了」，要说明原因——空地址
 * 会让插件彻底失联，而这张卡片正是唯一的补救入口。
 */
export function connectionFormState(
  current: CardConnection,
  draft: ConnectionDraft,
): ConnectionFormState {
  const url = draft.panelUrl.trim();
  const token = draft.token.trim();
  const tokenHint: TokenHint = token !== "" ? "replace"
    : current.tokenConfigured ? "keep" : "unset";

  if (url === "") return { canSave: false, blockedReason: "urlRequired", tokenHint };
  const changed = url !== current.panelUrl.trim() || token !== "";
  return { canSave: changed, blockedReason: null, tokenHint };
}
