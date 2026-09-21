import { describe, expect, it } from "vitest";
import { formatRouteBlock } from "../../src/route-message";
import type { RouteBlockReason } from "../../src/routing";

const NAMES: Record<string, string> = {
  "qwen3-4b": "Qwen3 4B",
  "qwen3-5-4b-q4-k-m": "Qwen3.5-4B-Q4_K_M",
  "llama3-8b": "Llama3 8B",
  "mistral-7b": "Mistral 7B",
  "gemma-9b": "Gemma 9B",
};
const nameOf = (key: string) => NAMES[key] ?? key;

function reason(patch: Partial<RouteBlockReason>): RouteBlockReason {
  return {
    kind: "mismatch",
    runningModels: ["qwen3-4b"],
    defaultModel: "qwen3-4b",
    requestedModel: "qwen3-5-4b-q4-k-m",
    inferring: null,
    ...patch,
  };
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

  it("mismatch：单模型在跑时不追加「默认模型是」这句（信息冗余，维持既有简洁文案）", () => {
    const text = formatRouteBlock(reason({}), nameOf);
    expect(text).not.toContain("默认模型是");
  });

  it("mismatch：多模型在跑时列出全部在跑模型，且补一句面板当前默认模型", () => {
    const text = formatRouteBlock(
      reason({ runningModels: ["qwen3-4b", "llama3-8b"], defaultModel: "qwen3-4b" }),
      nameOf,
    );
    expect(text).toContain("Qwen3 4B");
    expect(text).toContain("Llama3 8B");
    expect(text).toContain("默认模型是「Qwen3 4B」");
  });

  it("mismatch：超过 3 个在跑模型时截断为「A、B、C 等 N 个」", () => {
    const text = formatRouteBlock(
      reason({
        runningModels: ["qwen3-4b", "llama3-8b", "mistral-7b", "gemma-9b"],
        defaultModel: "qwen3-4b",
      }),
      nameOf,
    );
    expect(text).toContain("Qwen3 4B、Llama3 8B、Mistral 7B 等 4 个");
    expect(text).not.toContain("Gemma 9B");
  });

  it("mismatch：多模型但面板显式没有默认模型时，不点名「改用」哪一个", () => {
    const text = formatRouteBlock(
      reason({ runningModels: ["qwen3-4b", "llama3-8b"], defaultModel: null }),
      nameOf,
    );
    expect(text).not.toContain("默认模型是");
    expect(text).toContain("或改用运行中的模型继续对话");
  });

  it("no-model：引导启动请求的那个模型", () => {
    const text = formatRouteBlock(
      reason({ kind: "no-model", runningModels: [], defaultModel: null }), nameOf);
    expect(text).toContain("还没有模型在运行");
    expect(text).toContain("「Qwen3.5-4B-Q4_K_M」");
  });

  it("not-ready：说的是运行中那个模型正在加载，不提请求的那个", () => {
    const text = formatRouteBlock(
      reason({ kind: "not-ready", runningModels: ["qwen3-4b"], defaultModel: "qwen3-4b" }), nameOf);
    expect(text).toContain("「Qwen3 4B」正在加载");
    expect(text).not.toContain("Qwen3.5-4B");
  });

  it("not-ready：加载中的是请求模型自身时，说的是请求模型本身", () => {
    const text = formatRouteBlock(
      reason({
        kind: "not-ready",
        runningModels: ["qwen3-5-4b-q4-k-m"],
        defaultModel: "qwen3-5-4b-q4-k-m",
        requestedModel: "qwen3-5-4b-q4-k-m",
      }),
      nameOf,
    );
    expect(text).toContain("「Qwen3.5-4B-Q4_K_M」正在加载");
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
      reason({ kind: "not-ready", runningModels: ["qwen3-4b"], defaultModel: "qwen3-4b" }), nameOf);
    expect(text).not.toContain("auto-switch");
  });

  it("解析不到 displayName 时回落配置 key，不出现 undefined", () => {
    const text = formatRouteBlock(reason({}), (key) => key);
    expect(text).toContain("「qwen3-4b」");
    expect(text).not.toContain("undefined");
  });
});
