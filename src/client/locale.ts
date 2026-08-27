// 卡片的中英文词典。命名空间与 rpc-contract.ts 的两个命名空间都不是同一个东西：
// 这里只是 dsh 本地化系统的 dictionary key，随便起，不受 settingsNamespace() 的
// kebab-case 校验约束（那条约束只管 SETTINGS_NAMESPACE）。
export const LOCALE_NS = "llamapad-panel-card";

export type LocaleKey = keyof typeof zh;

export const zh = {
  title: "llamapad 模型面板",
  openPanel: "在浏览器中打开面板",
  loading: "正在读取面板状态…",
  panelUnavailable: "暂时无法连接到面板。",
  refreshFailed: "状态刷新失败，下方显示的是上一次读到的内容。",
  noModelRunning: "当前没有模型在运行",
  runningModel: "正在运行：{name}",
  inferring: "推理中",
  idle: "空闲",
  inferringUnknown: "推理状态未知",
  start: "启动",
  stop: "停止",
  startPending: "启动中…",
  stopPending: "停止中（可能需要等待现有请求处理完毕，最长约 60 秒）…",
  missingFile: "模型文件缺失",
  missingMmproj: "mmproj 文件缺失",
} as const;

export const en = {
  title: "llamapad Model Panel",
  openPanel: "Open panel in browser",
  loading: "Loading panel status…",
  panelUnavailable: "The panel is temporarily unreachable.",
  refreshFailed: "Refresh failed; showing the last known state.",
  noModelRunning: "No model is running",
  runningModel: "Running: {name}",
  inferring: "Inferring",
  idle: "Idle",
  inferringUnknown: "Inference state unknown",
  start: "Start",
  stop: "Stop",
  startPending: "Starting…",
  stopPending: "Stopping (may wait up to ~60s to drain in-flight requests)…",
  missingFile: "Model file missing",
  missingMmproj: "mmproj file missing",
} satisfies Record<LocaleKey, string>;
