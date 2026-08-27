/**
 * 设置卡片的 RPC 契约：host 半身（panel-gateway.ts）与浏览器半身（client/）共用同一份。
 *
 * 为什么要有这个文件——dsh 的两侧描述符是**各自独立推导**的：
 * - host 侧走 SRC 反射（dsh-api-gateway 的 resolveSrcDescriptor），wire 字段名取自
 *   方法的**真实 JS 形参名**；
 * - 浏览器侧要求 strict 描述符（requireStrictDescriptor），wire 字段名由本文件写死。
 * 两边只靠字段名对齐，谁改了对不上就是运行期 400。把方法名与形参名收在这里当唯一出处，
 * 让「改一处、漏另一处」在编译期就暴露，而不是等到用户点按钮。
 *
 * 连带的构建约束：宿主既然按形参名推导，产物就**绝不能开 minify**（见 scripts/build.mjs）。
 */

/** npm 包名，作为 TypertRemoteContribution.package 与描述符 id 前缀。 */
export const RPC_PACKAGE = "llamapad-dsh-plugin";

/**
 * wire 命名空间，同时也是 host 侧 Cordis service key（TypertRemoteService 的构造参数），
 * 浏览器侧则表现为 `ctx.remote.llamapadPanel.*`——所以必须是合法 JS 标识符，用驼峰。
 */
export const RPC_NAMESPACE = "llamapadPanel";

/**
 * settings 命名空间，与 RPC_NAMESPACE **不是同一个东西**，别合并：
 * dsh 的 `settingsNamespace()` 有硬校验 `/^[a-z][a-z0-9-]*$/`（dsh-settings/lib/index.js:81），
 * 驼峰会当场抛 TypeError，所以这里必须是 kebab-case。
 *
 * 它同时是卡片的 slot key——Plugins 页签按 settings namespace 把「Host 已服务的 namespace」
 * 和「已注册到 settings.plugin.item 的卡片」配对，两边对不上卡片就永远不会被派发出来。
 * 即：host 侧 installSettingsSection 用它，浏览器侧 slots.register 的 key 也用它。
 */
export const SETTINGS_NAMESPACE = "llamapad-panel";

/** 方法名的唯一出处：host 的方法名与浏览器的描述符都从这里取。 */
export const RPC_METHOD = {
  snapshot: "snapshot",
  start: "start",
  stop: "stop",
} as const;

/** start / stop 的形参名——必须与 panel-gateway.ts 里方法签名的形参逐字一致。 */
export const RPC_WIRE_MODEL = "model";

/** 卡片列表里的一行模型。字段是 PanelModelView 的子集，只留卡片真会渲染的。 */
export interface CardModel {
  name: string;
  displayName: string;
  namespace: string;
  quant: string | null;
  /** modelsView 的四态：running / ready / missing-file / missing-mmproj */
  status: string;
}

/** 卡片一次轮询拿到的全部内容：列表 + 运行状态 + 打开面板用的地址。 */
export interface CardSnapshot {
  models: CardModel[];
  /** 运行中模型的 name；无模型在跑为 null */
  running: string | null;
  /** true=正在推理，false=空闲，null=不可知（面板没给或探测失败），不等于「不忙」 */
  inferring: boolean | null;
  /** 浏览器可见的面板地址，供「用浏览器打开」按钮使用（host 侧的 panelUrl 未必可达） */
  openUrl: string;
  /**
   * 面板不可达 / 鉴权失败时的中文说明。
   * 走返回值而不是抛错：卡片要能画出「面板连不上」这个状态并继续显示按钮，
   * 而 RPC 抛错在浏览器侧只会得到一个 { ok:false, error } 外壳，信息更少也更难渲染。
   */
  panelError: string | null;
}

/* ------------------------------------------------------------------ *
 * 浏览器侧 strict codec
 *
 * dsh 的 TypertSchema 只要求 `{ parse(value: unknown): T }` 一个方法（见
 * dsh-typert-protocol 的 types.d.ts），不绑定 zod。手写几个校验函数即可，
 * 免得为了三个方法把整个 zod 打进浏览器产物。
 * ------------------------------------------------------------------ */

/** dsh 的 TypertCodec 的 strict 分支，本地重述一份避免浏览器产物 import 运行时包。 */
export interface StrictCodec<T> {
  readonly mode: "strict";
  readonly typeSymbol: string;
  readonly schema: { parse(value: unknown): T };
}

function strict<T>(typeSymbol: string, parse: (value: unknown) => T): StrictCodec<T> {
  return { mode: "strict", typeSymbol, schema: { parse } };
}

function fail(field: string, expected: string): never {
  throw new TypeError(`llamapad RPC: ${field} 期望 ${expected}`);
}

function asString(value: unknown, field: string): string {
  return typeof value === "string" ? value : fail(field, "string");
}

function asNullableString(value: unknown, field: string): string | null {
  if (value === null) return null;
  return asString(value, field);
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(field, "object");
  return value as Record<string, unknown>;
}

function parseCardModel(value: unknown, field: string): CardModel {
  const row = asRecord(value, field);
  return {
    name: asString(row["name"], `${field}.name`),
    displayName: asString(row["displayName"], `${field}.displayName`),
    namespace: asString(row["namespace"], `${field}.namespace`),
    quant: asNullableString(row["quant"], `${field}.quant`),
    status: asString(row["status"], `${field}.status`),
  };
}

function parseCardSnapshot(value: unknown): CardSnapshot {
  const row = asRecord(value, "snapshot");
  const models = row["models"];
  if (!Array.isArray(models)) fail("snapshot.models", "array");
  const inferring = row["inferring"];
  if (inferring !== null && typeof inferring !== "boolean") fail("snapshot.inferring", "boolean | null");
  return {
    models: models.map((item, index) => parseCardModel(item, `snapshot.models[${index}]`)),
    running: asNullableString(row["running"], "snapshot.running"),
    inferring,
    openUrl: asString(row["openUrl"], "snapshot.openUrl"),
    panelError: asNullableString(row["panelError"], "snapshot.panelError"),
  };
}

const SNAPSHOT_CODEC = strict<CardSnapshot>(`${RPC_PACKAGE}#CardSnapshot`, parseCardSnapshot);
const MODEL_NAME_CODEC = strict<string>(`${RPC_PACKAGE}#ModelName`, (value) =>
  asString(value, RPC_WIRE_MODEL));

/** 一条 InvocationDescriptor 的最小形状（dsh 的类型更宽，这里只用到这些字段）。 */
interface Descriptor {
  readonly id: string;
  readonly service: string;
  readonly namespace: string;
  readonly method: string;
  readonly invocation: { readonly kind: "direct" };
  readonly parameters: readonly {
    readonly name: string;
    readonly wire: string;
    readonly source: "json";
    readonly codec: StrictCodec<unknown>;
  }[];
  readonly result: StrictCodec<unknown>;
}

function descriptor(method: string, parameters: Descriptor["parameters"]): Descriptor {
  return {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/${method}`,
    service: RPC_NAMESPACE,
    namespace: RPC_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters,
    result: SNAPSHOT_CODEC,
  };
}

const MODEL_PARAM = {
  name: RPC_WIRE_MODEL,
  wire: RPC_WIRE_MODEL,
  source: "json",
  codec: MODEL_NAME_CODEC,
} as const;

/**
 * 浏览器侧 `ctx.remote.$mount()` 的入参。
 *
 * 三个方法都以 CardSnapshot 作为返回值——动作做完顺带回传最新状态，
 * 省掉「点完按钮再多打一次 snapshot」的往返，也避免中间态闪烁。
 */
export const RPC_CONTRIBUTION = {
  package: RPC_PACKAGE,
  descriptors: [
    descriptor(RPC_METHOD.snapshot, []),
    descriptor(RPC_METHOD.start, [MODEL_PARAM]),
    descriptor(RPC_METHOD.stop, [MODEL_PARAM]),
  ],
} as const;
