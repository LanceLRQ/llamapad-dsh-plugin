import { describe, expect, it } from "vitest";
import { decideRoute } from "../../src/routing";
import type { PanelRuntimeStatus } from "../../src/panel-client";

function status(
  running: PanelRuntimeStatus["running"],
  busy?: PanelRuntimeStatus["busy"],
): PanelRuntimeStatus {
  return { running, ...(busy !== undefined ? { busy } : {}) };
}

describe("decideRoute：三档 × 三种运行态的判定矩阵", () => {
  // ---- strict ----
  it("strict + 无模型在跑 → error", () => {
    expect(decideRoute("strict", "a", status(null))).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
    });
  });

  it("strict + 运行中==请求 → proceed", () => {
    expect(decideRoute("strict", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("strict + 运行中!=请求 → error，文案带双方模型名与切档提示", () => {
    const decision = decideRoute("strict", "llama3-8b", status({ model: "qwen3-8b" }));
    expect(decision.action).toBe("error");
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.code).toBe("MODEL_NOT_RUNNING");
    expect(decision.message).toBe(
      "当前运行的是 qwen3-8b，请求的是 llama3-8b；strict 档不会自动切换，请到 llamapad 面板启动目标模型，或把 chatBehavior 改为 auto-switch。",
    );
  });

  // ---- passthrough ----
  it("passthrough + 无模型在跑 → error", () => {
    expect(decideRoute("passthrough", "a", status(null))).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
    });
  });

  it("passthrough + 运行中==请求 → proceed", () => {
    expect(decideRoute("passthrough", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("passthrough + 运行中!=请求 → proceed，目标改写为运行中的模型", () => {
    expect(decideRoute("passthrough", "b", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  // ---- auto-switch ----
  it("auto-switch + 无模型在跑 → start", () => {
    expect(decideRoute("auto-switch", "a", status(null))).toEqual({
      action: "start", model: "a",
    });
  });

  it("auto-switch + 运行中==请求 → proceed（不重复 start）", () => {
    expect(decideRoute("auto-switch", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("auto-switch + 运行中!=请求 → start（保留旧版选谁起谁）", () => {
    expect(decideRoute("auto-switch", "b", status({ model: "a" }))).toEqual({
      action: "start", model: "b",
    });
  });

  // ---- 忙碌信息 ----
  it("忙碌信息：inferring===true 时，mismatch 错误文案追加提示", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, { inferring: true, slotsRunning: 2 }));
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("目标机器正在推理中");
  });

  it("忙碌信息：inferring===true 时，无模型在跑的错误文案也追加提示", () => {
    const decision = decideRoute("passthrough", "a", status(null, { inferring: true, slotsRunning: 1 }));
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.message).toContain("目标机器正在推理中");
  });

  it("忙碌信息：busy 为 null（不可知）不追加提示", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, null));
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.message).not.toContain("推理中");
  });

  it("忙碌信息：inferring===false 不追加提示", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, { inferring: false, slotsRunning: 0 }));
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.message).not.toContain("推理中");
  });
});

describe("decideRoute：就绪窗口（容器在跑但 llama-server 还没监听）", () => {
  it("strict + 运行中==请求 + ready:false → error(MODEL_NOT_READY)，文案说明正在加载", () => {
    const decision = decideRoute("strict", "a", status({ model: "a", ready: false }));
    expect(decision.action).toBe("error");
    if (decision.action !== "error") throw new Error("unreachable");
    expect(decision.code).toBe("MODEL_NOT_READY");
    expect(decision.message).toBe(
      "模型 a 的容器已启动，但 llama-server 还没开始监听（大模型冷启动需要数十秒加载权重）；请稍候重试。",
    );
  });

  it("passthrough + ready:false → 同样 error(MODEL_NOT_READY)", () => {
    expect(decideRoute("passthrough", "b", status({ model: "a", ready: false }))).toMatchObject({
      action: "error", code: "MODEL_NOT_READY",
    });
  });

  it("auto-switch + 运行中==请求 + ready:false → error(MODEL_NOT_READY)，不重复 start", () => {
    expect(decideRoute("auto-switch", "a", status({ model: "a", ready: false }))).toMatchObject({
      action: "error", code: "MODEL_NOT_READY",
    });
  });

  it("auto-switch + 运行中!=请求 + ready:false → 照常 start（要换的就是这个未就绪的容器）", () => {
    expect(decideRoute("auto-switch", "b", status({ model: "a", ready: false }))).toEqual({
      action: "start", model: "b",
    });
  });

  it("ready:true → 按既有三档判定，不受影响", () => {
    expect(decideRoute("strict", "a", status({ model: "a", ready: true }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("ready 缺席（老面板）→ 按不可知处理，维持既有行为不误伤", () => {
    expect(decideRoute("strict", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
    expect(decideRoute("passthrough", "b", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });
});
