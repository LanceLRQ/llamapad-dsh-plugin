/**
 * SSE 驱动的运行状态刷新器（吸收并替代 directory-refresh.ts，轮询保留为降级兜底）。
 *
 * 浏览器侧模型目录只在宿主 emit `llm/adapters-updated` 时重拉，而模型启停发生在面板
 * 一侧，dsh 感知不到——本模块负责补上这一环。与旧轮询版的差别：
 *
 * - 首选 SSE（`/api/v1/events/stream`）：model.* 事件到达即探测 runtime/status，模型
 *   变化才 emit，刷新延迟从「一个轮询间隔」降到「一次推送 + 一次探测」；
 * - 定时轮询只作降级兜底：SSE 建连连续失败 3 次（且期间没有任何成功事件）才启用，
 *   节拍仍是 statusRefreshMs（旧 directory-refresh 的逻辑原样搬进来）；
 * - 两个副产物：事件内存环（gateway 卡片事件流的数据源）与 fleetCache（M5 提示词
 *   快照的数据源，本任务先养数据）。
 *
 * ## 断流检测：为什么需要看门狗
 *
 * streamEvents 的契约是「已建立后的断流静默」——连接建立后死亡不触发任何回调（见
 * panel-client.ts 的 StreamEventsHandler 注释），而面板心跳是 SSE 注释行，被解析器
 * 过滤后对调用方不可见。也就是说死流无法被直接观察，只能间接探：SSE 模式下按
 * intervalMs 节拍用 `getEvents({limit:1})` 读一眼最新事件 id——
 * - 探针失败 → 面板不可达，常驻流必死 → 记一次流失败；
 * - 最新 id 超过水位线 → 有事件发生了而 SSE 没送到 → 流已落后/死亡，回收重连
 *   （重连的 snapshot 会把漏掉的事件按「新事件」补进环）；
 * - 其余 → 面板活着且没漏事件，流视为健康。
 * 这不是轮询还魂：runtime/status + models 的探测仍只由 model.* 事件触发，看门狗只
 * 读事件表一行，是「断流可检测」能落地的前提代价，且 intervalMs=0 时它同样不启动
 * （0 的语义是「不打扰面板」，常驻 SSE 连接违背它，整个 watcher 都不启动）。
 */
import type { Context } from "@deepseek-ai/cordis";
import type { PanelClient, PanelEvent } from "./panel-client";

/**
 * 面板舰队状态的同步可读缓存（M5「提示词快照」的数据源，本任务暂无消费者）。
 * 每次状态探测（SSE 事件触发或降级轮询）后写入，两模式语义完全一致。
 */
export interface FleetCache {
  running: string | null;
  models: { name: string; displayName: string; quant: string | null }[];
  /** 写入时刻（毫秒时间戳），消费者用它判断缓存新鲜度 */
  fetchedAt: number;
}

/** createFleetCache 的返回形状：get 同步读、update 整体替换。 */
export interface FleetCacheHandle {
  get(): FleetCache | null;
  update(patch: FleetCache): void;
}

export function createFleetCache(): FleetCacheHandle {
  let cache: FleetCache | null = null;
  return {
    get: () => cache,
    update: (patch) => {
      cache = patch;
    },
  };
}

/**
 * 事件内存环：保留最近 N 条面板事件（新事件进尾、超出裁头），供 gateway 组进卡片
 * 快照下发。snapshot() 返回副本——gateway 拿到的数组怎么改都不回写内部状态。
 */
export interface EventRing {
  push(event: PanelEvent): void;
  snapshot(): PanelEvent[];
}

export function createEventRing(capacity = 8): EventRing {
  const events: PanelEvent[] = [];
  return {
    push: (event) => {
      events.push(event);
      // 裁头而不是 unshift 进队首：push/shift 组合在高频写入下是 O(n) 搬移，
      // 追加 + 一次性裁剪让环始终保持「时间升序、最多 capacity 条」
      if (events.length > capacity) events.splice(0, events.length - capacity);
    },
    snapshot: () => [...events],
  };
}

/** SSE 建连失败连续到这个数（且期间没有任何成功事件）就降级到定时轮询。 */
const SSE_FALLBACK_THRESHOLD = 3;

/**
 * SSE 重连退避表：2s → 5s → 15s 封顶。3 次封顶降级意味着 15s 这一档在纯建连失败
 * 路径上通常轮不到（第 3 次失败先进轮询），它服务的是混合路径：失败一两次后成功
 * 事件会清零档位，但如果看门狗探针失败与建连失败交错，档位可能走到 15s——封顶
 * 保证最坏情况下重连间隔有界。
 */
const RECONNECT_BACKOFF_MS: readonly number[] = [2_000, 5_000, 15_000];

/**
 * 轮询模式里 SSE 恢复的宽限期：试探重连后这段时间内没有 onError 才切回 SSE。
 * 防抖动用——刚连上就死、连上就死的颤振连接会让两模式来回翻；期间收到任何事件
 * 则立即切回（事件到达是通路恢复最硬的证据，不必干等满 30s）。
 */
const RECOVERY_GRACE_MS = 30_000;

export interface StatusWatchOptions {
  ctx: Context;
  /**
   * 惰性取当前 client，而非持有一份快照：index.ts 在配置变更时会原地改写
   * adapterOptions.client，这里抱着构造期引用不放的话，面板地址热更新后新连接
   * 仍会打向旧 client。
   */
  client: () => PanelClient;
  /**
   * 节拍（毫秒）：SSE 模式下是看门狗探针间隔，降级后是轮询间隔。
   * <=0 完全不启动——SSE 也不连（0 的语义是「不打扰面板」，常驻连接违背它）。
   */
  intervalMs: number;
  /** 事件环（gateway 卡片事件流数据源）；缺省时事件照常触发探测，只是不入环 */
  eventRing?: EventRing;
  /** fleet 缓存（M5 数据源）；缺省时探测照常，只是不落缓存 */
  fleetCache?: FleetCacheHandle;
  /** 可注入定时器与时钟实现，测试用假实现避免真的等待；默认全局实现 */
  setTimeoutImpl?: (callback: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
  nowImpl?: () => number;
}

export function startStatusWatch(options: StatusWatchOptions): void {
  const { ctx, client, intervalMs } = options;
  // 用正向判定而不是 `intervalMs <= 0`：绕过 schemastery 直接调 apply 的调用方
  // （测试、脚本）可能压根不带这个字段，`undefined <= 0` 为假会放行进去，随后
  // setTimeout(fn, undefined) 等价于 0 毫秒——变成死循环猛打面板。NaN 同理。
  if (!(intervalMs > 0)) return;
  const schedule = options.setTimeoutImpl ?? ((callback, ms) => setTimeout(callback, ms));
  const cancel = options.clearTimeoutImpl ?? ((handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]));
  const now = options.nowImpl ?? (() => Date.now());
  const fleetCache = options.fleetCache;
  const eventRing = options.eventRing;

  ctx.effect(() => {
    let stopped = false;
    // undefined = 尚未探测过；首轮只定基线不 emit——插件刚起目录本来就会加载一次，
    // 这里再 emit 纯属多余空转（沿用 directory-refresh 语义）。
    let baseline: string | null | undefined;
    // 探测序号：事件与轮询可能并发触发多次探测，旧结果落地时若已有新一轮在飞，
    // 直接丢弃——否则慢的旧结果会把新基线倒写回去
    let probeSeq = 0;

    // —— 模式与 SSE 侧簿记 ——
    let mode: "sse" | "polling" = "sse";
    // 模式世代：每次模式切换 +1。看门狗链的 finally 要靠它防 ABA——一条挂起中的
    // 看门狗 tick 在 await 期间可能经历 sse→polling→sse 的往返（降级后恢复试探立刻
    // 成功），只看当前 mode 会误判「自己仍是现役链」而复活，与切换时新起的链并存，
    // 变成永久双倍看门狗。捕获进入时的世代、落地时不一致就安静退场
    let epoch = 0;
    let stopStream: (() => void) | null = null;
    // 事件 id 水位线：面板 id 单调递增，严格大于它的才算「新事件」。-Infinity 表示
    // 还一无所见（连启动对表都没成功过）
    let maxSeenId = Number.NEGATIVE_INFINITY;
    // 是否成功对过一次表（getEvents 读到过最新 id，哪怕是空结果）
    let watermarkReady = false;
    // 连续失败计数：onError 与看门狗探针失败都算，任何成功事件清零
    let consecutiveErrors = 0;
    // 退避档位（成功事件清零）
    let reconnectAttempts = 0;
    let reconnectHandle: unknown;
    let watchdogHandle: unknown;
    let pollHandle: unknown;
    // —— 轮询模式里 SSE 恢复试探的簿记 ——
    // 宽限期内试探连接已失败（onError 触发过）→ 本轮不切回
    let recoveryFailed = false;
    // 试探连接建立时刻 + RECOVERY_GRACE_MS，过了它且没失败才切回
    let recoveryDeadline = 0;

    /**
     * 一次状态探测：runtimeStatus 与 listModels 并发，更新 fleetCache，运行中模型
     * 变化才 emit。SSE 事件触发与降级轮询共用这一份逻辑，两模式的 fleetCache 与
     * 「变化才 emit」语义因此完全一致。
     */
    async function probe(): Promise<void> {
      const seq = ++probeSeq;
      const [statusResult, modelsResult] = await Promise.allSettled([
        client().runtimeStatus(),
        client().listModels(),
      ]);
      // 落地即过期（新一轮探测已在飞）或插件已卸载：丢弃。stopped 同时挡掉
      // 「卸载与到期擦肩而过」的竞态——ctx 已释放，不该再往上面 emit
      if (stopped || seq !== probeSeq) return;
      if (statusResult.status === "fulfilled") {
        const current = statusResult.value.running?.model ?? null;
        if (baseline === undefined) {
          baseline = current;
        } else if (current !== baseline) {
          baseline = current;
          ctx.emit("llm/adapters-updated");
        }
      }
      // fleetCache 只在两半都成功时写入：models 失败时硬写会向消费者谎报「没有模型」，
      // 不如保持上一份完整快照（get 返回 null 的初始态由消费者按「不可知」处理）
      if (statusResult.status === "fulfilled" && modelsResult.status === "fulfilled") {
        fleetCache?.update({
          running: statusResult.value.running?.model ?? null,
          models: modelsResult.value.map((m) => ({
            name: m.name, displayName: m.displayName, quant: m.quant,
          })),
          fetchedAt: now(),
        });
      }
    }

    /** 尽力而为的事件水位线对表：成功一次即可，此后靠流内 id 与看门狗探针维持。 */
    async function bootstrapWatermark(): Promise<void> {
      try {
        const events = await client().getEvents({ limit: 1 });
        if (stopped) return;
        watermarkReady = true;
        const latestId = events[0]?.id; // ts 倒序，首行最新
        if (latestId !== undefined && latestId > maxSeenId) maxSeenId = latestId;
      } catch {
        // 对表失败不致命：此时面板多半连不上，SSE 建连同样会失败并走失败计数那条路
      }
    }

    function connectStream(): void {
      // 惰性取 client：配置热更换后，这次新连接自然打到新面板地址（旧连接由
      // killStream 或自身的静默死亡收尾）
      stopStream = client().streamEvents({ onEvent: handleEvent, onError: handleStreamError });
    }

    function killStream(): void {
      stopStream?.();
      stopStream = null;
    }

    function clearPendingReconnect(): void {
      if (reconnectHandle !== undefined) {
        cancel(reconnectHandle);
        reconnectHandle = undefined;
      }
    }

    function handleEvent(event: PanelEvent): void {
      if (stopped) return;
      // 任何帧到达（哪怕历史重放）都是 SSE 通路可用的铁证：失败计数与退避档位清零
      consecutiveErrors = 0;
      reconnectAttempts = 0;

      if (mode === "polling") {
        // 恢复试探的连接收到事件：SSE 已恢复，立即切回。宽限期是给「连上了但面板
        // 一直安静」的兜底，事件本身就是更硬的证据
        promoteToSse();
      }

      if (!watermarkReady && maxSeenId === Number.NEGATIVE_INFINITY) {
        // 启动对表失败且此前一无所见：这一条就是最新的历史事件（面板 snapshot 按
        // ts 倒序推，第一条即最大 id），只定水位线，不入环不触发——宁可漏过「无面板
        // 历史时的第一条真事件」，不能把整段历史当新闻灌进环
        maxSeenId = event.id;
        return;
      }
      if (event.id <= maxSeenId) return; // snapshot 历史重放：过滤掉
      maxSeenId = event.id;
      eventRing?.push(event);
      // 模型生命周期事件（model.start / model.stop / model.exit …）→ 立即探测运行
      // 状态；其余种类（download.* 等）只入环，不值得为它们打扰 runtime/status
      if (event.kind.startsWith("model.")) void probe();
    }

    function handleStreamError(): void {
      if (stopped) return;
      // onError 意味着这次尝试已终结（此后本层不会再有回调）。先把句柄防御性收掉
      // （幂等无害，还能兜住「报了错却没真断」的怪异实现），再走失败计数，
      // 顺序不能反——先置空会让后面的 killStream 拿不到句柄
      killStream();
      if (mode === "polling") {
        // 恢复试探失败：不切回，留在轮询等下一轮再试（宽限期条件被打破）
        recoveryFailed = true;
        return;
      }
      handleStreamFailure();
    }

    /** SSE 模式下的一次流失败：计数 → 够 3 次降级轮询，否则按退避表排重连。 */
    function handleStreamFailure(): void {
      killStream();
      clearPendingReconnect();
      consecutiveErrors += 1;
      if (consecutiveErrors >= SSE_FALLBACK_THRESHOLD) {
        enterPolling();
        return;
      }
      const delay = RECONNECT_BACKOFF_MS[Math.min(reconnectAttempts, RECONNECT_BACKOFF_MS.length - 1)]!;
      reconnectAttempts += 1;
      reconnectHandle = schedule(() => {
        reconnectHandle = undefined;
        if (!stopped && mode === "sse") connectStream();
      }, delay);
    }

    /**
     * SSE 模式的看门狗（节拍 = intervalMs），断流检测见模块头注释。finally 里再排
     * 下一轮而不是 setInterval：探针慢时不堆积并发；mode/stopped 双检挡掉「降级或
     * 卸载与到期擦肩而过」后再排表的竞态。
     */
    async function watchdogTick(): Promise<void> {
      const myEpoch = epoch; // 世代捕获，见 epoch 声明处的 ABA 说明
      try {
        const events = await client().getEvents({ limit: 1 });
        if (stopped || mode !== "sse") return;
        const latestId = events[0]?.id;
        if (!watermarkReady) {
          // 看门狗探针本身就是一次成功对表：先立水位线再做落后判定，否则首次探针
          // 会把「从未对过表」误判成「流落后了」触发无谓重连
          watermarkReady = true;
          if (latestId !== undefined && latestId > maxSeenId) maxSeenId = latestId;
        }
        if (latestId !== undefined && latestId > maxSeenId) {
          // 有事件发生了而 SSE 没送到：流已落后/死亡。回收重连（不走退避——这不是
          // 建连失败，是换一条活流），重连后的 snapshot 会把漏掉的事件补进环
          killStream();
          clearPendingReconnect();
          connectStream();
        }
        // 其余情况：面板活着且没漏事件，流视为健康，不动它
      } catch {
        if (stopped || mode !== "sse") return;
        handleStreamFailure();
      } finally {
        if (!stopped && mode === "sse" && epoch === myEpoch) {
          watchdogHandle = schedule(() => {
            void watchdogTick();
          }, intervalMs);
        }
      }
    }

    /** 降级到定时轮询：旧 directory-refresh 的节拍，外加每轮试探 SSE 恢复。 */
    function enterPolling(): void {
      if (mode === "polling") return;
      mode = "polling";
      epoch += 1;
      killStream();
      clearPendingReconnect();
      if (watchdogHandle !== undefined) {
        cancel(watchdogHandle);
        watchdogHandle = undefined;
      }
      // 计数职责移交：降级后切回与否由恢复试探的宽限期判定，不再用失败次数卡
      consecutiveErrors = 0;
      reconnectAttempts = 0;
      recoveryFailed = false;
      pollHandle = schedule(() => {
        void pollTick();
      }, intervalMs);
    }

    /** 切回 SSE：停轮询表、起看门狗；当前恢复试探连接直接留用为常驻流，不重连。 */
    function promoteToSse(): void {
      if (mode === "sse") return;
      mode = "sse";
      epoch += 1;
      if (pollHandle !== undefined) {
        cancel(pollHandle);
        pollHandle = undefined;
      }
      recoveryFailed = false;
      consecutiveErrors = 0;
      reconnectAttempts = 0;
      watchdogHandle = schedule(() => {
        void watchdogTick();
      }, intervalMs);
    }

    /** 轮询模式的一轮：宽限期检查 → SSE 恢复试探 → 状态探测（旧 tick 主体）。 */
    async function pollTick(): Promise<void> {
      const myEpoch = epoch; // 世代捕获：await 期间可能切回 SSE 又再次降级（ABA），见 epoch 声明
      try {
        if (stopStream !== null && !recoveryFailed && now() >= recoveryDeadline) {
          // 试探连接挂着、宽限期内没失败：SSE 已恢复，切回并停轮询表。本轮探测跳过
          // ——SSE 模式有事件驱动的探测，不缺这一轮
          promoteToSse();
          return;
        }
        if (!watermarkReady) void bootstrapWatermark();
        trySseRecovery();
        await probe();
      } finally {
        // 一轮结束再排下一轮：探测慢时不堆积；世代不一致说明本链已被切换取代，
        // 到此为止（新链由切换方负责排表）
        if (!stopped && mode === "polling" && epoch === myEpoch) {
          pollHandle = schedule(() => {
            void pollTick();
          }, intervalMs);
        }
      }
    }

    /** 轮询模式每轮的 SSE 恢复试探：直接重连一次 streamEvents，成败由回调异步告知。 */
    function trySseRecovery(): void {
      if (stopStream !== null) return; // 已有试探连接在飞（或挂着），不叠加
      recoveryFailed = false;
      recoveryDeadline = now() + RECOVERY_GRACE_MS;
      connectStream();
    }

    // 启动顺序：先对水位线（尽力而为）再连流——snapshot 帧会一次重放最近 20 条
    // 历史事件，水位线先立起来它们才能被按「历史」过滤；对表失败也不挡连接
    // （handleEvent 对「一无所见」的首条事件有定水位线兜底）。
    void (async () => {
      await bootstrapWatermark();
      if (stopped) return;
      connectStream();
      watchdogHandle = schedule(() => {
        void watchdogTick();
      }, intervalMs);
    })();

    // 立即做一次状态探测定运行基线 + 填 fleetCache：SSE 模式只在 model.* 事件时
    // 探测，没有这次冷启动定基线，启动后的第一个 model.* 事件会撞上「无基线只定
    // 不 emit」而漏掉一次刷新（基线会直接定到变化后的值上）
    void probe();

    return () => {
      stopped = true;
      killStream();
      clearPendingReconnect();
      if (watchdogHandle !== undefined) cancel(watchdogHandle);
      if (pollHandle !== undefined) cancel(pollHandle);
    };
  }, "llamapad-status-watch");
}
