// 设置卡片的 React 组件本身：只负责「照着 state.ts 折算出的 view 摆控件」与轮询/
// 点击这两件跟运行环境绑定、没法纯函数化的事，推导逻辑一律委托给 state.ts。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  Input,
  Pill,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { IconCheck, IconChevronDown, IconLink, IconPlay, IconStop, IconWarning } from "./icons";
import type { CardEvent, CardSnapshot, CardStartingModel } from "../rpc-contract";
import type { PanelApi } from "./rpc";
import {
  buildCardView,
  connectionFormState,
  createSnapshotSequencer,
  describeEventTone,
  describeLoadingElapsed,
  describeStarting,
  formatEventTime,
  inferringDotState,
  isModelStarting,
  runningModelDisplayName,
  runningRowDotState,
  selectNotifiableEvents,
  shouldFastPoll,
  type ConnectionDraft,
  type EventTone,
  type InferringBadge,
  type LoadingElapsed,
  type PendingAction,
  type SnapshotSequencer,
  type TokenHint,
} from "./state";
import { injectCardStyles } from "./styles";
import type { LocaleKey } from "./locale";

/**
 * 轮询间隔：卡片挂载期间定时刷新；phase 为 starting 时提速到 2s——对齐 llamapad
 * 面板自身启动进度条的刷新口径，其它阶段回落到 5s。卸载时清掉，不常驻打面板。
 */
const POLL_INTERVAL_MS = 5000;
const POLL_INTERVAL_STARTING_MS = 2000;

// 模块加载时注入一次即可（injectCardStyles 内部按 tag id 判重），不必放进渲染函数
// 里每次渲染都查一遍 DOM——与官方 dsh-client-ui-settings-general 的 CSS 注入时机一致。
injectCardStyles();

export type Translate = (key: LocaleKey, params?: Record<string, unknown>) => string;

export interface CardProps {
  readonly api: PanelApi;
  readonly t: Translate;
  /**
   * `plugins.bundle.config`/`plugins.row.config`（0.1.7）的 owner props 之一：
   * `"summary"` 是列表/行页顶部的一句话简介，`"page"` 与未传（0.1.5 的
   * settings.plugin.item 不带这个 prop）都是现有的完整卡片。summary 态不启动
   * 轮询——它只在页面切换到详情前露出一瞬，没有必要打面板。
   */
  readonly view?: "summary" | "page";
}

/**
 * 标题行：整行是一个按钮，点哪都能折叠（对齐官方 PluginCard 的交互，照抄的是结构与
 * CSS，不 import 官方 PluginCard 本身——官方 bundle-purity gate 禁止第三方这么做）。
 * 「用浏览器打开面板」按钮**不能**留在这一行——它嵌在按钮里点了会连带折叠，
 * 已挪进内容区顶部（见 OpenPanelRow）。四种阶段（首次加载/硬失败/正常/局部刷新
 * 失败）都要露出同一个头，跟官方三张卡（终端/Agent 循环/网页搜索）在同一个
 * settings.plugin.item 列表里保持一致的外框，不能只有内容就位那一刻才有边框。
 */
function CardHeader({ t, open, onToggle }: { t: Translate; open: boolean; onToggle: () => void }) {
  const title = t("title");
  return (
    <button
      type="button"
      className="llamapad-card__header"
      aria-expanded={open}
      aria-label={`${t(open ? "collapse" : "expand")}: ${title}`}
      onClick={onToggle}
    >
      <span className="llamapad-card__headText">
        <span className="llamapad-card__title">{title}</span>
        <span className="llamapad-card__subtitle">{t("subtitle")}</span>
      </span>
      <IconChevronDown
        size={14}
        className={`llamapad-card__chevron${open ? " llamapad-card__chevronOpen" : ""}`}
      />
    </button>
  );
}

/**
 * 内容区顶部的一行操作按钮：「用浏览器打开面板」（从标题行挪来的，理由见 CardHeader
 * 注释）+ 可选的「手动刷新」。刷新按钮放这里而不是标题行——标题行整行已经是一个
 * `<button>`（点哪都能折叠），HTML 不允许按钮嵌按钮，且这里恰好是「状态区右上角」，
 * 语义上也贴（"立即刷新我下面看到的这些状态"）。
 *
 * refreshing/onRefresh 均为可选：早退分支（一次快照都没拿到过）复用本组件时不传，
 * 此时不渲染刷新按钮——那个阶段本就在（首次）加载中，多一个刷新按钮只是噪音。
 */
function OpenPanelRow({
  t,
  openUrl,
  refreshing,
  onRefresh,
}: {
  t: Translate;
  openUrl: string;
  refreshing?: boolean;
  onRefresh?: () => void;
}) {
  return (
    <div className="llamapad-card__openRow">
      {onRefresh !== undefined ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={refreshing === true}
          onClick={onRefresh}
        >
          {refreshing === true ? t("refreshing") : t("refresh")}
        </Button>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        icon={<IconLink size={16} />}
        disabled={openUrl.length === 0}
        onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")}
      >
        {t("openPanel")}
      </Button>
    </div>
  );
}

export function Card({ api, t, view: ownerView }: CardProps) {
  // 快照与「本轮刷新失败」分开存：一次轮询失败不该把上一次拿到的模型列表和
  // openUrl 一起抹掉——那样用户既看不到列表，连「用浏览器打开面板」这条退路
  // 也一并消失，恰好是最需要退路的时候。有旧快照就继续画，只在顶部补一条提示。
  const [snapshot, setSnapshot] = useState<CardSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());

  // ── 事件流：已见 id 去重 + Toast 队列 ──
  // 已见事件 id 集合，初始为空。注意初始为空意味着首轮快照经 selectNotifiableEvents
  // 会「全是新事件」，所以首轮必须静默吸收（不弹 Toast）：插件刚起时事件环里躺着的
  // 是更早发生的历史，不是新闻，重放一遍只会白白打断用户。是否首轮由下面的 ref
  // 标记，而不是拿集合是否为空判断——首轮快照恰好没事件时，之后到来的事件是真新闻，
  // 不该被「空集首轮」的假设吞掉。
  const seenEventIdsRef = useRef<Set<number>>(new Set());
  const absorbedFirstSnapshotRef = useRef(false);
  // Toast 队列：队首即当前正在展示的那条。Toast 是组件级原语——一次只能挂一个，
  // hold+fade 结束后回调 onDone 由 owner 卸载；同一轮快照到来多条新事件时，多出的
  // 在这里排队逐条消费。seq 是单调递增的「每次展示」序号：Toast 重显必须按 per-show
  // sequence 重新挂载（见 primitives 的 Toast.d.ts），React 靠 key 变化才会卸旧挂新、
  // 重启动画与它内部的 4s 计时器。
  const toastSeqRef = useRef(0);
  const [toastQueue, setToastQueue] = useState<readonly { seq: number; event: CardEvent }[]>([]);

  /**
   * 快照的唯一入口：轮询、start/stop 回传、saveConnection 回传三条到达路径都走这里，
   * 事件去重与 Toast 入队也只在这一处做——哪条路径绕开它，哪轮的 id 就进不了已见
   * 集合，下一轮会把旧事件当新闻重弹一遍。
   */
  const applySnapshot = (next: CardSnapshot) => {
    setSnapshot(next);
    setLoadError(null);
    const notifiable = absorbedFirstSnapshotRef.current
      ? selectNotifiableEvents(seenEventIdsRef.current, next)
      : []; // 首轮：只吸收不弹，理由见 seenEventIdsRef 的注释
    absorbedFirstSnapshotRef.current = true;
    for (const item of next.events) seenEventIdsRef.current.add(item.id);
    if (notifiable.length > 0) {
      const tagged = notifiable.map((item) => ({ seq: ++toastSeqRef.current, event: item }));
      setToastQueue((queue) => [...queue, ...tagged]);
    }
  };

  // Toast 消费完一条就弹出下一条（或清空）。onDone 必须是稳定引用：Toast 内部把它
  // 放进 useEffect 的依赖数组，若每次渲染都换新函数，2s 轮询带来的重渲染会不断
  // 重置它 hold 3s + fade 1s 的计时器，Toast 永远等不到 onDone。空依赖 + 函数式
  // setState 保证身份跨渲染不变。
  const dismissToast = useCallback(() => {
    setToastQueue((queue) => queue.slice(1));
  }, []);

  // 默认展开：这张卡是实时状态而非配置表单，进设置页第一眼就该看到「现在跑的是谁」。
  // 折叠态不持久化——官方 PluginCard 同样是每次挂载都从头开始，跨会话记住反而意外。
  const [open, setOpen] = useState(true);

  // 连接配置区草稿：token 从不预填（它根本不下发，见 CardConnection 注释），
  // panelUrl 由下面的 effect 在「用户还没动过输入框」时跟随快照预填。
  const [draft, setDraft] = useState<ConnectionDraft>({ panelUrl: "", token: "" });
  const [savingConn, setSavingConn] = useState(false);
  const [connSaved, setConnSaved] = useState(false);

  // 快照到达后用当前地址预填一次输入框。只在用户还没动过输入框时填，否则轮询
  // 到来会把正在输入的内容冲掉——touchedRef 一旦被点击/输入置真就再也不回退。
  const snapshotUrl = snapshot?.connection.panelUrl ?? "";
  const touchedRef = useRef(false);
  useEffect(() => {
    if (!touchedRef.current) setDraft((d) => ({ ...d, panelUrl: snapshotUrl }));
  }, [snapshotUrl]);

  // 只在这个布尔值上做文章，不直接用 snapshot：snapshot 每次轮询都会换一个新对象，
  // 若把它塞进下面两个 effect 的依赖数组，效果就是定时器永远「刚建好就被清理重建」，
  // 轮询被自己不断打断。fastPoll（state.ts 的 shouldFastPoll：phase===starting 或
  // 「还没出现在 runningModels 里」的 starting 非空）只在真正跨越边界时才改变引用
  // 相等性。单模型加载中的既有文案分支（下面 JSX 里的 loadingLabel 那支）仍直接判
  // `view.phase === "starting"`，不复用这个变量——那支判的是「要不要画哪种文案」，
  // 这里判的是「轮询/秒表要不要提速」，语义不同，没必要共用一个名字制造耦合假象。
  // 本卡片自己的启停请求在途（pending）也算：面板在收到 start 的同一刻就把模型列进
  // starting，但普通档轮询要几秒后才打下一枪，真机实测这几秒里卡片仍显示「当前没有
  // 模型在运行」。pending 一出现 fastPoll 就翻成 true，下面的 effect 随之重建并立即
  // 拉一次快照，之后按 2s 档跟进。
  const fastPoll = pending !== null || (snapshot !== null && shouldFastPoll(snapshot));

  // 只在卡片挂载（可见）**且展开**期间轮询；effect 的清理函数负责在卸载/折叠时停表，
  // 不让它常驻在后台打面板。phase 跨过 starting 边界、或折叠态改变时才重建定时器——
  // 不能让这个 effect 因为快照内容变化而频繁重建。
  const apiRef = useRef(api);
  apiRef.current = api;
  // 在途动作的取消控制器：runAction 里创建、动作收尾时清空（见 runAction 注释）
  const abortRef = useRef<AbortController | null>(null);

  // 过期快照守卫（state.ts 的 createSnapshotSequencer）：轮询、手动刷新、start/stop、
  // setDefaultModel、saveConnection 都可能同时在途，谁先回包不由谁先发起决定——
  // 尤其 start/stop 这类 60s+ 的长请求，发起得早却可能回来得晚。每个请求在**发起时**
  // 用 seqRef.next() 取号，回包时用 seqRef.accept(seq) 校验，只有不早于「已应用的
  // 最大序号」才放行 applySnapshot；用 `if (seqRef.current === null)` 而不是
  // `useRef(createSnapshotSequencer())` 惰性初始化，避免每次渲染都白白 new 一个
  // 序号器（只有第一次渲染真正用得上）。
  const seqRef = useRef<SnapshotSequencer | null>(null);
  if (seqRef.current === null) seqRef.current = createSnapshotSequencer();
  /** 序号校验通过才应用快照；校验不通过时静默丢弃（更旧的回包，已经被追平）。 */
  const applySnapshotIfCurrent = (seq: number, next: CardSnapshot) => {
    if (seqRef.current?.accept(seq) === true) applySnapshot(next);
  };

  useEffect(() => {
    if (!open || ownerView === "summary") return;   // 折起来、或只画一句话简介时都不打面板
    let cancelled = false;
    const load = async () => {
      const seq = seqRef.current?.next() ?? 0;
      try {
        const next = await apiRef.current.snapshot();
        if (cancelled) return;
        applySnapshotIfCurrent(seq, next);
      } catch (error) {
        if (!cancelled) setLoadError(describeError(error));
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, fastPoll ? POLL_INTERVAL_STARTING_MS : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fastPoll, open, ownerView]);

  // 秒表：phase===starting 或有模型仍在启动中（starting 非空）时走动，展开期间才走；
  // 一旦两个条件都不满足或被折叠就清掉 interval，不让它常驻在背景空转。fastPoll 与
  // 轮询提速用的是同一个判定（shouldFastPoll），理由一致：两者都是「有一个正在计时
  // 的等待动作」，共用一档节奏。
  useEffect(() => {
    if (!fastPoll || !open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [fastPoll, open]);

  // 手动刷新：立即打一次 snapshot 并按现有 loadError 展示逻辑处理失败，成功路径
  // 复用 applySnapshotIfCurrent（可能被更晚回来的轮询/动作请求追平而静默丢弃）。
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    const seq = seqRef.current?.next() ?? 0;
    setRefreshing(true);
    apiRef.current.snapshot()
      .then((next) => applySnapshotIfCurrent(seq, next))
      .catch((error: unknown) => setLoadError(describeError(error)))
      .finally(() => setRefreshing(false));
  };

  // 「设为默认」在途状态：只记模型名（不像 start/stop 那样区分动作种类，setDefaultModel
  // 只有一种动作），非 null 时多模型运行列表里的全部「设为默认」按钮统一禁用——避免
  // 同一面板收到互相插队的默认切换请求（对齐 start/stop 的既有节流思路）。没有取消
  // 语义（RPC 本身不声明 cancellation，见 rpc-contract.ts），失败与成功都走既有的
  // panelError/actionError 两个展示位，不新开 UI 区域。
  const [pendingDefaultModel, setPendingDefaultModel] = useState<string | null>(null);
  const setDefault = (model: string) => {
    const seq = seqRef.current?.next() ?? 0;
    setPendingDefaultModel(model);
    apiRef.current.setDefaultModel(model)
      .then((next) => applySnapshotIfCurrent(seq, next))
      .catch((error: unknown) => setActionError(describeError(error)))
      .finally(() => setPendingDefaultModel(null));
  };

  const runAction = (model: string, kind: "start" | "stop") => {
    // 每个动作配一个 AbortController 存 ref：在途行的按钮换成「取消等待」语义，
    // 点击只 abort、不重发动作。pending 与 abortRef 同生共死（finally 里一起清），
    // 其它行在有动作在途时本来就被禁用，所以任意时刻至多一个在途控制器。
    const controller = new AbortController();
    abortRef.current = controller;
    // 序号在发起时就取——start/stop 这类请求可能排空等到 60s+，期间轮询多半已经
    // 把更新的快照应用上了，回包到达时用 applySnapshotIfCurrent 校验，旧的就丢弃
    // 不覆盖（但下面的 pending 清理属于「这次动作收尾」的副作用，与快照是否被
    // 采用无关，必须照常执行，否则按钮会卡在「取消等待」出不来）。
    const seq = seqRef.current?.next() ?? 0;
    setPending({ model, kind });
    setActionError(null);
    const call = kind === "start"
      ? apiRef.current.start(model, controller.signal)
      : apiRef.current.stop(model, controller.signal);
    call
      .then((next) => {
        applySnapshotIfCurrent(seq, next);
      })
      .catch((error: unknown) => {
        // 用户主动取消不是故障：不画红色横幅。host 侧对取消会回一份不带
        // panelError 的快照，但传输层也可能先一步以错误收场——统一按 signal
        // 状态判定，快照交给既有轮询自然追平。
        if (controller.signal.aborted) return;
        setActionError(describeError(error));
      })
      .finally(() => {
        if (abortRef.current === controller) abortRef.current = null;
        setPending(null);
      });
  };

  // dsh 0.1.7 的插件管理页在某些位置只要一句话简介（view:'summary'，见
  // docs/research/2026-09-24-dsh-015-017-settings.md 第 4 节），不需要走下面的
  // 快照/轮询/操作逻辑。放在全部 hooks 之后提前返回，不破坏 hooks 调用顺序。
  if (ownerView === "summary") {
    return <span>{t("cardSummary")}</span>;
  }

  if (snapshot === null) {
    // 一次都没拿到过快照：连 openUrl 都不知道，画不出可用的「用浏览器打开」按钮
    // （OpenPanelRow 会因为 openUrl 是空串自动把它禁掉），但外框、标题行照样露出，
    // 不能让这一阶段的卡片看着跟旁边官方卡是两套东西。
    return (
      <div className={`llamapad-card${open ? " llamapad-cardOpen" : ""}`}>
        <CardHeader t={t} open={open} onToggle={() => setOpen(!open)} />
        {open ? (
          <div className="llamapad-card__body">
            <OpenPanelRow t={t} openUrl="" />
            {loadError === null ? (
              <p className="llamapad-card__hint">{t("loading")}</p>
            ) : (
              <div className="llamapad-card__banner" role="alert">
                <IconWarning size={16} />
                <span>{t("panelUnavailable")}</span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    );
  }

  const view = buildCardView(snapshot, pending);
  const connForm = connectionFormState(snapshot.connection, draft);
  // 队首即当前展示的 Toast；空队列 → null 卸载（早退分支不可能有 Toast：首轮
  // 快照被静默吸收，队列只会在第一次 applySnapshot 之后才可能非空）。
  const currentToast = toastQueue[0] ?? null;
  // 「仍在启动中」行：已过滤掉那些已经出现在 runningModels 里的模型（见
  // describeStarting 注释——面板 start 请求的 10s 存活检测还没返回，但该模型的
  // 加载进度已经能从 runningModels 观测到，不重复画）。这个列表长度同时也是
  // 下面 noModelRunning 判定要用到的依据：真正「什么都没有」才显示那句话。
  const startingRows = describeStarting(snapshot, now);

  return (
    <div className={`llamapad-card${open ? " llamapad-cardOpen" : ""}`}>
      <CardHeader t={t} open={open} onToggle={() => setOpen(!open)} />
      {open ? (
        <div className="llamapad-card__body">
          <OpenPanelRow t={t} openUrl={snapshot.openUrl} refreshing={refreshing} onRefresh={refresh} />
          {snapshot.panelError !== null ? (
            <div className="llamapad-card__banner" role="alert">
              <IconWarning size={16} />
              <span>{snapshot.panelError}</span>
            </div>
          ) : null}

          {loadError !== null ? (
            <div className="llamapad-card__banner" role="alert">
              <IconWarning size={16} />
              <span>{t("refreshFailed")}</span>
            </div>
          ) : null}

          <div className="llamapad-card__status">
            {view.phase === "idle" && startingRows.length === 0 ? (
              // starting 非空时不画这句话——「当前没有模型在运行」在这种时候是
              // 误导：面板正在处理一个 start/restart 请求，只是还没起来，不是
              // 「什么都没在发生」（见下方 __startingList 那块）。
              <span>{t("noModelRunning")}</span>
            ) : snapshot.runningModels.length > 1 ? (
              // 多模型：运行区从单行改为列表，每行「模型名 · 已加载 N 秒 · ready 点 ·
              // （默认标记/设为默认按钮）」。只有一个模型在跑时（长度 <=1）走下面
              // 未改动的单行分支，视觉与多模型改造前完全一致。
              <ul className="llamapad-card__runningList">
                {snapshot.runningModels.map((item) => {
                  const elapsed = describeLoadingElapsed(item.startedAt, now);
                  return (
                    <li key={item.name} className="llamapad-card__runningRow">
                      <StateDot state={runningRowDotState(item.ready)} />
                      <span className="llamapad-card__runningName">{runningModelDisplayName(item)}</span>
                      {elapsed !== null ? (
                        <span className="llamapad-card__runningMeta">
                          {elapsed.unit === "seconds"
                            ? t("runningElapsedSeconds", { sec: elapsed.seconds })
                            : t("runningElapsedMinutes", { min: elapsed.minutes, sec: elapsed.seconds })}
                        </span>
                      ) : null}
                      {item.isDefault ? (
                        <Pill active>{t("defaultBadge")}</Pill>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={pendingDefaultModel !== null}
                          onClick={() => setDefault(item.name)}
                        >
                          {pendingDefaultModel === item.name ? t("settingDefault") : t("setDefault")}
                        </Button>
                      )}
                    </li>
                  );
                })}
              </ul>
            ) : view.phase === "starting" ? (
              <>
                {/* ongoing 是 StateDot 四态里唯一带动效的一档（内置的像素追逐动画），
                    拿来当「正在加载」的视觉提示比 done/warning 更贴切，不需要我们
                    自己另写一份加载动画样式。 */}
                <StateDot state="ongoing" />
                <span>
                  {loadingLabel(
                    t,
                    view.runningModel?.displayName ?? snapshot.running,
                    describeLoadingElapsed(snapshot.startedAt, now),
                  )}
                </span>
              </>
            ) : view.phase === "ready" ? (
              <>
                <StateDot state={view.inferring !== null ? inferringDotState(view.inferring) : "done"} />
                {/* 运行中的模型有可能已经不在列表里（配置删了但容器还在跑），
                    此时退回用面板给的 name，不能因为列表里找不到就说「没有模型在运行」。 */}
                <span>{t("runningModel", { name: view.runningModel?.displayName ?? snapshot.running })}</span>
                {view.inferring !== null ? (
                  <Pill active={view.inferring === "inferring"}>{t(inferringLabelKey(view.inferring))}</Pill>
                ) : null}
              </>
            ) : null /* phase===idle 且 startingRows 非空：没有可画的运行/加载中内容，
                         交给下面的 __startingList 区块，这里留空不重复表达 */}
          </div>

          {/* 「仍在启动中」列表：只在 startingRows 非空时渲染（已过滤掉那些已经
              出现在 runningModels 里的模型，见 describeStarting 注释）。可以与
              上面的运行中/加载中内容并存——例如面板已有一个模型在跑，用户又点了
              启动另一个模型，这另一个模型尚未建好容器时就会单独出现在这里。 */}
          {startingRows.length > 0 ? (
            <ul className="llamapad-card__startingList">
              {startingRows.map((row) => (
                <li key={row.name} className="llamapad-card__startingRow">
                  <StateDot state="ongoing" />
                  <span>
                    {t(row.action === "restart" ? "restartingModel" : "startingModel", {
                      name: row.displayName,
                      stage: t(stageLabelKey(row.stage)),
                      sec: row.elapsedSec,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* 排空说明放在这里而不是按钮上：这句话足够长，塞进按钮会把整行撑到换行、
              把模型名挤成省略号，而它恰恰是「为什么停止要等这么久」的唯一解释。 */}
          {pending?.kind === "stop" ? (
            <p className="llamapad-card__hint">{t("stopPendingHint")}</p>
          ) : null}

          {actionError !== null ? (
            <p className="llamapad-card__actionError" role="alert">{actionError}</p>
          ) : null}

          <ul className="llamapad-card__list">
            {view.rows.map(({ model, action }) => {
              // 面板对同一模型的并发启停会回 409：这个模型的 start/restart 请求已经
              // 在面板那边处理中（不论是否已经在 runningModels 里能看见它），再点一次
              // 只会换来一个报错，禁用比让用户点了再等错误更友好（见 isModelStarting
              // 注释——这里刻意不用 describeStarting 过滤后的子集，理由同它）。
              const startingHere = isModelStarting(snapshot, model.name);
              return (
                <li key={model.name} className="llamapad-card__row" data-running={model.status === "running" ? "true" : undefined}>
                  <div className="llamapad-card__rowInfo">
                    <span className="llamapad-card__rowName">{model.displayName}</span>
                    <span className="llamapad-card__rowMeta">
                      {model.namespace}
                      {model.quant !== null ? ` · ${model.quant}` : ""}
                    </span>
                    {action.missingReason !== null ? (
                      <span className="llamapad-card__rowMissing">{t(missingReasonKey(action.missingReason))}</span>
                    ) : null}
                  </div>
                  <Button
                    type="button"
                    variant={action.kind === "stop" ? "outline" : "primary"}
                    size="sm"
                    icon={action.kind === "stop" ? <IconStop size={16} /> : <IconPlay size={16} />}
                    // 本卡片自己发起的在途请求（pending）不受 startingHere 影响：此时按钮是
                    // 「取消等待」，面板把它列进 starting 恰恰是用户最可能想取消的时候
                    disabled={action.disabled || (startingHere && !action.pending)}
                    onClick={() =>
                      // 在途行的按钮承担「取消等待」：只 abort 在途请求，不重发动作
                      action.pending ? abortRef.current?.abort() : runAction(model.name, action.kind)
                    }
                  >
                    {action.pending ? t("cancelAction") : t(action.kind === "stop" ? "stop" : "start")}
                  </Button>
                </li>
              );
            })}
          </ul>

          <div className="llamapad-card__conn">
            <span className="llamapad-card__title">{t("connTitle")}</span>
            <label className="llamapad-card__connField">
              <span className="llamapad-card__connLabel">{t("connUrlLabel")}</span>
              <Input
                value={draft.panelUrl}
                placeholder={t("connUrlPlaceholder")}
                disabled={savingConn}
                onChange={(e) => {
                  touchedRef.current = true;
                  setDraft({ ...draft, panelUrl: e.target.value });
                  setConnSaved(false);
                }}
              />
            </label>
            <label className="llamapad-card__connField">
              <span className="llamapad-card__connLabel">{t("connTokenLabel")}</span>
              <Input
                type="password"
                value={draft.token}
                disabled={savingConn}
                onChange={(e) => {
                  setDraft({ ...draft, token: e.target.value });
                  setConnSaved(false);
                }}
              />
              <span className="llamapad-card__rowMeta">{t(tokenHintKey(connForm.tokenHint))}</span>
            </label>
            <div className="llamapad-card__connActions">
              {connForm.blockedReason === "urlRequired" ? (
                <span className="llamapad-card__actionError">{t("connUrlRequired")}</span>
              ) : connSaved ? (
                <span className="llamapad-card__rowMeta">{t("connSaved")}</span>
              ) : null}
              <Button
                type="button"
                variant="primary"
                size="sm"
                disabled={!connForm.canSave || savingConn}
                onClick={() => {
                  const seq = seqRef.current?.next() ?? 0;
                  setSavingConn(true);
                  apiRef.current.saveConnection(draft.panelUrl, draft.token)
                    .then((next) => {
                      // 快照本身可能被过期守卫丢弃（更晚回来的旧回包），但「保存
                      // 成功、清掉密文草稿」这个副作用与快照是否被采用无关，必须
                      // 照常执行，理由同 runAction 里的 pending 清理。
                      applySnapshotIfCurrent(seq, next);
                      setDraft((d) => ({ ...d, token: "" }));   // 存完就把密文草稿清掉
                      setConnSaved(true);
                    })
                    .catch((error: unknown) => setActionError(describeError(error)))
                    .finally(() => setSavingConn(false));
                }}
              >
                {savingConn ? t("connSaving") : t("connSave")}
              </Button>
            </div>
          </div>

          {/* 最近事件：事件环还是空数组时整节不渲染——不为一块永远空着的区域
              留标题和分隔线。行按 tone 着色（describeEventTone），时间用方括号
              短格式，排序信快照的升序契约。 */}
          {snapshot.events.length > 0 ? (
            <div className="llamapad-card__events">
              <span className="llamapad-card__eventsTitle">{t("eventsTitle")}</span>
              <ul className="llamapad-card__eventsList">
                {snapshot.events.map((item) => (
                  <li
                    key={item.id}
                    className={`llamapad-card__event${eventToneModifier(describeEventTone(item.kind))}`}
                  >
                    <span className="llamapad-card__eventTime">[{formatEventTime(item.ts, now)}]</span>
                    <span className="llamapad-card__eventText">{item.message}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* Toast 挂在卡片根节点内：组件级原语由 owner 自己挂/卸（它渲染时走 body
          portal，视觉位置不受卡片折叠与层级影响）。文案直接用事件 message，
          不经词典翻译（理由见 locale.ts zh.eventsTitle 的注释）。 */}
      {currentToast !== null ? (
        <Toast
          key={currentToast.seq}
          text={currentToast.event.message}
          icon={toastIcon(currentToast.event.kind)}
          onDone={dismissToast}
        />
      ) : null}
    </div>
  );
}

/** 加载中状态行的文案：耗时算不出来（startedAt 缺失/解析失败）时退化成不带耗时的兜底句。 */
function loadingLabel(t: Translate, name: string | null, elapsed: LoadingElapsed | null): string {
  if (elapsed === null) return t("loadingModelPlain", { name });
  if (elapsed.unit === "seconds") return t("loadingModel", { name, sec: elapsed.seconds });
  return t("loadingModelLong", { name, min: elapsed.minutes, sec: elapsed.seconds });
}

function inferringLabelKey(badge: InferringBadge): LocaleKey {
  if (badge === "inferring") return "inferring";
  if (badge === "idle") return "idle";
  return "inferringUnknown";
}

function missingReasonKey(reason: "missing-file" | "missing-mmproj"): LocaleKey {
  return reason === "missing-file" ? "missingFile" : "missingMmproj";
}

/** 「仍在启动中」行的阶段文案 key：三态逐一映射，见 locale.ts 的 stagePreparing 等三条。 */
function stageLabelKey(stage: CardStartingModel["stage"]): LocaleKey {
  if (stage === "preparing") return "stagePreparing";
  if (stage === "pulling") return "stagePulling";
  return "stageCreating";
}

function tokenHintKey(hint: TokenHint): LocaleKey {
  return hint === "keep" ? "connTokenKeep" : hint === "replace" ? "connTokenReplace" : "connTokenUnset";
}

/** tone → 事件行的 BEM 修饰类；neutral 落基类的 rowMeta 灰，不加修饰。 */
function eventToneModifier(tone: EventTone): string {
  if (tone === "error") return " llamapad-card__event--error";
  if (tone === "success") return " llamapad-card__event--success";
  return "";
}

/**
 * Toast 的前缀图标：error 配警示三角、success 配对钩，neutral 不配——图标只在
 * 「值得多看一眼」的信号上才有信息量，中性事件（如 model.stop）配图标只是噪音。
 */
function toastIcon(kind: string): ReactNode {
  const tone = describeEventTone(kind);
  if (tone === "error") return <IconWarning size={16} />;
  if (tone === "success") return <IconCheck size={16} />;
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
