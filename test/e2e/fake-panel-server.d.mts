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
}

export interface FakePanel {
  server: Server;
  state: FakePanelState;
}

export function createFakePanel(options?: { loadMs?: number }): FakePanel;
