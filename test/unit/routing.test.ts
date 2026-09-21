import { describe, expect, it } from "vitest";
import { decideRoute } from "../../src/routing";
import type { PanelRunningModel, PanelRuntimeStatus } from "../../src/panel-client";

function status(
  running: PanelRuntimeStatus["running"],
  busy?: PanelRuntimeStatus["busy"],
): PanelRuntimeStatus {
  return { running, ...(busy !== undefined ? { busy } : {}) };
}

/** 多模型面板态：显式给 models[] + defaultModel，不依赖 running 字段的兼容合成路径。 */
function multiStatus(
  models: PanelRunningModel[],
  defaultModel: string | null,
  busy?: PanelRuntimeStatus["busy"],
): PanelRuntimeStatus {
  return {
    running: models.find((m) => m.model === defaultModel) ?? null,
    models,
    defaultModel,
    ...(busy !== undefined ? { busy } : {}),
  };
}

describe("decideRoute：三档 × 三种运行态的判定矩阵", () => {
  // ---- strict ----
  it("strict + 无模型在跑 → error", () => {
    expect(decideRoute("strict", "a", status(null))).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
      reason: { kind: "no-model", runningModels: [] },
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
      reason: { kind: "mismatch", runningModels: ["qwen3-8b"],
                requestedModel: "llama3-8b", inferring: null },
    });
  });

  // ---- passthrough ----
  it("passthrough + 无模型在跑 → error", () => {
    expect(decideRoute("passthrough", "a", status(null))).toMatchObject({
      action: "error", code: "MODEL_NOT_RUNNING",
      reason: { kind: "no-model", runningModels: [] },
    });
  });

  it("passthrough + 运行中==请求 → proceed", () => {
    expect(decideRoute("passthrough", "a", status({ model: "a" }))).toEqual({
      action: "proceed", targetModel: "a",
    });
  });

  it("passthrough + 运行中!=请求 → proceed，目标改写为默认模型", () => {
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
      reason: { kind: "not-ready", runningModels: ["a"], requestedModel: "a" },
    });
  });

  it("passthrough + ready:false → 同样 error(MODEL_NOT_READY)（目标没跑，落点默认模型未就绪）", () => {
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

describe("decideRoute：多模型矩阵（目标在跑 / 目标没跑但别的在跑 / 一个都没跑 × 三档）", () => {
  const running = [
    { model: "a", ready: true },
    { model: "b", ready: true },
  ];

  describe("目标在跑（请求非默认的 b，a 是默认）", () => {
    it("strict → proceed", () => {
      expect(decideRoute("strict", "b", multiStatus(running, "a"))).toEqual({
        action: "proceed", targetModel: "b",
      });
    });
    it("passthrough → proceed（命中目标本身，不落到默认模型）", () => {
      expect(decideRoute("passthrough", "b", multiStatus(running, "a"))).toEqual({
        action: "proceed", targetModel: "b",
      });
    });
    it("auto-switch → proceed（不重复 start，也不影响 a）", () => {
      expect(decideRoute("auto-switch", "b", multiStatus(running, "a"))).toEqual({
        action: "proceed", targetModel: "b",
      });
    });
  });

  describe("目标没跑但别的在跑（请求 c，a/b 都在跑，a 是默认）", () => {
    it("strict → error(mismatch)，reason 列出全部在跑模型", () => {
      const decision = decideRoute("strict", "c", multiStatus(running, "a"));
      expect(decision).toMatchObject({
        action: "error", code: "MODEL_NOT_RUNNING",
        reason: { kind: "mismatch", runningModels: ["a", "b"], defaultModel: "a", requestedModel: "c" },
      });
    });
    it("passthrough → proceed，落点是默认模型 a，不是随便一个在跑的", () => {
      expect(decideRoute("passthrough", "c", multiStatus(running, "a"))).toEqual({
        action: "proceed", targetModel: "a",
      });
    });
    it("passthrough + 没有默认模型（面板显式清空）→ error(no-model)", () => {
      const decision = decideRoute("passthrough", "c", multiStatus(running, null));
      expect(decision).toMatchObject({
        action: "error", code: "MODEL_NOT_RUNNING",
        reason: { kind: "no-model" },
      });
    });
    it("auto-switch → start c（绝不停 a/b，只管把 c 换上来）", () => {
      expect(decideRoute("auto-switch", "c", multiStatus(running, "a"))).toEqual({
        action: "start", model: "c",
      });
    });
  });

  describe("一个都没跑", () => {
    it("strict → error(no-model)", () => {
      expect(decideRoute("strict", "c", multiStatus([], null))).toMatchObject({
        action: "error", code: "MODEL_NOT_RUNNING",
        reason: { kind: "no-model", runningModels: [] },
      });
    });
    it("passthrough → error(no-model)", () => {
      expect(decideRoute("passthrough", "c", multiStatus([], null))).toMatchObject({
        action: "error", code: "MODEL_NOT_RUNNING",
        reason: { kind: "no-model", runningModels: [] },
      });
    });
    it("auto-switch → start", () => {
      expect(decideRoute("auto-switch", "c", multiStatus([], null))).toEqual({
        action: "start", model: "c",
      });
    });
  });

  describe("就绪闸门在多模型下只认目标自己 / 落点默认模型，不被无关模型的加载态误伤", () => {
    it("auto-switch 请求 c：b 还在加载，但 c 跟 b 无关 → 不拦，照常 start", () => {
      const models = [{ model: "a", ready: true }, { model: "b", ready: false }];
      expect(decideRoute("auto-switch", "c", multiStatus(models, "a"))).toEqual({
        action: "start", model: "c",
      });
    });

    it("auto-switch 请求 b：b 自己没就绪 → 拦，不重复 start（目标就是它自己）", () => {
      const models = [{ model: "a", ready: true }, { model: "b", ready: false }];
      expect(decideRoute("auto-switch", "b", multiStatus(models, "a"))).toMatchObject({
        action: "error", code: "MODEL_NOT_READY",
      });
    });

    it("strict 请求 c：默认模型 a 没就绪 → 报 not-ready 而非 mismatch（即便 b 已就绪）", () => {
      const models = [{ model: "a", ready: false }, { model: "b", ready: true }];
      const decision = decideRoute("strict", "c", multiStatus(models, "a"));
      expect(decision).toMatchObject({
        action: "error", code: "MODEL_NOT_READY",
        reason: { kind: "not-ready", runningModels: ["a", "b"] },
      });
    });

    it("strict 请求 c：默认模型 a 已就绪，b 还在加载 → 不受 b 影响，正常报 mismatch", () => {
      const models = [{ model: "a", ready: true }, { model: "b", ready: false }];
      const decision = decideRoute("strict", "c", multiStatus(models, "a"));
      expect(decision).toMatchObject({
        action: "error", code: "MODEL_NOT_RUNNING",
        reason: { kind: "mismatch" },
      });
    });
  });
});
