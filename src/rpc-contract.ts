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
// 只引类型不引运行时：本文件同时进浏览器产物（client bundle），panel-client.ts 是
// Node 侧的 HTTP 客户端，类型引用在编译期擦除、不会把它打进浏览器
import type { PanelEvent } from "./panel-client";

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
  saveConnection: "saveConnection",
} as const;

/** start / stop 的形参名——必须与 panel-gateway.ts 里方法签名的形参逐字一致。 */
export const RPC_WIRE_MODEL = "model";

/** saveConnection 的形参名——必须与 panel-gateway.ts 方法签名的形参逐字一致。 */
export const RPC_WIRE_PANEL_URL = "panelUrl";
export const RPC_WIRE_TOKEN = "token";

/** 卡片列表里的一行模型。字段是 PanelModelView 的子集，只留卡片真会渲染的。 */
export interface CardModel {
  name: string;
  displayName: string;
  namespace: string;
  quant: string | null;
  /** modelsView 的四态：running / ready / missing-file / missing-mmproj */
  status: string;
}

/**
 * 运行阶段。由 host 侧折算后下发，浏览器端不重复推导——判定依据（/slots 与
 * /health 的状态码同步性）是真机实测出来的，只该有一处知道它，见
 * panel-gateway.ts 的 buildSnapshot。
 *
 * - `idle`     无模型在跑
 * - `starting` 容器已起、llama-server 仍在把模型读进显存（实测 27B/Q4 约 33 秒，
 *              期间 /health 与 /slots 一律 503 `{"message":"Loading model"}`）
 * - `ready`    可服务
 *
 * 与 inferring 的关系：`starting` 时 /slots 必然探不到，所以 inferring 必为 null。
 * 卡片在这一阶段不要画「推理状态未知」——那句话在加载中是纯噪音。
 */
export type RuntimePhase = "idle" | "starting" | "ready";

/** 连接配置的展示态。token 永远不出现在这里——只说「配没配」，不说「配的是什么」。 */
export interface CardConnection {
  panelUrl: string;
  tokenConfigured: boolean;
}

/**
 * 卡片事件流的一条（面板事件的下发投影）。字段与 PanelEvent 同形但独立声明：
 * wire 契约只认这一个类型，面板侧投影将来加字段也不会顺着泄漏进浏览器产物——
 * 卡片该展示什么由这里的字段集说了算。
 */
export interface CardEvent {
  /** 面板事件表的自增 id，单调递增，浏览器侧用它做「已见过」去重 */
  id: number;
  /** 毫秒时间戳 */
  ts: number;
  /** 事件种类（model.start / model.stop / download.* …），卡片按前缀分组渲染 */
  kind: string;
  message: string;
}

/** PanelEvent → CardEvent 的投影映射，gateway 组装快照时逐条过一遍。 */
export function toCardEvent(event: PanelEvent): CardEvent {
  return { id: event.id, ts: event.ts, kind: event.kind, message: event.message };
}

/** 卡片一次轮询拿到的全部内容：列表 + 运行状态 + 打开面板用的地址。 */
export interface CardSnapshot {
  models: CardModel[];
  /** 运行中模型的 name；无模型在跑为 null */
  running: string | null;
  /** 运行阶段，三态语义见 RuntimePhase */
  phase: RuntimePhase;
  /**
   * 运行中容器的启动时刻（ISO 8601 字符串）；无模型在跑、或面板没给为 null。
   * 卡片用它算「已加载 N 秒」——传绝对时刻而不是让卡片自己按住秒表，
   * 这样轮询抖动、组件重挂载、以及「模型是别的客户端启动的」三种情况下都还准。
   */
  startedAt: string | null;
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
  /** 当前连接配置（面板地址 + token 是否已配），供设置卡片渲染连接区。 */
  connection: CardConnection;
  /**
   * 最近的面板事件（时间升序，最多 eventRing 容量条），来自 status-watch 的事件环。
   * 浏览器卡片本任务暂未消费（事件流 UI 是后续任务的活），先随快照下发养数据。
   */
  events: CardEvent[];
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

function asNumber(value: unknown, field: string): number {
  return typeof value === "number" ? value : fail(field, "number");
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

function parseCardConnection(value: unknown): CardConnection {
  const row = asRecord(value, "snapshot.connection");
  const tokenConfigured = row["tokenConfigured"];
  if (typeof tokenConfigured !== "boolean") fail("snapshot.connection.tokenConfigured", "boolean");
  return { panelUrl: asString(row["panelUrl"], "snapshot.connection.panelUrl"), tokenConfigured };
}

function parseCardEvent(value: unknown, field: string): CardEvent {
  const row = asRecord(value, field);
  return {
    id: asNumber(row["id"], `${field}.id`),
    ts: asNumber(row["ts"], `${field}.ts`),
    kind: asString(row["kind"], `${field}.kind`),
    message: asString(row["message"], `${field}.message`),
  };
}

function parseCardSnapshot(value: unknown): CardSnapshot {
  const row = asRecord(value, "snapshot");
  const models = row["models"];
  if (!Array.isArray(models)) fail("snapshot.models", "array");
  const events = row["events"];
  if (!Array.isArray(events)) fail("snapshot.events", "array");
  const inferring = row["inferring"];
  if (inferring !== null && typeof inferring !== "boolean") fail("snapshot.inferring", "boolean | null");
  const phase = row["phase"];
  if (phase !== "idle" && phase !== "starting" && phase !== "ready") {
    fail("snapshot.phase", '"idle" | "starting" | "ready"');
  }
  return {
    models: models.map((item, index) => parseCardModel(item, `snapshot.models[${index}]`)),
    running: asNullableString(row["running"], "snapshot.running"),
    phase,
    startedAt: asNullableString(row["startedAt"], "snapshot.startedAt"),
    inferring,
    openUrl: asString(row["openUrl"], "snapshot.openUrl"),
    panelError: asNullableString(row["panelError"], "snapshot.panelError"),
    connection: parseCardConnection(row["connection"]),
    events: events.map((item, index) => parseCardEvent(item, `snapshot.events[${index}]`)),
  };
}

const SNAPSHOT_CODEC = strict<CardSnapshot>(`${RPC_PACKAGE}#CardSnapshot`, parseCardSnapshot);
const MODEL_NAME_CODEC = strict<string>(`${RPC_PACKAGE}#ModelName`, (value) =>
  asString(value, RPC_WIRE_MODEL));

/**
 * 一条 InvocationDescriptor 的最小形状（dsh 的类型更宽，这里只用到这些字段）。
 *
 * cancellation：声明「传输层取消通道」（见 dsh-typert-protocol 的 types.d.ts）——
 * signal 不进 wire 参数，浏览器侧生成方法以**末位可选形参 `signal?: AbortSignal`**
 * 暴露，由网关注入到 host 方法业务形参之后。只有可能长时间在途的方法（start/stop
 * 的排空等待最长 60s+）才声明；snapshot/saveConnection 一问一答，不需要。
 */
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
  readonly cancellation?: { readonly parameter: "signal" };
  readonly result: StrictCodec<unknown>;
}

function descriptor(
  method: string,
  parameters: Descriptor["parameters"],
  cancellation?: Descriptor["cancellation"],
): Descriptor {
  return {
    id: `${RPC_PACKAGE}#${RPC_NAMESPACE}/${method}`,
    service: RPC_NAMESPACE,
    namespace: RPC_NAMESPACE,
    method,
    invocation: { kind: "direct" },
    parameters,
    // 不声明取消通道的方法不带这个字段（而不是传 undefined 撑开对象）
    ...(cancellation !== undefined ? { cancellation } : {}),
    result: SNAPSHOT_CODEC,
  };
}

const MODEL_PARAM = {
  name: RPC_WIRE_MODEL,
  wire: RPC_WIRE_MODEL,
  source: "json",
  codec: MODEL_NAME_CODEC,
} as const;

const PANEL_URL_PARAM = {
  name: RPC_WIRE_PANEL_URL,
  wire: RPC_WIRE_PANEL_URL,
  source: "json",
  codec: strict<string>(`${RPC_PACKAGE}#PanelUrl`, (value) => asString(value, RPC_WIRE_PANEL_URL)),
} as const;

const TOKEN_PARAM = {
  name: RPC_WIRE_TOKEN,
  wire: RPC_WIRE_TOKEN,
  source: "json",
  codec: strict<string>(`${RPC_PACKAGE}#Token`, (value) => asString(value, RPC_WIRE_TOKEN)),
} as const;

/** start/stop 共用的取消通道声明（见 Descriptor.cancellation 注释）。 */
const SIGNAL_CANCELLATION = { parameter: "signal" } as const;

/**
 * 浏览器侧 `ctx.remote.$mount()` 的入参。
 *
 * 四个方法都以 CardSnapshot 作为返回值——动作做完顺带回传最新状态，
 * 省掉「点完按钮再多打一次 snapshot」的往返，也避免中间态闪烁。
 * start/stop 额外声明 cancellation：生成方法暴露为 `start(model, signal?)`，
 * 供卡片把「取消等待」手势传到 host（见 Descriptor.cancellation 注释）。
 */
export const RPC_CONTRIBUTION = {
  package: RPC_PACKAGE,
  descriptors: [
    descriptor(RPC_METHOD.snapshot, []),
    descriptor(RPC_METHOD.start, [MODEL_PARAM], SIGNAL_CANCELLATION),
    descriptor(RPC_METHOD.stop, [MODEL_PARAM], SIGNAL_CANCELLATION),
    descriptor(RPC_METHOD.saveConnection, [PANEL_URL_PARAM, TOKEN_PARAM]),
  ],
} as const;
