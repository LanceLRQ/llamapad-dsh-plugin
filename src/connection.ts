import { PanelError, type PanelClient } from "./panel-client";
import type { Config } from "./index";

/**
 * 连接参数的读取、比较与未配置态占位。
 *
 * 单独成文件而不是塞进 index.ts：index.ts 是接线现场（谁注册谁、什么顺序），
 * 这里是「什么算一次连接、两次连接算不算同一个」的判定，纯数据、可单测。
 * 也不放进 panel-client.ts——那边是 HTTP 客户端本身，不该认识 Config 这个概念。
 */

/** 一次面板连接的全部构成要素：任一变化都必须换一套 client。 */
export interface ConnectionParams {
  panelUrl: string;
  token: string;
  mode: string;
  llamaBaseUrl?: string;
  requestTimeoutMs: number;
}

export function readConnection(config: Config): ConnectionParams {
  return {
    panelUrl: config.panelUrl ?? "",
    token: config.token ?? "",
    mode: config.mode,
    ...(config.llamaBaseUrl ? { llamaBaseUrl: config.llamaBaseUrl } : {}),
    requestTimeoutMs: config.requestTimeoutMs,
  };
}

/** 地址与 token 都非空白才算能连——两者缺一，任何请求都只会 401 或连不上。 */
export function isConnectionComplete(params: ConnectionParams): boolean {
  return params.panelUrl.trim() !== "" && params.token.trim() !== "";
}

/**
 * 要不要换一套 client。逐字段比而不是 JSON.stringify：字段少、意图明确，
 * 且 stringify 会因为 llamaBaseUrl 这种可选键的有无而给出「变了」的假阳性。
 * requestTimeoutMs 也要比——createPanelClient 在构造期就把它固化进去了。
 */
export function connectionChanged(
  prev: ConnectionParams | null,
  next: ConnectionParams,
): boolean {
  if (prev === null) return true;
  return prev.panelUrl !== next.panelUrl
    || prev.token !== next.token
    || prev.mode !== next.mode
    || prev.llamaBaseUrl !== next.llamaBaseUrl
    || prev.requestTimeoutMs !== next.requestTimeoutMs;
}

const UNCONFIGURED_MESSAGE =
  "尚未配置 llamapad 面板地址与 token。请在 设置 → 插件配置 → llamapad 模型面板 里填写。";

function unconfigured(): never {
  throw new PanelError(UNCONFIGURED_MESSAGE, "PANEL_UNREACHABLE", 0);
}

/**
 * 未配置态的占位 client：让 adapter / gateway 照常注册，用户在模型选择器里
 * 仍看得见 provider，点下去得到的是一句指路，而不是一个查不出原因的空列表。
 *
 * 两个例外不抛错，因为它们的契约本身就允许「不可知」，抛错反而会破坏调用方的降级路径：
 * llamaHealth 是布尔探测（false=不健康），getReasoningInfo 是「不可知一律 null」。
 */
export function createUnconfiguredClient(): PanelClient {
  return {
    baseUrl: "",
    listModels: async () => unconfigured(),
    getModel: async () => unconfigured(),
    getEffectiveConfig: async () => unconfigured(),
    runtimeStatus: async () => unconfigured(),
    startModel: async () => unconfigured(),
    stopModel: async () => unconfigured(),
    getReasoningInfo: async () => null,
    llamaHealth: async () => false,
  };
}
