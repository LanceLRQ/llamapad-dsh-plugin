import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFakePanel } from "./fake-panel-server.mjs";
import { LlamapadAdapter } from "../../src/adapter";
import { createPanelClient } from "../../src/panel-client";
import { createModelGate } from "../../src/switching";

/**
 * 多模型场景的假面板 E2E（docs/plans/2026-09-21-multi-model-adapt.md 任务 8）。
 *
 * 面板 `feature/multi-model` 分支（解除「同一时刻只运行一个模型」的约束）尚未合并
 * 进 dev/main，本插件是提前适配——假面板用 `multiModel: true` 演出该分支的契约
 * （`runtime/status` 的 `models[]`/`defaultModel`、`GET/PUT default-model` 路由、
 * `/v1/models` 反代按运行集合聚合），用来验证任务 1-7 的适配确实修好了计划背景一节
 * 列出的六处沉默错配里最贵的两个：
 * - P0-1：auto-switch 请求非默认模型时假超时（旧实现拿 `running` 当"唯一在跑的模型"
 *   比较，多模型下 `running` 其实是默认模型，永远对不上目标）
 * - P0-2：strict 把在跑的非默认模型误判成"未运行"（同一个错误假设的另一处症状）
 *
 * `multiModel: false`（也是 `createFakePanel` 的默认值）是"老面板模式"：本目录其余
 * 既有 E2E（adapter-e2e / tools-e2e / status-watch-e2e）本就是在这个默认值下跑的，
 * 已经是一张隐式的回归网；这里再起一组独立假面板显式验证这套契约本身
 * （`models[]`/`defaultModel` 缺席、`default-model` 路由 404、`/v1/models` 单条），
 * 让"老面板模式该是什么样子"不必去读 fake-panel-server.mjs 的默认参数就能确认。
 */

/** 与 adapter-e2e.test.ts 同款拉流小工具：跑完一整条流，只取其副作用（起停/请求体） */
async function drain(adapter: LlamapadAdapter, model: string) {
  const chunks: unknown[] = [];
  for await (const c of adapter.stream({
    provider: "llamapad", model,
    messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }], source: {} }],
  } as any)) chunks.push(c);
  return chunks;
}

describe("多模型：auto-switch 正常就绪（P0-1）", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, state } = createFakePanel({ loadMs: 50, multiModel: true }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("默认模型已在跑时请求非默认模型：正常就绪，不假超时、不驱逐默认模型（A4）", async () => {
    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const adapter = new LlamapadAdapter({
      client, gate: createModelGate(client), token: "lp_e2e", mode: "proxy",
      chatBehavior: "auto-switch", pollIntervalMs: 20,
      // 故意给一个比 loadMs 富余但远小于生产默认值（300000ms）的超时：如果 P0-1
      // 的 bug 还在，probeReady 会一直读到默认模型的 ready、目标模型永远"未就绪"，
      // 测试会在这里真的等满超时再抛错失败，而不是靠断言层面的巧合通过
      startTimeoutMs: 2_000,
    });

    // 第一个 start 的模型在多模型模式下自动成为默认（见假面板头部注释）
    await drain(adapter, "qwen-small");
    expect(state.defaultModel).toBe("qwen-small");

    // 目标是非默认模型：这正是 P0-1 复现的确切条件
    await drain(adapter, "qwen-big");
    expect(state.starts).toEqual(["qwen-small", "qwen-big"]);
    expect(state.chatRequests.at(-1)!.model).toBe("qwen-big");

    // A4：auto-switch 只保证目标在跑，绝不为了它停别的模型——默认模型应该还活着
    expect(state.runtime.has("qwen-small")).toBe(true);
    expect(state.runtime.has("qwen-big")).toBe(true);
    expect(state.defaultModel).toBe("qwen-small");

    const status = await client.runtimeStatus();
    expect(status.models?.map((m) => m.model).sort()).toEqual(["qwen-big", "qwen-small"]);
    expect(status.defaultModel).toBe("qwen-small");
  });
});

describe("多模型：strict 对非默认模型对话（P0-2）", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let baseUrl: string;

  beforeAll(async () => {
    ({ server, state } = createFakePanel({ loadMs: 20, multiModel: true }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("默认模型是 A、请求非默认但在跑的 B：strict 档放行，不报 MODEL_NOT_RUNNING", async () => {
    // 先用 auto-switch 把两个模型都跑起来：qwen-small 先起 → 默认；qwen-big 后起 → 非默认
    const bootClient = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const bootAdapter = new LlamapadAdapter({
      client: bootClient, gate: createModelGate(bootClient), token: "lp_e2e", mode: "proxy",
      chatBehavior: "auto-switch", pollIntervalMs: 10,
    });
    await drain(bootAdapter, "qwen-small");
    await drain(bootAdapter, "qwen-big");
    expect(state.defaultModel).toBe("qwen-small");

    // strict 档：旧实现拿 status.running（=默认模型 qwen-small）跟目标 qwen-big 比较，
    // 对不上就判成 mismatch/MODEL_NOT_RUNNING——即便 qwen-big 明明正在运行
    const strictClient = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const strictAdapter = new LlamapadAdapter({
      client: strictClient, gate: createModelGate(strictClient), token: "lp_e2e",
      mode: "proxy", chatBehavior: "strict",
    });
    const chunks = await drain(strictAdapter, "qwen-big");
    expect(chunks.length).toBeGreaterThan(0);
    expect(state.chatRequests.at(-1)!.model).toBe("qwen-big");

    // 顺带验证 A6：聚合列表按 id 精确匹配到 qwen-big 自己的思考强度声明，不是
    // 默认模型 qwen-small 的（两者在假面板里特意给了不同的 levels，见
    // fake-panel-server.mjs 的 REASONING_DECLARATIONS）
    const resolved = await strictAdapter.resolveModel("llamapad", "qwen-big");
    expect(resolved.reasoning?.efforts.map((e) => e.id)).toEqual(["high", "medium", "low", "minimal"]);
  });
});

describe("老面板模式：双向兼容回归（A2）", () => {
  let server: ReturnType<typeof createFakePanel>["server"];
  let state: ReturnType<typeof createFakePanel>["state"];
  let baseUrl: string;

  beforeAll(async () => {
    // 不传 multiModel（默认 false）——刻意不显式传 true/false 之外的值，验证的
    // 就是"什么都不传时就是老面板模式"这件事本身
    ({ server, state } = createFakePanel({ loadMs: 50 }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;
  });
  afterAll(() => server.close());

  it("runtime/status 不带 models[]/defaultModel，default-model 路由 404，/v1/models 只回一条", async () => {
    const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    await client.startModel("qwen-small");

    const statusRes = await fetch(`${baseUrl}/api/v1/runtime/status`, {
      headers: { authorization: "Bearer lp_e2e" },
    });
    const statusBody = await statusRes.json();
    expect(statusBody).not.toHaveProperty("models");
    expect(statusBody).not.toHaveProperty("defaultModel");
    expect(statusBody.running).toMatchObject({ model: "qwen-small" });

    const getDefault = await fetch(`${baseUrl}/api/v1/runtime/default-model`, {
      headers: { authorization: "Bearer lp_e2e" },
    });
    expect(getDefault.status).toBe(404);
    const putDefault = await fetch(`${baseUrl}/api/v1/runtime/default-model`, {
      method: "PUT",
      headers: { authorization: "Bearer lp_e2e", "content-type": "application/json" },
      body: JSON.stringify({ model: "qwen-small" }),
    });
    expect(putDefault.status).toBe(404);
    // panel-client 把 404 折成 UNSUPPORTED，与「模型没在跑」的 409 分开
    await expect(client.getDefaultModel()).rejects.toMatchObject({ code: "UNSUPPORTED", status: 404 });

    const modelsRes = await fetch(`${baseUrl}/api/v1/proxy/llama/v1/models`, {
      headers: { authorization: "Bearer lp_e2e" },
    });
    const modelsBody = await modelsRes.json();
    expect(modelsBody.data).toHaveLength(1);
    expect(modelsBody.data[0].id).toBe("qwen-small");

    await client.stopModel("qwen-small"); // 复原，不影响下一条用例
  });

  it("既有三档语义原样成立：auto-switch 冷启动、strict mismatch 报错、not-ready 闸门", async () => {
    const autoClient = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const autoAdapter = new LlamapadAdapter({
      client: autoClient, gate: createModelGate(autoClient), token: "lp_e2e", mode: "proxy",
      chatBehavior: "auto-switch", pollIntervalMs: 10,
    });
    await drain(autoAdapter, "qwen-big");
    expect(state.starts).toContain("qwen-big");

    // strict + mismatch：running 是 qwen-big（老面板模式下 start 会停旧起新，
    // 场上只可能有它一个），请求 qwen-small 应报 MODEL_NOT_RUNNING
    const strictClient = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
    const strictAdapter = new LlamapadAdapter({
      client: strictClient, gate: createModelGate(strictClient), token: "lp_e2e",
      mode: "proxy", chatBehavior: "strict",
    });
    await expect(drain(strictAdapter, "qwen-small")).rejects.toMatchObject({ code: "MODEL_NOT_RUNNING" });

    // not-ready 闸门：容器已起、仍在加载
    state.running = "qwen-big";
    state.readyAt = Date.now() + 10_000;
    await expect(drain(strictAdapter, "qwen-big")).rejects.toMatchObject({ code: "MODEL_NOT_READY" });
    state.readyAt = 0; // 复原
  });
});
