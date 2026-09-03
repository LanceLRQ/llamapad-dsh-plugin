// 监控页的纯 SVG 折线组件。为什么自绘 SVG 而不是 canvas：六指标最多 7d@15min ≈
// 672 点/条，一条 polyline 毫无压力；SVG 声明式地跟着 React 重渲，天然随设备像素比
// 缩放不模糊（canvas 要自己管 DPR、resize 与重绘时机），也谈不上交互状态（首版
// 无 hover）。dsh-client-ui-primitives 没有任何图表组件（导出清单核实过），曲线
// 只能自己画，SVG 是零依赖下代价最小的那条路。
//
// 本组件在本仓库没有 React 测试环境（无先例，不引入 jsdom）：归一化的「不炸」
// 边界（空数组/单点/零跨度）都收在纯函数化的小分支里，逻辑量小到肉眼可审。
interface SparklinePoint {
  readonly ts: number;
  readonly value: number;
}

export interface SparklineProps {
  readonly points: readonly SparklinePoint[];
  /** viewBox 名义坐标系的宽高（非渲染像素——svg 由 CSS 铺满卡宽，均匀缩放） */
  readonly width: number;
  readonly height: number;
  readonly color?: string;
}

/** 曲线离画布边缘的留白：不给 stroke（1.5px）与末点圆（r2.5）贴边后被裁掉半截。 */
const PAD = 3;
const STROKE_WIDTH = 1.5;
const DOT_RADIUS = 2.5;

/**
 * 单条曲线。
 *
 * 归一化策略：
 * - x 轴按 ts 线性展开（不是按点序等分）：增量拼接与空窗缺口下相邻点的间距应该
 *   反映真实时间间隔，等分展开会把「模型停了十分钟」画成匀速下滑，撒谎。
 * - y 轴按本窗口的 min/max 归一：sparkline 只表达「形状与相对变化」，不标轴——
 *   绝对值在旁边的当前值文本里明文给出。
 * - 零跨度（max===min，含单点、恒值序列）画中线：既不像「顶满」也不像「贴地
 *   为 0」，对「恒 50%」与「恒 0%」一视同仁，不预设哪边更可能。
 * - 单点画整宽平线 + 末点圆（一个点画不出斜率，平线如实表达「没有变化」）；
 *   空数组只画空 svg 不画线——占住布局高度（曲线区不塌陷），等数据来了再画。
 */
export function Sparkline({ points, width, height, color = "var(--dsw-alias-brand-primary)" }: SparklineProps) {
  const n = points.length;
  // svg 恒渲染（空数据也占住高度，布局不跳）；polyline 与末点圆按数据有无决定
  if (n === 0) {
    return (
      <svg
        className="llamapad-monitor__spark"
        viewBox={`0 0 ${width} ${height}`}
        aria-hidden="true"
      />
    );
  }

  let minV = Infinity;
  let maxV = -Infinity;
  for (const point of points) {
    if (point.value < minV) minV = point.value;
    if (point.value > maxV) maxV = point.value;
  }
  const valueSpan = maxV - minV;
  const first = points[0];
  const last = points[n - 1];
  // noUncheckedIndexedAccess 下索引访问是可空的：n>0 已在上方分支保证，这里用
  // 显式收窄兜住类型（而不是非空断言，本仓库不用 `!`）
  if (first === undefined || last === undefined) {
    return (
      <svg className="llamapad-monitor__spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true" />
    );
  }
  const ts0 = first.ts;
  const tsSpan = last.ts - ts0;

  const yOf = (value: number): number =>
    valueSpan === 0
      ? height / 2
      : PAD + (1 - (value - minV) / valueSpan) * (height - 2 * PAD);
  // ts 全同（去重后不该出现，守势）：退化为按点序等分，至少还能画出形状
  const xOfTs = (ts: number, index: number): number =>
    tsSpan === 0
      ? PAD + (index / (n - 1)) * (width - 2 * PAD)
      : PAD + ((ts - ts0) / tsSpan) * (width - 2 * PAD);

  // 单点：xOfTs 的分母会除零，直接画整宽平线，末点圆落在右端
  const line =
    n === 1
      ? `0,${yOf(first.value).toFixed(2)} ${width},${yOf(first.value).toFixed(2)}`
      : points
          .map((point, index) => `${xOfTs(point.ts, index).toFixed(2)},${yOf(point.value).toFixed(2)}`)
          .join(" ");
  const lastX = n === 1 ? width - PAD : xOfTs(last.ts, n - 1);
  const lastY = yOf(last.value);

  return (
    <svg className="llamapad-monitor__spark" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      {/* aria-hidden：曲线纯装饰，数值在相邻文本明文展示，读屏不需要这条线 */}
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={STROKE_WIDTH}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx={lastX} cy={lastY} r={DOT_RADIUS} fill={color} />
    </svg>
  );
}
