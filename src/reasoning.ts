import { ReasoningEffortId, type LlmModelReasoningInfo } from "@deepseek-ai/dsh-llm";

/**
 * 思考强度（reasoning_effort）的纯判定：面板中转层的档位声明 → dsh 档位表。
 *
 * 背景：llama.cpp 是否接受 reasoning_effort 完全取决于 GGUF 内嵌的 chat template 是否读取
 * 这个变量，且同系列不同打包的值域也可能不同——值域只能从当前那份 GGUF 现读，不能按模型名
 * 硬编码。面板已经做完了这件事：它在 `/api/v1/proxy/llama/v1/models` 的响应里给每个条目注入
 * `x_llamapad.reasoning_effort.{supported, levels}`，并在 `/v1/chat/completions` 上按该值域
 * 改写客户端传来的值（别名 → 值域内透传 → 就近取整 → 丢弃字段），兜底策略保证请求一定不失败。
 *
 * 插件因此不复刻面板的改写算法——那等于把面板的规格抄一份到插件里，两边今后必然漂移。
 * 插件只做两件事：把面板的声明读出来（parseReasoningInfo）、映射成 dsh 的档位表
 * （buildReasoningInfo），值怎么改写交给面板。
 */

/** 面板 `x_llamapad.reasoning_effort` 的插件侧投影（aliases / rounding 是面板内部策略，插件不消费） */
export interface PanelReasoningInfo {
  /** 面板判定该模型的 chat template 是否支持 reasoning_effort。
   *  面板对 unsupported 与 unknown（GGUF 未内嵌模板）都报 false，插件区分不了也不必区分 */
  supported: boolean;
  /** 模板接受的值域；面板提取不到时为 null */
  levels: string[] | null;
}

/** 完整档位枚举，与面板 lib/reasoning-effort.ts 的 ALL_LEVELS 一致（值域未知时的兜底） */
export const ALL_EFFORT_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

/** 阶梯档位的中文显示名；阶梯外的自定义档位回退为 id 本身 */
const EFFORT_LABELS: Record<string, string> = {
  minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高",
};

/**
 * 从面板增强过的 `/v1/models` 响应里取出思考强度声明。
 * 形状不符（老面板没有 x_llamapad、JSON 结构意外、data 为空）一律返回 null——
 * 这是「没问到」而非「不支持」，两者在 buildReasoningInfo 里的处理刻意不同。
 */
export function parseReasoningInfo(body: unknown): PanelReasoningInfo | null {
  if (typeof body !== "object" || body === null) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const first = data[0];
  if (typeof first !== "object" || first === null) return null;
  const extra = (first as { x_llamapad?: unknown }).x_llamapad;
  if (typeof extra !== "object" || extra === null) return null;
  const effort = (extra as { reasoning_effort?: unknown }).reasoning_effort;
  if (typeof effort !== "object" || effort === null) return null;
  const { supported, levels } = effort as { supported?: unknown; levels?: unknown };
  if (typeof supported !== "boolean") return null;
  const clean = Array.isArray(levels) ? levels.filter((l): l is string => typeof l === "string") : [];
  return { supported, levels: clean.length > 0 ? clean : null };
}

/**
 * 面板声明 → dsh 档位表。三种输入对应三种处理，差别是有意的：
 *
 * - `supported: false`：面板问过了，答案是「这个模板不吃这个参数」——不上报，
 *   不给用户一个选了也不生效的选择器
 * - `supported: true`：上报。值域已知就只列这几档；未知（levels 为 null）列完整枚举，
 *   反正 proxy 模式下面板会把值域外的取值就近改写或丢弃，用户选不坏
 * - `null`（没问到：模型未运行拿不到声明，或端点不可用）：同样列完整枚举。
 *   面板的档位声明只对**当前运行中**的模型有效（中转层用运行中容器的模型组装响应），
 *   未运行模型永远走这条分支——「不知道」不该退化成「没有」，否则用户在切换模型之前
 *   看不到该模型能选什么
 */
export function buildReasoningInfo(panel: PanelReasoningInfo | null): LlmModelReasoningInfo | undefined {
  if (panel !== null && !panel.supported) return undefined;
  const levels = panel?.levels && panel.levels.length > 0 ? panel.levels : [...ALL_EFFORT_LEVELS];
  return {
    efforts: levels.map((id) => ({
      id: ReasoningEffortId(id),
      name: EFFORT_LABELS[id] ?? id,
    })),
  };
}
