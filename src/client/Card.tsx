// 设置卡片的 React 组件本身：只负责「照着 state.ts 折算出的 view 摆控件」与轮询/
// 点击这两件跟运行环境绑定、没法纯函数化的事，推导逻辑一律委托给 state.ts。
import { useEffect, useRef, useState } from "react";
import {
  Button,
  IconLinkOutline16,
  IconPlayOutline16,
  IconStopFill16,
  IconWarningOutline16,
  Pill,
  StateDot,
} from "@deepseek-ai/dsh-client-ui-primitives";
import type { CardSnapshot } from "../rpc-contract";
import type { PanelApi } from "./rpc";
import {
  buildCardView,
  describeLoadingElapsed,
  inferringDotState,
  type InferringBadge,
  type LoadingElapsed,
  type PendingAction,
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
 * 标题行：卡片名 + 「用浏览器打开面板」按钮。四种阶段（首次加载/硬失败/正常/
 * 局部刷新失败）都要露出同一个头，跟官方三张卡（终端/Agent 循环/网页搜索）在
 * 同一个 settings.plugin.item 列表里保持一致的外框，不能只有内容就位那一刻才有边框。
 */
function CardHeader({ t, openUrl }: { t: Translate; openUrl: string }) {
  return (
    <div className="llamapad-card__header">
      <span className="llamapad-card__title">{t("title")}</span>
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

  // 只在这个布尔值上做文章，不直接用 snapshot：snapshot 每次轮询都会换一个新对象，
  // 若把它塞进下面两个 effect 的依赖数组，效果就是定时器永远「刚建好就被清理重建」，
  // 轮询被自己不断打断。isStarting 只在真正跨越 starting 边界时才改变引用相等性。
  const isStarting = snapshot !== null && snapshot.phase === "starting";

  // 只在卡片挂载（可见）期间轮询；effect 的清理函数负责在卸载时停表，
  // 不让它常驻在后台打面板。phase 跨过 starting 边界时才重建定时器，换挡到
  // 2s/5s 两档中的一档——不能让这个 effect 因为快照内容变化而频繁重建。
  const apiRef = useRef(api);
  apiRef.current = api;
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await apiRef.current.snapshot();
        if (cancelled) return;
        setSnapshot(next);
        setLoadError(null);
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
  }, [isStarting]);

  // 秒表：只在 phase===starting 期间走动，驱动「已加载 N 秒」的文案；一旦跨出这个
  // 阶段就清掉 interval，不让它常驻在背景空转——其它阶段完全不需要按秒刷新。
  useEffect(() => {
    if (!isStarting) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(tick);
  }, [isStarting]);

  const runAction = (model: string, kind: "start" | "stop") => {
    setPending({ model, kind });
    setActionError(null);
    const call = kind === "start" ? apiRef.current.start(model) : apiRef.current.stop(model);
    call
      .then((next) => {
        setSnapshot(next);
        setLoadError(null);
      })
      .catch((error: unknown) => setActionError(describeError(error)))
      .finally(() => setPending(null));
  };

  if (snapshot === null) {
    // 一次都没拿到过快照：连 openUrl 都不知道，画不出可用的「用浏览器打开」按钮
    // （CardHeader 会因为 openUrl 是空串自动把它禁掉），但外框、标题行照样露出，
    // 不能让这一阶段的卡片看着跟旁边官方卡是两套东西。
    return (
      <div className="llamapad-card">
        <CardHeader t={t} openUrl="" />
        <div className="llamapad-card__body">
          {loadError === null ? (
            <p className="llamapad-card__hint">{t("loading")}</p>
          ) : (
            <div className="llamapad-card__banner" role="alert">
              <IconWarningOutline16 />
              <span>{t("panelUnavailable")}</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  const view = buildCardView(snapshot, pending);

  return (
    <div className="llamapad-card">
      <CardHeader t={t} openUrl={snapshot.openUrl} />
      <div className="llamapad-card__body">
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
                onClick={() => runAction(model.name, action.kind)}
              >
                {action.pending ? t(pendingLabelKey(action.kind)) : t(action.kind === "stop" ? "stop" : "start")}
              </Button>
            </li>
          ))}
        </ul>
      </div>
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

function pendingLabelKey(kind: "start" | "stop"): LocaleKey {
  return kind === "start" ? "startPending" : "stopPending";
}

function missingReasonKey(reason: "missing-file" | "missing-mmproj"): LocaleKey {
  return reason === "missing-file" ? "missingFile" : "missingMmproj";
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
