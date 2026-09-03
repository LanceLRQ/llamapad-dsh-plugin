import type { ContentBlock, GenerateOptions } from "@deepseek-ai/dsh-llm";
import type { ImageAttachmentRef } from "@deepseek-ai/dsh-attachment";

/**
 * dsh GenerateOptions → llama.cpp（OpenAI 兼容）chat/completions 请求体。
 * 决策记录：assistant 历史里的 reasoning 块不回传（llama.cpp 推理内容不进后续请求）；
 * reasoning_effort 原样透传，取值改写由面板中转层负责。
 */

/** 预解析成功的一张图：原始字节 + 已验证的 media type（base64 编码留在本层做） */
export interface ResolvedImage {
  data: Uint8Array;
  mediaType: string;
}

/**
 * 预解析结果。key 用 **ref 对象引用**而非 attachmentId：
 * - collectImages 返回的就是 messages 里出现的同一批 ref 对象，buildChatBody 阶段用
 *   `block.attachment` 反查时引用恒等命中，不需要任何 id 全局唯一性假设（品牌类型本质
 *   还是 string，跨会话/跨来源的碰撞行为没有契约保证）；
 * - 同一张图贴两次（两个 ImageBlock 共享一个 ref）天然命中同一条解析结果，不多读盘。
 * value 为 null = 读取失败或服务缺席 → 该图降级为占位文本。
 */
export type ResolvedImages = Map<ImageAttachmentRef, ResolvedImage | null>;

/**
 * 图片不可用时的显式占位文本。对齐 dsh 自己的降级思路（OFFLOADED_IMAGE_TEXT）：
 * 图片读不出来时宁可给模型一段可调试的占位说明，也不静默丢块——静默丢会让
 * 「模型答非所问」在排查时完全看不出是因为图没送到。
 */
const IMAGE_UNAVAILABLE_PLACEHOLDER = "[image attachment unavailable]";

/** OpenAI 兼容多模态 content 块（llama.cpp 只认 text 与 image_url 两种） */
type OpenAiContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

interface OpenAiMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null | OpenAiContentPart[];
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
}

/**
 * 收集请求里出现的全部图片引用（user 顶层 + tool-result 嵌套 content，递归），
 * 供调用方在拼请求体之前并行预解析。同一 ref 对象去重——同一张图贴两处只读一次盘。
 * 纯函数：不读不写任何外部状态。
 */
export function collectImages(options: GenerateOptions): ImageAttachmentRef[] {
  const out: ImageAttachmentRef[] = [];
  const seen = new Set<ImageAttachmentRef>();
  const walk = (blocks: readonly ContentBlock[]): void => {
    for (const block of blocks) {
      if (block.type === "image") {
        if (!seen.has(block.attachment)) {
          seen.add(block.attachment);
          out.push(block.attachment);
        }
      } else if (block.type === "tool-result") {
        walk(block.content);
      }
    }
  };
  for (const message of options.messages) walk(message.content);
  return out;
}

/**
 * @param resolved 可选的预解析结果。缺省（undefined）时行为与图片通道落地前完全一致：
 * 没接线 readImage 的调用方（单测/编程直用）拿到的就是旧版静默忽略。
 * 传了 Map 才会走 image_url / 占位降级两条新路径。
 */
export function buildChatBody(options: GenerateOptions, resolved?: ResolvedImages): Record<string, unknown> {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: "system", content: options.system });
  for (const message of options.messages) messages.push(...mapMessage(message, resolved));
  const body: Record<string, unknown> = {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (options.tools && options.tools.length > 0) {
    body.tools = options.tools.map((tool) => ({
      type: "function",
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
  }
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.max_tokens = options.maxTokens;
  if (options.stop && options.stop.length > 0) body.stop = options.stop;
  // 思考强度：原样透传给面板中转层。面板会按该模型 chat template 的真实值域改写
  // （别名 → 值域内透传 → 就近取整 → 丢弃字段），插件不做二次判断——复刻那套算法
  // 只会与面板漂移。direct 模式没有这层保护，故在 adapter.stream 入口就拒绝了。
  if (options.reasoningEffort !== undefined) body.reasoning_effort = options.reasoningEffort;
  return body;
}

function mapMessage(message: GenerateOptions["messages"][number], resolved?: ResolvedImages): OpenAiMessage[] {
  if (message.role === "system") {
    // system 不携带图片（dsh 的图片只进 user 侧）；类型上拦不住就显式占位——
    // 与静默丢同为难解，但占位至少在排查时看得见
    const parts: string[] = [];
    for (const block of message.content) {
      if (isText(block)) parts.push(block.text);
      else if (block.type === "image") parts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
    }
    return [{ role: "system", content: parts.join("") }];
  }
  if (message.role === "assistant") {
    const textParts: string[] = [];
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    for (const block of message.content) {
      if (isText(block)) textParts.push(block.text);
      else if (block.type === "image") {
        // 实际不会发生（适配器声明 text-only 输出），防御路径同样显式占位
        textParts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
      } else if (block.type === "tool-call") {
        toolCalls.push({ id: block.id, type: "function", function: { name: block.name, arguments: block.arguments } });
      }
      // reasoning 块：跳过（见文件头决策）
    }
    return [{ role: "assistant", content: textParts.join("") || null, ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}) }];
  }
  // user：text 块合入一条 user；tool-result 块各拆一条 role:"tool"
  // （ToolResultBlock 字段以包为准：toolCallId + content: ContentBlock[]）
  const out: OpenAiMessage[] = [];
  const textParts: string[] = [];
  // 图片只有在接了预解析（resolved 存在）时才进 wire：命中的进 image_url 块，
  // null/缺键的降级占位并进 text；resolved 缺省则是旧版静默忽略（见 buildChatBody 注释）
  const imageParts: OpenAiContentPart[] = [];
  for (const block of message.content) {
    if (isText(block)) textParts.push(block.text);
    else if (block.type === "image") {
      if (resolved === undefined) continue;
      const hit = resolved.get(block.attachment);
      if (hit !== undefined && hit !== null) {
        // host 进程是 Node 环境，Buffer 可用；mediaType 用读回并存时验证过的那份
        imageParts.push({
          type: "image_url",
          image_url: { url: `data:${hit.mediaType};base64,${Buffer.from(hit.data).toString("base64")}` },
        });
      } else {
        textParts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
      }
    } else if (block.type === "tool-result") {
      out.push({ role: "tool", tool_call_id: block.toolCallId, content: renderToolResult(block.content) });
    }
  }
  if (imageParts.length > 0) {
    // 数组形态只在这一条消息真的有图进 wire 时才启用；文本（含占位）合一个块置前，
    // image_url 按出现顺序排后；原本无文本就不造空 text 块（llama.cpp 对空串块没有意义）
    const content = textParts.length > 0
      ? [{ type: "text", text: textParts.join("") } as OpenAiContentPart, ...imageParts]
      : imageParts;
    out.unshift({ role: "user", content });
  } else if (textParts.length > 0) {
    out.unshift({ role: "user", content: textParts.join("") });
  }
  return out;
}

function isText(block: ContentBlock): block is Extract<ContentBlock, { type: "text" }> {
  return block.type === "text";
}

function renderToolResult(content: ContentBlock[]): string {
  // content 恒为 ContentBlock[]（types.d.ts 核对）：拼 text 块文本。OpenAI 的 tool 通道
  // 只收 string content，图没法以 image_url 形态搭乘——降级为显式占位而非静默忽略，
  // 模型与排查者至少知道「这里本来有一张图」
  const parts: string[] = [];
  for (const block of content) {
    if (isText(block)) parts.push(block.text);
    else if (block.type === "image") parts.push(IMAGE_UNAVAILABLE_PLACEHOLDER);
  }
  return parts.join("");
}
