import { describe, expect, it } from "vitest";
import { buildReasoningInfo, parseReasoningInfo, ALL_EFFORT_LEVELS } from "../../src/reasoning";

describe("parseReasoningInfo：从面板增强过的 /v1/models 响应里取思考强度声明", () => {
  const enhanced = (extra: unknown) => ({
    object: "list",
    data: [{ id: "qwen3", object: "model", x_llamapad: { reasoning_effort: extra } }],
  });

  it("取出 supported 与 levels", () => {
    expect(parseReasoningInfo(enhanced({ supported: true, levels: ["xhigh", "medium", "low"], rounding: "down" })))
      .toEqual({ supported: true, levels: ["xhigh", "medium", "low"] });
  });

  it("levels 为 null（模板支持但提取不到值域）原样保留 null", () => {
    expect(parseReasoningInfo(enhanced({ supported: true, levels: null })))
      .toEqual({ supported: true, levels: null });
  });

  it("supported:false（模板不支持，或 GGUF 没内嵌模板导致不可知）", () => {
    expect(parseReasoningInfo(enhanced({ supported: false, levels: null })))
      .toEqual({ supported: false, levels: null });
  });

  it("levels 里的非字符串项被剔除，剔空后归 null", () => {
    expect(parseReasoningInfo(enhanced({ supported: true, levels: ["low", 3, null] })))
      .toEqual({ supported: true, levels: ["low"] });
    expect(parseReasoningInfo(enhanced({ supported: true, levels: [1, 2] })))
      .toEqual({ supported: true, levels: null });
  });

  it("老面板（没有 x_llamapad）→ null", () => {
    expect(parseReasoningInfo({ object: "list", data: [{ id: "qwen3" }] })).toBeNull();
  });

  it("形状不符一律 null，不抛错", () => {
    for (const bad of [null, undefined, "", 42, [], { data: "x" }, { data: [] }, { data: [null] }]) {
      expect(parseReasoningInfo(bad)).toBeNull();
    }
  });
});

describe("buildReasoningInfo：面板声明 → dsh LlmModelReasoningInfo", () => {
  it("supported + 已知值域 → 只列这几档，顺序照面板给的", () => {
    const info = buildReasoningInfo({ supported: true, levels: ["xhigh", "medium", "low"] });
    expect(info?.efforts.map((e) => e.id)).toEqual(["xhigh", "medium", "low"]);
    expect(info?.efforts.map((e) => e.name)).toEqual(["超高", "中", "低"]);
  });

  it("supported 但值域未知 → 完整枚举", () => {
    expect(buildReasoningInfo({ supported: true, levels: null })?.efforts.map((e) => e.id))
      .toEqual([...ALL_EFFORT_LEVELS]);
  });

  it("面板明说不支持 → undefined（不给用户一个选了也没用的选项）", () => {
    expect(buildReasoningInfo({ supported: false, levels: null })).toBeUndefined();
  });

  it("没问到（模型未运行 / 端点不可用）→ 完整枚举兜底", () => {
    expect(buildReasoningInfo(null)?.efforts.map((e) => e.id)).toEqual([...ALL_EFFORT_LEVELS]);
  });

  it("值域里的阶梯外自定义档位，显示名回退为 id 本身", () => {
    const info = buildReasoningInfo({ supported: true, levels: ["low", "ultra"] });
    expect(info?.efforts).toEqual([
      { id: "low", name: "低" },
      { id: "ultra", name: "ultra" },
    ]);
  });

  it("空数组值域视同未知，退回完整枚举（不产出一个空选择器）", () => {
    expect(buildReasoningInfo({ supported: true, levels: [] })?.efforts.map((e) => e.id))
      .toEqual([...ALL_EFFORT_LEVELS]);
  });
});
