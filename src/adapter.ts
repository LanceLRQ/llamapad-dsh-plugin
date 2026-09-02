import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import { DEFAULT_DRAIN_TIMEOUT_MS, type PanelClient, type PanelModelView, type PanelRuntimeStatus } from "./panel-client";
import { EnsureError, type ModelGate } from "./switching";
import { decideRoute, type ChatBehavior } from "./routing";
import { buildChatBody } from "./openai-wire";
import { translateOpenAiSse } from "./translate";
import { buildReasoningInfo } from "./reasoning";

export interface LlamapadAdapterOptions {
  client: PanelClient;
  gate: ModelGate;
  token: string;
  mode: "proxy" | "direct";
  llamaBaseUrl?: string;
  /** 聊天路由档位，默认 strict（见 routing.ts） */
  chatBehavior?: ChatBehavior;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
  /** auto-switch 档触发 start 时是否让服务端排空在途推理，默认 true */
  drainOnSwitch?: boolean;
  /** 排空等待的最长时间（毫秒），默认 60000，仅 drainOnSwitch=true 时生效 */
  drainTimeoutMs?: number;
  defaultContextWindow?: number;
  fetchImpl?: typeof fetch;
}

export class LlamapadAdapter extends LlmAdapter {
  constructor(private readonly options: LlamapadAdapterOptions) { super(); }

  override providerInfo(provider: string): LlmProviderInfo {
    return { id: provider, name: "llamapad 本地模型" };
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const models = await this.options.client.listModels();
    return models.map((m) => {
      const { name, description } = describeModel(m);
      return { provider, id: m.name, name, description };
    });
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    // direct 模式绕过面板中转，面板的思考强度改写与兜底都不生效——值域外的取值会被模型
    // chat template 的 jinja raise_exception 打成 HTTP 500。既然用不了，就连问都不问，
    // 省掉两次往返（stream 里也会明确拒绝，见该方法开头）。
    const wantsReasoning = this.options.mode === "proxy";
    const [detail, effective, status] = await Promise.all([
      this.options.client.getModel(model).catch(() => null),
      this.options.client.getEffectiveConfig(model).catch(() => null),
      wantsReasoning ? this.options.client.runtimeStatus().catch(() => null) : Promise.resolve(null),
    ]);
    // /effective 是权威来源（合并了全局默认与模型覆盖）：只要它可用就完全以它为准，
    // 包括「读不出来」这个结论本身——不能再回落去读模型级 ctx_size，否则 args_override
    // 配在全局层时会把那个已经失效的数字又捡回来。端点整个不可用（老版面板没有它 /
    // 请求失败）才退回旧的模型级 overrides 路径。
    const source = effective !== null ? effective.merged : detail?.overrides;
    const contextWindow = readCtxSize(source) ?? this.options.defaultContextWindow;
    const reasoning = wantsReasoning ? await this.resolveReasoning(model, status) : undefined;
    return {
      provider,
      id: model,
      name: detail?.displayName || model,
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
      ...(reasoning !== undefined ? { reasoning } : {}),
    };
  }

  /**
   * 思考强度档位。面板的档位声明由中转层用**当前运行中容器的模型**组装，因此只有
   * 「请求的就是运行中那个模型」时问才有意义——问别的模型拿回来的是运行中模型的值域，
   * 比不问更糟。未运行时直接交给 buildReasoningInfo(null) 走完整枚举兜底。
   */
  private async resolveReasoning(
    model: string,
    status: PanelRuntimeStatus | null,
  ): Promise<LlmModelReasoningInfo | undefined> {
    if (status?.running?.model !== model) return buildReasoningInfo(null);
    return buildReasoningInfo(await this.options.client.getReasoningInfo().catch(() => null));
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined && this.options.mode === "direct") {
      throw new LlmError(
        "direct 模式不支持思考强度：该模式直连 llama.cpp，绕过了面板中转层的取值改写与兜底，"
        + "值域外的取值会被模型 chat template 的 jinja 校验打成 HTTP 500。改用 proxy 模式即可使用。",
        "UNSUPPORTED",
      );
    }
    const behavior = this.options.chatBehavior ?? "strict";
    let targetModel: string;
    // direct 模式拼 URL 要用的运行态：proceed 分支用路由判定时读到的那份即可（没发生启停，
    // 数据不会过期）；start 分支必须在 gate.ensure() 之后重新查一次——否则切到端口不同的
    // 模型时，这里仍是切换前的旧运行态，direct URL 会拼出已经停掉的旧端口。
    // proxy 模式压根不看 hostPort（走面板反代），那次重查纯属白跑，故按 mode 收口。
    let runningForUrl: PanelRuntimeStatus["running"] = null;
    try {
      // busy=1 只有 strict/passthrough 的报错文案用得上；auto-switch 不会走到报错分支，省这次查询
      const status = await this.options.client.runtimeStatus(behavior === "auto-switch" ? undefined : { busy: true });
      const decision = decideRoute(behavior, options.model, status);
      if (decision.action === "error") {
        throw new EnsureError(decision.message, decision.code);
      }
      if (decision.action === "start") {
        const drainOnSwitch = this.options.drainOnSwitch ?? true;
        await this.options.gate.ensure(decision.model, {
          ...(options.signal ? { signal: options.signal } : {}),
          ...(this.options.startTimeoutMs !== undefined ? { timeoutMs: this.options.startTimeoutMs } : {}),
          ...(this.options.pollIntervalMs !== undefined ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
          ...(drainOnSwitch
            ? { drain: true, drainTimeoutMs: this.options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS }
            : {}),
        });
        targetModel = decision.model;
        if (this.options.mode === "direct") {
          runningForUrl = (await this.options.client.runtimeStatus()).running;
        }
      } else {
        targetModel = decision.targetModel;
        runningForUrl = status.running;
      }
    } catch (error) {
      throw mapEnsureError(error, options.signal?.aborted === true);
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = this.options.mode === "direct"
      ? buildDirectUrl(this.options.llamaBaseUrl ?? "", runningForUrl, targetModel)
      : `${this.options.client.baseUrl}/api/v1/proxy/llama/v1/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json", ...attributionHeaders() };
    if (this.options.mode === "proxy") headers.authorization = `Bearer ${this.options.token}`;
    const body = buildChatBody(options);
    body.model = targetModel;  // strict 保持原样；passthrough 可能已改写为运行中的模型
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok || response.body === null) {
      const text = await response.text().catch(() => "");
      throw new LlmError(
        `llama.cpp 请求失败: ${response.status} ${text.slice(0, 200)}`,
        response.status === 401 ? "AUTH" : "PROVIDER_HTTP_ERROR",
        { status: response.status },
      );
    }
    yield* translateOpenAiSse(response.body);
  }
}

function mapEnsureError(error: unknown, signalAborted: boolean): Error {
  if (signalAborted) return new DOMException("切换等待被取消", "AbortError");  // 运行时据此归类 aborted
  const code = (error as { code?: string }).code;
  if (code === "MODEL_NOT_FOUND" || code === "MODEL_FILES_MISSING" || code === "AUTH"
    || code === "PANEL_UNREACHABLE" || code === "START_TIMEOUT" || code === "ABORTED"
    || code === "MODEL_NOT_RUNNING" || code === "MODEL_NOT_READY"
    || code === "RUNTIME_BUSY" || code === "START_REJECTED") {
    return new LlmError((error as Error).message, code);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * direct 模式的请求地址：主机名固定取 llamaBaseUrl，端口按目标模型当前的 hostPort 动态拼接。
 * 拿不到 hostPort（未知运行态 / 运行的不是目标模型）时原样回落到静态 llamaBaseUrl——
 * 这也是 auto-switch 切到 host_port 不同的模型时不再指向旧容器的关键：port 永远读自
 * 「即将请求的这个模型」当前的运行态，而不是构造适配器时写死的那一个。
 */
function buildDirectUrl(llamaBaseUrl: string, running: PanelRuntimeStatus["running"], targetModel: string): string {
  // 面板在模型行已被删时会给 hostPort: null，用 == null 一并挡掉 null 与缺席
  const hostPort = running?.model === targetModel ? running.hostPort : undefined;
  if (hostPort == null) return `${llamaBaseUrl}/v1/chat/completions`;
  try {
    const parsed = new URL(llamaBaseUrl);
    parsed.port = String(hostPort);
    // 用 href 而非 origin：llamaBaseUrl 带路径前缀（反代场景）时 origin 会把它吞掉，
    // 变成静默改写请求路径——只换端口，其余原样保留
    return `${parsed.href.replace(/\/+$/, "")}/v1/chat/completions`;
  } catch {
    return `${llamaBaseUrl}/v1/chat/completions`;
  }
}

/**
 * 面板模型行 → 选择器展示文案。`LlmModelInfo` 没有状态位（见类型定义），状态只能
 * 编码进 name/description 的文本里，抽成纯函数便于单测覆盖 4 种 status 而不必绕经
 * listModels 的网络往返。
 * - running：name 前加 ● 前缀（不用空格占位对齐，选择器变宽字体对不齐更乱）
 * - missing-file / missing-mmproj：description 末尾按既有的 " · " 分隔追加提示——
 *   选中这类模型必然在启动时 422，提前标出来省一次踩坑
 * - configStale：运行中且启动后配置又被保存过——容器参数不热更新，description 末尾提示需重启
 * - ready：不加任何标记
 */
export function describeModel(m: PanelModelView): { name: string; description: string } {
  const baseName = m.displayName || m.name;
  const name = m.status === "running" ? `● ${baseName}` : baseName;
  const baseDescription = `${m.namespace}${m.quant ? ` · ${m.quant}` : ""}`;
  // 三种提示互斥且有优先级：缺件是"起都起不来"，最要紧；configStale 只在 running 时
  // 由面板置真，与缺件天然不同时出现，放末位不会被吃掉
  const suffix = m.status === "missing-file" ? " · 文件缺失（面板文件页可自动寻找）"
    : m.status === "missing-mmproj" ? " · mmproj 缺失（面板文件页可自动寻找）"
    : m.configStale === true ? " · 配置已改，重启后生效"
    : "";
  return { name, description: `${baseDescription}${suffix}` };
}

/**
 * 从 llamapad 配置对象读 ctx_size。两个来源共用本函数：`/effective` 的 merged（全局默认
 * 与模型覆盖合并后的权威值）与模型级 overrides（`/effective` 不可用时的回退来源）——
 * 两者是同一套 `{ docker?, server? }` 两段结构，读法完全一致；「哪个来源更权威」由调用方
 * （resolveModel）选定后再交给本函数，不是本函数的职责。
 */
function readCtxSize(config: unknown): number | undefined {
  if (config === null || typeof config !== "object") return undefined;
  // docker.args_override 一旦设置（非空数组），llama-server 的生成参数整段被取代，
  // server.* 全段（含 ctx_size）不再生效——此时 ctx_size 已经不是权威值，宁可不报
  // 也不能报一个已经失效的数字。
  const docker = (config as { docker?: unknown }).docker;
  if (docker !== null && typeof docker === "object") {
    const argsOverride = (docker as { args_override?: unknown }).args_override;
    if (Array.isArray(argsOverride) && argsOverride.length > 0) return undefined;
  }
  const server = (config as { server?: { ctx_size?: unknown } }).server;
  if (server === null || typeof server !== "object") return undefined;
  const ctx = (server as { ctx_size?: unknown }).ctx_size;
  return typeof ctx === "number" && ctx > 0 ? ctx : undefined;
}
