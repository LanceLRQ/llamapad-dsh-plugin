import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
// 仅为副作用引入：dsh-typert-registry 用 declare module 给 ctx.typert 补上 register()
// 等方法，不引入这个模块 TS 就看不到 augmentation（运行时由宿主提供，不进产物）。
import type {} from "@deepseek-ai/dsh-typert-registry";
import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";
import { LlamapadAdapter } from "./adapter";
import { startDirectoryRefresh } from "./directory-refresh";
import { createPanelClient, DEFAULT_DRAIN_TIMEOUT_MS } from "./panel-client";
import { PanelGateway } from "./panel-gateway";
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
  if (!config.panelUrl || !config.token) {
    console.warn(
      "[llamapad-dsh-plugin] 尚未配置 panelUrl / token，已跳过适配器注册。" +
      "请在 profile 的 cordis.patch.yml 里按 id 覆盖 llamapad 行（模板见包内 examples/profile-patch.example.yml），改完重启 dsh。",
    );
    return;
  }
  if (config.mode !== "proxy" && config.mode !== "direct") {
    throw new Error(`mode 必须是 proxy 或 direct，当前: ${config.mode}`);
  }
  if (config.mode === "direct" && !config.llamaBaseUrl) {
    throw new Error("direct 模式需要配置 llamaBaseUrl");
  }
  if (config.chatBehavior !== "strict" && config.chatBehavior !== "passthrough" && config.chatBehavior !== "auto-switch") {
    throw new Error(`chatBehavior 必须是 strict / passthrough / auto-switch 之一，当前: ${config.chatBehavior}`);
  }
  const client = createPanelClient({
    baseUrl: config.panelUrl,
    token: config.token,
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  });
  // 共享门：与 B 形态（tools.ts）的 start 工具共用同一把锁，避免同一面板出现两把锁
  // 各自判断"要不要起/停"而互相插队（见 switching.ts 的 sharedModelGate 注释）
  const gate = sharedModelGate(client);
  // auto-switch 档忽略 hideStoppedModels：那一档靠「选中未启动的模型」触发自动启动，
  // 把未启动的模型藏起来会让整档不可用。这里 warn 一次即可，不必每次 listModels 都喊。
  const hideStoppedModels = config.hideStoppedModels === true && config.chatBehavior !== "auto-switch";
  if (config.hideStoppedModels === true && config.chatBehavior === "auto-switch") {
    console.warn(
      "[llamapad-dsh-plugin] chatBehavior=auto-switch 时忽略 hideStoppedModels："
      + "该档需要选中未启动的模型来触发自动启动，隐藏它们会让这一档无法使用。",
    );
  }
  ctx.llm.registerAdapter([config.provider], new LlamapadAdapter({
    client,
    gate,
    token: config.token,
    mode: config.mode,
    chatBehavior: config.chatBehavior,
    ...(config.llamaBaseUrl ? { llamaBaseUrl: config.llamaBaseUrl } : {}),
    ...(config.startTimeoutMs ? { startTimeoutMs: config.startTimeoutMs } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    drainOnSwitch: config.drainOnSwitch,
    ...(config.drainTimeoutMs ? { drainTimeoutMs: config.drainTimeoutMs } : {}),
    ...(config.defaultContextWindow ? { defaultContextWindow: config.defaultContextWindow } : {}),
    hideStoppedModels,
  }));
  startDirectoryRefresh({ ctx, client, intervalMs: config.statusRefreshMs });

  // 设置卡片的 host 半身：构造即在 ctx.reflect 自注册，dispose 跟随本插件 fiber
  // （TypertRemoteService 继承自 cordis Service，语义见其类注释），不需要手动 ctx.effect。
  new PanelGateway(ctx, {
    client,
    gate,
    panelUrl: config.panelUrl,
    ...(config.panelPublicUrl ? { panelPublicUrl: config.panelPublicUrl } : {}),
    drainOnSwitch: config.drainOnSwitch,
    ...(config.drainTimeoutMs ? { drainTimeoutMs: config.drainTimeoutMs } : {}),
  });

  // settings 命名空间必须是 SETTINGS_NAMESPACE（kebab-case）而非 RPC_NAMESPACE（驼峰）——
  // 两者是不同的东西，见 rpc-contract.ts 顶部注释。它同时是卡片在 Plugins 页签的 slot key：
  // 该页签只渲染「host 已服务的 settings namespace ∩ 已注册到 settings.plugin.item 的卡片」
  // 的交集，两边对不上卡片就不会出现。
  //
  // 本轮不做配置表单：不接受这个 namespace 的写入，真源仍只有 cordis.patch.yml。setSource /
  // onChange 如实接住 dsh-settings 的回调即可，不读取、不据此改变上面已经用 config（entry 层）
  // 构造完毕的 client / gate / adapter / 网关——现有配置读取路径必须与今天完全一致。
  installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), Config, config, {
    setSource: () => {},
    onChange: () => {},
  });

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

export { LlamapadAdapter, createPanelClient, createModelGate };
