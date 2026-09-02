import { describe, expect, it, vi } from "vitest";
import {
  buildListModelsTool,
  buildStartModelTool,
  buildStatusTool,
  buildStopModelTool,
  LIST_MODELS_LIMIT,
} from "../../src/tools";
import { PanelError, type PanelClient, type PanelModelView } from "../../src/panel-client";
import { createModelGate } from "../../src/switching";

function fakeExec(signal: AbortSignal = new AbortController().signal): any {
  return {
    signal,
    callId: "c1" as any,
    rootCallId: "c1" as any,
    name: "test",
    arguments: {},
    token: Symbol("t"),
    deferContext: () => {},
    concludeTurn: () => {},
  };
}

function fakeClient(overrides: Partial<PanelClient> = {}): PanelClient {
  // start / stop 与 runtimeStatus 之间保持状态联动：切换门的就绪轮询判定的是「**目标模型**
  // 是否已就绪」（switching.ts 的 probeReady），替身若永远报 running:null，轮询会一直等不到
  // 自己而空转到超时。联动后这份替身才对得上真实面板的语义。
  let running: string | null = null;
  return {
    baseUrl: "http://panel",
    listModels: async () => [],
    getModel: async () => null,
    runtimeStatus: async () => ({ running: running === null ? null : { model: running, ready: true } }),
    startModel: async (name: string) => { running = name; },
    stopModel: async () => { running = null; return { ok: true }; },
    llamaHealth: async () => true,
    ...overrides,
  } as PanelClient;
}

describe("llamapad_status", () => {
  it("面板不可达 → panelReachable:false, running:false（不抛错）", async () => {
    const client = fakeClient({
      runtimeStatus: async () => { throw new PanelError("面板不可达", "PANEL_UNREACHABLE"); },
    });
    const value = await buildStatusTool(client).execute({}, fakeExec());
    expect(value).toEqual({ panelReachable: false, running: false });
  });

  it("非 PanelError 异常照抛", async () => {
    const client = fakeClient({ runtimeStatus: async () => { throw new Error("boom"); } });
    await expect(buildStatusTool(client).execute({}, fakeExec())).rejects.toThrow("boom");
  });

  it("无模型在跑", async () => {
    const client = fakeClient({ runtimeStatus: async () => ({ running: null }) });
    const value = await buildStatusTool(client).execute({}, fakeExec());
    expect(value).toEqual({ panelReachable: true, running: false });
  });

  it("运行中 + busy 已知 → 带 inferring/slotsRunning", async () => {
    const client = fakeClient({
      runtimeStatus: async () => ({
        running: { model: "a", displayName: "A", hostPort: 18080 },
        busy: { inferring: true, slotsRunning: 2 },
      }),
    });
    const value = await buildStatusTool(client).execute({}, fakeExec());
    expect(value).toEqual({
      panelReachable: true,
      running: true,
      model: "a",
      displayName: "A",
      hostPort: 18080,
      inferring: true,
      slotsRunning: 2,
    });
  });

  it("busy 为 null（不可知）→ 不渲染 inferring/slotsRunning，不伪造成 false", async () => {
    const client = fakeClient({
      runtimeStatus: async () => ({ running: { model: "a" }, busy: null }),
    });
    const value: any = await buildStatusTool(client).execute({}, fakeExec());
    expect(value).toEqual({ panelReachable: true, running: true, model: "a" });
    expect("inferring" in value).toBe(false);
    expect("slotsRunning" in value).toBe(false);
  });

  it("render：面板不可达时输出可读摘要", () => {
    const tool = buildStatusTool(fakeClient());
    const blocks = tool.output.render({}, { panelReachable: false, running: false });
    expect(blocks).toEqual([{ type: "text", text: "llamapad 面板不可达" }]);
  });
});

describe("llamapad_list_models", () => {
  it("正常列表：按 name 升序，quant 为 null 时省略字段", async () => {
    const client = fakeClient({
      listModels: async () => [
        { name: "b", displayName: "B", namespace: "main", quant: null, sizeBytes: 2, hostPort: 1, status: "stopped" },
        { name: "a", displayName: "A", namespace: "main", quant: "Q4_K_M", sizeBytes: 1, hostPort: 1, status: "running" },
      ],
    });
    const value: any = await buildListModelsTool(client).execute({}, fakeExec());
    expect(value.models.map((m: any) => m.name)).toEqual(["a", "b"]);
    expect(value.models[0].quant).toBe("Q4_K_M");
    expect("quant" in value.models[1]).toBe(false);
    expect(value.total).toBe(2);
    expect(value.truncated).toBe(false);
  });

  it("超过上限 → 截断为 100 条，total 仍是真实总数", async () => {
    const many: PanelModelView[] = Array.from({ length: LIST_MODELS_LIMIT + 20 }, (_, i) => ({
      name: `m${String(i).padStart(3, "0")}`,
      displayName: `M${i}`,
      namespace: "main",
      quant: null,
      sizeBytes: 1,
      hostPort: 1,
      status: "stopped",
    }));
    const client = fakeClient({ listModels: async () => many });
    const value: any = await buildListModelsTool(client).execute({}, fakeExec());
    expect(value.models).toHaveLength(LIST_MODELS_LIMIT);
    expect(value.total).toBe(LIST_MODELS_LIMIT + 20);
    expect(value.truncated).toBe(true);
    expect(value.models[0].name).toBe("m000");
  });
});

describe("llamapad_start_model", () => {
  it("默认参数：走共享门，drain 默认 true，等待就绪后 waitedReady:true", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    const ensureSpy = vi.spyOn(gate, "ensure");
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    const value = await tool.execute({ model: "a" }, fakeExec());
    expect(value).toEqual({ started: true, model: "a", waitedReady: true });
    expect(ensureSpy).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ drain: true, timeoutMs: 300000, pollIntervalMs: 2000 }),
    );
  });

  it("waitReady:false 且模型未就绪 → 不抛错，直接返回 waitedReady:false", async () => {
    const client = fakeClient({ llamaHealth: async () => false });
    const gate = createModelGate(client);
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    const value = await tool.execute({ model: "a", waitReady: false }, fakeExec());
    expect(value).toEqual({ started: true, model: "a", waitedReady: false });
  });

  it("waitReady:false 但已就绪 → waitedReady:true（真实探测到健康，不是硬编码 false）", async () => {
    const client = fakeClient({ llamaHealth: async () => true });
    const gate = createModelGate(client);
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    const value = await tool.execute({ model: "a", waitReady: false }, fakeExec());
    expect(value).toEqual({ started: true, model: "a", waitedReady: true });
  });

  // 回归：waitReady:false 一度用 timeoutMs:0 表达，而同目标 ensure 会合流——
  // 0ms 预算会被合流上来的等待者（A 形态聊天路径）继承而立刻 START_TIMEOUT，
  // 本次调用也会错把别人预算下的超时当成自己的结果。共享门让这条跨入口生效。
  it("waitReady:false 走 ensure 的 waitReady 开关，不传 0ms 预算", async () => {
    const client = fakeClient({ llamaHealth: async () => false });
    const gate = createModelGate(client);
    const ensureSpy = vi.spyOn(gate, "ensure");
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    await tool.execute({ model: "a", waitReady: false }, fakeExec());
    expect(ensureSpy).toHaveBeenCalledWith(
      "a",
      expect.objectContaining({ waitReady: false, timeoutMs: 300000 }),
    );
  });

  it("模型不存在 → 照抛，不吞错", async () => {
    const client = fakeClient({
      startModel: async () => { throw new PanelError("模型不存在: a", "MODEL_NOT_FOUND", 404); },
    });
    const gate = createModelGate(client);
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    await expect(tool.execute({ model: "a" }, fakeExec())).rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("drain:false 时不透传 drain 给 gate.ensure", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    const ensureSpy = vi.spyOn(gate, "ensure");
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    await tool.execute({ model: "a", drain: false }, fakeExec());
    const options = ensureSpy.mock.calls[0]![1] as Record<string, unknown>;
    expect("drain" in options).toBe(false);
  });

  it("timeoutMs 参数覆盖插件默认的 startTimeoutMs", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    const ensureSpy = vi.spyOn(gate, "ensure");
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    await tool.execute({ model: "a", timeoutMs: 5000 }, fakeExec());
    expect(ensureSpy).toHaveBeenCalledWith("a", expect.objectContaining({ timeoutMs: 5000 }));
  });

  it("必须经共享门：start 走的是传入的 gate 实例，而非另起一把门", async () => {
    const client = fakeClient();
    const gate = createModelGate(client);
    const ensureSpy = vi.spyOn(gate, "ensure");
    const tool = buildStartModelTool(client, gate, { startTimeoutMs: 300000, pollIntervalMs: 2000 });
    await tool.execute({ model: "a" }, fakeExec());
    expect(ensureSpy).toHaveBeenCalledTimes(1);
  });
});

describe("llamapad_stop_model", () => {
  it("没有模型在跑 → stopped:false，不抛错", async () => {
    const client = fakeClient({ runtimeStatus: async () => ({ running: null }) });
    const value = await buildStopModelTool(client).execute({}, fakeExec());
    expect(value).toEqual({ stopped: false });
  });

  it("有模型在跑 → 停止并透传 drainReason", async () => {
    const client = fakeClient({
      runtimeStatus: async () => ({ running: { model: "a" } }),
      stopModel: async (name: string, opts: any) => {
        expect(name).toBe("a");
        expect(opts).toEqual({ drain: true });
        return { ok: true, drain: { drained: true, reason: "idle" } };
      },
    });
    const value = await buildStopModelTool(client).execute({}, fakeExec());
    expect(value).toEqual({ stopped: true, model: "a", drainReason: "idle" });
  });

  it("drain:false 时不透传 drain 给 stopModel", async () => {
    const client = fakeClient({
      runtimeStatus: async () => ({ running: { model: "a" } }),
      stopModel: async (_name: string, opts: any) => {
        expect(opts).toEqual({});
        return { ok: true };
      },
    });
    const value = await buildStopModelTool(client).execute({ drain: false }, fakeExec());
    expect(value).toEqual({ stopped: true, model: "a" });
  });

  it("drainTimeoutMs 透传给 stopModel", async () => {
    const client = fakeClient({
      runtimeStatus: async () => ({ running: { model: "a" } }),
      stopModel: async (_name: string, opts: any) => {
        expect(opts).toEqual({ drain: true, drainTimeoutMs: 5000 });
        return { ok: true };
      },
    });
    await buildStopModelTool(client).execute({ drainTimeoutMs: 5000 }, fakeExec());
  });
});
