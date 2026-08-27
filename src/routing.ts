import type { PanelRuntimeStatus } from "./panel-client";

/**
 * 聊天路由三档判定：决定「这次对话请求该直接转发、该先启动模型、还是该报错」。
 * 纯函数、不做任何 IO——副作用（调 gate.ensure / 报错）由调用方（adapter.ts）执行。
 *
 * - strict（默认）：聊天路径完全不触发启停，请求模型必须与运行中一致，否则报错引导用户
 *   去 llamapad 面板操作，在途流因此绝对安全
 * - passthrough：有模型在跑就发给它（名字对不上也照发，target 改写为运行中的模型），
 *   没有模型在跑时与 strict 同样报错
 * - auto-switch：保留旧版「选谁起谁」行为，start 自带停旧起新
 */
export type ChatBehavior = "strict" | "passthrough" | "auto-switch";

export type RouteDecision =
  | { action: "proceed"; targetModel: string }
  | { action: "start"; model: string }
  | { action: "error"; code: "MODEL_NOT_RUNNING"; message: string };

export function decideRoute(
  behavior: ChatBehavior,
  requestedModel: string,
  status: PanelRuntimeStatus,
): RouteDecision {
  const running = status.running;

  if (behavior === "auto-switch") {
    if (running?.model === requestedModel) return { action: "proceed", targetModel: requestedModel };
    return { action: "start", model: requestedModel };
  }

  // strict / passthrough：无模型在跑一律报错，聊天路径不会替用户按下启动键
  // （用真值判定而非 === null：running 来自面板 HTTP 响应，缺键时不该炸成 TypeError）
  if (!running) {
    return { action: "error", code: "MODEL_NOT_RUNNING", message: noModelRunningMessage(status.busy) };
  }
  if (running.model === requestedModel) {
    return { action: "proceed", targetModel: requestedModel };
  }
  if (behavior === "passthrough") {
    return { action: "proceed", targetModel: running.model };
  }
  // strict + 运行中模型与请求不符
  return {
    action: "error",
    code: "MODEL_NOT_RUNNING",
    message: mismatchMessage(running.model, requestedModel, status.busy),
  };
}

function busySuffix(busy: PanelRuntimeStatus["busy"]): string {
  // busy 为 null 代表「不可知」而非「不忙」，此时不追加提示（宁可不说，也不误报）
  return busy?.inferring === true ? "；目标机器正在推理中" : "";
}

function noModelRunningMessage(busy: PanelRuntimeStatus["busy"]): string {
  return `当前没有模型在运行，请先到 llamapad 面板启动一个模型${busySuffix(busy)}；`
    + "如需按请求自动启动，可把 chatBehavior 改为 auto-switch。";
}

function mismatchMessage(runningModel: string, requestedModel: string, busy: PanelRuntimeStatus["busy"]): string {
  return `当前运行的是 ${runningModel}，请求的是 ${requestedModel}${busySuffix(busy)}；`
    + "strict 档不会自动切换，请到 llamapad 面板启动目标模型，或把 chatBehavior 改为 auto-switch。";
}
