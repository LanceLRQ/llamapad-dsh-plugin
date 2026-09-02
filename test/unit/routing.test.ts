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
      reason: { kind: "no-model", runningModel: null },
    });
  });

  it("strict + 运行中==请求 → proceed", () => {
    expect(decideRoute("strict", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("strict + 运行中!=请求 → error，reason 带双方模型 key 与忙碌态", () => {
    const decision = decideRoute("strict", "llama3-8b", status({ model: "qwen3-8b" }));
    expect(decision).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
      reason: { kind: "mismatch", runningModel: "qwen3-8b",
                requestedModel: "llama3-8b", inferring: null },
    });
  });

  // ---- passthrough ----
  it("passthrough + 无模型在跑 → error", () => {
    expect(decideRoute("passthrough", "a", status(null))).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
      reason: { kind: "no-model", runningModel: null },
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
  it("忙碌信息：inferring===true 时 reason.inferring 为 true", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, { inferring: true, slotsRunning: 2 }));
    expect(decision).toMatchObject({ action: "error", reason: { inferring: true } });
  });

  it("忙碌信息：inferring===true 时，无模型在跑的 reason.inferring 也为 true", () => {
    const decision = decideRoute("passthrough", "a", status(null, { inferring: true, slotsRunning: 1 }));
    expect(decision).toMatchObject({ action: "error", reason: { kind: "no-model", inferring: true } });
  });

  it("忙碌信息：busy 为 null（不可知）→ reason.inferring 为 null", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, null));
    expect(decision).toMatchObject({ action: "error", reason: { inferring: null } });
  });

  it("忙碌信息：inferring===false → reason.inferring 为 false", () => {
    const decision = decideRoute("strict", "b", status({ model: "a" }, { inferring: false, slotsRunning: 0 }));
    expect(decision).toMatchObject({ action: "error", reason: { inferring: false } });
  });
});

describe("decideRoute：就绪窗口（容器在跑但 llama-server 还没监听）", () => {
  it("strict + 运行中==请求 + ready:false → error(MODEL_NOT_READY)，reason.kind 为 not-ready", () => {
    const decision = decideRoute("strict", "a", status({ model: "a", ready: false }));
    expect(decision).toMatchObject({
      action: "error", code: "MODEL_NOT_READY",
      reason: { kind: "not-ready", runningModel: "a", requestedModel: "a" },
    });
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
