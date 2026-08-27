// 卡片的纯逻辑：把一份 CardSnapshot（+ 本地的「动作在途」态）折算成渲染要用的
// 展示值。刻意不掺 React——状态推导本身没有理由依赖运行环境，纯函数才好单测，
// 也让 Card 组件本身只剩"照着 view 摆控件"这一件事。
import type { CardModel, CardSnapshot } from "../rpc-contract";

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

function missingReasonOf(status: string): "missing-file" | "missing-mmproj" | null {
  return status === "missing-file" || status === "missing-mmproj" ? status : null;
}

/** 一行模型的操作按钮描述：动作种类、是否禁用、缺失原因（供文案挑选）、本行是否正在等待这次动作。 */
export interface RowAction {
  readonly kind: "start" | "stop";
  readonly disabled: boolean;
  readonly missingReason: "missing-file" | "missing-mmproj" | null;
  readonly pending: boolean;
}

/**
 * 推导一行模型的操作按钮状态。
 *
 * 只要有任意一个动作在途（不论作用于哪个模型），全部行都禁用——面板同一时刻只运行
 * 一个模型，允许在途动作时继续点别的行等于给同一面板发互相插队的启停请求。
 */
export function rowActionFor(model: CardModel, pending: PendingAction | null): RowAction {
  const kind: "start" | "stop" = model.status === "running" ? "stop" : "start";
  const missingReason = missingReasonOf(model.status);
  const isPendingRow = pending !== null && pending.model === model.name;
  const disabled = missingReason !== null || pending !== null;
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
  readonly inferring: InferringBadge | null;
  readonly openDisabled: boolean;
}

export function buildCardView(snapshot: CardSnapshot, pending: PendingAction | null): CardView {
  const runningModel = snapshot.models.find((model) => model.name === snapshot.running) ?? null;
  return {
    rows: snapshot.models.map((model) => ({ model, action: rowActionFor(model, pending) })),
    runningModel,
    inferring: describeInferring(snapshot.running, snapshot.inferring),
    openDisabled: snapshot.openUrl.length === 0,
  };
}
