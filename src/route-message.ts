import type { RouteBlockReason } from "./routing";

/**
 * 「聊天被拦」文案的唯一出处。
 *
 * 与 routing.ts 分家的理由：那边回答「该不该拦」，是判定；这边回答「怎么跟用户说」，
 * 是措辞。措辞需要用户自定义的模型名（displayName），而那要查面板——判定函数是每次
 * 对话都要走的热路径，不能为了措辞去背一次网络往返。所以判定只产出结构化 reason，
 * 由调用方在**确实要报错时**才解析名字再来这里成文。
 *
 * 用词约束（用户 2026-09-02 明确要求）：主句里不出现 strict / passthrough / 档位
 * 这类只有读过文档才懂的词，直接说「该做什么」。auto-switch 是真实可用的能力，
 * 降级成末尾一句括号提示保留。
 */

/** 配置 key → 用户可读名；解析不到时由调用方回落 key 本身。 */
export type ModelNameResolver = (model: string) => string;

/** 卡片就在设置页里，指路比让用户自己找面板 URL 更快 */
const PANEL_PATH = "设置 → 插件配置 → llamapad 模型面板";

const AUTO_SWITCH_HINT =
  "（想让选中的模型自动启动：把插件配置里的 chatBehavior 改成 auto-switch）";

/** mismatch 文案最多点名几个在跑模型；超过就截断成「A、B、C 等 N 个」，
 *  免得多模型面板上一长串名字把主句撑爆 */
const MAX_LISTED_RUNNING = 3;

function listRunningNames(runningModels: string[], nameOf: ModelNameResolver): string {
  const displayed = runningModels.map(nameOf);
  if (displayed.length <= MAX_LISTED_RUNNING) return displayed.join("、");
  return `${displayed.slice(0, MAX_LISTED_RUNNING).join("、")} 等 ${displayed.length} 个`;
}

export function formatRouteBlock(reason: RouteBlockReason, nameOf: ModelNameResolver): string {
  const requested = nameOf(reason.requestedModel);

  // 容器已起、llama-server 还在读权重：等一下就好，既不用去面板操作也不用换档，
  // 所以这一支既不给引导也不给 auto-switch 提示，只说清楚「在等什么、要等多久」。
  // 加载中的到底是谁：闸门要么拦的是目标自己（此时它必然在 runningModels 里），
  // 要么拦的是目标没跑时的落点——默认模型，两者取一，不能瞎猜成 requestedModel。
  if (reason.kind === "not-ready") {
    const loadingModel = reason.runningModels.includes(reason.requestedModel)
      ? reason.requestedModel
      : (reason.defaultModel ?? reason.requestedModel);
    return `「${nameOf(loadingModel)}」正在加载中，大模型通常要几十秒，稍等片刻再发送。`;
  }

  // busy 为 null 是「不可知」而非「不忙」，此时不提（宁可不说也不误报）
  const busy = reason.inferring === true ? "目标机器上还有对话正在生成。" : "";

  if (reason.kind === "no-model") {
    // passthrough 还有一条防御性落点走这一支：场上有模型在跑、面板却报不出默认模型
    // （正常面板不会这样——起了第一个模型就会有默认）。这时候说「还没有模型在运行」
    // 与用户在面板上看到的正好相反，只能说清楚真正缺的是「请求该发给谁」
    const head = reason.runningModels.length > 0
      ? `面板没有默认模型，「${requested}」也没在运行。`
      : "还没有模型在运行。";
    return `${head}${busy}到 ${PANEL_PATH} 里启动「${requested}」后再发送。`
      + AUTO_SWITCH_HINT;
  }

  // mismatch：单模型在跑时维持老文案（点名那一个）；多模型在跑时列出全部在跑模型，
  // 并补一句面板当前默认模型——它是 passthrough 档实际会落到的对象，也是这里唯一
  // 能给出的确定的「改用哪个」建议。面板显式没有默认模型时不点名，只说「运行中的」
  const runningList = listRunningNames(reason.runningModels, nameOf);
  const multiModel = reason.runningModels.length > 1;
  const defaultHint = multiModel && reason.defaultModel
    ? `面板当前默认模型是「${nameOf(reason.defaultModel)}」。`
    : "";
  const switchSuggestion = reason.defaultModel
    ? `或改用「${nameOf(reason.defaultModel)}」继续对话`
    : "或改用运行中的模型继续对话";
  return `「${requested}」还没启动，当前运行的是「${runningList}」。${busy}${defaultHint}`
    + `到 ${PANEL_PATH} 里启动「${requested}」，${switchSuggestion}。`
    + AUTO_SWITCH_HINT;
}
