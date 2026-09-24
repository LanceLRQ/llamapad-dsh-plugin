// dsh 设置服务的两代差异收在这里，其余代码只见 bindSettings 一个入口。
//
// 0.1.5：插件注册自己的命名空间（installSection），值存在 $DSH_HOME/settings.yaml，
//   经 setSource/onChange 热更新；写入 update(命名空间, patch)。
// 0.1.7：没有命名空间注册。Config 里 .volatile() 的字段由 loader 就地改写 Volatile
//   引用，再向本插件 fiber 发 loader/volatile-update；写入 update(条目 id, patch)，
//   落到 profile 的 cordis.patch.yml。
//
// 分支靠特征检测（有没有 installSection / configure），不比较宿主版本号。
import type { Context } from "@deepseek-ai/cordis";
import { SETTINGS_NAMESPACE } from "../rpc-contract";

const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

interface VolatileLike { get(): unknown }

export function isVolatile(value: unknown): value is VolatileLike {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * 标记为可热更新的字段。schemastery 是 peer，用的是宿主那份：0.1.7 宿主（3.18.4）
 * 有 volatile()；0.1.5 宿主（3.18.2）没有，原样返回，字段按普通字段处理。
 */
export function live<S>(schema: S): S {
  const candidate = schema as S & { volatile?: () => S };
  return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}

/** 把 Volatile 字段解包成当前值。0.1.7 上每次都要现取，loader 会就地改写引用。 */
export function plain<T extends object>(config: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) out[key] = isVolatile(value) ? value.get() : value;
  return out as T;
}

export interface SettingsHooks<T> {
  setSource(source: () => T): void;
  onChange(): void;
}

interface SettingsV015 {
  installSection(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown): void;
  update(ns: string, patch: object): Promise<void>;
}

interface SettingsV017 {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
  update(ns: string, patch: object): Promise<void>;
}

interface ConfigEditorLike {
  edit(entry: unknown, next: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
}

const isV015 = (s: unknown): s is SettingsV015 =>
  typeof (s as SettingsV015 | undefined)?.installSection === "function";
const isV017 = (s: unknown): s is SettingsV017 =>
  typeof (s as SettingsV017 | undefined)?.configure === "function";

/**
 * 接上宿主的设置服务，返回给设置卡片 saveConnection 用的写入函数。
 * 服务缺席时 hooks 一次都不会被调用，调用方沿用初始配置，插件照常工作。
 */
export function bindSettings<T extends { panelUrl?: unknown; token?: unknown }>(
  ctx: Context, schema: unknown, entry: T, hooks: SettingsHooks<T>,
): (patch: Partial<T>) => Promise<void> {
  const anyCtx = ctx as any;
  // 0.1.7 的热更新事件只投递给本插件 fiber 上的监听器，必须挂在 ctx 本身，
  // 不能挂进下面 inject 出来的子上下文。0.1.5 上这个事件不会出现，挂着无害。
  anyCtx.on("loader/volatile-update", () => hooks.onChange());

  ctx.inject(["settings"], (sctx) => {
    const settings = (sctx as any).settings;
    if (isV015(settings)) {
      settings.installSection(ctx, SETTINGS_NAMESPACE, schema, plain(entry), hooks);
    } else if (isV017(settings)) {
      (sctx as any).effect(() => settings.configure({ auto: false }, anyCtx.fiber));
      const current = plain(entry);
      if (!current.panelUrl || !current.token) {
        anyCtx.logger("llamapad-dsh-plugin").warn(
          "当前 dsh 把插件配置存在 profile 的 cordis.patch.yml 里。旧版设置卡片保存的面板地址和 token"
          + " 留在 $DSH_HOME/settings.yaml.imported 的 llamapad-panel 一节，没有自动迁移，请在设置卡片里重新填写一次。",
        );
      }
    }
  });

  return async (patch) => {
    const settings = anyCtx.get("settings");
    if (isV015(settings)) return settings.update(SETTINGS_NAMESPACE, patch);
    const pluginEntry = anyCtx.fiber?.entry;
    if (isV017(settings) && pluginEntry !== undefined) return settings.update(pluginEntry.options.id, patch);
    const editor = anyCtx.get("configEditor") as ConfigEditorLike | undefined;
    if (typeof editor?.edit === "function" && pluginEntry !== undefined) {
      await editor.edit(pluginEntry, (current) => ({ ...current, ...patch }));
      return;
    }
    throw new Error("dsh 的设置服务不可用，无法保存连接配置。请直接编辑 profile 的 cordis.patch.yml");
  };
}
