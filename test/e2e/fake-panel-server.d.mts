import type { Server } from "node:http";

/** 假面板测试资产（fake-panel-server.mjs）的类型声明：allowJs 关闭，仅测试侧使用 */
export interface FakePanelEvent {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

export interface FakePanelState {
  running: string | null;
  readyAt: number;
  starts: string[];
  stops: string[];
  chatRequests: Array<Record<string, unknown>>;
  busy: { inferring: boolean; slotsRunning: number } | null;
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
}

export function createFakePanel(options?: { loadMs?: number }): FakePanel;
