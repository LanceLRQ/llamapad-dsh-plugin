import { describe, expect, it, vi } from "vitest";
import { createPanelApi, type PanelRemoteNamespace } from "../../src/client/rpc";
import type { CardSnapshot } from "../../src/rpc-contract";

function fakeSnapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    models: [],
    running: null,
    // 本文件测的是 RPC 外壳拆解，不涉及 phase/startedAt 的推导逻辑（那是
    // client-state.test.ts 的范围），这里两处用例都会把 running 覆盖成 "m1"，
    // 语义上是一个已就绪、可服务的运行中模型，所以默认给 "ready"；startedAt
    // 具体值本文件不断言，留 null（契约允许的合法值）即可。
    phase: "ready",
    startedAt: null,
    inferring: null,
    openUrl: "http://panel.local",
    panelError: null,
    // 本文件不测连接配置区（那是 saveConnection 专属，client-rpc.test.ts 只测既有三个
    // 方法的外壳拆解），给一个合法占位即可。
    connection: { panelUrl: "http://panel.local", tokenConfigured: false },
    ...overrides,
  };
}

// dsh 的 RPC 面是「返回 Result、不抛错」的外壳：{ok:true,value} | {ok:false,error}。
// createPanelApi 负责在这里把外壳拆开，成功给业务值，失败转成真正的 Error 抛出，
// 这样卡片组件里只需要 try/catch，不用满地判断 .ok。
describe("createPanelApi", () => {
  it("snapshot 成功 → 直接返回 value", async () => {
    const value = fakeSnapshot({ running: "m1" });
    const namespace: PanelRemoteNamespace = {
      snapshot: vi.fn(async () => ({ ok: true as const, value })),
      start: vi.fn(),
      stop: vi.fn(),
      saveConnection: vi.fn(),
    };
    const api = createPanelApi(namespace);
    await expect(api.snapshot()).resolves.toEqual(value);
  });

  it("snapshot 失败 → 抛出携带 code 与 message 的 Error", async () => {
    const namespace: PanelRemoteNamespace = {
      snapshot: vi.fn(async () => ({ ok: false as const, error: { code: "PANEL_UNREACHABLE", message: "连接超时" } })),
      start: vi.fn(),
      stop: vi.fn(),
      saveConnection: vi.fn(),
    };
    const api = createPanelApi(namespace);
    await expect(api.snapshot()).rejects.toThrow(/PANEL_UNREACHABLE/);
    await expect(api.snapshot()).rejects.toThrow(/连接超时/);
  });

  it("start 成功 → 透传形参并返回新 snapshot", async () => {
    const value = fakeSnapshot({ running: "m1" });
    const start = vi.fn(async (model: string) => ({ ok: true as const, value: { ...value, running: model } }));
    const api = createPanelApi({ snapshot: vi.fn(), start, stop: vi.fn(), saveConnection: vi.fn() });
    await expect(api.start("m1")).resolves.toEqual({ ...value, running: "m1" });
    // signal 形参缺席时也按两位传（undefined 占位），保持 namespace 调用形状稳定
    expect(start).toHaveBeenCalledWith("m1", undefined);
  });

  it("stop 失败 → 抛出 Error 且不吞掉底层 message", async () => {
    const stop = vi.fn(async () => ({ ok: false as const, error: { code: "DRAIN_TIMEOUT", message: "排空超时" } }));
    const api = createPanelApi({ snapshot: vi.fn(), start: vi.fn(), stop, saveConnection: vi.fn() });
    await expect(api.stop("m1")).rejects.toThrow(/DRAIN_TIMEOUT/);
    expect(stop).toHaveBeenCalledWith("m1", undefined);
  });

  it("start 的 signal 形参透传（取消手势要一路带到 host）", async () => {
    const start = vi.fn(async () => ({ ok: true as const, value: fakeSnapshot() }));
    const api = createPanelApi({ snapshot: vi.fn(), start, stop: vi.fn(), saveConnection: vi.fn() });
    const controller = new AbortController();
    await api.start("m1", controller.signal);
    expect(start).toHaveBeenCalledWith("m1", controller.signal);
  });

  it("stop 的 signal 形参透传", async () => {
    const stop = vi.fn(async () => ({ ok: true as const, value: fakeSnapshot() }));
    const api = createPanelApi({ snapshot: vi.fn(), start: vi.fn(), stop, saveConnection: vi.fn() });
    const controller = new AbortController();
    await api.stop("m1", controller.signal);
    expect(stop).toHaveBeenCalledWith("m1", controller.signal);
  });
});
