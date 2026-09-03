import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { PanelGateway, type PanelGatewayOptions } from "../../src/panel-gateway";
import { RPC_CONTRIBUTION, RPC_METHOD, RPC_NAMESPACE, RPC_WIRE_MODEL, RPC_WIRE_RANGE, RPC_WIRE_SINCE, type MonitorSnapshot } from "../../src/rpc-contract";
import { PanelError, type PanelClient, type PanelModelView, type PanelEvent } from "../../src/panel-client";
import { EnsureError, type ModelGate } from "../../src/switching";

/** Service 构造只用到 ctx.reflect.provide（见 @deepseek-ai/cordis 的 Service 基类）。 */
function fakeCtx(): Context {
  return { reflect: { provide: vi.fn() } } as unknown as Context;
}

function fakeModel(overrides: Partial<PanelModelView> = {}): PanelModelView {
  return {
    name: "a", displayName: "模型 A", namespace: "main",
    quant: "Q4_K_M", sizeBytes: 1, hostPort: 8081, status: "ready",
    ...overrides,
  };
}

function fakeClient(overrides: Partial<PanelClient> = {}): PanelClient {
  return {
    baseUrl: "http://panel:8080",
    listModels: async () => [fakeModel()],
    getModel: async () => null,
    runtimeStatus: async () => ({ running: null, busy: null }),
    startModel: async () => {},
    stopModel: async () => ({ ok: true }),
    llamaHealth: async () => true,
    getMetricsWindow: async () => ({ range: "30m", from: 0, resolution: "5s", series: {}, mode: "full" }),
    getGpuStats: async () => ({ available: false, status: "unavailable", devices: [], totals: null }),
    ...overrides,
  } as PanelClient;
}

function fakeGate(overrides: Partial<ModelGate> = {}): ModelGate {
  return {
    ensure: vi.fn(async () => {}),
    lastStarted: () => null,
    ...overrides,
  };
}

function makeGateway(
  overrides: Partial<PanelGatewayOptions> = {},
  writeSettings: (patch: Record<string, unknown>) => Promise<void> = async () => {},
) {
  const client = overrides.client ?? fakeClient();
  const gate = overrides.gate ?? fakeGate();
  const gateway = new PanelGateway(
    fakeCtx(),
    { panelUrl: "http://panel:8080", token: "", ...overrides, client, gate },
    writeSettings,
  );
  return { gateway, client, gate };
}

describe("PanelGateway", () => {
  describe("snapshot", () => {
    it("正常路径：并发取 listModels 与 runtimeStatus({busy:true})，组装 CardSnapshot", async () => {
      const listModels = vi.fn(async () => [
        fakeModel({ name: "a", status: "running" }),
        fakeModel({ name: "b", status: "ready", quant: null }),
      ]);
      const runtimeStatus = vi.fn(async (options?: { busy?: boolean }) => {
        expect(options).toEqual({ busy: true });
        return { running: { model: "a" }, busy: { inferring: true, slotsRunning: 1 } };
      });
      const { gateway } = makeGateway({ client: fakeClient({ listModels, runtimeStatus }) });

      const snapshot = await gateway.snapshot();

      expect(snapshot).toEqual({
        models: [
          { name: "a", displayName: "模型 A", namespace: "main", quant: "Q4_K_M", status: "running" },
          { name: "b", displayName: "模型 A", namespace: "main", quant: null, status: "ready" },
        ],
        running: "a",
        phase: "ready",
        startedAt: null,
        inferring: true,
        openUrl: "http://panel:8080",
        panelError: null,
        connection: { panelUrl: "http://panel:8080", tokenConfigured: false },
        events: [], // 未接事件环（status-watch 未启用）时为空数组
      });
      expect(listModels).toHaveBeenCalledTimes(1);
      expect(runtimeStatus).toHaveBeenCalledTimes(1);
    });

    it("events 惰性 getter 接线时：事件环内容经 toCardEvent 投影随快照下发（每次现取）", async () => {
      const ring: PanelEvent[] = [
        { id: 2, ts: 1725350400000, kind: "model.stop", message: "停止 qwen3" },
        { id: 3, ts: 1725350500000, kind: "download.complete", message: "下载完成" },
      ];
      const { gateway } = makeGateway({ events: () => [...ring] });

      const snapshot = await gateway.snapshot();
      expect(snapshot.events).toEqual([
        { id: 2, ts: 1725350400000, kind: "model.stop", message: "停止 qwen3" },
        { id: 3, ts: 1725350500000, kind: "download.complete", message: "下载完成" },
      ]);

      // 环是活的：getter 现取意味着下一次快照能看到新事件，不需要重建 gateway
      ring.push({ id: 4, ts: 1725350600000, kind: "model.start", message: "启动 qwen3" });
      const next = await gateway.snapshot();
      expect(next.events).toHaveLength(3);
    });

    it("无运行中模型、busy 为 null：running/inferring 均为 null，phase 为 idle，startedAt 为 null", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({ runtimeStatus: async () => ({ running: null, busy: null }) }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.running).toBeNull();
      expect(snapshot.inferring).toBeNull();
      expect(snapshot.phase).toBe("idle");
      expect(snapshot.startedAt).toBeNull();
    });

    it("listModels 失败：models 兜底为空数组，panelError 非空，不抛错", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          listModels: async () => { throw new PanelError("llamapad 面板不可达: http://panel:8080", "PANEL_UNREACHABLE"); },
        }),
      });
      await expect(gateway.snapshot()).resolves.toMatchObject({
        models: [],
        running: null,
        inferring: null,
        panelError: expect.stringContaining("面板不可达"),
      });
    });

    it("runtimeStatus 失败：running/inferring 兜底为 null，panelError 非空，models 仍来自 listModels", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => { throw new PanelError("llamapad token 无效或未授权", "AUTH"); },
        }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.models).toHaveLength(1);
      expect(snapshot.running).toBeNull();
      expect(snapshot.inferring).toBeNull();
      expect(snapshot.panelError).toContain("token");
      // runtimeStatus 整体 rejected 时 running 本来就折算成 null，phase 走跟 running
      // 为 null 时同一条规则得到 idle，不需要为"rejected"单独分支。
      expect(snapshot.phase).toBe("idle");
    });
  });

  describe("phase 判定（/health 与 /slots 状态码同步性推导出的三态）", () => {
    it("busy 非 null：phase 为 ready，且不调用 llamaHealth（稳态零开销的守卫）", async () => {
      const llamaHealth = vi.fn(async () => true);
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({
            running: { model: "a", startedAt: "2026-08-28T00:00:00.000Z" },
            busy: { inferring: false, slotsRunning: 0 },
          }),
          llamaHealth,
        }),
      });

      const snapshot = await gateway.snapshot();

      expect(snapshot.phase).toBe("ready");
      expect(llamaHealth).not.toHaveBeenCalled();
    });

    it("busy 为 null 且 llamaHealth 探测成功：phase 为 ready", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({ running: { model: "a" }, busy: null }),
          llamaHealth: async () => true,
        }),
      });

      const snapshot = await gateway.snapshot();

      expect(snapshot.phase).toBe("ready");
    });

    it("busy 为 null 且 llamaHealth 探测失败：phase 为 starting（加载窗口）", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({ running: { model: "a" }, busy: null }),
          llamaHealth: async () => false,
        }),
      });

      const snapshot = await gateway.snapshot();

      expect(snapshot.phase).toBe("starting");
    });

    it("startedAt 从面板响应的 running.startedAt 透传到 snapshot", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({
            running: { model: "a", startedAt: "2026-08-28T01:23:45.000Z" },
            busy: { inferring: false, slotsRunning: 0 },
          }),
        }),
      });

      const snapshot = await gateway.snapshot();

      expect(snapshot.startedAt).toBe("2026-08-28T01:23:45.000Z");
    });
  });

  describe("openUrl 回落", () => {
    it("缺省 panelPublicUrl 时回落 panelUrl", async () => {
      const { gateway } = makeGateway({ panelUrl: "http://internal:8080" });
      const snapshot = await gateway.snapshot();
      expect(snapshot.openUrl).toBe("http://internal:8080");
    });

    it("提供 panelPublicUrl 时优先使用", async () => {
      const { gateway } = makeGateway({
        panelUrl: "http://internal:8080",
        panelPublicUrl: "http://public.example.com",
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.openUrl).toBe("http://public.example.com");
    });
  });

  describe("start", () => {
    it("成功：waitReady:false 乐观启动，不做就绪轮询，返回新 snapshot", async () => {
      const ensure = vi.fn(async () => {});
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }) });

      const snapshot = await gateway.start("a");

      expect(ensure).toHaveBeenCalledTimes(1);
      expect(ensure).toHaveBeenCalledWith("a", expect.objectContaining({ waitReady: false }));
      expect(snapshot.panelError).toBeNull();
    });

    it("成功路径 snapshot 带上正确的 phase/startedAt（复用 buildSnapshot，未被裁剪）", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({
            running: { model: "a", startedAt: "2026-08-28T00:00:00.000Z" },
            busy: { inferring: false, slotsRunning: 0 },
          }),
        }),
      });

      const snapshot = await gateway.start("a");

      expect(snapshot.phase).toBe("ready");
      expect(snapshot.startedAt).toBe("2026-08-28T00:00:00.000Z");
    });

    it("排空参数透传：drainOnSwitch/drainTimeoutMs 原样带进 gate.ensure", async () => {
      const ensure = vi.fn(async () => {});
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }), drainOnSwitch: true, drainTimeoutMs: 12345 });

      await gateway.start("a");

      expect(ensure).toHaveBeenCalledWith("a", { waitReady: false, drain: true, drainTimeoutMs: 12345 });
    });

    it("不配置排空参数时不传 drain 字段（不是传 undefined 撑开对象）", async () => {
      const ensure = vi.fn(async () => {});
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }) });

      await gateway.start("a");

      expect(ensure).toHaveBeenCalledWith("a", { waitReady: false });
    });

    it("末位 signal 透传给 gate.ensure 的 options（RPC 取消通道的 host 半身入口）", async () => {
      const ensure = vi.fn(async () => {});
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }) });
      const controller = new AbortController();

      await gateway.start("a", controller.signal);

      expect(ensure).toHaveBeenCalledWith("a", { waitReady: false, signal: controller.signal });
    });

    it("用户取消（signal.aborted）：返回不带 panelError 的快照——取消不是故障，不画红色横幅", async () => {
      const controller = new AbortController();
      const ensure = vi.fn(async () => {
        controller.abort(); // 模拟在途等待被取消后 ensure 抛出
        throw new EnsureError("等待 a 就绪时被取消", "ABORTED");
      });
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }) });

      const snapshot = await gateway.start("a", controller.signal);

      expect(snapshot.panelError).toBeNull();
      expect(snapshot.models).toHaveLength(1); // 快照本体照常组装
    });

    it("gate.ensure 抛错：不外抛，走 panelError，其余字段尽量填", async () => {
      const ensure = vi.fn(async () => { throw new EnsureError("模型不存在: x", "MODEL_NOT_FOUND"); });
      const { gateway } = makeGateway({ gate: fakeGate({ ensure }) });

      const snapshot = await gateway.start("x");

      expect(snapshot.panelError).toContain("模型不存在");
      expect(snapshot.models).toHaveLength(1); // buildSnapshot 仍尽量填了 listModels 的结果
      // 错误分支是 { ...(await this.buildSnapshot()), panelError } 展开出来的，
      // phase 必须跟着 buildSnapshot 走，不能因为展开写法漏掉。
      expect(snapshot.phase).toBe("idle");
    });

    it("model 为空串：属于编程错误，直接抛而不是塞进 panelError", async () => {
      const { gateway } = makeGateway();
      await expect(gateway.start("")).rejects.toThrow();
    });
  });

  describe("stop", () => {
    it("成功：调用 client.stopModel 并带排空参数，返回新 snapshot", async () => {
      const stopModel = vi.fn(async () => ({ ok: true as const }));
      const { gateway } = makeGateway({
        client: fakeClient({ stopModel }),
        drainOnSwitch: false,
        drainTimeoutMs: 5000,
      });

      const snapshot = await gateway.stop("a");

      expect(stopModel).toHaveBeenCalledWith("a", { drain: false, drainTimeoutMs: 5000 });
      expect(snapshot.panelError).toBeNull();
    });

    it("成功路径 snapshot 带上正确的 phase/startedAt（复用 buildSnapshot，未被裁剪）", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          runtimeStatus: async () => ({
            running: { model: "a", startedAt: "2026-08-28T00:00:00.000Z" },
            busy: { inferring: false, slotsRunning: 0 },
          }),
        }),
      });

      const snapshot = await gateway.stop("a");

      expect(snapshot.phase).toBe("ready");
      expect(snapshot.startedAt).toBe("2026-08-28T00:00:00.000Z");
    });

    it("client.stopModel 抛错：不外抛，走 panelError", async () => {
      const stopModel = vi.fn(async () => { throw new PanelError("停止失败: 服务异常", "PANEL_HTTP", 500); });
      const { gateway } = makeGateway({ client: fakeClient({ stopModel }) });

      const snapshot = await gateway.stop("a");

      expect(snapshot.panelError).toContain("停止失败");
      // 同 start() 的错误分支，展开写法不能漏掉 phase。
      expect(snapshot.phase).toBe("idle");
    });

    it("model 为空串：属于编程错误，直接抛而不是塞进 panelError", async () => {
      const { gateway } = makeGateway();
      await expect(gateway.stop("")).rejects.toThrow();
    });

    it("末位 signal 透传给 client.stopModel 的 options", async () => {
      const stopModel = vi.fn(async () => ({ ok: true as const }));
      const { gateway } = makeGateway({ client: fakeClient({ stopModel }) });
      const controller = new AbortController();

      await gateway.stop("a", controller.signal);

      expect(stopModel).toHaveBeenCalledWith("a", { signal: controller.signal });
    });

    it("用户取消（signal.aborted）：返回不带 panelError 的快照（与 start 同一条取消语义）", async () => {
      const controller = new AbortController();
      const stopModel = vi.fn(async () => {
        controller.abort();
        throw new PanelError("llamapad 面板不可达: http://panel:8080", "PANEL_UNREACHABLE");
      });
      const { gateway } = makeGateway({ client: fakeClient({ stopModel }) });

      const snapshot = await gateway.stop("a", controller.signal);

      expect(snapshot.panelError).toBeNull();
      expect(snapshot.models).toHaveLength(1);
    });

    it("stopModel 抛 RUNTIME_BUSY：panelError 直出面板原文，不套「面板请求失败」的壳", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          stopModel: async () => {
            throw new PanelError("运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试", "RUNTIME_BUSY", 409);
          },
        }),
      });

      const snapshot = await gateway.stop("a");

      expect(snapshot.panelError).toBe("运行时忙：正在启动模型 qwen3，请等待当前操作完成后再试");
    });
  });

  describe("monitor", () => {
    const windowFixture = {
      range: "30m" as const,
      from: 1_700_000_000_000,
      resolution: "5s" as const,
      series: {
        "infer.tokens_per_sec": [{ ts: 1_700_000_000_000, value: 12.5 }],
        "container.cpu_percent": [{ ts: 1_700_000_000_000, value: 42 }],
      },
      mode: "full" as const,
    };
    const gpuFixture = {
      available: true,
      status: "available" as const,
      devices: [{ index: 0, memUsedMib: 1024, memTotalMib: 24564, utilPercent: 42, tempC: 61, powerW: 250.5 }],
      totals: { memUsedMib: 1024, memTotalMib: 24564 },
    };

    it("正常路径：metrics 窗口与 gpu/stats 并发合并成 MonitorSnapshot，serverTs 是组装时刻", async () => {
      const getMetricsWindow = vi.fn(async () => windowFixture);
      const getGpuStats = vi.fn(async () => gpuFixture);
      const before = Date.now();
      const { gateway } = makeGateway({ client: fakeClient({ getMetricsWindow, getGpuStats }) });

      const snapshot = await gateway.monitor("30m", undefined);

      expect(Date.now()).toBeGreaterThanOrEqual(before);
      expect(snapshot).toEqual({
        series: windowFixture.series,
        gpu: gpuFixture,
        mode: "full",
        serverTs: expect.any(Number),
        panelError: null,
      });
      expect(snapshot.serverTs).toBeGreaterThanOrEqual(before);
      expect(getMetricsWindow).toHaveBeenCalledTimes(1);
      expect(getGpuStats).toHaveBeenCalledTimes(1);
    });

    it("range/since 透传：since 缺省不带键（可选即省略），在场则原样带进 options", async () => {
      const getMetricsWindow = vi.fn(async () => windowFixture);
      const getGpuStats = vi.fn(async () => gpuFixture);
      const { gateway } = makeGateway({ client: fakeClient({ getMetricsWindow, getGpuStats }) });

      await gateway.monitor("2h", undefined);
      expect(getMetricsWindow).toHaveBeenCalledWith("2h", {});

      await gateway.monitor("2h", 1_700_000_004_000);
      expect(getMetricsWindow).toHaveBeenLastCalledWith("2h", { since: 1_700_000_004_000 });
    });

    it("metrics 半边失败：series 兜底空对象、mode 兜底 full、panelError 非空，gpu 半边照常下发", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          getMetricsWindow: async () => { throw new PanelError("llamapad 面板不可达: http://panel:8080", "PANEL_UNREACHABLE"); },
          getGpuStats: async () => gpuFixture,
        }),
      });

      const snapshot = await gateway.monitor("30m", undefined);

      expect(snapshot.series).toEqual({});
      // mode 兜底必须是 full：delta 语义是「追加到已有曲线」，没有基础数据时
      // 浏览器必须走整窗替换，才不会把空缺当成「无新点」静默吞掉
      expect(snapshot.mode).toBe("full");
      expect(snapshot.gpu).toEqual(gpuFixture);
      expect(snapshot.panelError).toContain("面板不可达");
    });

    it("gpu 半边失败：gpu 兜底 null、panelError 非空，series 照常下发（反向半边失败）", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          getMetricsWindow: async () => ({ ...windowFixture, mode: "delta" }),
          getGpuStats: async () => { throw new PanelError("面板请求失败", "PANEL_HTTP", 500); },
        }),
      });

      const snapshot = await gateway.monitor("30m", 1);

      expect(snapshot.series).toEqual(windowFixture.series);
      expect(snapshot.mode).toBe("delta"); // metrics 半边成功时 mode 原样透传
      expect(snapshot.gpu).toBeNull();
      expect(snapshot.panelError).toContain("PANEL_HTTP");
    });

    it("signal 透传给两条拉取的 options（RPC 取消通道 → 两条在途请求）", async () => {
      const getMetricsWindow = vi.fn(async () => windowFixture);
      const getGpuStats = vi.fn(async () => gpuFixture);
      const { gateway } = makeGateway({ client: fakeClient({ getMetricsWindow, getGpuStats }) });
      const controller = new AbortController();

      await gateway.monitor("30m", undefined, controller.signal);

      expect(getMetricsWindow).toHaveBeenCalledWith("30m", { signal: controller.signal });
      expect(getGpuStats).toHaveBeenCalledWith({ signal: controller.signal });
    });

    it("用户取消（signal.aborted）：不塞 panelError——取消不是故障，不画红色横幅", async () => {
      const controller = new AbortController();
      const getMetricsWindow = vi.fn(async () => {
        controller.abort(); // 模拟在途拉取被取消后 panel-client 折出的 PANEL_UNREACHABLE
        throw new PanelError("llamapad 面板不可达: http://panel:8080", "PANEL_UNREACHABLE");
      });
      const { gateway } = makeGateway({ client: fakeClient({ getMetricsWindow }) });

      const snapshot = await gateway.monitor("30m", undefined, controller.signal);

      expect(snapshot.panelError).toBeNull();
      expect(snapshot.series).toEqual({});
    });

    it("range 非法：属于无法执行的输入，直接抛 TypeError（对齐 model 为空串的先例）", async () => {
      const { gateway } = makeGateway();
      await expect(gateway.monitor("1h", undefined)).rejects.toThrow(TypeError);
      await expect(gateway.monitor("", undefined)).rejects.toThrow(TypeError);
    });
  });

  // @Remote 装饰器已从 panel-gateway.ts 删掉（真机验证过：SRC 反射把标记写进
  // dsh-typert-protocol 的模块级 WeakMap，第三方插件与宿主分别从各自 node_modules
  // 解析该包，运行时是两份模块实例、两张 WeakMap，网关读不到标记，端点 404）。
  // 现在网关真正的契约是 RPC_CONTRIBUTION.descriptors + ctx.typert.register()（见
  // index.ts），网关按 `receiver[descriptor.method](...)` 直接属性调用——这里守住
  // 的是"改了 rpc-contract.ts 却漏改 panel-gateway.ts 方法名/形参顺序"这类回归。
  describe("RPC_CONTRIBUTION 契约不变量（网关按 descriptor.method 直接属性调用）", () => {
    it("每个 descriptor.method 在 PanelGateway.prototype 上都能取到且是函数", () => {
      for (const descriptor of RPC_CONTRIBUTION.descriptors) {
        const implementation = (PanelGateway.prototype as unknown as Record<string, unknown>)[descriptor.method];
        expect(typeof implementation).toBe("function");
      }
    });

    it("每个 descriptor 的 service/namespace 都等于 RPC_NAMESPACE", () => {
      for (const descriptor of RPC_CONTRIBUTION.descriptors) {
        expect(descriptor.service).toBe(RPC_NAMESPACE);
        expect(descriptor.namespace).toBe(RPC_NAMESPACE);
      }
    });

    it("start/stop 的 wire 参数名是 RPC_WIRE_MODEL（wire 名真源现在是描述符，不再是形参名）", () => {
      const start = RPC_CONTRIBUTION.descriptors.find((d) => d.method === "start");
      const stop = RPC_CONTRIBUTION.descriptors.find((d) => d.method === "stop");
      expect(start?.parameters[0]?.wire).toBe(RPC_WIRE_MODEL);
      expect(stop?.parameters[0]?.wire).toBe(RPC_WIRE_MODEL);
    });

    it("snapshot 没有参数", () => {
      const snapshot = RPC_CONTRIBUTION.descriptors.find((d) => d.method === "snapshot");
      expect(snapshot?.parameters).toEqual([]);
    });

    it("start/stop 描述符声明 cancellation（浏览器侧以末位可选 signal 形参暴露），snapshot/saveConnection 不带", () => {
      const byMethod = new Map(RPC_CONTRIBUTION.descriptors.map((d) => [d.method, d]));
      expect(byMethod.get(RPC_METHOD.start)?.cancellation).toEqual({ parameter: "signal" });
      expect(byMethod.get(RPC_METHOD.stop)?.cancellation).toEqual({ parameter: "signal" });
      expect(byMethod.get(RPC_METHOD.snapshot)?.cancellation).toBeUndefined();
      expect(byMethod.get(RPC_METHOD.saveConnection)?.cancellation).toBeUndefined();
    });

    it("monitor 描述符：range 必填、since 可选（acceptsUndefined）、带取消通道，result 换成 MonitorSnapshot codec", () => {
      const monitor = RPC_CONTRIBUTION.descriptors.find((d) => d.method === RPC_METHOD.monitor);
      expect(monitor).toBeDefined();
      // wire 名由描述符写死（浏览器侧生成方法按 wire 名传参）
      expect(monitor!.parameters.map((p) => p.wire)).toEqual([RPC_WIRE_RANGE, RPC_WIRE_SINCE]);
      // since 可选即省略：浏览器侧 undefined 实参不发 wire 键，网关靠 acceptsUndefined 放行缺席
      expect(monitor!.parameters[0]!.acceptsUndefined).toBeUndefined();
      expect(monitor!.parameters[1]!.acceptsUndefined).toBe(true);
      // 24h/7d 窗口响应大，切页/切 range 要能取消在途
      expect(monitor!.cancellation).toEqual({ parameter: "signal" });
      // 与其余四个方法不同：monitor 的返回值是 MonitorSnapshot，不是 CardSnapshot
      expect(monitor!.result.typeSymbol).toBe("llamapad-dsh-plugin#MonitorSnapshot");
    });
  });

  describe("monitor codec（经描述符暴露的 strict 校验，浏览器产物用同一份）", () => {
    const monitorDescriptor = RPC_CONTRIBUTION.descriptors.find((d) => d.method === RPC_METHOD.monitor)!;
    const rangeCodec = monitorDescriptor.parameters[0]!.codec.schema;
    const sinceCodec = monitorDescriptor.parameters[1]!.codec.schema;
    const resultCodec = monitorDescriptor.result.schema;

    it("RANGE_CODEC：四档放行，其余（含大小写漂移、空串）拒成 TypeError", () => {
      for (const ok of ["30m", "2h", "24h", "7d"] as const) {
        expect(rangeCodec.parse(ok)).toBe(ok);
      }
      for (const bad of ["1h", "30M", "", "7d ", 30]) {
        expect(() => rangeCodec.parse(bad)).toThrow(TypeError);
      }
    });

    it("SINCE_CODEC：undefined 放行（可选即省略的另一半），数字放行，其余拒", () => {
      expect(sinceCodec.parse(undefined)).toBeUndefined();
      expect(sinceCodec.parse(1_700_000_000_000)).toBe(1_700_000_000_000);
      for (const bad of ["1700", null, Number.NaN]) {
        expect(() => sinceCodec.parse(bad)).toThrow(TypeError);
      }
    });

    it("MONITOR_CODEC：完整快照逐字段收窄通过（series/gpu/mode/serverTs/panelError）", () => {
      const snapshot = {
        series: { "gpu.util_percent": [{ ts: 1, value: 2 }], "infer.kv_cache_tokens": [] },
        gpu: {
          available: true,
          status: "available",
          devices: [{ index: 0, memUsedMib: 1, memTotalMib: 2, utilPercent: 3, tempC: null, powerW: 44.5 }],
          totals: { memUsedMib: 1, memTotalMib: 2 },
        },
        mode: "delta",
        serverTs: 1,
        panelError: null,
      };
      expect(resultCodec.parse(snapshot)).toEqual(snapshot);
    });

    it("MONITOR_CODEC：series 缺席键容忍、坏点不容忍（在场就必须是好形状）", () => {
      // 六个键一个不给：合法（面板下线指标 = 不出键）。描述符的 codec 按
      // StrictCodec<unknown> 存放，parse 结果显式收窄回 MonitorSnapshot 再断言
      const empty = resultCodec.parse({ series: {}, gpu: null, mode: "full", serverTs: 1, panelError: null }) as MonitorSnapshot;
      expect(empty.series).toEqual({});
      // 在场键逐点校验：ts 非数字 / value 缺席 / 点不是对象，都拒
      for (const badPoints of [
        [{ ts: "1", value: 2 }],
        [{ ts: 1 }],
        ["not-a-point"],
      ]) {
        expect(() => resultCodec.parse({
          series: { "gpu.mem_used_mib": badPoints },
          gpu: null, mode: "full", serverTs: 1, panelError: null,
        })).toThrow(TypeError);
      }
      // 在场键不是数组也拒
      expect(() => resultCodec.parse({
        series: { "gpu.mem_used_mib": "12,13" },
        gpu: null, mode: "full", serverTs: 1, panelError: null,
      })).toThrow(TypeError);
    });

    it("MONITOR_CODEC：gpu 为 null（半边失败）或三态 unavailable 都放行，坏 status 拒", () => {
      expect((resultCodec.parse({ series: {}, gpu: null, mode: "full", serverTs: 1, panelError: "面板请求失败" }) as MonitorSnapshot).gpu).toBeNull();
      const unavailable = { available: false, status: "unavailable", devices: [], totals: null };
      expect((resultCodec.parse({ series: {}, gpu: unavailable, mode: "full", serverTs: 1, panelError: null }) as MonitorSnapshot).gpu)
        .toEqual(unavailable);
      expect(() => resultCodec.parse({
        series: {}, gpu: { available: false, status: "maybe", devices: [], totals: null },
        mode: "full", serverTs: 1, panelError: null,
      })).toThrow(TypeError);
    });

    it("MONITOR_CODEC：mode/serverTs/panelError 收窄（mode 两态、serverTs 数字、panelError 字符串或 null）", () => {
      for (const bad of [
        { series: {}, gpu: null, mode: "partial", serverTs: 1, panelError: null },
        { series: {}, gpu: null, mode: "full", serverTs: "1", panelError: null },
        { series: {}, gpu: null, mode: "full", serverTs: 1, panelError: 42 },
      ]) {
        expect(() => resultCodec.parse(bad)).toThrow(TypeError);
      }
    });
  });

  describe("面板错误文案（describePanelError，模块内私有函数，经 snapshot() 观察）", () => {
    it("AUTH 码：产出固定中文说明，不透传面板返回的裸 code 文本", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          listModels: async () => { throw new PanelError("unauthorized", "AUTH", 401); },
        }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.panelError).toBe("llamapad token 无效或未授权，请检查插件配置里的 token");
    });

    it("PANEL_UNREACHABLE 码：原样透传 message", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          listModels: async () => { throw new PanelError("llamapad 面板不可达: http://panel:8080", "PANEL_UNREACHABLE"); },
        }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.panelError).toBe("llamapad 面板不可达: http://panel:8080");
    });

    it("其它 code（无 status）：带上 code，不带括号里的空 status", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          listModels: async () => { throw new PanelError("模型不存在: x", "MODEL_NOT_FOUND"); },
        }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.panelError).toBe("面板请求失败（MODEL_NOT_FOUND）：模型不存在: x");
    });

    it("其它 code（带 status）：code 与 status 一起带上", async () => {
      const { gateway } = makeGateway({
        client: fakeClient({
          listModels: async () => { throw new PanelError("boom", "PANEL_HTTP", 500); },
        }),
      });
      const snapshot = await gateway.snapshot();
      expect(snapshot.panelError).toBe("面板请求失败（PANEL_HTTP 500）：boom");
    });
  });

  describe("PanelGateway：连接配置", () => {
    it("snapshot 带出当前面板地址与「token 是否已配置」，但绝不带出 token 本身", async () => {
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "http://p:8080", token: "lp_secret" },
        async () => {});
      const snap = await gateway.snapshot();
      expect(snap.connection).toEqual({ panelUrl: "http://p:8080", tokenConfigured: true });
      expect(JSON.stringify(snap)).not.toContain("lp_secret");
    });

    it("未配置时 tokenConfigured 为 false", async () => {
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "", token: "" },
        async () => {});
      expect((await gateway.snapshot()).connection).toEqual({ panelUrl: "", tokenConfigured: false });
    });

    it("saveConnection 把非空字段写进 settings", async () => {
      const writes: unknown[] = [];
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "", token: "" },
        async (patch) => { writes.push(patch); });
      await gateway.saveConnection("http://new:9090", "lp_new");
      expect(writes).toEqual([{ panelUrl: "http://new:9090", token: "lp_new" }]);
    });

    it("token 传空串 = 不改动 token（沿用官方 SecretField 的语义：留空即保留原值）", async () => {
      const writes: unknown[] = [];
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "http://p:1", token: "old" },
        async (patch) => { writes.push(patch); });
      await gateway.saveConnection("http://new:9090", "");
      expect(writes).toEqual([{ panelUrl: "http://new:9090" }]);
    });

    it("面板地址空白 → 抛错，不写入（空地址会让插件彻底失联，且没有撤销入口）", async () => {
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "http://p:1", token: "t" },
        async () => {});
      await expect(gateway.saveConnection("   ", "")).rejects.toThrow();
    });

    it("写入失败时把原因带回快照的 panelError，不抛给浏览器", async () => {
      const gateway = new PanelGateway(fakeCtx() as never,
        { client: fakeClient(), gate: fakeGate(), panelUrl: "http://p:1", token: "t" },
        async () => { throw new Error("磁盘只读"); });
      const snap = await gateway.saveConnection("http://new:9090", "");
      expect(snap.panelError).toContain("磁盘只读");
    });
  });
});
