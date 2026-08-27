import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { LlamapadAdapter } from "./adapter";
import { createPanelClient } from "./panel-client";
import { createModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
  provider: string;
  mode: string;
  llamaBaseUrl?: string;
  startTimeoutMs: number;
  pollIntervalMs: number;
  requestTimeoutMs: number;
  defaultContextWindow?: number;
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  // 不用 .required()：bundle 安装后用户总要先补配置再重启，缺配置不该拖垮整个 dsh 启动
  panelUrl: Schema.string().description("llamapad 面板地址，如 http://192.168.1.10:8080"),
  token: Schema.string().role("secret").description("llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）"),
  provider: Schema.string().default("llamapad").description("provider 路由名（agent 配置的 provider 字段）"),
  mode: Schema.string().default("proxy").description("推理通道：proxy=走面板反代（默认，llama.cpp 端口无需暴露）；direct=直连 llama.cpp（需 llamaBaseUrl）"),
  llamaBaseUrl: Schema.string().description("direct 模式下 llama.cpp 基地址，如 http://192.168.1.10:18080"),
  startTimeoutMs: Schema.number().default(300000).description("切换后等待模型就绪的超时（毫秒）"),
  pollIntervalMs: Schema.number().default(2000).description("就绪探测轮询间隔（毫秒）"),
  requestTimeoutMs: Schema.number().default(30000).description("面板控制面单请求超时（毫秒）"),
  defaultContextWindow: Schema.number().description("模型未配置 ctx_size 时 resolveModel 的兜底上下文窗口"),
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
  const client = createPanelClient({
    baseUrl: config.panelUrl,
    token: config.token,
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  });
  const gate = createModelGate(client);
  ctx.llm.registerAdapter([config.provider], new LlamapadAdapter({
    client,
    gate,
    token: config.token,
    mode: config.mode,
    ...(config.llamaBaseUrl ? { llamaBaseUrl: config.llamaBaseUrl } : {}),
    ...(config.startTimeoutMs ? { startTimeoutMs: config.startTimeoutMs } : {}),
    ...(config.pollIntervalMs ? { pollIntervalMs: config.pollIntervalMs } : {}),
    ...(config.defaultContextWindow ? { defaultContextWindow: config.defaultContextWindow } : {}),
  }));
}

export { LlamapadAdapter, createPanelClient, createModelGate };
