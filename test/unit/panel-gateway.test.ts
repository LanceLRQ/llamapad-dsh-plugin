import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { PanelGateway, type PanelGatewayOptions } from "../../src/panel-gateway";
import { RPC_CONTRIBUTION, RPC_NAMESPACE, RPC_WIRE_MODEL } from "../../src/rpc-contract";
import { PanelError, type PanelClient, type PanelModelView } from "../../src/panel-client";
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
      });
      expect(listModels).toHaveBeenCalledTimes(1);
      expect(runtimeStatus).toHaveBeenCalledTimes(1);
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
