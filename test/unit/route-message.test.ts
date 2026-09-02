import { describe, expect, it } from "vitest";
import { formatRouteBlock } from "../../src/route-message";
import type { RouteBlockReason } from "../../src/routing";

const NAMES: Record<string, string> = {
  "qwen3-4b": "Qwen3 4B",
  "qwen3-5-4b-q4-k-m": "Qwen3.5-4B-Q4_K_M",
};
const nameOf = (key: string) => NAMES[key] ?? key;

function reason(patch: Partial<RouteBlockReason>): RouteBlockReason {
  return { kind: "mismatch", runningModel: "qwen3-4b", requestedModel: "qwen3-5-4b-q4-k-m",
           inferring: null, ...patch };
}

describe("formatRouteBlock：不含术语的操作引导", () => {
  it("mismatch：两个模型都用 displayName，不出现配置 key", () => {
    const text = formatRouteBlock(reason({}), nameOf);
    expect(text).toContain("「Qwen3.5-4B-Q4_K_M」");
    expect(text).toContain("「Qwen3 4B」");
    expect(text).not.toContain("qwen3-5-4b-q4-k-m");
  });

  it("mismatch：主句不含 strict / 档 这类术语", () => {
    const text = formatRouteBlock(reason({}), nameOf);
    expect(text).not.toContain("strict");
    expect(text).not.toContain("档");
  });

  it("mismatch：给出两条可执行的出路（去面板启动 / 改用运行中的）", () => {
    const text = formatRouteBlock(reason({}), nameOf);
    expect(text).toContain("llamapad 模型面板");
    expect(text).toContain("或改用");
  });

  it("no-model：引导启动请求的那个模型", () => {
    const text = formatRouteBlock(
      reason({ kind: "no-model", runningModel: null }), nameOf);
    expect(text).toContain("还没有模型在运行");
    expect(text).toContain("「Qwen3.5-4B-Q4_K_M」");
  });

  it("not-ready：说的是运行中那个模型正在加载，不提请求的那个", () => {
    const text = formatRouteBlock(
      reason({ kind: "not-ready", runningModel: "qwen3-4b" }), nameOf);
    expect(text).toContain("「Qwen3 4B」正在加载");
    expect(text).not.toContain("Qwen3.5-4B");
  });

  it("inferring===true 追加忙碌说明", () => {
    expect(formatRouteBlock(reason({ inferring: true }), nameOf)).toContain("正在生成");
  });

  it("inferring===null（不可知）不追加忙碌说明", () => {
    expect(formatRouteBlock(reason({ inferring: null }), nameOf)).not.toContain("正在生成");
  });

  it("inferring===false 不追加忙碌说明", () => {
    expect(formatRouteBlock(reason({ inferring: false }), nameOf)).not.toContain("正在生成");
  });

  it("not-ready 不追加 auto-switch 提示（等一下就好，换档无意义）", () => {
    const text = formatRouteBlock(
      reason({ kind: "not-ready", runningModel: "qwen3-4b" }), nameOf);
    expect(text).not.toContain("auto-switch");
  });

  it("解析不到 displayName 时回落配置 key，不出现 undefined", () => {
    const text = formatRouteBlock(reason({}), (key) => key);
    expect(text).toContain("「qwen3-4b」");
    expect(text).not.toContain("undefined");
  });
});
