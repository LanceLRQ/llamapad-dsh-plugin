import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@deepseek-ai/dsh-tools";
import { createFakePanel } from "./fake-panel-server.mjs";
import { apply, Config } from "../../src/tools";

let server: ReturnType<typeof createFakePanel>["server"];
let state: ReturnType<typeof createFakePanel>["state"];
let baseUrl: string;

beforeAll(async () => {
  ({ server, state } = createFakePanel({ loadMs: 50 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(() => server.close());

/** apply() 只需要 ctx.tools.register；用 Map 收集注册的工具定义供测试直接调用 */
function fakeCtx() {
  const registered = new Map<string, ToolDefinition>();
  const ctx = {
    tools: {
      register: (def: ToolDefinition) => { registered.set(def.name, def); return () => registered.delete(def.name); },
    },
  } as any;
  return { ctx, registered };
}

function fakeExec(): any {
  return {
    signal: new AbortController().signal,
    callId: "c1",
    rootCallId: "c1",
    name: "test",
    arguments: {},
    token: Symbol("t"),
    deferContext: () => {},
    concludeTurn: () => {},
  };
}

describe("B 形态工具 E2E（假面板）", () => {
  it("status → list → start → status → stop → status → 再次 stop 走通真实 HTTP 链路", async () => {
    const { ctx, registered } = fakeCtx();
    apply(ctx, Config({ panelUrl: baseUrl, token: "lp_e2e", pollIntervalMs: 10 }) as any);

    const statusBefore = await registered.get("llamapad_status")!.execute({}, fakeExec());
    expect(statusBefore).toEqual({ panelReachable: true, running: false });

    const listResult: any = await registered.get("llamapad_list_models")!.execute({}, fakeExec());
    expect(listResult.models.map((m: any) => m.name)).toEqual(["qwen-big", "qwen-small"]);
    expect(listResult.total).toBe(2);
    expect(listResult.truncated).toBe(false);

    const startResult = await registered.get("llamapad_start_model")!.execute({ model: "qwen-small" }, fakeExec());
    expect(startResult).toEqual({ started: true, model: "qwen-small", waitedReady: true });
    expect(state.starts).toEqual(["qwen-small"]);

    const statusAfterStart: any = await registered.get("llamapad_status")!.execute({}, fakeExec());
    expect(statusAfterStart.running).toBe(true);
    expect(statusAfterStart.model).toBe("qwen-small");

    const stopResult: any = await registered.get("llamapad_stop_model")!.execute({}, fakeExec());
    expect(stopResult.stopped).toBe(true);
    expect(stopResult.model).toBe("qwen-small");
    expect(stopResult.drainReason).toBe("idle");
    expect(state.stops).toEqual(["qwen-small"]);

    const statusAfterStop = await registered.get("llamapad_status")!.execute({}, fakeExec());
    expect(statusAfterStop).toEqual({ panelReachable: true, running: false });

    const stopAgain = await registered.get("llamapad_stop_model")!.execute({}, fakeExec());
    expect(stopAgain).toEqual({ stopped: false });
  });

  it("模型不存在 → llamapad_start_model 照抛 MODEL_NOT_FOUND，不吞错", async () => {
    const { ctx, registered } = fakeCtx();
    apply(ctx, Config({ panelUrl: baseUrl, token: "lp_e2e" }) as any);
    await expect(registered.get("llamapad_start_model")!.execute({ model: "nope" }, fakeExec()))
      .rejects.toMatchObject({ code: "MODEL_NOT_FOUND" });
  });

  it("token 无效（401）→ llamapad_status 报面板不可达，而不是把 401 错误抛给模型", async () => {
    const { ctx, registered } = fakeCtx();
    // 假面板只接受 "Bearer lp_*" 前缀，不带该前缀即触发真实 401（见 fake-panel-server.mjs）
    apply(ctx, Config({ panelUrl: baseUrl, token: "wrong-token" }) as any);
    const value = await registered.get("llamapad_status")!.execute({}, fakeExec());
    expect(value).toEqual({ panelReachable: false, running: false });
  });
});

describe("llamapad_start_model waitReady:false（独立假面板，慢加载）", () => {
  it("乐观启动：不等就绪，立即返回 waitedReady:false，但 start 请求确实发出去了", async () => {
    const { server: slowServer, state: slowState } = createFakePanel({ loadMs: 5000 });
    await new Promise<void>((resolve) => slowServer.listen(0, "127.0.0.1", resolve));
    const address = slowServer.address() as { port: number };
    const slowBaseUrl = `http://127.0.0.1:${address.port}`;
    try {
      const { ctx, registered } = fakeCtx();
      apply(ctx, Config({ panelUrl: slowBaseUrl, token: "lp_e2e" }) as any);
      const result = await registered.get("llamapad_start_model")!.execute(
        { model: "qwen-small", waitReady: false },
        fakeExec(),
      );
      expect(result).toEqual({ started: true, model: "qwen-small", waitedReady: false });
      expect(slowState.starts).toEqual(["qwen-small"]);
    } finally {
      slowServer.close();
    }
  });
});
