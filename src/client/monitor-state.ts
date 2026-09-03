// 监控页的纯逻辑：把 monitor RPC 的增量快照折算成渲染要用的展示值（曲线序列的
// 合并、增量水位、轮询间隔、数值格式）。刻意不掺 React——与 state.ts 的分工约定
// 一致：状态推导不依赖运行环境，纯函数才好单测，MonitorPage.tsx 只剩「照着摆控件
// 与轮询」这一件事。
//
// 类型全部从 panel-client 以 type-only 引入（编译期擦除，不会把 Node 侧 HTTP 客户端
// 打进浏览器产物——与 rpc-contract.ts 顶部的 import type 同一条约束）。
import type {
  MetricsRange,
  MetricPoint,
  MonitorMetricId,
  PanelGpuDevice,
  PanelGpuStats,
} from "../panel-client";

/** MonitorSnapshot.series 的形状重述，避免每个函数签名都写一遍 Partial Record。 */
export type MonitorSeries = Partial<Record<MonitorMetricId, MetricPoint[]>>;

/**
 * 把一轮 monitor 响应的 series 并进已有曲线。
 *
 * - mode=full：整窗替换。面板的窗口起点随时间滑动，旧点会滚出窗口，任何「保留
 *   旧键再叠加」的策略都会让曲线越滚越长——直接换掉 next 才是窗口语义。
 * - mode=delta：按 ts 去重拼接。**同 ts 后到覆盖先到**：15min 聚合桶还在收样本时
 *   面板会对同一个 ts 重发修正值（比如桶刚闭合时先给部分样本的均值、下一轮再给
 *   全量均值），覆盖而不是丢弃才能让曲线自我修正；而先到覆盖后到会把修正值丢掉。
 *
 * 结果按键 ts 升序排列；next 里缺席的键在 delta 下保留 prev 原值（面板那一轮只是
 * 没有新点，不是指标下线——下线走 full 才生效）。返回的数组要么是 next 原数组、
 * 要么是新建数组，调用方一律不原地修改。
 */
export function mergeSeries(
  prev: MonitorSeries,
  next: MonitorSeries,
  mode: "full" | "delta",
): MonitorSeries {
  if (mode === "full") return next;
  const merged: MonitorSeries = {};
  for (const id of Object.keys(prev) as MonitorMetricId[]) {
    // prev 独有的键：delta 里没有它的新闻，原样带过
    if (next[id] === undefined) merged[id] = prev[id];
  }
  for (const id of Object.keys(next) as MonitorMetricId[]) {
    const incoming = next[id];
    if (incoming === undefined) continue; // 类型收窄：Partial 的键值可能名义上缺席
    const existing = prev[id];
    if (existing === undefined || existing.length === 0) {
      merged[id] = incoming;
      continue;
    }
    // 按 ts 去重拼接：同 ts 后到（next）覆盖先到（prev），见函数注释
    const byTs = new Map<number, MetricPoint>();
    for (const point of existing) byTs.set(point.ts, point);
    for (const point of incoming) byTs.set(point.ts, point);
    merged[id] = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }
  return merged;
}

/**
 * 增量水位：六个指标全部点里的最大 ts——下一轮 delta 的 since。
 *
 * 为什么取「六指标全局最大」而不是逐指标各记各的：monitor 的 since 是**整份快照
 * 级**的参数（描述符只有一个 since），没有逐指标的位置；取全局最大意味着个别
 * 指标可能漏掉比水位更早的尾部点，但那些点在下一轮 full（30m 窗口约每 30m 必有
 * 一次，见 panel-client 的增量否决条件）就会补齐，而取更小值会让所有指标每轮都
 * 重传已有点，白费增量协议。无任何点返回 0（= 首帧全量水位）。
 */
export function nextSince(series: MonitorSeries): number {
  let max = 0;
  for (const points of Object.values(series)) {
    for (const point of points) {
      if (point.ts > max) max = point.ts;
    }
  }
  return max;
}

/**
 * range → 轮询间隔：30m/2h 档 5s，24h/7d 档 60s。
 *
 * 匹配数据分辨率而不是「越快越好」：30m/2h 窗口是 5s 采样的 ring，5s 轮询恰好
 * 一步一拍；24h/7d 是 15min 聚合桶，5s 轮询意味着 180 次请求里 179 次拿到同一
 * 个桶，纯空转——降到 60s 既省流量也不损失可见的时效性（桶本身一刻钟才更新）。
 */
export function pollIntervalFor(range: MetricsRange): number {
  return range === "30m" || range === "2h" ? 5_000 : 60_000;
}

/** MiB → GiB 一位小数（面板指标以 MiB 为单位上报，展示按用户熟悉的 GiB 折算）。 */
export function formatMiB(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/** 显存「已用/总量」共用一个单位：formatMiB 各带单位会得到「12.3 GiB/24.0 GiB」的赘语。 */
export function formatMiBPair(usedMib: number, totalMib: number): string {
  return `${(usedMib / 1024).toFixed(1)}/${(totalMib / 1024).toFixed(1)} GiB`;
}

/** tok/s 一位小数：生成速度的有效变化就在小数位，取整会抹平低速档的差别。 */
export function formatSpeed(tokensPerSec: number): string {
  return `${tokensPerSec.toFixed(1)} tok/s`;
}

/** 百分比取整：CPU/GPU 利用率的采样噪声远大于 1%，小数位是伪精度。 */
export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/**
 * token 计数（KV cache）：取整 + 千分位分组。不用 toLocaleString——它的分组符
 * 随宿主 locale 变，同一份数据在 zh/en 环境呈现会不一致，纯函数要可复现。
 */
export function formatTokens(value: number): string {
  return String(Math.round(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * 序列的当前值：按最大 ts 取（面板窗口按 ts 升序的契约下就是末点；不直接读
 * 末元素是对「点序不可信」的守势——谁在中间塞一个乱序点，当前值不该跟着错）。
 * 无点（含键缺席）返回 null，由调用方落「暂无数据」文案。
 */
export function latestValue(points: readonly MetricPoint[] | undefined): number | null {
  if (points === undefined || points.length === 0) return null;
  let latest: MetricPoint | null = null;
  for (const point of points) {
    if (latest === null || point.ts >= latest.ts) latest = point;
  }
  return latest === null ? null : latest.value;
}

/**
 * 分卡明细行文案：`GPU 0 · 12.3/24.0 GiB · 87% · 65°C · 180W`。
 * tempC/powerW 为 null（nvidia-smi 解析不到）时整段省略而不是补 0——65°C 与
 * 「温度未知」是两回事，补占位数字会把「不知道」伪装成「正常」。
 */
export function formatGpuDeviceLine(device: PanelGpuDevice): string {
  const parts = [
    `GPU ${device.index}`,
    formatMiBPair(device.memUsedMib, device.memTotalMib),
    formatPercent(device.utilPercent),
  ];
  if (device.tempC !== null) parts.push(`${Math.round(device.tempC)}°C`);
  if (device.powerW !== null) parts.push(`${Math.round(device.powerW)}W`);
  return parts.join(" · ");
}
