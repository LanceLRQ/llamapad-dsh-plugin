import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { createFakePanel } from "./fake-panel-server.mjs";
import { createPanelClient } from "../../src/panel-client";
import { PanelGateway } from "../../src/panel-gateway";
import { RPC_CONTRIBUTION, RPC_METHOD, type MonitorSnapshot } from "../../src/rpc-contract";

/**
 * monitor 的假面板 E2E：真 panel-client（真 fetch + 投影）+ 假面板的 metrics/gpu
 * 端点（delta 三否决与三态同构自面板源码）+ 真 PanelGateway 的并发合并。
 * 单测（panel-gateway.test.ts）用 mock client 钉的是「合并语义」本身；这里钉的是
 * 「真 HTTP 链路下两端契约对得上」——query 拼装、series 裁剪、可空字段（温度/功耗/
 * totals）、以及 host 组装的 MonitorSnapshot 能原样通过浏览器侧的 strict codec
 * （rpc-contract 是两侧共用的一份，roundtrip 在这条链路上验证最有说服力）。
 */
let server: ReturnType<typeof createFakePanel>["server"];
let state: ReturnType<typeof createFakePanel>["state"];
let gateway: PanelGateway;

/** monitor 描述符的 result codec：即浏览器产物用的同一份 strict 校验 */
const monitorResultCodec = RPC_CONTRIBUTION.descriptors
  .find((d) => d.method === RPC_METHOD.monitor)!.result.schema;

beforeAll(async () => {
  ({ server, state } = createFakePanel({ loadMs: 10 }));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const client = createPanelClient({ baseUrl, token: "lp_e2e", requestTimeoutMs: 2_000 });
  // Service 构造只用到 ctx.reflect.provide（对齐 panel-gateway 单测的假 ctx）
  gateway = new PanelGateway(
    { reflect: { provide: vi.fn() } } as unknown as Context,
    { client, gate: { ensure: async () => {}, lastStarted: () => null }, panelUrl: baseUrl, token: "lp_e2e" },
    async () => {},
  );
});
afterAll(() => server.close());

/** 断言并返回最新一条 metrics 请求留痕（range 原样 + since 原始字符串） */
function lastMetricsRequest(): { range: string; since: string | null } {
  return state.metricsRequests[state.metricsRequests.length - 1]!;
}

describe("monitor E2E（gateway → 真面板客户端 → 假面板）", () => {
  it("首帧 full：并发合并两半；series 裁剪到监控键（多余键不下发）、空数组语义保留；温度功耗/totals 逐字段透传", async () => {
    const before = Date.now();
    const snapshot = await gateway.monitor("30m", undefined);

    // query 拼装：range 必发、since 缺省不发参数（让服务端自己定「无水位=全量」）
    expect(lastMetricsRequest()).toEqual({ range: "30m", since: null });

    const tokens = snapshot.series["infer.tokens_per_sec"]!;
    expect(tokens).toHaveLength(3); // 假面板 seed 的三个点整窗透传
    expect(snapshot.series["gpu.util_percent"]).toEqual([]); // 在场空数组=未采集，保留
    expect(snapshot.series["container.cpu_percent"]).toHaveLength(1);
    // 插件不消费的键（host.*）必须被投影裁掉，不随 MonitorSnapshot 下发
    expect(Object.keys(snapshot.series)).not.toContain("host.cpu_percent");

    // gpu 半边：分卡明细逐字段透传（第二卡温度/功耗 null 是真机解析不到的契约值）、
    // totals 是两卡合计；samples 字段不声明即丢弃
    expect(snapshot.gpu).toEqual({
      available: true,
      status: "available",
      devices: [
        { index: 0, memUsedMib: 1024, memTotalMib: 24564, utilPercent: 42, tempC: 61, powerW: 250.5 },
        { index: 1, memUsedMib: 512, memTotalMib: 24564, utilPercent: 7, tempC: null, powerW: null },
      ],
      totals: { memUsedMib: 1536, memTotalMib: 49128 },
    });

    expect(snapshot.mode).toBe("full");
    expect(snapshot.panelError).toBeNull();
    expect(snapshot.serverTs).toBeGreaterThanOrEqual(before); // host 组装时刻
    // host 组装的返回值必须能原样通过浏览器侧 strict codec（两侧共用 rpc-contract）
    expect(monitorResultCodec.parse(snapshot)).toEqual(snapshot);
  });

  it("带 since 的 30m 增量：只回 ts > since 的新点、mode=delta（水位取自上次收到的点，同浏览器用法）", async () => {
    await gateway.monitor("30m", undefined); // 先拿整窗，从中取水位
    const full = await gateway.monitor("30m", undefined);
    const points = full.series["infer.tokens_per_sec"]!;
    const since = points[1]!.ts; // 浏览器侧的取法：上次收到的点里挑一个做水位

    const snapshot = await gateway.monitor("30m", since);

    expect(lastMetricsRequest()).toEqual({ range: "30m", since: String(since) });
    expect(snapshot.mode).toBe("delta");
    // 严格大于水位的点只有第三个；其余序列的点都 ≤ since，过滤后为空数组
    expect(snapshot.series["infer.tokens_per_sec"]).toEqual([points[2]!]);
    expect(snapshot.series["infer.kv_cache_tokens"]).toEqual([]);
    expect(snapshot.series["container.cpu_percent"]).toEqual([]);
    expect(snapshot.panelError).toBeNull();
  });

  it("24h 档否决增量（15m 聚合桶不可追加）：带 since 仍回 full 整窗", async () => {
    const full = await gateway.monitor("30m", undefined);
    const since = full.series["infer.tokens_per_sec"]![1]!.ts;

    const snapshot = await gateway.monitor("24h", since);

    // 假面板同构了 planWindowQuery 的否决②：插件侧零判断、只认响应里的 mode
    expect(lastMetricsRequest()).toEqual({ range: "24h", since: String(since) });
    expect(snapshot.mode).toBe("full");
    expect(snapshot.series["infer.tokens_per_sec"]).toHaveLength(3);
  });

  it("gpu 半边失败：panelError 非空、gpu 为 null，metrics 半边照常下发", async () => {
    state.failGpu = true;
    try {
      const snapshot = await gateway.monitor("30m", undefined);
      expect(snapshot.gpu).toBeNull();
      expect(snapshot.series["infer.tokens_per_sec"]!).toHaveLength(3);
      expect(snapshot.mode).toBe("full");
      expect(snapshot.panelError).toContain("gpu 注入失败");
    } finally {
      state.failGpu = false;
    }
  });

  it("metrics 半边失败：series 兜底空、mode 兜底 full，gpu 半边照常下发（反向半边失败）", async () => {
    state.failMetrics = true;
    try {
      const snapshot = await gateway.monitor("30m", undefined);
      expect(snapshot.series).toEqual({});
      // mode 兜必须是 full：delta 的语义是「追加到已有曲线」，没有基础数据时
      // 整窗替换才不会把空缺静默吞掉
      expect(snapshot.mode).toBe("full");
      expect(snapshot.gpu).not.toBeNull();
      expect(snapshot.panelError).toContain("metrics 注入失败");
    } finally {
      state.failMetrics = false;
    }
  });

  it("纯 CPU 机器是合法状态：unavailable / probing 不抛错、devices 空、totals 为 null（不是 0/0）", async () => {
    state.gpuStatus = "unavailable";
    let snapshot = await gateway.monitor("30m", undefined);
    expect(snapshot.gpu).toEqual({ available: false, status: "unavailable", devices: [], totals: null });
    expect(snapshot.panelError).toBeNull();

    state.gpuStatus = "probing";
    snapshot = await gateway.monitor("30m", undefined);
    expect(snapshot.gpu).toEqual({ available: false, status: "probing", devices: [], totals: null });
    expect(snapshot.panelError).toBeNull();
    // 收尾恢复默认，别让后续用例（或同文件新增用例）拿到被改写的状态
    state.gpuStatus = "available";
  });

  it("range 非法：网关在发请求前就抛 TypeError（对齐 model 空串先例），假面板不收到请求", async () => {
    const requestsBefore = state.metricsRequests.length;
    await expect(gateway.monitor("1h", undefined)).rejects.toThrow(TypeError);
    expect(state.metricsRequests.length).toBe(requestsBefore);
  });

  it("返回值过浏览器侧 strict codec 的全档位抽查（四档 range 都能组装出合法快照）", async () => {
    for (const range of ["30m", "2h", "24h", "7d"] as const) {
      const snapshot: MonitorSnapshot = await gateway.monitor(range, undefined);
      expect(monitorResultCodec.parse(snapshot)).toEqual(snapshot);
    }
  });
});
