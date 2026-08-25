import { LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import type { GenerateOptions, LlmModelInfo, LlmProviderInfo, LlmResolvedModelInfo, StreamChunk } from "@deepseek-ai/dsh-llm";
import type { PanelClient } from "./panel-client";
import type { ModelGate } from "./switching";
import { buildChatBody } from "./openai-wire";
import { translateOpenAiSse } from "./translate";

export interface LlamapadAdapterOptions {
  client: PanelClient;
  gate: ModelGate;
  token: string;
  mode: "proxy" | "direct";
  llamaBaseUrl?: string;
  startTimeoutMs?: number;
  pollIntervalMs?: number;
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
    return models.map((m) => ({
      provider,
      id: m.name,
      name: m.displayName || m.name,
      description: `${m.namespace}${m.quant ? ` · ${m.quant}` : ""}`,
    }));
  }

  override async resolveModel(provider: string, model: string, _signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    const detail = await this.options.client.getModel(model).catch(() => null);
    const contextWindow = readCtxSize(detail?.overrides) ?? this.options.defaultContextWindow;
    return {
      provider,
      id: model,
      name: detail?.displayName || model,
      ...(contextWindow !== undefined ? { context: { contextWindow } } : {}),
      // reasoning 刻意省略：llama.cpp 无 reasoning-effort 控制（契约：省略 = 无此能力）
    };
  }

  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.reasoningEffort !== undefined) {
      throw new LlmError("llamapad/llama.cpp 不支持 reasoning effort 控制", "UNSUPPORTED");
    }
    try {
      await this.options.gate.ensure(options.model, {
        ...(options.signal ? { signal: options.signal } : {}),
        ...(this.options.startTimeoutMs !== undefined ? { timeoutMs: this.options.startTimeoutMs } : {}),
        ...(this.options.pollIntervalMs !== undefined ? { pollIntervalMs: this.options.pollIntervalMs } : {}),
      });
    } catch (error) {
      throw mapEnsureError(error, options.signal?.aborted === true);
    }
    const doFetch = this.options.fetchImpl ?? fetch;
    const url = this.options.mode === "direct"
      ? `${this.options.llamaBaseUrl}/v1/chat/completions`
      : `${this.options.client.baseUrl}/api/v1/proxy/llama/v1/chat/completions`;
    const headers: Record<string, string> = { "content-type": "application/json", ...attributionHeaders() };
    if (this.options.mode === "proxy") headers.authorization = `Bearer ${this.options.token}`;
    const response = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(buildChatBody(options)),
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
    || code === "PANEL_UNREACHABLE" || code === "START_TIMEOUT" || code === "ABORTED") {
    return new LlmError((error as Error).message, code);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function readCtxSize(overrides: unknown): number | undefined {
  // llamapad overrides JSON：{ server?: { ctx_size?: number }, docker?: {...} }
  if (overrides === null || typeof overrides !== "object") return undefined;
  const server = (overrides as { server?: { ctx_size?: unknown } }).server;
  if (server === null || typeof server !== "object") return undefined;
  const ctx = (server as { ctx_size?: unknown }).ctx_size;
  return typeof ctx === "number" && ctx > 0 ? ctx : undefined;
}
