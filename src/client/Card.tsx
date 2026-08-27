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
import { buildCardView, inferringDotState, type InferringBadge, type PendingAction } from "./state";
import { injectCardStyles } from "./styles";
import type { LocaleKey } from "./locale";

/** 轮询间隔：卡片挂载期间定时刷新；卸载时清掉，不常驻打面板。 */
const POLL_INTERVAL_MS = 5000;

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

  // 只在卡片挂载（可见）期间轮询；effect 的清理函数负责在卸载时停表，
  // 不让它常驻在后台打面板。
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
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

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
          {snapshot.running !== null ? (
            <>
              <StateDot state={view.inferring !== null ? inferringDotState(view.inferring) : "done"} />
              {/* 运行中的模型有可能已经不在列表里（配置删了但容器还在跑），
                  此时退回用面板给的 name，不能因为列表里找不到就说「没有模型在运行」。 */}
              <span>{t("runningModel", { name: view.runningModel?.displayName ?? snapshot.running })}</span>
              {view.inferring !== null ? (
                <Pill active={view.inferring === "inferring"}>{t(inferringLabelKey(view.inferring))}</Pill>
              ) : null}
            </>
          ) : (
            <span>{t("noModelRunning")}</span>
          )}
        </div>

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
