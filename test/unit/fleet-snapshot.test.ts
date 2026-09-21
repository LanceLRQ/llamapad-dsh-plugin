import { describe, expect, it } from "vitest";
import { renderFleetSnapshot } from "../../src/fleet-snapshot";
import type { FleetCache } from "../../src/status-watch";

/** 最小合法缓存；fetchedAt 只参与新鲜度判断，不参与渲染，随便给个定值。 */
function cache(patch: Partial<FleetCache> = {}): FleetCache {
  return { running: [], defaultModel: null, models: [], fetchedAt: 1_000, ...patch };
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

  it("models 空且 running 为空 → 空串（无可奉告，不出只含标题的空壳）", () => {
    expect(renderFleetSnapshot(cache())).toBe("");
  });

  it("非空形态：标题、Running 行、可启动清单、工具提示句各就各位", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
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
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q4_K_M)");
    expect(startableList(text)).toBe("deepseek-r1-0528 (Q4_K_M)");
  });

  it("quant 为 null → 省略括号而不是输出 (null)", () => {
    const text = renderFleetSnapshot(cache({
      running: ["raw-gguf"],
      defaultModel: "raw-gguf",
      models: [model("raw-gguf", null), model("other", null)],
    }));
    expect(text).toContain("Running: raw-gguf\n");
    expect(text).toContain("Available to start: other\n");
    expect(text).not.toContain("(null)");
  });

  it("running 的 quant 从 models 清单里查（running 只是名字）", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b", "Q6_K")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q6_K)");
  });

  it("running 不在 models 清单里 → 仍显示 Running（无 quant），可启动清单照常", () => {
    const text = renderFleetSnapshot(cache({
      running: ["phantom"],
      defaultModel: "phantom",
      models: [model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Running: phantom");
    expect(text).toContain("Available to start: deepseek-r1-0528 (Q4_K_M)");
  });

  it("一个都没跑但有可启动模型 → 明说没有模型在跑", () => {
    const text = renderFleetSnapshot(cache({
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

describe("renderFleetSnapshot：running 行的 contextWindow（F1 规格：name/quant/contextWindow）", () => {
  it("quant 与 context 都在：Running: name (quant, Nk context)——131072 折成 128k", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b", "Q4_K_M")],
      contextWindows: { "qwen3-32b": 131072 },
    }));
    expect(text).toContain("Running: qwen3-32b (Q4_K_M, 128k context)");
  });

  it("quant 为 null、context 在：括号里只剩 (Nk context) 一段", () => {
    const text = renderFleetSnapshot(cache({
      running: ["raw-gguf"],
      defaultModel: "raw-gguf",
      models: [model("raw-gguf", null)],
      contextWindows: { "raw-gguf": 131072 },
    }));
    expect(text).toContain("Running: raw-gguf (128k context)");
    expect(text).not.toContain(",,");
  });

  it("quant 在、context 缺席（该模型键不在 contextWindows 里）：维持旧形态 (quant)，不编造 context", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b", "Q4_K_M")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q4_K_M)");
    expect(text).not.toContain("context)");
  });

  it("两者皆无：无括号（不输出空括号或 (null)）", () => {
    const text = renderFleetSnapshot(cache({
      running: ["raw-gguf"],
      defaultModel: "raw-gguf",
      models: [model("raw-gguf", null)],
    }));
    expect(text).toContain("Running: raw-gguf\n");
    expect(text).not.toContain("()");
  });

  it("格式化边界：1024 恰好折 1k；1000 低于 1024 原样输出（折 k 会丢掉全部有效数字）", () => {
    const at1k = renderFleetSnapshot(cache({
      running: ["m"], defaultModel: "m", models: [model("m", null)], contextWindows: { m: 1024 },
    }));
    expect(at1k).toContain("Running: m (1k context)");
    const below = renderFleetSnapshot(cache({
      running: ["m"], defaultModel: "m", models: [model("m", null)], contextWindows: { m: 1000 },
    }));
    expect(below).toContain("Running: m (1000 context)");
  });

  it("running 不在 models 清单里（quant 查不到）但 context 在：名字后只跟 context", () => {
    const text = renderFleetSnapshot(cache({
      running: ["phantom"],
      defaultModel: "phantom",
      models: [model("other", "Q4_K_M")],
      contextWindows: { phantom: 65536 },
    }));
    expect(text).toContain("Running: phantom (64k context)");
  });
});

describe("renderFleetSnapshot：多模型（修 P1-4：可启动清单要剔除全部在跑模型，不只是默认那个）", () => {
  it("0 个在跑：文案与单模型面板一致，只说没有模型在运行", () => {
    const text = renderFleetSnapshot(cache({
      models: [model("deepseek-r1-0528"), model("qwen3-32b")],
    }));
    expect(text).toContain("No model is currently running.");
    expect(text).not.toContain("Requests without an explicit model");
    expect(startableList(text)).toBe("deepseek-r1-0528 (Q4_K_M), qwen3-32b (Q4_K_M)");
  });

  it("1 个在跑：单模型时不必标注 (default)、也不必补充「落到谁」这句——本来就没有歧义", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Running: qwen3-32b (Q4_K_M)");
    expect(text).not.toContain("default");
    expect(text).not.toContain("Requests without an explicit model");
  });

  it("多个在跑：Running 行列出全部在跑模型（各带 quant/context），默认模型标注 (default)", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b", "deepseek-r1-0528"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b", "Q4_K_M"), model("deepseek-r1-0528", "Q6_K"), model("qwen2.5-vl-7b")],
      contextWindows: { "qwen3-32b": 131072 },
    }));
    expect(text).toContain(
      "Running: qwen3-32b (Q4_K_M, 128k context, default), deepseek-r1-0528 (Q6_K)",
    );
  });

  it("多个在跑：补一行说明不带模型名的请求会落到谁", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b", "deepseek-r1-0528"],
      defaultModel: "deepseek-r1-0528",
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).toContain("Requests without an explicit model go to: deepseek-r1-0528");
  });

  it("多个在跑但面板没有默认模型（defaultModel 为 null）：不标注 (default)、不补充落点说明", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b", "deepseek-r1-0528"],
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).not.toContain("default");
    expect(text).not.toContain("Requests without an explicit model");
  });

  it("可启动清单剔除全部在跑模型，而不只是默认那一个（P1-4：老实现只剔除单个 cache.running）", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b", "deepseek-r1-0528"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528"), model("qwen2.5-vl-7b", "Q6_K")],
    }));
    // deepseek-r1-0528 虽不是默认模型，但同样在跑，不该出现在「可启动」里
    expect(startableList(text)).toBe("qwen2.5-vl-7b (Q6_K)");
  });

  it("多个在跑、全部都在 models 清单里能启动的模型已跑满：可启动清单不出现（不补空行）", () => {
    const text = renderFleetSnapshot(cache({
      running: ["qwen3-32b", "deepseek-r1-0528"],
      defaultModel: "qwen3-32b",
      models: [model("qwen3-32b"), model("deepseek-r1-0528")],
    }));
    expect(text).not.toContain("Available to start");
  });
});
