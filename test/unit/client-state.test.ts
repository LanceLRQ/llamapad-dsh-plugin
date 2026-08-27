import { describe, expect, it } from "vitest";
import {
  buildCardView,
  describeInferring,
  inferringDotState,
  rowActionFor,
} from "../../src/client/state";
import type { CardModel, CardSnapshot } from "../../src/rpc-contract";

function model(overrides: Partial<CardModel> = {}): CardModel {
  return {
    name: "qwen-small",
    displayName: "Qwen Small",
    namespace: "main",
    quant: "Q4_K_M",
    status: "ready",
    ...overrides,
  };
}

function snapshot(overrides: Partial<CardSnapshot> = {}): CardSnapshot {
  return {
    models: [],
    running: null,
    inferring: null,
    openUrl: "http://panel.local",
    panelError: null,
    ...overrides,
  };
}

describe("describeInferring", () => {
  it("没有模型在跑时不产出任何展示态，即便 inferring 字段有值", () => {
    expect(describeInferring(null, true)).toBeNull();
    expect(describeInferring(null, false)).toBeNull();
    expect(describeInferring(null, null)).toBeNull();
  });

  it("有模型在跑且 inferring===true → inferring", () => {
    expect(describeInferring("qwen-small", true)).toBe("inferring");
  });

  it("有模型在跑且 inferring===false → idle", () => {
    expect(describeInferring("qwen-small", false)).toBe("idle");
  });

  it("有模型在跑且 inferring===null → unknown（不可知，不等于空闲）", () => {
    expect(describeInferring("qwen-small", null)).toBe("unknown");
  });
});

describe("inferringDotState", () => {
  it("inferring → ongoing", () => {
    expect(inferringDotState("inferring")).toBe("ongoing");
  });
  it("idle → done", () => {
    expect(inferringDotState("idle")).toBe("done");
  });
  it("unknown → warning", () => {
    expect(inferringDotState("unknown")).toBe("warning");
  });
});

describe("rowActionFor", () => {
  it("running 行 → stop 动作，未禁用", () => {
    const action = rowActionFor(model({ status: "running" }), null);
    expect(action).toEqual({ kind: "stop", disabled: false, missingReason: null, pending: false });
  });

  it("ready 行 → start 动作，未禁用", () => {
    const action = rowActionFor(model({ status: "ready" }), null);
    expect(action).toEqual({ kind: "start", disabled: false, missingReason: null, pending: false });
  });

  it("missing-file 行 → start 动作但禁用，标出缺失原因", () => {
    const action = rowActionFor(model({ status: "missing-file" }), null);
    expect(action).toEqual({ kind: "start", disabled: true, missingReason: "missing-file", pending: false });
  });

  it("missing-mmproj 行 → start 动作但禁用，标出缺失原因", () => {
    const action = rowActionFor(model({ status: "missing-mmproj" }), null);
    expect(action).toEqual({ kind: "start", disabled: true, missingReason: "missing-mmproj", pending: false });
  });

  it("本行有动作在途 → 禁用且 pending=true", () => {
    const m = model({ name: "a", status: "ready" });
    const action = rowActionFor(m, { model: "a", kind: "start" });
    expect(action).toEqual({ kind: "start", disabled: true, missingReason: null, pending: true });
  });

  it("别的行有动作在途 → 本行也禁用（避免同一面板互相插队），但 pending=false", () => {
    const m = model({ name: "b", status: "ready" });
    const action = rowActionFor(m, { model: "a", kind: "start" });
    expect(action).toEqual({ kind: "start", disabled: true, missingReason: null, pending: false });
  });
});

describe("buildCardView", () => {
  it("整合运行状态、推理态与逐行动作", () => {
    const running = model({ name: "m1", status: "running" });
    const ready = model({ name: "m2", status: "ready" });
    const missing = model({ name: "m3", status: "missing-file" });
    const view = buildCardView(
      snapshot({ models: [running, ready, missing], running: "m1", inferring: true }),
      null,
    );
    expect(view.runningModel).toEqual(running);
    expect(view.inferring).toBe("inferring");
    expect(view.openDisabled).toBe(false);
    expect(view.rows).toEqual([
      { model: running, action: { kind: "stop", disabled: false, missingReason: null, pending: false } },
      { model: ready, action: { kind: "start", disabled: false, missingReason: null, pending: false } },
      { model: missing, action: { kind: "start", disabled: true, missingReason: "missing-file", pending: false } },
    ]);
  });

  it("无模型在跑 → runningModel 为 null，不产出推理态", () => {
    const view = buildCardView(snapshot({ models: [model()], running: null }), null);
    expect(view.runningModel).toBeNull();
    expect(view.inferring).toBeNull();
  });

  it("openUrl 为空 → openDisabled 为 true", () => {
    const view = buildCardView(snapshot({ openUrl: "" }), null);
    expect(view.openDisabled).toBe(true);
  });
});
