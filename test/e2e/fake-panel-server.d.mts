import type { Server } from "node:http";

/** 假面板测试资产（fake-panel-server.mjs）的类型声明：allowJs 关闭，仅测试侧使用 */
export interface FakePanelState {
  running: string | null;
  readyAt: number;
  starts: string[];
  stops: string[];
  chatRequests: Array<Record<string, unknown>>;
  busy: { inferring: boolean; slotsRunning: number } | null;
}

export interface FakePanel {
  server: Server;
  state: FakePanelState;
}

export function createFakePanel(options?: { loadMs?: number }): FakePanel;
