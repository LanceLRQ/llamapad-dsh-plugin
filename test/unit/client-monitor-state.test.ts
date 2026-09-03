// 监控页的纯逻辑单测：增量拼接、水位推导、轮询间隔选择、展示折算。MonitorPage/
// Sparkline 是摆控件层，本仓库不设 React 测试环境（无先例），逻辑全部压在这些
// 纯函数上——与 Card.tsx / state.ts 的分工约定一致。
import { describe, expect, it } from "vitest";
import {
  formatGpuDeviceLine,
  formatMiB,
  formatMiBPair,
  formatPercent,
  formatSpeed,
  formatTokens,
  latestValue,
  mergeSeries,
  nextSince,
  pollIntervalFor,
} from "../../src/client/monitor-state";
import type { MetricPoint, MonitorMetricId, PanelGpuDevice } from "../../src/panel-client";

function point(ts: number, value: number): MetricPoint {
  return { ts, value };
}

function seriesOf(entries: Partial<Record<MonitorMetricId, MetricPoint[]>>) {
  return entries;
}

describe("mergeSeries", () => {
  it("mode=full 整窗替换：next 缺的键不再出现，prev 的旧点不残留", () => {
    const prev = seriesOf({
      "infer.tokens_per_sec": [point(1, 10), point(2, 20)],
      "gpu.util_percent": [point(1, 50)],
    });
    const next = seriesOf({ "infer.tokens_per_sec": [point(3, 30)] });
    expect(mergeSeries(prev, next, "full")).toEqual(next);
  });

  it("mode=full 空 prev 也成立（首帧语义）", () => {
    const next = seriesOf({ "container.cpu_percent": [point(1, 1)] });
    expect(mergeSeries({}, next, "full")).toEqual(next);
  });

  it("mode=delta 按 ts 升序拼接 prev 与 next", () => {
    const prev = seriesOf({ "infer.tokens_per_sec": [point(1, 10), point(2, 20)] });
    const next = seriesOf({ "infer.tokens_per_sec": [point(3, 30), point(4, 40)] });
    expect(mergeSeries(prev, next, "delta")).toEqual({
      "infer.tokens_per_sec": [point(1, 10), point(2, 20), point(3, 30), point(4, 40)],
    });
  });

  it("mode=delta 同 ts 后到覆盖先到（只保留一条，取 next 的值）", () => {
    const prev = seriesOf({ "infer.tokens_per_sec": [point(1, 10), point(2, 20)] });
    const next = seriesOf({ "infer.tokens_per_sec": [point(2, 99), point(3, 30)] });
    expect(mergeSeries(prev, next, "delta")).toEqual({
      "infer.tokens_per_sec": [point(1, 10), point(2, 99), point(3, 30)],
    });
  });

  it("mode=delta 空 prev（守势：服务端误回 delta）时结果就是 next 各键", () => {
    const next = seriesOf({ "gpu.mem_used_mib": [point(5, 100)] });
    expect(mergeSeries({}, next, "delta")).toEqual({ "gpu.mem_used_mib": [point(5, 100)] });
  });

  it("mode=delta prev 独有的键保留（面板那轮只是没给新点）", () => {
    const prev = seriesOf({
      "infer.tokens_per_sec": [point(1, 10)],
      "container.mem_percent": [point(1, 40)],
    });
    const next = seriesOf({ "infer.tokens_per_sec": [point(2, 20)] });
    expect(mergeSeries(prev, next, "delta")).toEqual({
      "infer.tokens_per_sec": [point(1, 10), point(2, 20)],
      "container.mem_percent": [point(1, 40)],
    });
  });

  it("mode=delta next 为空对象时原样返回 prev（无新点的空轮询）", () => {
    const prev = seriesOf({ "infer.kv_cache_tokens": [point(1, 100)] });
    expect(mergeSeries(prev, {}, "delta")).toEqual(prev);
  });
});

describe("nextSince", () => {
  it("取六个指标全部点里的最大 ts", () => {
    const series = seriesOf({
      "infer.tokens_per_sec": [point(1_000, 1), point(5_000, 2)],
      "container.cpu_percent": [point(7_000, 3)],
    });
    expect(nextSince(series)).toBe(7_000);
  });

  it("没有任何点（含空对象）返回 0——首帧水位语义", () => {
    expect(nextSince({})).toBe(0);
    expect(nextSince({ "gpu.util_percent": [] })).toBe(0);
  });
});

describe("pollIntervalFor", () => {
  it("30m / 2h 档 5s（匹配 5s 采样 ring 的数据分辨率）", () => {
    expect(pollIntervalFor("30m")).toBe(5_000);
    expect(pollIntervalFor("2h")).toBe(5_000);
  });

  it("24h / 7d 档 60s（15min 聚合桶，更快的轮询只是空转）", () => {
    expect(pollIntervalFor("24h")).toBe(60_000);
    expect(pollIntervalFor("7d")).toBe(60_000);
  });
});

describe("展示折算", () => {
  it("formatMiB：MiB → GiB 一位小数", () => {
    expect(formatMiB(12_615.68)).toBe("12.3 GiB");
    expect(formatMiB(0)).toBe("0.0 GiB");
  });

  it("formatMiBPair：显存用「已用/总量」共用一个单位", () => {
    expect(formatMiBPair(12_615.68, 24_563.2)).toBe("12.3/24.0 GiB");
  });

  it("formatSpeed：tok/s 保留一位小数", () => {
    expect(formatSpeed(12.34)).toBe("12.3 tok/s");
    expect(formatSpeed(0)).toBe("0.0 tok/s");
  });

  it("formatPercent：百分比取整", () => {
    expect(formatPercent(86.6)).toBe("87%");
    expect(formatPercent(0.4)).toBe("0%");
  });

  it("formatTokens：整数 + 千分位分组（KV cache 是 token 计数）", () => {
    expect(formatTokens(1_234_567)).toBe("1,234,567");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(0)).toBe("0");
  });
});

describe("latestValue", () => {
  it("返回末点值（面板窗口按 ts 升序的契约）", () => {
    expect(latestValue([point(1, 10), point(2, 20)])).toBe(20);
  });

  it("点序不可信时按最大 ts 取（增量拼接外的守势）", () => {
    expect(latestValue([point(9, 90), point(2, 20)])).toBe(90);
  });

  it("空数组或键缺席返回 null", () => {
    expect(latestValue([])).toBeNull();
    expect(latestValue(undefined)).toBeNull();
  });
});

describe("formatGpuDeviceLine", () => {
  function device(overrides: Partial<PanelGpuDevice> = {}): PanelGpuDevice {
    return {
      index: 0,
      memUsedMib: 12_615.68,
      memTotalMib: 24_563.2,
      utilPercent: 86.6,
      tempC: 65,
      powerW: 180,
      ...overrides,
    };
  }

  it("全字段：GPU 序号 · 已用/总量 GiB · 利用率% · 温度 · 功耗", () => {
    expect(formatGpuDeviceLine(device())).toBe("GPU 0 · 12.3/24.0 GiB · 87% · 65°C · 180W");
  });

  it("tempC 为 null 时省略温度段（nvidia-smi 解析不到）", () => {
    expect(formatGpuDeviceLine(device({ tempC: null }))).toBe("GPU 0 · 12.3/24.0 GiB · 87% · 180W");
  });

  it("powerW 为 null 时省略功耗段", () => {
    expect(formatGpuDeviceLine(device({ powerW: null }))).toBe("GPU 0 · 12.3/24.0 GiB · 87% · 65°C");
  });

  it("两个可空字段都缺时只剩前三段，不残留分隔点", () => {
    expect(formatGpuDeviceLine(device({ tempC: null, powerW: null }))).toBe("GPU 0 · 12.3/24.0 GiB · 87%");
  });

  it("分卡序号透传（多卡机器上区分行）", () => {
    expect(formatGpuDeviceLine(device({ index: 3 }))).toContain("GPU 3 ·");
  });
});
