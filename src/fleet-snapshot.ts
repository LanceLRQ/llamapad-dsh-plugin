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
 * ctx_size（token 数）→ 展示文案：>= 1024 折成 k（131072 → "128k"，四舍五入到最近的
 * 整 k），低于 1024 的配置（如 512/1000）原样输出数字——折 k 会得到 "1k" 以下的
 * 有效数字丢失，提示词里宁可多两个字符也要保真。
 */
function formatContext(tokens: number): string {
  return tokens >= 1024 ? `${Math.round(tokens / 1024)}k` : String(tokens);
}

/**
 * 把一份 fleet 缓存渲染成系统提示分节文本；无可奉告时返回空串——systemPrompt
 * 的 renderPrompt 会丢弃空分节，所以「面板还没探测成功」「机器上一无所有」
 * 都天然降级为「这一节不存在」，不会留下标题空壳。
 */
export function renderFleetSnapshot(cache: FleetCache | null): string {
  // null = 尚未成功探测过（面板不可达/未配置）：宁可沉默也不谎报「没有本地模型」
  if (cache === null) return "";
  if (cache.running.length === 0 && cache.models.length === 0) return "";

  const lines: string[] = ["## Local model fleet (llamapad)", ""];

  // running 只是个名字集合，quant 要回 models 清单里查；查不到（面板清单与运行态
  // 脱节的罕见窗口）就只报名字，不编造量化信息。contextWindow 来自 status-watch
  // 探测时的 /effective 读取（键缺席 = 未知/读取失败/args_override 失效/超出并发
  // 查询上限），同样缺席即省略——编一个 context 数字比不报更糟。
  //
  // 只有多于一个模型在跑时才标注 (default)：只跑一个模型时它显然就是请求的落点，
  // 标注纯属提示词预算的噪音（系统提示随每个请求整段重发）；同理，「不带模型名的
  // 请求会落到谁」这句解释性的话，也只在真的存在歧义（>1 个在跑）时才值得占位。
  if (cache.running.length > 0) {
    const multi = cache.running.length > 1;
    const runningEntries = cache.running.map((name) => {
      const runningModel = cache.models.find((m) => m.name === name);
      // 括号注解按「quant, context, default」拼：任一缺省就跳过它，全缺则整个
      // 括号不要——绝不输出 "(null)" 或空括号
      const annotations = [
        ...(runningModel?.quant != null ? [runningModel.quant] : []),
        ...(cache.contextWindows?.[name] !== undefined
          ? [`${formatContext(cache.contextWindows[name]!)} context`]
          : []),
        ...(multi && name === cache.defaultModel ? ["default"] : []),
      ];
      return annotations.length > 0 ? `${name} (${annotations.join(", ")})` : name;
    });
    lines.push(`Running: ${runningEntries.join(", ")}`);
    if (multi && cache.defaultModel !== null) {
      lines.push("", `Requests without an explicit model go to: ${cache.defaultModel}`);
    }
  } else {
    lines.push("No model is currently running.");
  }

  // 全部在跑的模型都从「可启动」剔除，而不只是默认那一个（修 P1-4：老实现只挡
  // 掉 cache.running 这一个名字，多模型面板下非默认的在跑模型会被诱导 start——
  // 面板语义里对运行中模型 start 会重建容器，代价不小）
  const startable = cache.models.filter((m) => !cache.running.includes(m.name));
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
