/**
 * 本地模型场快照 → 系统提示分节文本（M5「提示词快照」的渲染半身）。
 *
 * 数据源是 fleetCache（status-watch 每次状态探测写入），消费方是 dsh 的
 * systemPrompt 服务：index.ts 把本函数包成 text 注册为 `llamapad:local-fleet`
 * 分节，每次组装系统提示时同步求值——注册一次永远反映最新舰队状态。
 *
 * 输出语言是英文：读者是模型而非人，与 harness identity（order -100 档）保持
 * 一致，避免中英混排诱导模型在回复语言上产生偏向。
 */
import type { FleetCache } from "./status-watch";

/**
 * 可启动清单的截断上限。提示词预算敏感：系统提示随每个请求整段重发，且分节
 * 拼接后还有 harness identity / persona / tool guidance 等邻居挤占上下文；本地
 * 机器装几十个模型不稀奇，全量列出性价比太低。20 条足够让模型知道「本地有
 * 什么量级的东西」，超出部分以计数提示，模型需要细节时可调 llamapad_list_models。
 */
const MAX_STARTABLE = 20;

/** `name (quant)`；quant 未知（null）时省略括号而不是输出 "(null)"。 */
function entry(model: { name: string; quant: string | null }): string {
  return model.quant === null ? model.name : `${model.name} (${model.quant})`;
}

/**
 * 把一份 fleet 缓存渲染成系统提示分节文本；无可奉告时返回空串——systemPrompt
 * 的 renderPrompt 会丢弃空分节，所以「面板还没探测成功」「机器上一无所有」
 * 都天然降级为「这一节不存在」，不会留下标题空壳。
 */
export function renderFleetSnapshot(cache: FleetCache | null): string {
  // null = 尚未成功探测过（面板不可达/未配置）：宁可沉默也不谎报「没有本地模型」
  if (cache === null) return "";
  if (cache.running === null && cache.models.length === 0) return "";

  const lines: string[] = ["## Local model fleet (llamapad)", ""];

  // running 只是个名字，quant 要回 models 清单里查；查不到（面板清单与运行态
  // 脱节的罕见窗口）就只报名字，不编造量化信息
  if (cache.running !== null) {
    const runningModel = cache.models.find((m) => m.name === cache.running);
    lines.push(`Running: ${runningModel !== undefined ? entry(runningModel) : cache.running}`);
  } else {
    lines.push("No model is currently running.");
  }

  // 正在跑的模型从「可启动」剔除：它在跑，不是可启动；说成可启动会诱导模型
  // 对它调用 start（面板语义：对运行中模型 start 会重建容器，代价不小）
  const startable = cache.models.filter((m) => m.name !== cache.running);
  if (startable.length > 0) {
    const shown = startable.slice(0, MAX_STARTABLE).map(entry);
    const rest = startable.length - shown.length;
    if (rest > 0) shown.push(`… and ${rest} more`);
    lines.push("", `Available to start: ${shown.join(", ")}`);
  }

  // 工具提示句刻意写 "may be available"：llamapad_start_model / llamapad_stop_model
  // 属于 B 形态（tools 入口），用户没挂载它时这节照样在场，措辞不能撒谎；兜底
  // 指路 harness 的模型切换 UI。
  lines.push(
    "",
    "Local models can serve long-running or high-volume work without cloud tokens. "
      + "The llamapad_start_model / llamapad_stop_model tools may be available to start "
      + "or stop them; if not, ask the user to switch models in the harness UI.",
  );

  return lines.join("\n");
}
