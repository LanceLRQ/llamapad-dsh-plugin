import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
// 仅为副作用引入：dsh-typert-registry 用 declare module 给 ctx.typert 补上 register()
// 等方法，不引入这个模块 TS 就看不到 augmentation（运行时由宿主提供，不进产物）。
import type {} from "@deepseek-ai/dsh-typert-registry";
// 同上：dsh-attachment 用 declare module 给 ctx.attachments（AttachmentStore 服务）
// 补上类型；下面 ImageAttachmentRef 的类型引入顺带把这份 augmentation 带进编译。
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { LlamapadAdapter, type LlamapadAdapterOptions } from "./adapter";
import {
  connectionChanged, createUnconfiguredClient, isConnectionComplete, readConnection,
  type ConnectionParams,
} from "./connection";
import { startDirectoryRefresh } from "./directory-refresh";
import { createPanelClient, DEFAULT_DRAIN_TIMEOUT_MS } from "./panel-client";
import { PanelGateway, type PanelGatewayOptions } from "./panel-gateway";
import { RPC_CONTRIBUTION, RPC_PACKAGE, SETTINGS_NAMESPACE } from "./rpc-contract";
import { createModelGate, sharedModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
  /**
   * 浏览器可见的面板地址，供设置卡片「用浏览器打开」按钮使用；缺省回落 panelUrl。
   * 跨机部署时 panelUrl 是 host 进程视角的地址（可能是 127.0.0.1），浏览器打不开。
   */
  panelPublicUrl?: string;
  provider: string;
  mode: string;
  llamaBaseUrl?: string;
  chatBehavior: string;
  startTimeoutMs: number;
  pollIntervalMs: number;
  drainOnSwitch: boolean;
  drainTimeoutMs: number;
  requestTimeoutMs: number;
  defaultContextWindow?: number;
  statusRefreshMs: number;
  hideStoppedModels: boolean;
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  // 不用 .required()：bundle 安装后用户总要先补配置再重启，缺配置不该拖垮整个 dsh 启动
  panelUrl: Schema.string().description("llamapad 面板地址，如 http://192.168.1.10:8080"),
  token: Schema.string().role("secret").description("llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）"),
  panelPublicUrl: Schema.string().description(
    "浏览器可见的面板地址，供设置卡片「用浏览器打开」按钮使用；缺省回落 panelUrl。"
    + "跨机部署时 panelUrl 是 host 进程视角的地址（可能是 127.0.0.1），浏览器打不开",
  ),
  provider: Schema.string().default("llamapad").description("provider 路由名（agent 配置的 provider 字段）"),
  mode: Schema.string().default("proxy").description("推理通道：proxy=走面板反代（默认，llama.cpp 端口无需暴露）；direct=直连 llama.cpp（需 llamaBaseUrl）"),
  llamaBaseUrl: Schema.string().description("direct 模式下 llama.cpp 基地址，如 http://192.168.1.10:18080"),
  chatBehavior: Schema.string().default("strict").description(
    "聊天路由档位：strict（默认）=请求模型与运行中模型不一致或无模型在跑时报错，聊天路径完全不触发启停，"
    + "在途流绝对安全；passthrough=有模型在跑就发给它（名字对不上也照发），没跑时同样报错；"
    + "auto-switch=保留旧版「选谁起谁」行为，start 自带停旧起新",
  ),
  startTimeoutMs: Schema.number().default(300000).description("切换后等待模型就绪的超时（毫秒，仅 auto-switch 档生效）"),
  pollIntervalMs: Schema.number().default(2000).description("就绪探测轮询间隔（毫秒，仅 auto-switch 档生效）"),
  drainOnSwitch: Schema.boolean().default(true).description(
    "切换/停止前是否让服务端排空在途推理：auto-switch 档的自动切换与设置卡片的启停按钮共用这个开关",
  ),
  drainTimeoutMs: Schema.number().default(DEFAULT_DRAIN_TIMEOUT_MS).description(
    "排空等待的最长时间（毫秒，drainOnSwitch=true 时生效），同样是 auto-switch 档与设置卡片启停按钮共用的一个数字",
  ),
  requestTimeoutMs: Schema.number().default(30000).description("面板控制面单请求超时（毫秒）"),
  defaultContextWindow: Schema.number().description("模型未配置 ctx_size 时 resolveModel 的兜底上下文窗口"),
  statusRefreshMs: Schema.number().default(5000).description(
    "轮询面板运行状态并刷新 dsh 模型选择器的间隔（毫秒）；0 关闭。仅影响选择器上的运行中标记，不影响对话",
  ),
  hideStoppedModels: Schema.boolean().default(false).description(
    "模型选择器只显示运行中的模型（默认关闭）。开启后没有模型在跑时选择器会是空的；"
    + "auto-switch 档下该开关被忽略——那一档要靠选中未启动的模型来触发自动启动",
  ),
});

export const name = "llamapad-dsh-plugin";
export const inject = ["llm"];

export function apply(ctx: Context, config: Config) {
  // 这三项是编程/配置错误（写错了值），不是「还没填」，照旧直接抛——它们与连接是否
  // 配齐无关，settings 层也改不出合法值来，越早暴露越好。
  assertStaticConfig(config);

  // current 是「当前生效配置」的取值 thunk。初值指向 entry（cordis.yml 那层）；
  // settings 服务挂载后 setSource 会把它换成 () => scope.get()，从此读到的是
  // 「schema 默认 < cordis.yml < settings.yaml」三层合并后的值。
  let current: () => Config = () => config;

  // adapter 与 gateway 全程只有一个实例，配置变了改写它们的 options（见 adapter.ts /
  // panel-gateway.ts 两个 options 接口上的契约注释），不重建、不重新注册。
  const adapterOptions: LlamapadAdapterOptions = {
    client: createUnconfiguredClient(),
    gate: sharedModelGate(createUnconfiguredClient()),
    token: "", mode: "proxy",
  };
  const gatewayOptions: PanelGatewayOptions = {
    client: adapterOptions.client, gate: adapterOptions.gate, panelUrl: "", token: "",
  };

  let live: ConnectionParams | null = null;

  /** 幂等：连接参数没变就什么都不做。onChange 每次写入都会触发，包括我们自己写的那次。 */
  const syncConnection = () => {
    const cfg = current();
    const params = readConnection(cfg);
    const complete = isConnectionComplete(params);

    if (connectionChanged(live, params)) {
      const client = complete
        ? createPanelClient({
            baseUrl: params.panelUrl, token: params.token,
            ...(params.requestTimeoutMs ? { requestTimeoutMs: params.requestTimeoutMs } : {}),
          })
        : createUnconfiguredClient();
      // 共享门：与 B 形态（tools.ts）的 start 工具共用同一把锁，避免同一面板出现两把锁
      // 各自判断"要不要起/停"而互相插队（见 switching.ts 的 sharedModelGate 注释）
      const gate = sharedModelGate(client);
      adapterOptions.client = client;
      adapterOptions.gate = gate;
      gatewayOptions.client = client;
      gatewayOptions.gate = gate;
      live = params;
    }

    // 非连接类字段每次都同步：它们改了不需要换 client，但同样要立刻生效
    adapterOptions.token = params.token;
    adapterOptions.mode = params.mode === "direct" ? "direct" : "proxy";
    adapterOptions.chatBehavior = cfg.chatBehavior as never;
    // auto-switch 档忽略 hideStoppedModels：那一档靠「选中未启动的模型」触发自动启动，
    // 把未启动的模型藏起来会让整档不可用（见 filterModelsForSelector 注释）。
    adapterOptions.hideStoppedModels =
      cfg.hideStoppedModels === true && cfg.chatBehavior !== "auto-switch";
    adapterOptions.drainOnSwitch = cfg.drainOnSwitch;
    setOptional(adapterOptions, "llamaBaseUrl", params.llamaBaseUrl);
    setOptional(adapterOptions, "startTimeoutMs", cfg.startTimeoutMs);
    setOptional(adapterOptions, "pollIntervalMs", cfg.pollIntervalMs);
    setOptional(adapterOptions, "drainTimeoutMs", cfg.drainTimeoutMs);
    setOptional(adapterOptions, "defaultContextWindow", cfg.defaultContextWindow);
    // 图片读取通道不依赖连接参数，每次 sync 接的都是同一个实现（赋值幂等，重复触发
    // 的 onChange 无副作用）；放这里而非构造期，是为了让 adapterOptions 的全部接线
    // 集中在一个函数里，避免「半个 options 在构造期、半个在 sync」的漂移。
    adapterOptions.readImage = readImageFromAttachmentStore(ctx);
    gatewayOptions.panelUrl = params.panelUrl;
    // 设置卡片只需要「配没配」（CardSnapshot.connection.tokenConfigured），不需要 token
    // 本身参与任何请求——但缺了这行同步，tokenConfigured 会永远读到构造期的空字符串。
    gatewayOptions.token = params.token;
    gatewayOptions.drainOnSwitch = cfg.drainOnSwitch;
    setOptional(gatewayOptions, "panelPublicUrl", cfg.panelPublicUrl);
    setOptional(gatewayOptions, "drainTimeoutMs", cfg.drainTimeoutMs);
  };

  // 先接 settings：installSettingsSection 在挂载时会同步调一次 setSource + onChange，
  // 于是第一次 syncConnection 用的就已经是三层合并后的值。settings 服务没挂载时这两个
  // 回调都不会触发，靠下面那次手动调用兜底（syncConnection 幂等，两条路径都安全）。
  //
  // settings 命名空间必须是 SETTINGS_NAMESPACE（kebab-case）而非 RPC_NAMESPACE（驼峰）——
  // 两者是不同的东西，见 rpc-contract.ts 顶部注释。它同时是卡片在 Plugins 页签的 slot key：
  // 该页签只渲染「host 已服务的 settings namespace ∩ 已注册到 settings.plugin.item 的卡片」
  // 的交集，两边对不上卡片就不会出现——这正是缺配置也必须无条件走到这一步的原因。
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), Config, config, {
    setSource: (source) => { current = source; },
    onChange: syncConnection,
  });
  syncConnection();

  if (config.hideStoppedModels === true && config.chatBehavior === "auto-switch") {
    ctx.logger(name).warn(
      "chatBehavior=auto-switch 时忽略 hideStoppedModels："
      + "该档需要选中未启动的模型来触发自动启动，隐藏它们会让这一档无法使用。",
    );
  }

  ctx.llm.registerAdapter([config.provider], new LlamapadAdapter(adapterOptions));
  startDirectoryRefresh({ ctx, client: () => adapterOptions.client, intervalMs: config.statusRefreshMs });

  // 设置卡片的 host 半身：构造即在 ctx.reflect 自注册，dispose 跟随本插件 fiber
  // （TypertRemoteService 继承自 cordis Service，语义见其类注释），不需要手动 ctx.effect。
  new PanelGateway(ctx, gatewayOptions, (patch) => writeSettings(ctx, patch));

  // 把三个方法的 strict 描述符注册进 typert 共享注册表。
  //
  // 这一步不是可选优化，是唯一可行的通路：网关默认的 SRC 反射（@Remote 装饰器）把标记
  // 记在 dsh-typert-protocol 的**模块级 WeakMap** 里，而第三方插件从自己的 node_modules
  // 解析该包、宿主从 dsh 的安装目录解析，运行时是两份模块实例、两张 WeakMap——网关那份
  // 永远读不到我们写进去的标记，端点不被认领，请求直接 404。对齐版本号救不了这个：
  // 只要模块实例是两份，模块级状态就必然分裂。
  //
  // ctx.typert 是 cordis 服务，经 DI 拿到的是宿主那一份的实例，所以走它注册的描述符
  // 网关一定看得见。register() 内部用调用方 ctx 的 effect 持有，随本插件 fiber 一起回收。
  ctx.inject(["typert"], (typertCtx) => {
    typertCtx.typert.register({
      package: RPC_PACKAGE,
      face: "host",
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: RPC_CONTRIBUTION.descriptors,
    });
  });
}

/** mode / chatBehavior / direct 缺 llamaBaseUrl 三项静态校验，与连接是否配齐无关。 */
function assertStaticConfig(config: Config): void {
  if (config.mode !== "proxy" && config.mode !== "direct") {
    throw new Error(`mode 必须是 proxy 或 direct，当前: ${config.mode}`);
  }
  if (config.mode === "direct" && !config.llamaBaseUrl) {
    throw new Error("direct 模式需要配置 llamaBaseUrl");
  }
  if (config.chatBehavior !== "strict" && config.chatBehavior !== "passthrough"
      && config.chatBehavior !== "auto-switch") {
    throw new Error(`chatBehavior 必须是 strict / passthrough / auto-switch 之一，当前: ${config.chatBehavior}`);
  }
}

/**
 * adapter 图片读取通道的实现：机会式取宿主的 attachments 服务（AttachmentStore）。
 *
 * 为什么不能把 "attachments" 写进静态 inject（export const inject）：cordis 的静态注入
 * 要求服务在启动期就位，缺席会阻塞本插件启动——而插件的价值不止图片（文本对话、
 * 启停工具都不需要它），不该为一个可选能力赌上启动。host 的 web 组合实际必装此服务
 * （图片贴图全靠它），但机会式获取 + null 降级让插件在任何宿主形态下都能起、纯文本
 * 功能始终可用。
 *
 * ctx.get 的语义正是我们要的：服务未挂载返回 undefined（不抛错、不挂起等待）。每次
 * 调用时现取而非启动时取一次——提供该服务的宿主组件可能在插件加载之后才挂载，
 * 而注册表查询只是一次 map 命中，成本可忽略。
 */
function readImageFromAttachmentStore(ctx: Context) {
  return async (ref: ImageAttachmentRef): Promise<{ data: Uint8Array; mediaType: string } | null> => {
    const store = ctx.get("attachments");
    if (store === undefined) return null;
    try {
      const stored = await store.readImage(ref);
      // mediaType 取读回时验证过字节的那份（stored.ref.mediaType），比请求携带的 ref 更权威
      return { data: stored.data, mediaType: stored.ref.mediaType };
    } catch {
      // 读失败（存储校验不过等）→ null，wire 层降级为占位文本；不重试，理由见
      // adapter.ts 的 readImage 字段注释
      return null;
    }
  };
}

/**
 * 可选字段的写入：值为空时**删掉这个键**而不是写 undefined。
 * 两个 options 接口的可选字段都是「有这个键就当配了」的语义（构造处用的是
 * `...(x ? { k: x } : {})` 这种展开写法），留一个 undefined 值会让判断走岔。
 */
function setOptional<T extends object, K extends keyof T>(
  target: T, key: K, value: T[K] | undefined,
): void {
  if (value === undefined || value === "") delete target[key];
  else target[key] = value;
}

/**
 * 把补丁写进本插件的 settings 分节（$DSH_HOME/settings.yaml），供设置卡片的 saveConnection
 * 调用。不传 expectedRevision——卡片拿到的是脱敏后的 CardSnapshot.connection，没有 revision
 * 可带回来，乐观合并即可：并发写入本就是同一个人在同一张卡片上点，冲突概率可以忽略。
 *
 * ctx.inject(["settings"], …) 只在服务挂载后才回调；但这条路径只有卡片真被点了
 * saveConnection 才会触达，而卡片能渲染出来就意味着 settings 服务已经挂了（见上面
 * installSettingsSection 那段注释：Plugins 页签只派发「host 已服务的 namespace」的卡片），
 * 不会真的悬空等不到回调。
 */
function writeSettings(ctx: Context, patch: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    ctx.inject(["settings"], (sctx) => {
      sctx.settings.update(settingsNamespace(SETTINGS_NAMESPACE), patch).then(resolve, reject);
    });
  });
}

export { LlamapadAdapter, createPanelClient, createModelGate };
