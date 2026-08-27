import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { LlamapadAdapter } from "./adapter";
import { startDirectoryRefresh } from "./directory-refresh";
import { createPanelClient, DEFAULT_DRAIN_TIMEOUT_MS } from "./panel-client";
import { createModelGate, sharedModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
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
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  // 不用 .required()：bundle 安装后用户总要先补配置再重启，缺配置不该拖垮整个 dsh 启动
  panelUrl: Schema.string().description("llamapad 面板地址，如 http://192.168.1.10:8080"),
  token: Schema.string().role("secret").description("llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）"),
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
  drainOnSwitch: Schema.boolean().default(true).description("auto-switch 档切换前是否让服务端排空在途推理（仅 auto-switch 档生效）"),
  drainTimeoutMs: Schema.number().default(DEFAULT_DRAIN_TIMEOUT_MS).description("排空等待的最长时间（毫秒，仅 auto-switch 档且 drainOnSwitch=true 时生效）"),
  requestTimeoutMs: Schema.number().default(30000).description("面板控制面单请求超时（毫秒）"),
  defaultContextWindow: Schema.number().description("模型未配置 ctx_size 时 resolveModel 的兜底上下文窗口"),
  statusRefreshMs: Schema.number().default(5000).description(
    "轮询面板运行状态并刷新 dsh 模型选择器的间隔（毫秒）；0 关闭。仅影响选择器上的运行中标记，不影响对话",
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
  }));
  startDirectoryRefresh({ ctx, client, intervalMs: config.statusRefreshMs });
}

export { LlamapadAdapter, createPanelClient, createModelGate };
