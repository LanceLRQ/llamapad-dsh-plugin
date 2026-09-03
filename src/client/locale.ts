// 卡片的中英文词典。命名空间与 rpc-contract.ts 的两个命名空间都不是同一个东西：
// 这里只是 dsh 本地化系统的 dictionary key，随便起，不受 settingsNamespace() 的
// kebab-case 校验约束（那条约束只管 SETTINGS_NAMESPACE）。
export const LOCALE_NS = "llamapad-panel-card";

export type LocaleKey = keyof typeof zh;

export const zh = {
  title: "llamapad 模型面板",
  subtitle: "本地 llama.cpp 模型的启停与状态。",
  expand: "展开",
  collapse: "收起",
  openPanel: "在浏览器中打开面板",
  loading: "正在读取面板状态…",
  panelUnavailable: "暂时无法连接到面板。",
  refreshFailed: "状态刷新失败，下方显示的是上一次读到的内容。",
  noModelRunning: "当前没有模型在运行",
  loadingModel: "正在加载模型 {name}（已 {sec}s）",
  loadingModelLong: "正在加载模型 {name}（已 {min}分{sec}秒）",
  loadingModelPlain: "正在加载模型 {name}…",
  runningModel: "正在运行：{name}",
  inferring: "推理中",
  idle: "空闲",
  inferringUnknown: "推理状态未知",
  start: "启动",
  stop: "停止",
  // 在途动作行的按钮文案：点击是取消在途等待（含 60s+ 的排空），不是再发一次动作
  cancelAction: "取消等待",
  stopPendingHint: "停止前会等待在途请求处理完毕，最长约 60 秒。",
  missingFile: "模型文件缺失",
  missingMmproj: "mmproj 文件缺失",
  connTitle: "连接设置",
  connUrlLabel: "面板地址",
  connUrlPlaceholder: "http://192.168.1.10:8080",
  connTokenLabel: "API token",
  connTokenKeep: "留空则保持当前已配置的 token 不变",
  connTokenReplace: "保存后将覆盖当前的 token",
  connTokenUnset: "尚未配置 token，面板会拒绝所有请求",
  connUrlRequired: "面板地址不能为空",
  connSave: "保存",
  connSaving: "保存中…",
  connSaved: "已保存，正在用新配置重连",
  // 事件流小节的标题。Toast 的文案**不走词典**：直接用事件自带的 message——
  // 面板侧事件 message 本身就是中文人类可读文本（「模型 xxx 已启动」），逐 kind
  // 翻译会随面板事件表无界膨胀，en 环境下宁可原样显示也不维护一份必然滞后的映射。
  eventsTitle: "最近事件",
} as const;

export const en = {
  title: "llamapad Model Panel",
  subtitle: "Start, stop and watch local llama.cpp models.",
  expand: "Expand",
  collapse: "Collapse",
  openPanel: "Open panel in browser",
  loading: "Loading panel status…",
  panelUnavailable: "The panel is temporarily unreachable.",
  refreshFailed: "Refresh failed; showing the last known state.",
  noModelRunning: "No model is running",
  loadingModel: "Loading {name}… ({sec}s)",
  loadingModelLong: "Loading {name}… ({min}m{sec}s)",
  loadingModelPlain: "Loading {name}…",
  runningModel: "Running: {name}",
  inferring: "Inferring",
  idle: "Idle",
  inferringUnknown: "Inference state unknown",
  start: "Start",
  stop: "Stop",
  // In-flight action row button: clicking cancels the pending wait (incl. 60s+ drain)
  cancelAction: "Cancel",
  stopPendingHint: "Waiting for in-flight requests to drain before stopping (up to ~60s).",
  missingFile: "Model file missing",
  missingMmproj: "mmproj file missing",
  connTitle: "Connection",
  connUrlLabel: "Panel URL",
  connUrlPlaceholder: "http://192.168.1.10:8080",
  connTokenLabel: "API token",
  connTokenKeep: "Leave blank to keep the configured token",
  connTokenReplace: "Saving will replace the current token",
  connTokenUnset: "No token configured; the panel will reject every request",
  connUrlRequired: "Panel URL is required",
  connSave: "Save",
  connSaving: "Saving…",
  connSaved: "Saved. Reconnecting with the new settings.",
  // Toast text intentionally bypasses this dictionary; see the zh entry's comment.
  eventsTitle: "Recent activity",
} satisfies Record<LocaleKey, string>;
