// 监控页的 React 组件本身：只负责「照着 monitor-state.ts 折算出的展示值摆控件」
// 与「按 pollIntervalFor 轮询 monitor RPC」这两件跟运行环境绑定、没法纯函数化的事，
// 合并/水位/格式化一律委托给 monitor-state.ts（与 Card.tsx / state.ts 的分工同构）。
import { useEffect, useRef, useState } from "react";
import {
  Button,
  IconCloseOutline16,
  IconWarningOutline16,
  Pill,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { Sparkline } from "./Sparkline";
import type { PanelApi } from "./rpc";
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
  type MonitorSeries,
} from "./monitor-state";
import { injectMonitorStyles } from "./styles";
import type { LocaleKey } from "./locale";
// type-only：MetricsRange/MetricPoint/PanelGpuStats 锚定 panel-client 的类型，
// 编译期擦除，不会把 Node 侧 HTTP 客户端打进浏览器产物
import type { MetricsRange, MetricPoint, PanelGpuStats } from "../panel-client";

// 模块加载时注入一次（injectMonitorStyles 内部按 tag id 判重），与 Card 的
// injectCardStyles 同一时机——理由见 Card.tsx 对应注释。
injectMonitorStyles();

export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string;

/**
 * settings.section 的 owner props（宿主 shell 注入的关闭手势）+ 本插件 inject 的
 * api + 注册时声明 locale 合成的 t——四股 props 在 slot 机制里合流，这里只声明
 * 组件自己消费的三股。
 */
export interface MonitorPageProps {
  readonly api: PanelApi;
  readonly t: Translate;
  /** 关闭整个设置面板（开状态归宿主 shell 所有），见 settings.section 契约 */
  readonly close: () => void;
}

/** range 切换的四档：顺序即渲染顺序，label 走词典。 */
const RANGES: readonly { readonly id: MetricsRange; readonly labelKey: LocaleKey }[] = [
  { id: "30m", labelKey: "range30m" },
  { id: "2h", labelKey: "range2h" },
  { id: "24h", labelKey: "range24h" },
  { id: "7d", labelKey: "range7d" },
];

/** 曲线名义坐标系（Sparkline 的 viewBox，非渲染像素，见 Sparkline.tsx 注释）。 */
const SPARK_WIDTH = 300;
const SPARK_HEIGHT = 44;

/** 一条指标块：标签 + 当前值 + 曲线。valueText 由父级折算好（含「暂无数据」兜底）。 */
function MetricBlock({
  label,
  valueText,
  points,
}: {
  readonly label: string;
  readonly valueText: string;
  readonly points: readonly MetricPoint[] | undefined;
}) {
  return (
    <div className="llamapad-monitor__metric">
      <div className="llamapad-monitor__metricHead">
        <span className="llamapad-monitor__metricLabel">{label}</span>
        <span className="llamapad-monitor__metricValue">{valueText}</span>
      </div>
      <Sparkline points={points ?? []} width={SPARK_WIDTH} height={SPARK_HEIGHT} />
    </div>
  );
}

/** 当前值文案：无点落「暂无数据」，有值按各指标自己的单位折算。 */
function metricText(
  points: readonly MetricPoint[] | undefined,
  format: (value: number) => string,
  noData: string,
): string {
  const value = latestValue(points);
  return value === null ? noData : format(value);
}

export function MonitorPage({ api, t, close }: MonitorPageProps) {
  const [range, setRange] = useState<MetricsRange>("30m");
  const [series, setSeries] = useState<MonitorSeries>({});
  const [gpu, setGpu] = useState<PanelGpuStats | null>(null);
  // panelError 走快照字段（面板侧拉取失败的中文说明）；loadError 是 RPC 外壳本身
  // 抛错（传输/鉴权层）——分开存，横幅各画各的，语义同 Card.tsx 的两个错误位
  const [panelError, setPanelError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [receivedOnce, setReceivedOnce] = useState(false);

  // api 与合并后序列的镜像 ref：api 防 effect 因 props 换引用而重建（Card.tsx 同款）；
  // seriesRef 让轮询回调能「读最新合并结果 → 算下一轮水位」而不依赖 setState 的
  // 异步回填——setSeries 的函数式更新拿不到返回值，水位就必须另有出处。
  const apiRef = useRef(api);
  apiRef.current = api;
  const seriesRef = useRef<MonitorSeries>({});

  // ── 轮询 ──
  // 挂载即轮询、卸载即停：settings.section 的组件只在设置面板开到本页时挂载（离开
  // 设置页宿主直接卸载本组件），轮询生命周期贴着挂载语义走就够，不需要再挂
  // visibilitychange——那是在「组件常驻、页面可能被盖住」的模型下才需要的补丁。
  //
  // effect 以 range 为键：切档 = 拆旧表（abort 在途 + 清 interval）→ 建新表（换
  // pollIntervalFor 的间隔）→ since 从 0 起步重拉 full。旧档数据在 full 到达前
  // 继续显示（清掉会闪一屏空白，一个 RTT 的旧曲线没有误导性——它标注的还是原档）。
  useEffect(() => {
    let cancelled = false;
    // 本 effect 生命周期专属的取消通道：对接 monitor 描述符声明的 cancellation，
    // 卸载/切档时掐断在途（24h/7d 窗口响应大，不取消白占连接）
    const controller = new AbortController();
    // 增量水位：是「下一轮请求的参数」不是「要渲染的东西」，闭包变量即可；首帧 0
    // = 全量语义，成功后取合并结果的最大 ts（nextSince），失败保持原值重试
    let since = 0;

    const load = async () => {
      try {
        const snapshot = await apiRef.current.monitor(range, since, controller.signal);
        if (cancelled) return;
        const merged = mergeSeries(seriesRef.current, snapshot.series, snapshot.mode);
        seriesRef.current = merged;
        setSeries(merged);
        since = nextSince(merged);
        setGpu(snapshot.gpu);
        setPanelError(snapshot.panelError);
        setLoadError(null);
        setReceivedOnce(true);
      } catch (error) {
        // 切档/卸载引发的 abort 是常规手势不是故障，看 signal 状态而不是错误类型
        // （abort 在传输层已折成普通错误，分不出「取消」和「真挂」）
        if (cancelled || controller.signal.aborted) return;
        // 失败不清旧数据：曲线是「历史读数」，上一轮的内容仍然是真的，只补横幅
        setLoadError(describeError(error));
      }
    };

    void load();
    const timer = setInterval(() => {
      void load();
    }, pollIntervalFor(range));
    return () => {
      cancelled = true;
      controller.abort();
      clearInterval(timer);
    };
  }, [range]);

  const noData = t("monitorNoData");

  return (
    <div className="llamapad-monitor">
      <div className="llamapad-monitor__header">
        <h2 className="llamapad-monitor__title">{t("monitorTitle")}</h2>
        <div className="llamapad-monitor__ranges" role="group" aria-label={t("monitorRangeLabel")}>
          {RANGES.map(({ id, labelKey }) => (
            // Pill 带 onClick 时渲染成按钮：四档即一个单选组，active 表当前档
            <Pill key={id} active={range === id} aria-pressed={range === id} onClick={() => setRange(id)}>
              {t(labelKey)}
            </Pill>
          ))}
        </div>
        <Button type="button" variant="ghost" size="sm" icon={<IconCloseOutline16 />} onClick={close}>
          {t("monitorClose")}
        </Button>
      </div>

      {panelError !== null ? (
        <div className="llamapad-monitor__banner" role="alert">
          <IconWarningOutline16 />
          <span>{panelError}</span>
        </div>
      ) : null}

      {loadError !== null ? (
        <div className="llamapad-monitor__banner" role="alert">
          <IconWarningOutline16 />
          <span>{t("monitorRefreshFailed")}</span>
        </div>
      ) : null}

      {!receivedOnce ? <p className="llamapad-monitor__hint">{t("monitorLoading")}</p> : null}

      <div className="llamapad-monitor__grid">
        {/* ① 推理：生成速度 + KV cache */}
        <div className="llamapad-monitor__card">
          <span className="llamapad-monitor__cardTitle">{t("monitorCardInfer")}</span>
          <MetricBlock
            label={t("monitorTokens")}
            valueText={metricText(series["infer.tokens_per_sec"], formatSpeed, noData)}
            points={series["infer.tokens_per_sec"]}
          />
          <MetricBlock
            label={t("monitorKvCache")}
            valueText={metricText(series["infer.kv_cache_tokens"], formatTokens, noData)}
            points={series["infer.kv_cache_tokens"]}
          />
        </div>

        {/* ② GPU：显存 + 利用率 + 分卡明细。
            gpu 为 null（面板拉取失败）或没有任何设备（unavailable/probing）时整卡
            降级为说明文案——半张卡的混合态（有曲线没明细）比整卡说明更让人误以为
            数据是全的；拉取失败的细节由顶部 panelError 横幅交代。 */}
        <div className="llamapad-monitor__card">
          <span className="llamapad-monitor__cardTitle">{t("monitorCardGpu")}</span>
          {gpu !== null && gpu.devices.length > 0 ? (
            <>
              <MetricBlock
                label={t("monitorGpuMem")}
                valueText={metricText(series["gpu.mem_used_mib"], formatMiB, noData)}
                points={series["gpu.mem_used_mib"]}
              />
              <MetricBlock
                label={t("monitorGpuUtil")}
                valueText={metricText(series["gpu.util_percent"], formatPercent, noData)}
                points={series["gpu.util_percent"]}
              />
              <div className="llamapad-monitor__gpuRows">
                {/* 合计行只在多卡时有信息量（单卡与它下面那行完全重复） */}
                {gpu.devices.length > 1 && gpu.totals !== null ? (
                  <span className="llamapad-monitor__gpuRow">
                    {t("monitorGpuTotals", {
                      value: formatMiBPair(gpu.totals.memUsedMib, gpu.totals.memTotalMib),
                    })}
                  </span>
                ) : null}
                {gpu.devices.map((device) => (
                  <span key={device.index} className="llamapad-monitor__gpuRow">
                    {formatGpuDeviceLine(device)}
                  </span>
                ))}
              </div>
            </>
          ) : (
            <p className="llamapad-monitor__hint">
              {/* 为假的分支既可能是 null（拉取失败）也可能是「有对象没设备」，再判
                  一次空取 status：只有面板明确 probing 才说探测中，其余落 unavailable */}
              {gpu !== null && gpu.status === "probing" ? t("monitorGpuProbing") : t("monitorGpuUnavailable")}
            </p>
          )}
        </div>

        {/* ③ 容器：CPU 与内存占用 */}
        <div className="llamapad-monitor__card">
          <span className="llamapad-monitor__cardTitle">{t("monitorCardContainer")}</span>
          <MetricBlock
            label={t("monitorCpu")}
            valueText={metricText(series["container.cpu_percent"], formatPercent, noData)}
            points={series["container.cpu_percent"]}
          />
          <MetricBlock
            label={t("monitorMem")}
            valueText={metricText(series["container.mem_percent"], formatPercent, noData)}
            points={series["container.mem_percent"]}
          />
        </div>
      </div>
    </div>
  );
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
