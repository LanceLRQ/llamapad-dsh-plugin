# 2026-09-03 方案：多模态输入 · GPU 监控页 · 事件驱动 · 提示词快照

第三批功能的设计方案。范围与结论：

| # | 功能 | 一句话 | 依赖升级 | llamapad 改动 |
|---|---|---|---|---|
| F1 | 提示词快照（混合路由） | 把本地模型场状态注入系统提示，云端模型可感知并调度本地 GPU | 补钉 `dsh-system-prompt` | **无**（只读既有端点） |
| F2 | 多模态输入 | dsh 聊天贴图 → ImageBlock 转 image_url 发给配了 mmproj 的模型 | 补钉 `dsh-attachment` | **无**（`ModelView.mmprojFile` 已在线上契约） |
| F3 | GPU 监控页 | settings.section 整页：tokens/s 曲线 + 显存/温度/功耗，14 天历史 | 无 | **无**（metrics/gpu 端点既有） |
| F4 | 事件驱动刷新 | host 侧 SSE 替代轮询；崩溃/下载完成进卡片事件流 | 无 | **无**（events/stream 既有） |

另附快赢清单评估（§5）。**全部功能 llamapad 侧零改动**——四个功能只消费既有只读端点，
无需在开发机上动面板代码。

所有框架能力均已在本仓库 `node_modules` 的类型层核实（不是猜的）；仅存的两个运行期
不确定点单独列出（§10 风险表 R1/R2）。

---

## F1 提示词快照：让云端模型看见本地模型场

### 动机

B 形态工具是被动问答——模型不知道本地有什么就不会问。把「正在跑什么 / 还能起什么」
作为系统提示的一个分节主动注入后，任何 provider 的模型（包括云端 DeepSeek API）都能
感知本地算力：自行判断把翻译/摘要类任务引导到本地模型，或直接调 `llamapad_start_model`
拉起目标模型。「云端大脑 + 本地算力」的混合路由。

### 依据（已核实）

`@deepseek-ai/dsh-system-prompt@0.1.1-rc.2`（宿主 `dsh-agent` 的依赖，本仓库 pnpm store
里已有实例——即宿主组合在运行时提供 `ctx.systemPrompt` 服务）：

```ts
// lib/types/index.d.ts
export interface PromptSection {
  readonly name: string;      // 唯一，重复注册抛错
  readonly order: number;     // 升序拼接；约定 -100=harness identity、0=persona、100-199=tool guidance
  readonly text: string | ((context: AssembleContext) => string);  // 函数形式：每次组装求值
  readonly complete?: boolean;
}
// SystemPrompt（Service，ctx key: systemPrompt）
section(section: PromptSection): () => void;   // 返回 Cordis effect disposer
```

关键性质：`text` 支持函数形式、**每次组装时同步求值**——注册一次即可永远反映最新状态，
不用反复注销重注；`renderPrompt` 会丢弃空 section，所以「无缓存时返回空串」等价于该
分节不存在，天然降级。

### 设计

1. **补钉依赖**：`@deepseek-ai/dsh-system-prompt@0.1.1-rc.2` 进 dependencies（与
   `dsh-llm` 同代；见 §6 版本说明）。
2. **注册**（`index.ts`）：
   ```ts
   ctx.inject(["systemPrompt"], (sctx) =>
     sctx.systemPrompt.section({
       name: "llamapad:local-fleet",
       order: 50,              // persona(0) 之后、tool guidance(100-199) 之前
       text: () => renderFleetSnapshot(fleetCache),
     }),
   );
   ```
   动态 inject 而非静态写进插件 `inject` 数组：服务缺席时只是这个功能不生效，插件本体
   （适配器、卡片）照常加载——与现有 `ctx.inject(["typert"], ...)` 同一防御模式。
3. **状态缓存** `fleetCache`：内存对象 `{ running, models, fetchedAt }`，由 F4 的
   status-watch 在每次状态探测后顺手写入（SSE 事件触发的即时探测 + 兜底轮询共用一条
   写入路径）。text 求值是同步的，缓存必须同步可读——不在线时返回 `""`。
   F4 未实施前，由现有 `directory-refresh.ts` 的轮询回路代填（改动一行级别）。
4. **快照渲染** `renderFleetSnapshot(cache): string`（纯函数，单测主战场）：
   - 语言用英文（消费方是模型，与 harness identity 一致）
   - 内容：running model（name/quant/contextWindow）+ 可启动清单（name/quant，至多
     20 条 + `… and N more`）+ 一句 *"Local models are managed by llamapad; the
     llamapad_* tools may be available to start/stop them."*（B 形态没挂时这句话也成立
     ——"may be available"，不撒谎）
   - 面板不可达 / 未配置 → 空串（section 自动消失）
5. **配置**：`statusPromptSection: boolean`，默认 `true`。关闭即整段不注册。

### 边界与决策

- 快照会进入**所有 provider** 的会话系统提示（包括云端模型）——这正是功能目的，但要在
  README 里加一条隐私提示：模型名与量化信息会上行给该会话使用的远端 provider。
- 不用 `systemPrompt.context()`（动态上下文快照进 user 历史）：那会在每轮历史里落一份，
  逐渐膨胀；section 是「始终当前」的单份事实，语义更贴。
- 不碰 `system-prompt/assemble` waterfall——那是专家级整体改写通道，我们只是贡献一个
  分节，用注册 API 就够。

### 工作量

约 1 天（含单测）。依赖 F4 的缓存回路（或先用轮询回路顶上）。

---

## F2 多模态输入：贴图聊天

### 动机与现状缺口

`src/openai-wire.ts` 的 `mapMessage` 对 `ImageBlock` 是**静默忽略**（`renderToolResult`
注释原文承认了这一点）——用户在 dsh 里贴图，适配器默默丢掉，模型只收到文字。而
llamapad 配了 mmproj 的模型（Qwen-VL 类）本来就能吃 OpenAI 格式的 `image_url`。
这是修缺陷 + 开新能力二合一。

### 依据（已核实）

- dsh-llm 侧：图片以 `ImageBlock { type: 'image'; attachment: ImageAttachmentRef }`
  出现在 `GenerateOptions.messages[n].content` 数组里（`dsh-llm/lib/types/types.d.ts`，
  `GenerateOptions` 本身无 image 字段）；`LlmModelInfo.inputModalities?: readonly
  ('text'|'image')[]`，缺省 = 不可知，显式列出 = 能力声明。
- dsh-attachment 侧：`ctx.attachments`（`AttachmentStore` 服务）的
  `readImage(ref) → { ref, data: Uint8Array }`；`ImageAttachmentRef` 含
  `mediaType: 'image/png'|'image/jpeg'|'image/webp'|'image/gif'`。图片字节与引用分离，
  由宿主的 attachment 服务统一持有——适配器拿 ref 去换字节。
- llamapad 侧：`ModelView.mmprojFile: string | null`（`src/server/modelsView.ts:39`，
  「配置了 mmproj 时为其相对路径，否则 null」）——**模型列表直接暴露 mmproj 配置**，
  选择器门控零额外请求。模型详情 `GET /api/v1/models/:name` 同样含 mmproj 信息
  （实现时以 route.ts 实际字段名为准核对，预计 `mmproj_file` snake_case）。
- llama.cpp 侧：OpenAI 兼容端点接受
  `content: [{type:'text'},{type:'image_url', image_url:{url:'data:<mime>;base64,…'}}]`，
  mmproj 由面板启动参数注入，proxy/direct 两模式都原生支持（direct 不经过面板改写层，
  与思考强度的情况不同，没有 jinja 兜底问题）。

### 设计

1. **补钉依赖**：`@deepseek-ai/dsh-attachment@0.1.1-rc.2` 进 dependencies。当前
   node_modules 里解析到 0.0.1-rc.1 是没钉 peerDep 的漂移结果（`dsh-llm` 的
   peerDependencies 声明的是 `^0.1.1-rc.2`），见 §6。
2. **投影扩展**（`panel-client.ts`）：`PanelModelView` 加 `mmprojFile?: string | null`
   （老面板缺席 = undefined = 不可知）；`PanelModelDetail` 同理；listModels 的响应
   映射补 `mmprojFile: row.mmprojFile ?? null`。
3. **能力门控**（`adapter.ts` 纯函数 `inputModalitiesFor(view)`）：
   - `mmprojFile` 非空且 `status !== 'missing-mmproj'` → `['text','image']`
   - `mmprojFile` 非空但文件缺失（起不来，422 命运）或明确为 null → `['text']`
   - 字段缺席（老面板，不可知）→ 省略 `inputModalities`（不冒充 text-only，也不冒充
     vision——留给 resolveModel 的精确值兜底）
   - `listModels` 与 `resolveModel` 都按此上报（resolveModel 用 detail 的 mmproj 信息）。
4. **图片读取通道**（`LlamapadAdapterOptions` 加可选字段，沿用 fetchImpl 的注入模式）：
   ```ts
   readImage?: (ref: ImageAttachmentRef) => Promise<{ data: Uint8Array; mediaType: string } | null>;
   ```
   `index.ts` 提供实现：`ctx.get("attachments")` 机会式取服务（不能用静态 inject——
   服务缺席会阻塞整个插件启动），取不到或读失败返回 `null`。降级：`null` 时该图片
   变为文本占位 `"[image attachment unavailable]"`（对齐 dsh 自己的
   OFFLOADED_IMAGE_TEXT 思路——显式可调试，优于静默丢）。
5. **wire 组装**（`openai-wire.ts`，保持纯函数可测）：
   - 新增 `collectImages(options): ImageBlock[]` + 预解析步骤：adapter.stream 在
     buildChatBody 之前并行 `readImage` 全部 ImageBlock，得到
     `Map<ImageAttachmentRef, string /* data URL */>`
   - `buildChatBody(options, resolved)`：user 消息含图时 content 从 string 切换为数组
     形态（text 块 + 按序 image_url 块）；纯文本消息保持 string（少字节）
   - `renderToolResult` 内的 image → 同样的占位文本（现状是忽略，改为显式占位）
   - base64 编码用 Node 侧 `Buffer`（host 进程运行）
6. **测试**：单测——门控三态、含图 wire 体、占位降级、多图顺序；E2E——假面板断言
   收到的请求体里 `image_url` 的 data URL 前缀正确。

### 边界

- 图片体积：base64 膨胀 4/3，入参上限由宿主 attachment 服务的 imageLimits 在保存时
  已控（本插件不在 stream 里二次限制，避免与宿主策略漂移）。
- GIF 的 llama.cpp 解码支持真机验证（R2）；失败会以 llama.cpp 的 4xx 显式报错，不是
  静默行为。
- 不做输出侧多模态（llama.cpp 无图像生成），仅输入。

### 工作量

约 1.5 天。

---

## F3 GPU 监控页

### 动机

面板的 metrics 体系统白送：16 个指标、30m/2h 窗口 5 秒分辨率、24h/7d 15 分钟聚合、
**14 天历史**；`/gpu/stats` 另有分卡明细含温度与功耗（不进时序，只在即时快照）。
dsh 侧 `settings.section` 是整页 slot，比插件卡片空间大一个量级。聊天时盯 tokens/s
爬坡、查「上次跑 R1 显存峰值」都是现成数据。

### 依据（已核实）

- 面板端点（api.md + 服务层源码双重核实）：
  - `GET /api/v1/metrics/window?range=30m|2h|24h|7d&since=<ts>` →
    `{ range, from, resolution, series: { [metricId]: [{ts,value}] }, mode: "full"|"delta" }`；
    带 `since` 走增量模式只回新点——持续采集省流量
  - `GET /api/v1/gpu/stats` → `{ available, status, devices: [{index, memUsedMib,
    memTotalMib, utilPercent, tempC, powerW}], totals }`
- dsh 端 slot 契约（`dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`）：
  ```ts
  'settings.section': { kind: 'list'; scope: 'root'; owner: SettingsSectionOwnerProps /* {close} */ };
  ```
  JSDoc 明确：**一个 list 条目 = 一页设置页，导航条目由注册 options 携带**
  （`id` 驱动过滤、`order` 定位、`label` 本地化文案），宿主 shell 自动渲染导航——
  注册即出现，无需其他接线。
- `dsh-client-ui-primitives` **没有任何图表组件**（导出清单核实）——曲线自绘 SVG，
  零新依赖。

### 设计

1. **panel-client 扩展**：
   ```ts
   getMetricsWindow(range: "30m"|"2h"|"24h"|"7d", since?: number): Promise<PanelMetricsWindow>;
   getGpuStats(): Promise<PanelGpuStats>;
   ```
   投影类型只声明要画的指标（`infer.tokens_per_sec`、`infer.kv_cache_tokens`、
   `gpu.mem_used_mib`、`gpu.util_percent`、`container.cpu_percent`、
   `container.mem_percent`），series 键缺席容忍（面板加指标/减指标不炸）。
2. **RPC**（沿用 rpc-contract.ts 手写 strict codec 模式）：新方法
   `monitor(range, since)` → `MonitorSnapshot { series, gpu, serverTs, mode, panelError }`；
   host 侧 gateway 实现：metrics 窗口 + gpu/stats 并发 `allSettled`，失败语义沿用
   `panelError`（不抛错，页面要能画「连不上」）。**该方法描述符直接带
   `cancellation: { parameter: 'signal' }`**（快赢 Q3 在这里一并落地）：切页/切 range
   时浏览器取消在途请求，监控数据 24h/7d 窗口可能较大，取消有意义。
3. **client**：
   - `src/client/MonitorPage.tsx`：顶部 range 切换（30m/2h/24h/7d）+ 运行中模型标题行
     （含 phase）；主体三张卡：tokens/s 与 KV cache（推理）、GPU 显存与利用率（曲线）
     + 分卡明细（温度/功耗即时值）；容器 CPU/内存小卡
   - `src/client/Sparkline.tsx`：纯 SVG 折线（viewBox 自适应、末点高亮、hover 数值可
     后续再加，首版不做交互）
   - 注册（现有 inject scope 内追加）：
     ```ts
     inner.slots.register(
       { name: "settings.section", id: "llamapad-monitor", order: 60,
         label: /* locale */, locale: LOCALE_NS, inject: () => ({ api }) },
       MonitorPage,
     );
     ```
     `order: 60` 排在官方设置页之后（官方 general/appearance 等惯例低值段）。
   - 轮询：组件挂载起 `setInterval`（5s，匹配 30m/2h 的 5s 分辨率；24h/7d 档降到 60s），
     首帧 full、后续带 `since` 走 delta 增量拼接；卸载 clearInterval + abort 在途。
4. **卡片联动**：不做（设置导航里已有独立入口，卡片保持克制）。

### 边界

- 无模型在跑时 metrics 大多为空序列——页面显示「无运行容器」空态 + GPU 分卡仍可用
  （host 级指标照画）。
- `gpu.stats.status: "unavailable"`（纯 CPU 机器）→ GPU 卡整体隐藏。
- 曲线数据点上限：7d@15min ≈ 672 点/指标，SVG 一次 path 无压力。

### 工作量

约 2~3 天（客户端为主）。

---

## F4 事件驱动刷新与通知

### 动机

现状 `directory-refresh.ts` 每 5s 轮询 runtime/status。面板有现成 SSE
`GET /api/v1/events/stream`（snapshot 对齐 + 每 2s 增量 + 15s 心跳），且事件里有两个
高价值信号：**`model.exit`（容器异常退出）**、`download.complete`。host 侧换 SSE 后：
状态刷新从「最坏 5s 延迟」变「事件即达」，卡片还能显示最近事件流（崩溃红色标注）。

### 依据（已核实）

- 面板：`GET /api/v1/events/stream`（SSE，需 Authorization 头——浏览器 EventSource
  不支持自定义头，但 host 侧 `fetch` + ReadableStream 解析没问题）；连接即发
  `{type:"snapshot", events:[最近20条]}`，此后 `{type:"event", id, ts, kind, message}`；
  **不支持 Last-Event-ID 重放**（重连靠 snapshot 对齐 + id 去重）；事件 kind 全集见
  面板 `src/server/eventsStream.ts`（model.start/stop/start_failed/**exit**/update/
  delete/move、download.*、auth.*、config.*）。`message` 是人类可读中文，非结构化
  payload——展示直接用，不做解析。
- dsh：host→浏览器事件推送白名单是宿主装配常量（`API_REMOTE_FORWARDED_EVENTS`，
  `dsh-api-remotes`），**第三方不可运行时扩展**（转发循环只遍历宿主数组）——所以
  浏览器侧维持现有 snapshot 拉取模式，host 侧才是 SSE 的消费方。卡片本就有轮询
  （Card.tsx setInterval），事件数据搭 snapshot 顺风车下发。

### 设计

1. **panel-client**：新增 `streamEvents({ signal, onEvent }): () => void`——长连接
   fetch（**不带**现有 request() 的 AbortSignal.timeout 超时，SSE 是常驻连接）、逐行
   解析 SSE 帧、JSON 解析 snapshot/event 两型、导出停止函数。
2. **新模块 `status-watch.ts`**（吸收并最终替代 `directory-refresh.ts`）：
   - SSE 常连 + 指数退避重连（2s/5s/15s 封顶），dispose 跟随插件 fiber
   - 收到 `model.*` 前缀事件 → 立即 `runtimeStatus()` diff → 变化则
     `ctx.emit("llm/adapters-updated")`（复用现有语义与浏览器侧重拉链路）；顺带写
     `fleetCache`（F1 的数据源）
   - 事件入环：最近 8 条存内存 ring，供 gateway snapshot 下发
   - **兜底降级**：SSE 连续失败 3 次（老面板没有该端点 / 网络差）→ 回退到现有定时
     轮询（`statusRefreshMs` 语义不变）；SSE 恢复后停掉定时器
   - `statusRefreshMs: 0` 语义保留为「完全不启动」——**SSE 也不连**（0 的含义是
     「不打扰面板」，常驻 SSE 连接违背该含义）
3. **gateway / 卡片**：`CardSnapshot` 增加 `events: CardEvent[]`（`{id, ts, kind,
   message}`，来自内存 ring，不额外打面板）；卡片底部「最近事件」列表——`model.exit`
   红色、`download.complete` 绿色轻着色，其余中性；轮询间隔内发现新事件 id → Toast
   （组件级，primatives 的 Toast，卡片作用域内挂载）。
4. **（建议纳入）B 形态第 5 个工具 `llamapad_events`**：`GET /api/v1/events?limit=&kind=`
   的只读包装，参数 `limit`（默认 20 上限 100）+ `kind` 精确过滤。给 agent 排障用
   （「模型为什么停了」一问即答），与既有四工具同风格。成本约半天。

### 边界

- 面板没有「推理开始/结束」事件——`inferring` 状态仍靠现有 busy 探测，不变。
- 通知可见范围 = 设置页打开时（Toast 在卡片内）。这是插件 slot 能力的诚实边界，
  不为此上 shell.overlay（宿主声明未见，属未验证能力）。

### 工作量

约 2 天（含 `llamapad_events` 工具约 0.5 天）。

---

## 5. 快赢清单评估（半天级）

| # | 项 | 结论 | 说明 |
|---|---|---|---|
| Q1 | `isConcurrencySafe` × 4 工具 | ✅ 半小时 | 四工具只读或经共享门串行，全部标 true，框架即可并行派发读操作 |
| Q2 | `presentResult` 渲染卡 | ✅ 半天，收益中等 | `llamapad_status` → terminal 卡（`{card:'terminal', title, output, exitCode:0}`，command 字段作展示占位）；`llamapad_list_models` **保持 generic**——search paths 卡语义是文件路径列表，硬套模型列表是误用；start/stop 加 `presentCall` title |
| Q3 | RPC signal 取消 | ✅ 半天 | `descriptor.cancellation = {parameter:'signal'}`（类型核实），gateway start/stop 加末位 `signal?: AbortSignal` 传给 `gate.ensure`；卡片启动按钮挂 AbortController 提供「取消等待」。与 F3 的 monitor RPC 一并落地 |
| Q4 | `providerRetryPolicy` | ⚠️ 本轮不做 | 类型已核实（`{mode:'normal', maxRetries, retryableCodes, backoff}`），但「流已部分输出后框架是否还会重试」语义未知，盲开有重复输出风险。列入待办：真机验证语义后再开，默认 undefined（框架默认） |
| Q5 | `tools/pre-execute` 审批门 | ✅ 1 小时 | B 形态 Config 加 `toolApproval: 'allow'|'ask'` 默认 allow；ask 时对 `llamapad_start_model`/`llamapad_stop_model` 返回 `{kind:'ask', reason}`。注意框架语义：宿主无 approval 通道时 ask 会折算成 deny——README 注明 |
| Q6 | `ctx.logger` 替换 console.warn | ✅ 顺手 | 与任一里程碑同行 |

## 6. 依赖与版本策略

- **新增钉版**（dependencies，精确版本，与 `dsh-llm` 0.1.1-rc.2 同代）：
  - `@deepseek-ai/dsh-attachment@0.1.1-rc.2` —— F2 需要（当前 0.0.1-rc.1 是未钉
    peerDep 的漂移解析，`dsh-llm` 声明的 peer 范围是 `^0.1.1-rc.2`，本就该钉）
  - `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2` —— F1 需要
  - 两包均已在宿主安装树（pnpm store 有实例），补钉只是把「碰巧存在」变成「契约保证」，
    不会引入第二份框架
- `dsh.client.inject` 无需变化（监控页用的 slots/remote/locale 已声明）
- 构建约束不变：产物不 minify（SRC 形参名推导依赖，见 rpc-contract.ts 头注释）；
  新增文件全部走既有 esbuild 管线

## 7. 实施顺序

```
M1 快赢包（Q1/Q2/Q3/Q5/Q6，~1 天）
M2 F2 多模态（~1.5 天）——独立，价值最高
M3 F4 事件驱动（~2 天）——fleetCache 与降级回路是 F1 的地基
M4 F3 监控页（~2.5 天）——纯增量，随时可插队
M5 F1 提示词快照（~1 天）——消费 M3 的缓存
```

每个里程碑独立成一版 minor release（0.x 语义），单独可回滚。实施前按仓库惯例先把
本方案细化成 `docs/plans/` 的 micro-step 计划再动工。

## 8. 测试与验收

- **单测**：`inputModalitiesFor` 三态门控；含图 wire 组装（假 readImage）；占位降级；
  `renderFleetSnapshot`（空缓存/满缓存/截断）；SSE 帧解析与 id 去重；降级切换逻辑；
  monitor 投影容忍缺席键
- **E2E**（假面板）：新增 events/stream SSE 假端点（snapshot + 增量帧）、
  metrics/window、gpu/stats 假数据；断言含图请求体的 data URL 前缀；断言 SSE 事件后
  adapter 选择器刷新 emit
- **真机冒烟**：`docs/manual-smoke.md` 增补四节（贴图对话、监控页目检、拔网线触发
  SSE 降级、系统提示里看到 fleet 快照）

## 9. llamapad 侧改动

**无。** 四个功能全部消费既有只读端点（models/mmprojFile、events/stream、
metrics/window、gpu/stats），无需用户在开发机上处理任何面板改动。

## 10. 风险汇总

| # | 风险 | 等级 | 缓解 |
|---|---|---|---|
| R1 | host 进程 `ctx.attachments` 服务缺席（理论存在：宿主 web 组合必装，但未经真机确认） | 低 | `ctx.get()` 机会式获取 + 占位文本降级，功能退化为现状（丢图变显式占位），不炸 |
| R2 | llama.cpp 对 webp/gif 的解码支持差异 | 低 | 失败以 4xx 显式报错（非静默）；真机冒烟覆盖 png/jpeg，webp/gif 如实记录支持矩阵 |
| R3 | SSE 经反代（nginx）被缓冲 | 中 | 面板侧 SSE 已是既定端点（面板自己消费同款）；若用户反代缓冲导致超时，降级回路自动回轮询——行为等于现状，不会更糟 |
| R4 | fleet 快照进系统提示的信息上行（隐私） | 低 | README 隐私提示 + `statusPromptSection` 开关默认可关 |
| R5 | `settings.section` 注册后导航 label 本地化依赖重新注册机制 | 低 | 契约 JSDoc 明示「locale 切换靠注册方重新注册」，跟随现有 Card 的 locale 处理模式即可 |

## 附：核实来源索引

- `node_modules/@deepseek-ai/dsh-llm/lib/types/{types,message,content,index,retry-policy}.d.ts`
- `node_modules/@deepseek-ai/dsh-attachment/lib/types/{index,types}.d.ts`（0.0.1-rc.1，字段形状与 0.1.x 稳定面一致）
- pnpm store `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2/lib/types/index.d.ts`
- `node_modules/@deepseek-ai/dsh-tools/lib/types/{presentation,index,schema}.d.ts`
- `node_modules/@deepseek-ai/dsh-client-ui-settings/lib/types/client/contract/slots.d.ts`
- `node_modules/@deepseek-ai/dsh-typert-protocol/lib/types/types.d.ts`；store 内 `dsh-api-remotes/lib/types/remote-events.d.ts`
- `node_modules/@deepseek-ai/dsh-client-ui-primitives`（导出清单：无图表组件）
- llamapad `docs/guide/zh/api.md`、`src/server/modelsView.ts:39`、`src/core/schemas.ts:240`、`src/server/eventsStream.ts`
