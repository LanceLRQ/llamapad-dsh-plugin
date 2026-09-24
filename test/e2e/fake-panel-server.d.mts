import type { Server } from "node:http";

/** 假面板测试资产（fake-panel-server.mjs）的类型声明：allowJs 关闭，仅测试侧使用 */
export interface FakePanelEvent {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

/** 多模型模式（multiModel:true）下 state.runtime 的单个条目形状——见 FakePanelState.runtime */
export interface FakePanelRuntimeEntry {
  hostPort: number;
  readyAt: number;
  startedAt: string;
}

export interface FakePanelState {
  /** 老面板模式（默认）下的唯一运行态；多模型模式下不再被 start/stop 逻辑写入，
   *  一律为初始值——运行态改看 runtime/defaultModel，见二者注释 */
  running: string | null;
  readyAt: number;
  starts: string[];
  stops: string[];
  chatRequests: Array<Record<string, unknown>>;
  busy: { inferring: boolean; slotsRunning: number } | null;
  /** 老面板模式(false，默认)/多模型模式(true) 开关；createFakePanel 的 multiModel
   *  选项直接落地在这里，创建后不可切档（只读，测试不应改写） */
  readonly multiModel: boolean;
  /** `runtime/status` 的 `starting` 字段开关（默认 true）；createFakePanel 的
   *  supportsStarting 选项直接落地在这里，创建后不可切档（只读，测试不应改写）。
   *  与 multiModel 是独立的轴，见 fake-panel-server.mjs 文件头注释 */
  readonly supportsStarting: boolean;
  /** start 挂起配置：模型名 → 毫秒数（有限值=定时放行，Infinity=只能手动
   *  releaseStart 放行）；测试在调用 start 前写入，见文件头「start 挂起」段落 */
  startHoldMs: Map<string, number>;
  /** 挂起中的 start 请求（键=模型名），随 runtime/status 的 starting 字段一起投影；
   *  测试通常只读不写 */
  pendingStarts: Map<string, { action: "start" | "restart"; since: string; stage: "preparing" | "pulling" | "creating" }>;
  /** 内部：挂起请求的放行回调，供顶层 releaseStart(model) 调用；测试不应直接碰它 */
  startReleasers: Map<string, () => void>;
  /** 多模型模式专用：全部运行中模型各自的运行态，键为模型名。老面板模式下恒为空 Map */
  runtime: Map<string, FakePanelRuntimeEntry>;
  /** 多模型模式专用：不带 model 字段的请求会打给谁；老面板模式下恒为 null */
  defaultModel: string | null;
  /** 事件表（时间升序追加）；start/stop 路由会照真实面板的样子写入 model.* 事件 */
  events: FakePanelEvent[];
  /** 当前挂着的 SSE 连接数（res 对象集合），测试用它等「订阅已建立」 */
  eventStreams: Set<unknown>;
  /** /api/v1/events/stream 的累计连接数（含已断开的） */
  eventConnections: number;
  /** /api/v1/metrics/window 的请求留痕（since 为原始字符串，缺参 null），断言 query 拼装用 */
  metricsRequests: Array<{ range: string; since: string | null }>;
  /** 时序数据（键为指标 id）：full 整窗返回、delta 过滤 ts > since；测试可改写 */
  metricsSeries: Record<string, Array<{ ts: number; value: number }>>;
  /** 故障注入：true 时 /api/v1/metrics/window 回 500 */
  failMetrics: boolean;
  /** 故障注入：true 时 /api/v1/gpu/stats 回 500 */
  failGpu: boolean;
  /** gpu/stats 三态（真实面板透传 nvidia-smi 探测结论），默认 "available" */
  gpuStatus: "probing" | "unavailable" | "available";
  /** 分卡明细（gpuStatus 为 "available" 时下发）；温度/功耗可 null */
  gpuDevices: Array<{
    index: number;
    memUsedMib: number;
    memTotalMib: number;
    utilPercent: number;
    tempC: number | null;
    powerW: number | null;
  }>;
}

export interface FakePanel {
  server: Server;
  state: FakePanelState;
  /** 放行一个挂起中的 start 请求；目标模型当前没有挂起中的请求时是安全的空操作。
   *  见 FakePanelState.startHoldMs / pendingStarts 与文件头「start 挂起」段落 */
  releaseStart(model: string): void;
}

export function createFakePanel(options?: {
  loadMs?: number;
  multiModel?: boolean;
  /** `runtime/status` 的 `starting` 字段开关，默认 true */
  supportsStarting?: boolean;
}): FakePanel;
