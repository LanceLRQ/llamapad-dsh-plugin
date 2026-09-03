import { describe, expect, it } from "vitest";
import {
  buildCardView,
  connectionFormState,
  describeInferring,
  describeLoadingElapsed,
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
    phase: "ready",
    startedAt: null,
    inferring: null,
    openUrl: "http://panel.local",
    panelError: null,
    // 本文件测的是 buildCardView 等纯逻辑，不涉及连接配置区，占位即可
    // （任务 6 给 CardSnapshot 加了必填的 connection 字段，这里只是同步 fixture）。
    connection: { panelUrl: "http://panel.local", tokenConfigured: false },
    // 事件流同上：必填字段的合法占位（卡片消费 events 是后续任务的活）
    events: [],
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

  it("本行有动作在途 → 可点（按钮此时承担「取消等待」语义）且 pending=true", () => {
    const m = model({ name: "a", status: "ready" });
    const action = rowActionFor(m, { model: "a", kind: "start" });
    expect(action).toEqual({ kind: "start", disabled: false, missingReason: null, pending: true });
  });

  it("别的行有动作在途 → 本行仍禁用（避免同一面板互相插队），但 pending=false", () => {
    const m = model({ name: "b", status: "ready" });
    const action = rowActionFor(m, { model: "a", kind: "start" });
    expect(action).toEqual({ kind: "start", disabled: true, missingReason: null, pending: false });
  });

  it("在途行自己也缺文件时仍禁用（missingReason 优先于取消语义）", () => {
    const m = model({ name: "a", status: "missing-file" });
    const action = rowActionFor(m, { model: "a", kind: "start" });
    expect(action.disabled).toBe(true);
    expect(action.pending).toBe(true);
  });

  it("动作在途时按钮语义取用户发起的动作，不随 model.status 翻转", () => {
    // 启动过程中容器一起来 status 就变 running，若按 status 现推就会显示「停止中…」，
    // 而用户点的明明是启动。这条守住那次修正。
    const running = model({ name: "a", status: "running" });
    const action = rowActionFor(running, { model: "a", kind: "start" });
    expect(action.kind).toBe("start");
    expect(action.pending).toBe(true);
  });

  it("非在途行仍按 model.status 推导动作", () => {
    expect(rowActionFor(model({ name: "a", status: "running" }), null).kind).toBe("stop");
    expect(rowActionFor(model({ name: "a", status: "ready" }), null).kind).toBe("start");
  });

  it("加载中（starting）仍允许点动作——用户可能想中止一个加载了半天的大模型", () => {
    // rowActionFor 不感知 phase：按钮是否禁用只取决于 missingReason 与 pending，
    // starting 阶段既不缺文件也没有本地动作在途，所以行为与 ready 一致，不应额外禁用。
    const action = rowActionFor(model({ status: "running" }), null);
    expect(action.disabled).toBe(false);
  });
});

describe("buildCardView", () => {
  it("整合运行状态、推理态与逐行动作", () => {
    const running = model({ name: "m1", status: "running" });
    const ready = model({ name: "m2", status: "ready" });
    const missing = model({ name: "m3", status: "missing-file" });
    const view = buildCardView(
      snapshot({ models: [running, ready, missing], running: "m1", phase: "ready", inferring: true }),
      null,
    );
    expect(view.runningModel).toEqual(running);
    expect(view.phase).toBe("ready");
    expect(view.inferring).toBe("inferring");
    expect(view.openDisabled).toBe(false);
    expect(view.rows).toEqual([
      { model: running, action: { kind: "stop", disabled: false, missingReason: null, pending: false } },
      { model: ready, action: { kind: "start", disabled: false, missingReason: null, pending: false } },
      { model: missing, action: { kind: "start", disabled: true, missingReason: "missing-file", pending: false } },
    ]);
  });

  it("无模型在跑 → runningModel 为 null，不产出推理态", () => {
    const view = buildCardView(snapshot({ models: [model()], running: null, phase: "idle" }), null);
    expect(view.runningModel).toBeNull();
    expect(view.phase).toBe("idle");
    expect(view.inferring).toBeNull();
  });

  it("openUrl 为空 → openDisabled 为 true", () => {
    const view = buildCardView(snapshot({ openUrl: "" }), null);
    expect(view.openDisabled).toBe(true);
  });

  it("phase===starting 时不产出推理徽标——这句话在加载中是纯噪音", () => {
    const running = model({ name: "m1", status: "running" });
    // 按契约 starting 时 inferring 必为 null，这里刻意仍传 true，验证 starting 优先级
    // 高于 inferring 本身的值——不能指望上游永远守规矩，卡片自己也不该在这一步松懈。
    const view = buildCardView(
      snapshot({ models: [running], running: "m1", phase: "starting", inferring: true }),
      null,
    );
    expect(view.phase).toBe("starting");
    expect(view.inferring).toBeNull();
  });

  it("phase===ready 时按 inferring 字段正常推导徽标", () => {
    const running = model({ name: "m1", status: "running" });
    const view = buildCardView(
      snapshot({ models: [running], running: "m1", phase: "ready", inferring: null }),
      null,
    );
    expect(view.inferring).toBe("unknown");
  });
});

describe("describeLoadingElapsed", () => {
  const START = "2026-08-28T00:00:00.000Z";
  const startedAtMs = Date.parse(START);

  it("startedAt 为 null → null（卡片退化成不带耗时的文案）", () => {
    expect(describeLoadingElapsed(null, startedAtMs + 10_000)).toBeNull();
  });

  it("startedAt 无法解析（Date.parse 为 NaN）→ null", () => {
    expect(describeLoadingElapsed("不是一个时间", startedAtMs + 10_000)).toBeNull();
  });

  it("不满 60 秒 → 只给秒数", () => {
    const result = describeLoadingElapsed(START, startedAtMs + 18_000);
    expect(result).toEqual({ unit: "seconds", seconds: 18 });
  });

  it("59 秒仍属于秒数档，60 秒整刚好跨到分钟档", () => {
    expect(describeLoadingElapsed(START, startedAtMs + 59_000)).toEqual({ unit: "seconds", seconds: 59 });
    expect(describeLoadingElapsed(START, startedAtMs + 60_000)).toEqual({
      unit: "minutes",
      minutes: 1,
      seconds: 0,
    });
  });

  it("超过 60 秒 → 给分钟 + 秒钟", () => {
    // 92 秒 = 1 分 32 秒
    const result = describeLoadingElapsed(START, startedAtMs + 92_000);
    expect(result).toEqual({ unit: "minutes", minutes: 1, seconds: 32 });
  });

  it("now 早于 startedAt（时钟偏移）→ 按 0 秒处理，不出现负数", () => {
    const result = describeLoadingElapsed(START, startedAtMs - 5_000);
    expect(result).toEqual({ unit: "seconds", seconds: 0 });
  });

  it("不满 1 秒的余量向下取整，不四舍五入", () => {
    const result = describeLoadingElapsed(START, startedAtMs + 1_999);
    expect(result).toEqual({ unit: "seconds", seconds: 1 });
  });
});

describe("connectionFormState：连接表单的可保存判定", () => {
  const conn = { panelUrl: "http://p:8080", tokenConfigured: true };

  it("草稿与现值相同 → 不可保存（没什么可写的）", () => {
    expect(connectionFormState(conn, { panelUrl: "http://p:8080", token: "" }).canSave).toBe(false);
  });

  it("地址改了 → 可保存", () => {
    expect(connectionFormState(conn, { panelUrl: "http://q:9090", token: "" }).canSave).toBe(true);
  });

  it("只填了 token → 可保存（换 token 不换地址是常见操作）", () => {
    expect(connectionFormState(conn, { panelUrl: "http://p:8080", token: "lp_new" }).canSave).toBe(true);
  });

  it("地址被清空 → 不可保存，且给出原因", () => {
    const state = connectionFormState(conn, { panelUrl: "  ", token: "" });
    expect(state.canSave).toBe(false);
    expect(state.blockedReason).toBe("urlRequired");
  });

  it("token 未配置且草稿也没填 → 提示缺 token，但地址仍可单独保存", () => {
    const state = connectionFormState(
      { panelUrl: "http://p:8080", tokenConfigured: false },
      { panelUrl: "http://q:9090", token: "" });
    expect(state.canSave).toBe(true);
    expect(state.tokenHint).toBe("unset");
  });

  it("token 已配置且草稿留空 → 提示保持原值", () => {
    expect(connectionFormState(conn, { panelUrl: "http://p:8080", token: "" }).tokenHint)
      .toBe("keep");
  });

  it("草稿填了 token → 提示将被覆盖", () => {
    expect(connectionFormState(conn, { panelUrl: "http://p:8080", token: "x" }).tokenHint)
      .toBe("replace");
  });
});
