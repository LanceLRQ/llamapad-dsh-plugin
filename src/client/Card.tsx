// 设置卡片的 React 组件本身：只负责「照着 state.ts 折算出的 view 摆控件」与轮询/
// 点击这两件跟运行环境绑定、没法纯函数化的事，推导逻辑一律委托给 state.ts。
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  Button,
  IconCheckOutline16,
  IconChevronDownOutline14,
  IconLinkOutline16,
  IconPlayOutline16,
  IconStopFill16,
  IconWarningOutline16,
  Input,
  Pill,
  StateDot,
  Toast,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { CardEvent, CardSnapshot } from "../rpc-contract";
import type { PanelApi } from "./rpc";
import {
  buildCardView,
  connectionFormState,
  describeEventTone,
  describeLoadingElapsed,
  formatEventTime,
  inferringDotState,
  selectNotifiableEvents,
  type ConnectionDraft,
  type EventTone,
  type InferringBadge,
  type LoadingElapsed,
  type PendingAction,
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
      <IconChevronDownOutline14
        className={`llamapad-card__chevron${open ? " llamapad-card__chevronOpen" : ""}`}
      />
    </button>
  );
}

/** 内容区顶部的「用浏览器打开面板」——从标题行挪来的，理由见 CardHeader 注释。 */
function OpenPanelRow({ t, openUrl }: { t: Translate; openUrl: string }) {
  return (
    <div className="llamapad-card__openRow">
      <Button
        type="button"
        variant="outline"
        size="sm"
        icon={<IconLinkOutline16 />}
        disabled={openUrl.length === 0}
        onClick={() => window.open(openUrl, "_blank", "noopener,noreferrer")}
      >
        {t("openPanel")}
      </Button>
    </div>
  );
}

export function Card({ api, t }: CardProps) {
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
  // 轮询被自己不断打断。isStarting 只在真正跨越 starting 边界时才改变引用相等性。
  const isStarting = snapshot !== null && snapshot.phase === "starting";

  // 只在卡片挂载（可见）**且展开**期间轮询；effect 的清理函数负责在卸载/折叠时停表，
  // 不让它常驻在后台打面板。phase 跨过 starting 边界、或折叠态改变时才重建定时器——
  // 不能让这个 effect 因为快照内容变化而频繁重建。
  const apiRef = useRef(api);
  apiRef.current = api;
  // 在途动作的取消控制器：runAction 里创建、动作收尾时清空（见 runAction 注释）
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;            // 折起来就不打面板了
    let cancelled = false;
    const load = async () => {
      try {
        const next = await apiRef.current.snapshot();
        if (cancelled) return;
        applySnapshot(next);
      } catch (error) {
        if (!cancelled) setLoadError(describeError(error));
      }
    };
    void load();
    const timer = setInterval(() => {
      void load();
    }, isStarting ? POLL_INTERVAL_STARTING_MS : POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [isStarting, open]);

  // 秒表：只在 phase===starting 且展开期间走动，驱动「已加载 N 秒」的文案；一旦跨出
  // 这个阶段或被折叠就清掉 interval，不让它常驻在背景空转。
  useEffect(() => {
    if (!isStarting || !open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isStarting, open]);

  const runAction = (model: string, kind: "start" | "stop") => {
    // 每个动作配一个 AbortController 存 ref：在途行的按钮换成「取消等待」语义，
    // 点击只 abort、不重发动作。pending 与 abortRef 同生共死（finally 里一起清），
    // 其它行在有动作在途时本来就被禁用，所以任意时刻至多一个在途控制器。
    const controller = new AbortController();
    abortRef.current = controller;
    setPending({ model, kind });
    setActionError(null);
    const call = kind === "start"
      ? apiRef.current.start(model, controller.signal)
      : apiRef.current.stop(model, controller.signal);
    call
      .then((next) => {
        applySnapshot(next);
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
                <IconWarningOutline16 />
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

  return (
    <div className={`llamapad-card${open ? " llamapad-cardOpen" : ""}`}>
      <CardHeader t={t} open={open} onToggle={() => setOpen(!open)} />
      {open ? (
        <div className="llamapad-card__body">
          <OpenPanelRow t={t} openUrl={snapshot.openUrl} />
          {snapshot.panelError !== null ? (
            <div className="llamapad-card__banner" role="alert">
              <IconWarningOutline16 />
              <span>{snapshot.panelError}</span>
            </div>
          ) : null}

          {loadError !== null ? (
            <div className="llamapad-card__banner" role="alert">
              <IconWarningOutline16 />
              <span>{t("refreshFailed")}</span>
            </div>
          ) : null}

          <div className="llamapad-card__status">
            {view.phase === "idle" ? (
              <span>{t("noModelRunning")}</span>
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
            ) : (
              <>
                <StateDot state={view.inferring !== null ? inferringDotState(view.inferring) : "done"} />
                {/* 运行中的模型有可能已经不在列表里（配置删了但容器还在跑），
                    此时退回用面板给的 name，不能因为列表里找不到就说「没有模型在运行」。 */}
                <span>{t("runningModel", { name: view.runningModel?.displayName ?? snapshot.running })}</span>
                {view.inferring !== null ? (
                  <Pill active={view.inferring === "inferring"}>{t(inferringLabelKey(view.inferring))}</Pill>
                ) : null}
              </>
            )}
          </div>

          {/* 排空说明放在这里而不是按钮上：这句话足够长，塞进按钮会把整行撑到换行、
              把模型名挤成省略号，而它恰恰是「为什么停止要等这么久」的唯一解释。 */}
          {pending?.kind === "stop" ? (
            <p className="llamapad-card__hint">{t("stopPendingHint")}</p>
          ) : null}

          {actionError !== null ? (
            <p className="llamapad-card__actionError" role="alert">{actionError}</p>
          ) : null}

          <ul className="llamapad-card__list">
            {view.rows.map(({ model, action }) => (
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
                  icon={action.kind === "stop" ? <IconStopFill16 /> : <IconPlayOutline16 />}
                  disabled={action.disabled}
                  onClick={() =>
                    // 在途行的按钮承担「取消等待」：只 abort 在途请求，不重发动作
                    action.pending ? abortRef.current?.abort() : runAction(model.name, action.kind)
                  }
                >
                  {action.pending ? t("cancelAction") : t(action.kind === "stop" ? "stop" : "start")}
                </Button>
              </li>
            ))}
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
                  setSavingConn(true);
                  apiRef.current.saveConnection(draft.panelUrl, draft.token)
                    .then((next) => {
                      applySnapshot(next);
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
  if (tone === "error") return <IconWarningOutline16 />;
  if (tone === "success") return <IconCheckOutline16 />;
  return undefined;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
