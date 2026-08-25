# dsh 插件调研归档（2026-08-24）

> 结论先行：A 形态（LLM 适配器）完全可行，llamapad 侧**零改动**；等待期不能注入提示文本（会成为
> 历史上下文的一部分，且协议无旁路通道），采用静默等待；dsh 内嵌控制面板可行但成本高，列为后续里程碑。

## 1. DeepSeek Harness（dsh）是什么

- DeepSeek 开源的 Agent Harness（`deepseek-ai/deepseek-harness`，MIT，v0.1 技术预览，TypeScript）
- 口号 "Everything is a Plugin"：模型、工具、技能、会话、沙箱、存储全部是插件，基于 Cordis 插件框架（Koishi 生态同源）
- Web UI 跑在 `http://127.0.0.1:3080`，开发期插件用 `pnpm dsh web --patch ./cordis.yml` 以**绝对路径加载 TS 源码**，无需构建发布
- 文档：https://deepseek-harness.github.io/deepseek-harness/

## 2. 插件机制（已核实，来自 develop/basic 与实践文档）

- 插件 = 导出 `apply(ctx, config)` 的 TS 模块；`export const name`、`export const inject = ['llm']` 声明依赖
- 配置用 schemastery `Schema.object({...})` 声明；密钥走 `cordis.yml` 里 `!!js process.env.XXX` 注入
- `ctx` 上注册的一切（事件、工具、定时器）随插件卸载自动清理；手动清理用 `ctx.effect(() => () => {...})`

## 3. LLM 适配器契约（已读 npm 包 `@deepseek-ai/dsh-llm@0.0.1-rc.1` 的 .d.ts，真实签名）

```ts
export declare abstract class LlmAdapter {
  providerInfo(provider: string): LlmProviderInfo;            // { id, name }，id 必须等于 provider
  providerRetryPolicy(provider: string): ResolvedRetryPolicy | undefined;
  listModels(provider: string): Promise<readonly LlmModelInfo[]>;   // 目录是建议性的，不挡路由
  resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
  abstract stream(options: GenerateOptions): AsyncIterable<StreamChunk>;  // 唯一必须实现
}
// 注册：ctx.llm.registerAdapter(['llamapad'], adapter)（多路由原子注册，重复路由抛 DUPLICATE_ADAPTER）
```

关键事实：

- **模型选择是按调用时的**：`options.provider` 选适配器，`options.model` 是适配器自有 ID，无需启动时注册模型清单 → 完美映射 llamapad 模型名
- `GenerateOptions`：`{ provider, model, reasoningEffort?, messages, system?, tools?, temperature?, maxTokens?, stop?, signal?, sessionId?, purpose? }`
- `Message`：`{ id, role: 'system'|'user'|'assistant', content: ContentBlock[], source }`；**工具结果是以 user 角色、`ToolResultBlock` 内容块出现的**（映射 OpenAI `role:"tool"` 时要拆开）
- `LlmResolvedModelInfo.context = { contextWindow: number }`（token 数）
- `StreamChunk` 是**封闭的 7 元判别联合**：`block-start` / `text-delta` / `reasoning-delta` / `tool-call-delta` / `block-end` / `usage` / `finish`；顺序约束：usage 在 finish 前、finish 必须最后、每个 block-start 必有配对 block-end、index 按流中首次出现分配
- 错误两条路：`stream()` 内 throw `LlmError(message, code)`（稳定机器码，如 `PROVIDER_HTTP_ERROR`）；服务层会把 throw 归一化为终态 error/aborted finish。空响应有专门码 `EMPTY_RESPONSE`（export 自包根）
- 每个对 provider 的 HTTP 请求必须合并 `attributionHeaders()`（user-agent 标识）并透传 `options.signal`
- `usage` 计数是**不相交**语义：`inputTokens` 只算未缓存输入；llama.cpp 的 `prompt_tokens` 含缓存命中，无法拆分——v1 直接映射，M4 真机校准
- 包是 ESM（`"type": "module"`），`CallId` 等 brand 构造器从包根/`./brand` 导出
- 参考实现：仓库内 `packages/llm/llm-deepseek`（OpenAI 兼容 + eventsource-parser）

## 4. llamapad 对接面（已核对代码，无需改动）

| 能力 | API | 备注 |
|---|---|---|
| 列模型 | `GET /api/v1/models` → `{ models: ModelView[] }` | ModelView：`{ name, displayName, namespace, quant, sizeBytes, hostPort, status, ... }` |
| 单模型详情 | `GET /api/v1/models/:name` | overrides（含 ctx_size）从这里读 |
| 启动（自动停旧） | `POST /api/v1/models/:name/start` | 404 不存在 / 422 文件缺失 / 401 未授权 |
| 运行状态 | `GET /api/v1/runtime/status` | `{ running: { model, hostPort, ... } \| null }` |
| 就绪探测 | `GET /api/v1/proxy/llama/health`（带鉴权） | llama.cpp 加载中返回 503，就绪 200 |
| 推理数据面 | `POST /api/v1/proxy/llama/v1/chat/completions`（带鉴权） | SSE 流式反代，M3 已验证 |
| 鉴权 | `Authorization: Bearer lp_xxx` | API token，sha256 落库 |

- 单模型语义：start 接口自带「停旧起新」——**切换原语在 llamapad 侧已经存在**
- 反代通道意味着远程拓扑（dsh 与 GPU 服务器不在同一机器）下，llama.cpp 端口无需对外暴露

## 5. 等待期 UX 评估：注入 vs 转圈（用户问题的结论）

**结论：不注入，静默等待（dsh 界面自然显示加载状态）。**

依据（来自 llm-streaming 子系统文档 + 包内类型）：

1. `StreamChunk` 是封闭联合，**没有任何 status/ping/comment/telemetry 旁路通道**——想让用户看到字，唯一的产出物就是 text/reasoning 块
2. 所有 text 块经 `BlockAssembler` 折叠为 `ContentBlock[]`，`message()` 生成**冻结的 assistant 消息进入会话历史**——注入的「正在切换到 xxx」会成为模型自己在后续轮次里看到的"自己说过的话"，污染上下文且无法回收（截断规则只丢工具调用，text 块会保留）
3. reasoning 块同样入历史（`ReasoningBlock`），不能当提示通道用

唯一的非内容块是 `usage` / `finish`，都不携带用户可读文本。因此在协议层面**不存在**不影响上下文的注入方式。

## 6. dsh 内嵌控制面板（用户第 6 点）可行性

三条 UI 扩展路径（已读 cookbook）：

1. **settings 卡片**（`settings.plugin.item` 键控槽位）：Host 侧 `installSettingsSection` + 浏览器侧注册卡片，配置读写走 `ctx.settingsScope`——适合放 endpoint/token 配置卡
2. **会话节点**（`conversation.chat.node` 槽位）：持久化事件族 + Assembler + React 组件——适合展示流程状态，不适合做控制面板
3. **client modules**：`package.json` 声明 `dsh.client` 字段 + `./client` 导出，产物必须是 loader lazy-CJS 工厂格式

限制（重要）：

- 官方 tsdown 预设**未发布**，外部仓库要自己复刻产物格式（README known-limitations）
- 浏览器侧 ↔ Host 侧的 RPC 通道文档未展开（`connection`/`remote` 服务仅在 inject 列表出现）
- 浏览器直连 llamapad API 需要 llamapad 加 CORS 支持（目前没有）

**分期决策**：v0 不做 UI；后续里程碑先做「配置卡 + 打开 llamapad 面板链接」（低风险），再评估实时启停卡片（需 dsh 仓库检出 + 产物格式调研，或给 llamapad 加 CORS 让浏览器直连）。

## 7. npm 可用性（已验证）

`@deepseek-ai/cordis@4.0.1`、`@deepseek-ai/dsh-llm@0.0.1-rc.1`、`@deepseek-ai/dsh-tools@0.0.1-rc.1`、
`@deepseek-ai/dsh-settings@0.0.1-rc.1`、`@deepseek-ai/schemastery@3.18.1` 均已发布 npm。dsh-* 是 rc 版本，**钉精确版本**。

## 8. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| dsh v0.1 技术预览，API 可能变动 | 升级破坏 | 依赖钉精确版本；适配层薄 |
| llama.cpp usage/tool-call 流式细节与假设不符 | 翻译层 bug | Mac 假服务器 E2E 覆盖协议形状；M4 真机校准 |
| `reasoning_content`（DeepSeek 系 think 输出）处理 | 推理块呈现 | 翻译层已按 reasoning-delta 映射；M4 验证 `--reasoning-format` 行为（llamapad 挂账项） |
| 切换期间大模型加载 1-2 分钟 | 首 token 延迟 | 物理约束；静默等待 + 超时可配 |
| 多会话并发用不同模型 | 单模型运行时反复切换 | 插件内串行门 + 同目标合流 |
