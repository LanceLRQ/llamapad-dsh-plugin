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

export function formatRouteBlock(reason: RouteBlockReason, nameOf: ModelNameResolver): string {
  const requested = nameOf(reason.requestedModel);

  // 容器已起、llama-server 还在读权重：等一下就好，既不用去面板操作也不用换档，
  // 所以这一支既不给引导也不给 auto-switch 提示，只说清楚「在等什么、要等多久」。
  if (reason.kind === "not-ready") {
    const loading = nameOf(reason.runningModel ?? reason.requestedModel);
    return `「${loading}」正在加载中，大模型通常要几十秒，稍等片刻再发送。`;
  }

  // busy 为 null 是「不可知」而非「不忙」，此时不提（宁可不说也不误报）
  const busy = reason.inferring === true ? "目标机器上还有对话正在生成。" : "";

  if (reason.kind === "no-model") {
    return `还没有模型在运行。${busy}到 ${PANEL_PATH} 里启动「${requested}」后再发送。`
      + AUTO_SWITCH_HINT;
  }

  const running = nameOf(reason.runningModel ?? "");
  return `「${requested}」还没启动，当前运行的是「${running}」。${busy}`
    + `到 ${PANEL_PATH} 里启动「${requested}」，或改用「${running}」继续对话。`
    + AUTO_SWITCH_HINT;
}
