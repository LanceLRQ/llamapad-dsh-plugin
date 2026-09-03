/**
 * llamapad 面板控制面 REST 客户端（列模型 / 启停 / 状态 / 生效配置 / 就绪探测 / 监控）。
 * 推理数据面不走这里（见 adapter.ts 的 proxy/direct 双模式）。
 * 失败一律抛 PanelError，code 为稳定机器码：
 * AUTH | MODEL_NOT_FOUND | MODEL_FILES_MISSING | START_REJECTED | RUNTIME_BUSY | PANEL_HTTP | PANEL_UNREACHABLE
 */

import { parseReasoningInfo, type PanelReasoningInfo } from "./reasoning";

export interface PanelClientOptions {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export class PanelError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number) {
    super(message);
    this.name = "PanelError";
  }
}

/** GET /api/v1/models 行（llamapad ModelView 的插件侧投影） */
export interface PanelModelView {
  name: string; displayName: string; namespace: string;
  quant: string | null; sizeBytes: number; hostPort: number; status: string;
  /** 运行中且启动后配置又被保存过——容器参数不热更新，需重启才生效。
   *  面板 modelsView.ts 一直在返回，老面板缺席时为 undefined（不可知，不等于 false） */
  configStale?: boolean;
  /** 配置了 mmproj（视觉投影器）时为其相对路径，否则 null——它是「这个模型能不能看图」
   *  的能力判据（见 adapter.inputModalitiesFor）。面板 ModelView 一直在返回；
   *  老面板缺席时为 undefined（不可知），与 configStale 的「缺席不可知」语义一致 */
  mmprojFile?: string | null;
}

export interface PanelModelDetail {
  name: string; displayName: string; namespace: string; overrides?: unknown;
  /** 同 PanelModelView.mmprojFile。来源不同：详情行是 repo StoredModel 的 mmproj_file
   *  （snake_case，映射见 getModel），且「没配」在该响应里就是字段缺席（repo 把 DB NULL
   *  归一成 undefined）——与「老面板不可知」在详情路径上无法区分，统一按 undefined 处理 */
  mmprojFile?: string | null;
}

/** GET /api/v1/models/:name/effective 的插件侧投影：只取合并后配置，
 *  其余字段（defaults/params/overriddenKeys）插件用不到不声明 */
export interface PanelEffectiveConfig {
  /** mergeConfig(defaults, overrides) 的结果，形状校验交给读取方 */
  merged?: unknown;
}

export interface PanelRuntimeStatus {
  running: {
    model: string;
    displayName?: string;
    /** 容器名 */
    container?: string;
    hostPort?: number | null;
    /** startedAt 是运行中容器的启动时刻（ISO 8601），面板一直有返回 */
    startedAt?: string | null;
    /**
     * llama-server 是否已开始监听。**容器在跑 ≠ 模型可用**：面板 readiness.ts 实测
     * 27B 冷启动有 35 秒「容器已起、端口未监听」的窗口。面板 12cfd84 起返回；
     * 老面板缺席时为 undefined，一律按「不可知」处理，绝不当作 false（见 routing.ts）
     */
    ready?: boolean;
    /** 启动后模型行又被保存过 */
    configStale?: boolean;
  } | null;
  /** 仅 runtimeStatus({ busy: true }) 时返回；null 代表"不可知"，不代表"不忙" */
  busy?: { inferring: boolean; slotsRunning: number } | null;
}

/** 面板 events 表行的插件侧投影：GET /api/v1/events 响应行与 SSE snapshot/event 帧
 *  同构（面板 eventsStream.ts 的 EventRow）。ts 为毫秒时间戳；查询与快照按 ts 倒序、
 *  增量帧按 id 升序——顺序语义由调用方消化，本层只透传 */
export interface PanelEvent {
  id: number;
  ts: number;
  kind: string;
  message: string;
}

/* ------------------------------------------------------------------ *
 * 监控端点（GET /api/v1/metrics/window 与 GET /api/v1/gpu/stats）。
 * 面板一共采集 16 个指标，监控页只消费其中 6 个——键集收敛在下面的
 * MonitorMetricId / MONITOR_METRIC_IDS，面板将来增删指标都不会波及插件
 * （缺席键容忍；多出来的键在投影时直接丢弃，不下发不报错）。
 * ------------------------------------------------------------------ */

/** metrics 窗口的时间档位（面板 RANGE_KEYS 的四值枚举，非法值面板回 400） */
export type MetricsRange = "30m" | "2h" | "24h" | "7d";

/** 时序点：面板 WindowPoint 的同形投影（ts 毫秒时间戳 + 采样值） */
export interface MetricPoint {
  ts: number;
  value: number;
}

/**
 * 监控页消费的六个时序指标键。面板侧的 metric id 是点分命名空间字符串
 * （METRIC_IDS），这里只挑图表真会画的六个；类型是插件侧投影的唯一出处，
 * rpc-contract.ts 的 MonitorSnapshot.series 复用它（type-only 引用，不会把
 * 本文件拖进浏览器产物）。
 */
export type MonitorMetricId =
  | "infer.tokens_per_sec"
  | "infer.kv_cache_tokens"
  | "gpu.mem_used_mib"
  | "gpu.util_percent"
  | "container.cpu_percent"
  | "container.mem_percent";

/** 上面六个键的运行时清单：getMetricsWindow 的 series 裁剪按它遍历 */
export const MONITOR_METRIC_IDS: readonly MonitorMetricId[] = [
  "infer.tokens_per_sec",
  "infer.kv_cache_tokens",
  "gpu.mem_used_mib",
  "gpu.util_percent",
  "container.cpu_percent",
  "container.mem_percent",
];

/**
 * GET /api/v1/metrics/window 的插件侧投影。
 *
 * series 刻意声明为 Partial：面板的响应恒含全部 16 个指标键（buildWindowPayload
 * 补空数组），投影只保留六个监控键，且**缺席容忍**——面板将来下线某个指标、或老
 * 面板还没实现它时，键就是不出现在结果里，调用方按「未采集」处理即可，绝不为
 * 「面板少给了一个键」抛错。但**在场就必须是好形状**：某个键的值不是数组、或
 * 数组里混进 ts/value 非数字的坏点，本层直接抛 PanelError——坏数据折进
 * panelError 通道让监控页画出「指标拉取失败」，比把坏点透传到浏览器侧 strict
 * codec 再炸成 RPC 错误壳，信息多得多。
 */
export interface PanelMetricsWindow {
  range: MetricsRange;
  /** 窗口起点（毫秒时间戳），= now - RANGE_DEFS[range] */
  from: number;
  /** 窗口分辨率标称值（面板按档位报：≤2h 是 5s 采样 ring，更长是 15min 聚合桶） */
  resolution: "5s" | "15m";
  series: Partial<Record<MonitorMetricId, MetricPoint[]>>;
  /** 增量协议判别字段：delta 只含 ts > since 的新点，full 是整窗替换 */
  mode: "full" | "delta";
}

/** 单卡当前快照（gpu/stats 的分卡明细；温度/功耗 nvidia-smi 解析不到时为 null） */
export interface PanelGpuDevice {
  index: number;
  memUsedMib: number;
  memTotalMib: number;
  utilPercent: number;
  tempC: number | null;
  powerW: number | null;
}

/**
 * GET /api/v1/gpu/stats 的插件侧投影：当前值快照 + 分卡明细，不进时序。
 * status 三态透传 nvidia-smi 探测结论：probing（面板刚重启尚无结论，前端保持
 * 中立）/ unavailable（纯 CPU 机器，探测确认不可用）/ available。面板响应里还有
 * 一个 samples（各指标最近一拍）字段，监控页用窗口时序 + devices 已经覆盖同样
 * 的信息，投影里不声明、不下发。
 */
export interface PanelGpuStats {
  available: boolean;
  status: "probing" | "unavailable" | "available";
  devices: PanelGpuDevice[];
  /** 显存合计；无卡（devices 为空，含非 available 态）时为 null，不是 0/0 */
  totals: { memUsedMib: number; memTotalMib: number } | null;
}

/** getMetricsWindow 的可选参数 */
export interface MetricsWindowOptions {
  /**
   * 增量水位（毫秒 ts）：带上后服务端**可能**回 mode:"delta" 只含新点（24h/7d
   * 档、水位滑出窗口等情况服务端会否决回 full）。缺省即首次全量拉取。
   */
  since?: number;
  /**
   * 调用方取消手势（浏览器侧切页/切档时取消在途请求——24h/7d 窗口大，不取消
   * 会白白占着连接）。与单请求超时合并后交给 fetch，不进 query。语义与
   * StartModelOptions.signal 一致。
   */
  signal?: AbortSignal;
}

/** getGpuStats 的可选参数（只有取消手势，没有增量水位——它本来就是即时快照） */
export interface GpuStatsOptions {
  signal?: AbortSignal;
}

/** 排空等待的默认上限（毫秒），与服务端 runtime.ts 的 DEFAULT_DRAIN_TIMEOUT_MS 对齐。
 *  放在本文件（最底层、无同级依赖）供 adapter 与 index 的 schema 默认值共用，
 *  不让同一个数字散落三处各写一遍。 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 60_000;

/** POST .../start 的可选排空参数（服务端支持时才真正生效） */
export interface StartModelOptions {
  drain?: boolean;
  drainTimeoutMs?: number;
  /**
   * 调用方取消手势（浏览器侧「取消等待」按钮一路传来）。与单请求超时合并后交给
   * fetch——排空等待最长 60s+，没有它用户只能干等。不进请求体，纯属客户端行为。
   */
  signal?: AbortSignal;
}

/** POST .../stop 的可选排空参数，形状与 StartModelOptions 一致（服务端契约同构） */
export interface StopModelOptions {
  drain?: boolean;
  drainTimeoutMs?: number;
  /** 语义同 StartModelOptions.signal：取消在途的排空等待，不进请求体 */
  signal?: AbortSignal;
}

export interface StopModelResult {
  ok: true;
  /** 仅传了 drain/drainTimeoutMs 时服务端才会返回 */
  drain?: { drained: boolean; reason: "idle" | "timeout" | "unavailable" | "skipped" };
}

/** streamEvents 的回调句柄。错误语义刻意收窄：onError 只在「建连失败/端点不可用/
 *  鉴权失败」时触发一次（供调用方降级），**已建立后的断流静默**——重连是调用方
 *  （status-watch）的职责，本层是尽力而为的长连接，不做退避重试。 */
export interface StreamEventsHandler {
  /**
   * 调用方取消手势（如组件卸载）：abort 即停流，语义等同调用返回的停止函数。
   * SSE 需 Authorization 头而浏览器 EventSource 不支持自定义头，所以这里走
   * fetch 流式解析而非 EventSource——signal 是这套自管解析的取消通道
   */
  signal?: AbortSignal;
  /** 每条事件回调一次：snapshot 帧的 events 逐条、event 帧单条 */
  onEvent: (event: PanelEvent) => void;
  /** 端点不可用通道：PanelError（AUTH | PANEL_HTTP | PANEL_UNREACHABLE）。停止后静默 */
  onError?: (error: PanelError) => void;
}

export interface PanelClient {
  readonly baseUrl: string;
  listModels(): Promise<PanelModelView[]>;
  getModel(name: string): Promise<PanelModelDetail | null>;
  getEffectiveConfig(name: string): Promise<PanelEffectiveConfig | null>;
  runtimeStatus(options?: { busy?: boolean }): Promise<PanelRuntimeStatus>;
  startModel(name: string, options?: StartModelOptions): Promise<void>;
  stopModel(name: string, options?: StopModelOptions): Promise<StopModelResult>;
  /** 读当前运行模型的思考强度声明；端点不可用 / 无模型在跑 / 老面板一律 null（不可知） */
  getReasoningInfo(): Promise<PanelReasoningInfo | null>;
  llamaHealth(): Promise<boolean>;
  /** 查询最近事件（ts 毫秒倒序）；limit/kind 缺省时不发参数，服务端默认 20 条 */
  getEvents(options?: { limit?: number; kind?: string }): Promise<PanelEvent[]>;
  /**
   * 监控时序窗口（GET /api/v1/metrics/window）：series 已裁剪到六个监控键，
   * 缺席键容忍、坏点抛 PanelError（形状语义见 PanelMetricsWindow 注释）。
   */
  getMetricsWindow(range: MetricsRange, options?: MetricsWindowOptions): Promise<PanelMetricsWindow>;
  /**
   * GPU 当前值快照（GET /api/v1/gpu/stats）。纯 CPU 机器不抛错——那是一个完全
   * 合法的响应（status:"unavailable"），抛错留给「面板连不上/鉴权失败」。
   */
  getGpuStats(options?: GpuStatsOptions): Promise<PanelGpuStats>;
  /**
   * 订阅面板事件 SSE 流（GET /api/v1/events/stream，连接即发 snapshot、此后增量
   * event 帧、15s 心跳注释行）。尽力而为的长连接：断流不抛错（重连由调用方负责），
   * 建连失败/鉴权失败走 handler.onError（供调用方降级）。返回幂等的停止函数。
   */
  streamEvents(handler: StreamEventsHandler): () => void;
}

/**
 * start/stop 共用的排空请求组装：请求体与超时覆盖的换算逻辑完全一致，只写一份。
 *
 * 排空最长可能要等 drainTimeoutMs（默认 60s）才返回，而单请求默认超时只有 30s
 * （requestTimeoutMs）——不覆盖的话客户端会在服务端排空完成前自己先 abort 掉这次
 * 调用。取 max(默认超时, drainTimeoutMs + 10s) 作为这次调用的超时：+10s 是留给
 * 网络往返与服务端收尾的缓冲，避免排空刚好卡线时客户端抢先掐断。只传 drain 不传
 * drainTimeoutMs 时服务端会用它自己的 60s 默认值，客户端必须按同一个数字放宽，
 * 否则照样在服务端排空完成前先 abort——所以这里对齐 DEFAULT_DRAIN_TIMEOUT_MS
 * 而不是留空。
 */
function buildDrainRequest(
  options: { drain?: boolean; drainTimeoutMs?: number } | undefined,
  defaultTimeoutMs: number,
): { body?: string; timeoutOverride?: number } {
  const hasDrainFields = options?.drain !== undefined || options?.drainTimeoutMs !== undefined;
  const body = hasDrainFields
    ? JSON.stringify({
        ...(options?.drain !== undefined ? { drain: options.drain } : {}),
        ...(options?.drainTimeoutMs !== undefined ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
      })
    : undefined;
  const effectiveDrainMs = options?.drainTimeoutMs
    ?? (options?.drain === true ? DEFAULT_DRAIN_TIMEOUT_MS : undefined);
  const timeoutOverride = effectiveDrainMs !== undefined
    ? Math.max(defaultTimeoutMs, effectiveDrainMs + 10_000)
    : undefined;
  return { body, timeoutOverride };
}

/**
 * SSE 帧解析器（纯函数工厂，导出供单测）：喂网络 chunk（字符串），内部攒缓冲，凑齐
 * 完整帧（空行分界）就把 data 载荷 JSON.parse 后交给 onData。把撕裂/粘连/心跳注释/
 * CRLF 这些边界全部收敛在这一个可单测的单元里消化，streamEvents 只剩连接管理。
 *
 * - 帧分隔：空行。CR/LF/CRLF 先统一归一成 \n 再找 \n\n 边界——面板侧 data 恒为单行
 *   JSON（sse.ts），载荷里不会出现裸 CR/LF，归一不会破坏内容；chunk 撕在 \r 与 \n
 *   之间也安全：归一后至多多出一行空行，而空行/空帧本来就被忽略
 * - 帧内规则：只收集 data: 行（多行以 \n 拼接，SSE 规范语义），`:` 开头的注释行
 *   （15s 心跳保活）与 id:/event:/retry: 行一概忽略——面板增量帧刻意不带 id: 行
 *   （无 Last-Event-ID 重放语义），即便带了也不影响解析
 * - 容错：JSON 解析失败的帧静默丢弃——尽力而为的流不该被一帧脏数据整条炸掉
 */
export function createSseFrameParser(onData: (json: unknown) => void): (chunk: string) => void {
  let buffer = "";
  return (chunk: string) => {
    buffer = (buffer + chunk).replace(/\r\n?/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue; // 心跳注释行，对客户端不可见
        if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, "")); // 冒号后至多一个空格
      }
      if (dataLines.length > 0) {
        try {
          onData(JSON.parse(dataLines.join("\n")));
        } catch {
          // 脏帧静默丢弃
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  };
}

/** SSE 载荷的最小结构校验：四个字段齐且类型对才算一条事件——坏帧丢弃不炸流 */
function isPanelEvent(v: unknown): v is PanelEvent {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Record<string, unknown>;
  return typeof e.id === "number" && typeof e.ts === "number"
    && typeof e.kind === "string" && typeof e.message === "string";
}

/**
 * metrics 窗口响应的投影与校验（纯函数，模块私有）：
 * 只挑六个监控键、逐点收窄形状。容忍与不容忍的边界见 PanelMetricsWindow 注释——
 * 缺席键直接跳过；在场但坏形状（不是数组/点缺字段/字段非数字）抛 PanelError，
 * 让失败在 gateway 折进 panelError，而不是把坏数据带去浏览器侧的 strict codec。
 */
function projectMetricsWindow(body: unknown): PanelMetricsWindow {
  const row = body as Record<string, unknown>;
  const series: Partial<Record<MonitorMetricId, MetricPoint[]>> = {};
  const rawSeries = row["series"];
  // series 键整体缺席也容忍（老面板没有 metrics 端点时调用方拿到的是 404 抛错，
  // 走不到这里；能走到这的都是 200，但形状仍可能是空壳——按「全部缺席」处理）
  if (rawSeries !== undefined && rawSeries !== null) {
    if (typeof rawSeries !== "object" || Array.isArray(rawSeries)) {
      throw new PanelError("面板返回的指标序列形状非法（series 不是对象）", "PANEL_HTTP");
    }
    const source = rawSeries as Record<string, unknown>;
    for (const id of MONITOR_METRIC_IDS) {
      const points = source[id];
      if (points === undefined) continue; // 缺席容忍：面板下线/尚未实现该指标
      if (!Array.isArray(points)) {
        throw new PanelError(`面板返回的指标序列 ${id} 形状非法（不是数组）`, "PANEL_HTTP");
      }
      series[id] = points.map((point, index) => {
        if (typeof point !== "object" || point === null
          || typeof (point as Record<string, unknown>)["ts"] !== "number"
          || typeof (point as Record<string, unknown>)["value"] !== "number") {
          throw new PanelError(`面板返回的指标序列 ${id}[${index}] 形状非法（ts/value 不是数字）`, "PANEL_HTTP");
        }
        const p = point as { ts: number; value: number };
        // 投影成新对象：点多余的字段（将来面板加点）不顺着泄漏进插件侧类型
        return { ts: p.ts, value: p.value };
      });
    }
  }
  const mode = row["mode"];
  if (mode !== "full" && mode !== "delta") {
    throw new PanelError(`面板返回的 metrics 窗口形状非法（mode: ${String(mode)}）`, "PANEL_HTTP");
  }
  // range/from/resolution 只透传不校验：它们不进 MonitorSnapshot 的 wire（浏览器
  // 知道自己要的档位），坏值最多是展示层的无关紧要小错，不值得为它炸掉整个窗口
  return {
    range: row["range"] as MetricsRange,
    from: typeof row["from"] === "number" ? row["from"] : 0,
    resolution: row["resolution"] === "15m" ? "15m" : "5s",
    series,
    mode,
  };
}

/**
 * gpu/stats 响应的投影与校验（纯函数，模块私有）。与 metrics 同一条边界纪律：
 * 字段在场就必须是好形状（抛 PanelError 折进 panelError），samples 键不声明、
 * 不下发（见 PanelGpuStats 注释）。
 */
function projectGpuStats(body: unknown): PanelGpuStats {
  const row = body as Record<string, unknown>;
  const status = row["status"];
  if (status !== "probing" && status !== "unavailable" && status !== "available") {
    throw new PanelError(`面板返回的 GPU 状态形状非法（status: ${String(status)}）`, "PANEL_HTTP");
  }
  const available = row["available"];
  if (typeof available !== "boolean") {
    throw new PanelError("面板返回的 GPU 状态形状非法（available 不是布尔）", "PANEL_HTTP");
  }
  const rawDevices = row["devices"];
  if (!Array.isArray(rawDevices)) {
    throw new PanelError("面板返回的 GPU 状态形状非法（devices 不是数组）", "PANEL_HTTP");
  }
  const devices = rawDevices.map((device, index) => {
    if (typeof device !== "object" || device === null) {
      throw new PanelError(`面板返回的 GPU 分卡明细形状非法（devices[${index}]）`, "PANEL_HTTP");
    }
    const d = device as Record<string, unknown>;
    const num = (key: string): number => {
      const v = d[key];
      if (typeof v !== "number") {
        throw new PanelError(`面板返回的 GPU 分卡明细形状非法（devices[${index}].${key} 不是数字）`, "PANEL_HTTP");
      }
      return v;
    };
    const nullableNum = (key: string): number | null =>
      d[key] === null || d[key] === undefined ? null : num(key);
    return {
      index: num("index"),
      memUsedMib: num("memUsedMib"),
      memTotalMib: num("memTotalMib"),
      utilPercent: num("utilPercent"),
      tempC: nullableNum("tempC"),
      powerW: nullableNum("powerW"),
    };
  });
  const rawTotals = row["totals"];
  let totals: PanelGpuStats["totals"] = null;
  if (rawTotals !== null && rawTotals !== undefined) {
    if (typeof rawTotals !== "object") {
      throw new PanelError("面板返回的 GPU 状态形状非法（totals 不是对象）", "PANEL_HTTP");
    }
    const t = rawTotals as Record<string, unknown>;
    if (typeof t["memUsedMib"] !== "number" || typeof t["memTotalMib"] !== "number") {
      throw new PanelError("面板返回的 GPU 状态形状非法（totals.memUsedMib/memTotalMib 不是数字）", "PANEL_HTTP");
    }
    totals = { memUsedMib: t["memUsedMib"], memTotalMib: t["memTotalMib"] };
  }
  return { available, status, devices, totals };
}

export function createPanelClient(options: PanelClientOptions): PanelClient {
  const doFetch = options.fetch ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, "");
  const timeoutMs = options.requestTimeoutMs ?? 30_000;

  /**
   * 统一的单请求入口：超时（必有一层 AbortSignal.timeout）与外部取消 signal
   * （可选）在这里合并成一个 fetch signal。
   *
   * 合并策略：有外部 signal 且运行时支持 AbortSignal.any 时，用 any([timeout,
   * external]) 合成——任一触发即取消，超时兜底语义不被外部 signal 顶掉（反之亦然）；
   * AbortSignal.any 缺席（老 Node/老浏览器）时降级为只用超时 signal——取消手势丢失
   * 但行为不炸，比「为保取消而丢掉超时」安全：超时是防挂死的底线，取消只是体验增强。
   */
  async function request(
    path: string,
    init: RequestInit = {},
    timeoutOverrideMs?: number,
    externalSignal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeoutOverrideMs ?? timeoutMs);
    const signal = externalSignal !== undefined && typeof AbortSignal.any === "function"
      ? AbortSignal.any([timeoutSignal, externalSignal])
      : timeoutSignal;
    try {
      return await doFetch(`${base}${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${options.token}`,
          ...(init.body !== undefined ? { "content-type": "application/json" } : {}),
          ...(init.headers as Record<string, string> | undefined),
        },
        signal,
      });
    } catch {
      throw new PanelError(`llamapad 面板不可达: ${base}`, "PANEL_UNREACHABLE");
    }
  }

  async function readError(res: Response): Promise<string> {
    try {
      const body = (await res.json()) as { error?: string };
      return body.error ?? res.statusText;
    } catch {
      return res.statusText;
    }
  }

  function codeFor(res: Response): string {
    return res.status === 401 ? "AUTH" : "PANEL_HTTP";
  }

  /**
   * start / stop 共用的失败映射。两条路径的状态码语义完全同构（面板 start/stop 两个
   * route 是逐行同款处理），只有 500 兜底的动词不同，故传 action 拼文案。
   *
   * 422 有两种成因（面板 api.md:60）：模型文件缺失、思考强度取值不被该模型 chat
   * template 接受。按 message 前缀区分——这与面板 start route 自己的判定同源口径
   * （它也是 message.includes("模型文件缺失")），不猜第二种的具体文案，只认第一种的
   * 既有契约，其余一律 START_REJECTED 并原文透传面板 message（面板的错误 message 是
   * 中文且自解释，比插件另造一句更有用）。
   */
  async function startStopError(res: Response, name: string, action: "启动" | "停止"): Promise<PanelError> {
    const message = await readError(res);
    if (res.status === 404) return new PanelError(`模型不存在: ${name}`, "MODEL_NOT_FOUND", 404);
    if (res.status === 409) return new PanelError(message, "RUNTIME_BUSY", 409);
    if (res.status === 422) {
      return message.includes("模型文件缺失")
        ? new PanelError(message, "MODEL_FILES_MISSING", 422)
        : new PanelError(message, "START_REJECTED", 422);
    }
    if (res.status === 401) return new PanelError("llamapad token 无效或未授权", "AUTH", 401);
    return new PanelError(`${action}失败: ${message}`, "PANEL_HTTP", res.status);
  }

  return {
    baseUrl: base,
    async listModels() {
      const res = await request("/api/v1/models");
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      // 列表行就是 ModelView（驼峰，含 mmprojFile: string | null），与插件侧投影同名
      // 同形，直接解包透传即可——缺席（老面板）自然保持 undefined，无需映射
      const body = (await res.json()) as { models: PanelModelView[] };
      return body.models;
    },
    async getModel(name) {
      const res = await request(`/api/v1/models/${encodeURIComponent(name)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      // 详情响应是 repo StoredModel 原样序列化（snake_case：display_name / mmproj_file
      // 等），插件侧投影统一驼峰。display_name 双读：真机契约是 snake_case（历史版本
      // 只读驼峰，真机上展示名恒回落到模型 id——假面板/单测喂的是驼峰，两条路都得活）。
      // mmproj_file 在「没配」时本就是字段缺席（repo 把 DB NULL 归一成 undefined，
      // JSON 序列化丢键），保持缺席透出——归一成 null 会把「老面板不可知」塌缩成
      // 「明确文本模型」，inputModalitiesFor 的三态就只剩两态了
      const row = (await res.json()) as {
        name: string; display_name?: string; displayName?: string; namespace: string;
        overrides?: unknown; mmproj_file?: string | null;
      };
      return {
        name: row.name,
        displayName: row.display_name ?? row.displayName ?? row.name,
        namespace: row.namespace,
        ...(row.overrides !== undefined ? { overrides: row.overrides } : {}),
        ...(row.mmproj_file !== undefined ? { mmprojFile: row.mmproj_file } : {}),
      };
    },
    async getEffectiveConfig(name) {
      const res = await request(`/api/v1/models/${encodeURIComponent(name)}/effective`);
      if (res.status === 404) return null;
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return (await res.json()) as PanelEffectiveConfig;
    },
    async runtimeStatus(options) {
      const res = await request(`/api/v1/runtime/status${options?.busy ? "?busy=1" : ""}`);
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return (await res.json()) as PanelRuntimeStatus;
    },
    async startModel(name, startOptions) {
      const { body, timeoutOverride } = buildDrainRequest(startOptions, timeoutMs);
      const res = await request(
        `/api/v1/models/${encodeURIComponent(name)}/start`,
        { method: "POST", ...(body !== undefined ? { body } : {}) },
        timeoutOverride,
        startOptions?.signal,
      );
      if (res.ok) return;
      throw await startStopError(res, name, "启动");
    },
    async stopModel(name, stopOptions) {
      const { body, timeoutOverride } = buildDrainRequest(stopOptions, timeoutMs);
      const res = await request(
        `/api/v1/models/${encodeURIComponent(name)}/stop`,
        { method: "POST", ...(body !== undefined ? { body } : {}) },
        timeoutOverride,
        stopOptions?.signal,
      );
      if (res.ok) return (await res.json()) as StopModelResult;
      throw await startStopError(res, name, "停止");
    },
    async getReasoningInfo() {
      // 走中转层：面板在这条路径上给 /v1/models 的响应注入了 x_llamapad 声明。
      // 无模型在跑时面板回 503、老面板没有注入逻辑——两种情况都归 null（不可知），
      // 不抛错：这是一次锦上添花的能力探测，失败不该让 resolveModel 整个失败。
      let res: Response;
      try {
        res = await doFetch(`${base}/api/v1/proxy/llama/v1/models`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        return null;
      }
      if (!res.ok) return null;
      return parseReasoningInfo(await res.json().catch(() => null));
    },
    async llamaHealth() {
      try {
        const res = await doFetch(`${base}/api/v1/proxy/llama/health`, {
          headers: { authorization: `Bearer ${options.token}` },
          signal: AbortSignal.timeout(timeoutMs),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async getEvents(eventsOptions) {
      // limit/kind 缺省不发参数：让服务端用它自己的默认值（20 条/不过滤）。
      // 显式发 limit=20 会把「默认」焊死在两端，将来服务端调整默认就失配了
      const params = new URLSearchParams();
      if (eventsOptions?.limit !== undefined) params.set("limit", String(eventsOptions.limit));
      if (eventsOptions?.kind !== undefined) params.set("kind", eventsOptions.kind);
      const qs = params.toString();
      const res = await request(`/api/v1/events${qs ? `?${qs}` : ""}`);
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      const body = (await res.json()) as { events: PanelEvent[] };
      return body.events;
    },
    async getMetricsWindow(range, metricsOptions) {
      // since 缺省不发参数（同 getEvents 的理由：让服务端自己定「无水位=全量」，
      // 不在客户端焊死）。range 必发——缺省它服务端只会回 400
      const params = new URLSearchParams({ range });
      if (metricsOptions?.since !== undefined) params.set("since", String(metricsOptions.since));
      const res = await request(`/api/v1/metrics/window?${params.toString()}`, {}, undefined, metricsOptions?.signal);
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return projectMetricsWindow(await res.json());
    },
    async getGpuStats(gpuOptions) {
      const res = await request("/api/v1/gpu/stats", {}, undefined, gpuOptions?.signal);
      if (!res.ok) throw new PanelError(await readError(res), codeFor(res), res.status);
      return projectGpuStats(await res.json());
    },
    streamEvents(handler) {
      // 停止语义三件套：stopped 标志（一切回调静默的判据）+ 内部 AbortController
      // （掐断 fetch）+ reader.cancel()（掐断读循环——手动/代理包装的流未必把 fetch
      // signal 的 abort 传导到 body，cancel 是兜底）。幂等：多次调用只生效一次
      const internal = new AbortController();
      let stopped = false;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

      const stop = (): void => {
        if (stopped) return;
        stopped = true;
        internal.abort();
        reader?.cancel().catch(() => {}); // 已关/已取消的流再 cancel 会拒，吞掉
      };

      if (handler.signal?.aborted) {
        // 信号早已 abort：abort 事件已经错过（addEventListener 不会再触发），补检
        // 短路——连都不建。组件卸载先于异步建连完成的场景（StrictMode 双执行）靠它
        stopped = true;
      } else {
        // 外部取消走 stop()（而不只靠 fetch 的 signal abort）：保证 stopped 置位、
        // 回调立即静默，与主动调停止函数的语义完全一致
        handler.signal?.addEventListener("abort", stop, { once: true });
      }

      // 与 request() 同款合并降级策略：AbortSignal.any 可用则内外合并，缺席时降级
      // 只用内部 signal——停止是底线语义必须保住，外部取消是增强丢了不炸。
      // 关键差异：这里**故意没有超时层**——request() 的 AbortSignal.timeout 是单请求
      // 超时语义，会把它不该管的常驻 SSE 连接在 30s 处掐死
      const signal = handler.signal !== undefined && typeof AbortSignal.any === "function"
        ? AbortSignal.any([internal.signal, handler.signal])
        : internal.signal;

      void (async () => {
        if (stopped) return;
        let connected = false; // 区分「建连失败」（走 onError 供降级）与「中途断流」（静默）
        try {
          const res = await doFetch(`${base}/api/v1/events/stream`, {
            headers: { authorization: `Bearer ${options.token}` },
            signal,
          });
          if (stopped) return;
          if (!res.ok) {
            // 401（token 失效）/404（老面板没有事件端点）等：不抛——streamEvents 是
            // 尽力而为的订阅，把「端点不可用」经 onError 递给调用方做降级
            handler.onError?.(new PanelError(await readError(res), codeFor(res), res.status));
            return;
          }
          if (!res.body) return; // ok 却没有流体：怪异但不值得报错的边角，静默
          connected = true;
          reader = res.body.getReader();
          const decoder = new TextDecoder();
          const feed = createSseFrameParser((payload) => {
            if (stopped) return; // 停止函数被调后一切回调静默
            const frame = payload as { type?: unknown; events?: unknown };
            if (frame?.type === "snapshot" && Array.isArray(frame.events)) {
              // 连接建立即发的快照：逐条回调。面板不支持 Last-Event-ID 重放，断线
              // 重连靠新 snapshot 对齐（幂等替换整表），那是调用方的职责——本层只透传
              for (const e of frame.events) if (isPanelEvent(e)) handler.onEvent(e);
            } else if (frame?.type === "event" && isPanelEvent(frame)) {
              handler.onEvent(frame);
            }
          });
          // { stream: true }：多字节 UTF-8 字符撕在 chunk 边界也不烂（事件 message 含中文）
          for (;;) {
            const { done, value } = await reader.read();
            if (stopped || done) break;
            feed(decoder.decode(value, { stream: true }));
          }
        } catch {
          // 不抛给调用方：网络错误/流断开一律吞掉。仅建连阶段的失败走 onError
          // （PANEL_UNREACHABLE，调用方可据此降级或稍后自行重连）；已建立后的断流
          // 静默——退避/周期重试策略属于调用方（status-watch），本层不做
          if (!stopped && !connected) {
            handler.onError?.(new PanelError(`llamapad 面板不可达: ${base}`, "PANEL_UNREACHABLE"));
          }
        }
      })();

      return stop;
    },
  };
}

export type { PanelReasoningInfo } from "./reasoning";
