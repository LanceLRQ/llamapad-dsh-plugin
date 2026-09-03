import { describe, expect, it } from "vitest";
import { renderFleetSnapshot } from "../../src/fleet-snapshot";
import type { FleetCache } from "../../src/status-watch";

/** 最小合法缓存；fetchedAt 只参与新鲜度判断，不参与渲染，随便给个定值。 */
function cache(patch: Partial<FleetCache> = {}): FleetCache {
  return { running: null, models: [], fetchedAt: 1_000, ...patch };
}

/** 取「Available to start: 」一行的清单部分（noUncheckedIndexedAccess 下免 ! 链）。 */
function startableList(text: string): string {
  return text.match(/Available to start: (.*)\n/)?.[1] ?? "";
}

function model(name: string, quant: string | null = "Q4_K_M") {
  return { name, displayName: name, quant };
}

describe("renderFleetSnapshot", () => {
  it("cache 为 null → 空串（renderPrompt 丢弃空分节，面板不可达时天然降级）", () => {
    expect(renderFleetSnapshot(null)).toBe("");
  });

  it("models 空且 running 为 null → 空串（无可奉告，不出只含标题的空壳）", () => {
    expect(renderFleetSnapshot(cache())).toBe("");
  });

  it("非空形态：标题、Running 行、可启动清单、工具提示句各就各位", () => {
    const text = renderFleetSnapshot(cache({
      running: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528", "Q4_K_M"), model("qwen2.5-vl-7b", "Q6_K")],
    }));
    expect(text).toContain("## Local model fleet (llamapad)");
    expect(text).toContain("Running: qwen3-32b (Q4_K_M)");
    expect(text).toContain("Available to start: deepseek-r1-0528 (Q4_K_M), qwen2.5-vl-7b (Q6_K)");
    // 工具提示句要说「may be available」——B 形态（tools 入口）没挂载时不能撒谎
    expect(text).toContain("llamapad_start_model");
    expect(text).toContain("llamapad_stop_model");
    expect(text).toContain("may be available");
  });

  it("运行中的模型同时出现在 models 里时，从「可启动」清单剔除（它在跑，不是可启动）", () => {
    const text = renderFleetSnapshot(cache({
      running: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q4_K_M)");
    expect(startableList(text)).toBe("deepseek-r1-0528 (Q4_K_M)");
  });

  it("quant 为 null → 省略括号而不是输出 (null)", () => {
    const text = renderFleetSnapshot(cache({
      running: "raw-gguf",
      models: [model("raw-gguf", null), model("other", null)],
    }));
    expect(text).toContain("Running: raw-gguf\n");
    expect(text).toContain("Available to start: other\n");
    expect(text).not.toContain("(null)");
  });

  it("running 的 quant 从 models 清单里查（running 只是名字）", () => {
    const text = renderFleetSnapshot(cache({
      running: "qwen3-32b",
      models: [model("qwen3-32b", "Q6_K")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q6_K)");
  });

  it("running 不在 models 清单里 → 仍显示 Running（无 quant），可启动清单照常", () => {
    const text = renderFleetSnapshot(cache({
      running: "phantom",
      models: [model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Running: phantom");
    expect(text).toContain("Available to start: deepseek-r1-0528 (Q4_K_M)");
  });

  it("running 为 null 但有可启动模型 → 明说没有模型在跑", () => {
    const text = renderFleetSnapshot(cache({
      running: null,
      models: [model("deepseek-r1-0528")],
    }));
    expect(text).toContain("No model is currently running");
    expect(text).toContain("Available to start: deepseek-r1-0528 (Q4_K_M)");
    expect(text).not.toContain("Running:");
  });

  it("可启动清单截断到 20 条，超出用 … and N more 提示（提示词预算敏感）", () => {
    const models = Array.from({ length: 25 }, (_, i) => model(`m${String(i).padStart(2, "0")}`));
    const text = renderFleetSnapshot(cache({ models }));
    const listLine = startableList(text);
    expect(listLine).toContain("m00");
    expect(listLine).toContain("m19");
    expect(listLine).not.toContain("m20"); // 第 21 条起只以计数出现
    expect(listLine.endsWith("… and 5 more")).toBe(true);
    // 恰好 20 条：不截断、无提示尾巴
    const exact = renderFleetSnapshot(cache({ models: models.slice(0, 20) }));
    expect(startableList(exact)).toContain("m19");
    expect(exact).not.toContain("… and");
  });
});
