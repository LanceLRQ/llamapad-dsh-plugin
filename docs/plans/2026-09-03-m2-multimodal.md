# M2 多模态输入：micro-step 计划（2026-09-03）

依据：[2026-09-03 方案](../design/2026-09-03-multimodal-monitor-events-prompt.md) F2。
两个任务，一任务一提交。TDD。

## Task 1 mmproj 能力门控

1. 补钉依赖 `@deepseek-ai/dsh-attachment@0.1.1-rc.2`（与 dsh-llm 同代；对齐其
   peerDependencies 声明，消除 0.0.1-rc.1 漂移解析）
2. `panel-client.ts`：`PanelModelView` / `PanelModelDetail` 补 `mmprojFile?: string | null`
   （老面板缺席 = undefined = 不可知）；listModels/getModel 映射补字段
3. `adapter.ts` 纯函数 `inputModalitiesFor(mmprojFile, status)`：
   - 非空且 status ≠ missing-mmproj → `['text','image']`
   - 非空但 missing-mmproj（起不来）或明确 null → `['text']`
   - undefined（老面板不可知）→ 省略字段
   `listModels` 与 `resolveModel` 都按此上报（resolveModel 从 detail 读）
4. 单测：三态门控 × describeModel 不受影响

## Task 2 图片 wire 通道

1. `LlamapadAdapterOptions` 加可选 `readImage?: (ref) => Promise<{data, mediaType} | null>`
   （沿用 fetchImpl 注入模式；返回 null = 服务缺席/读失败 → 占位文本）
2. `index.ts`：`ctx.get("attachments")` 机会式取服务提供实现（不能静态 inject——
   服务缺席会阻塞插件启动）
3. `openai-wire.ts` 重构（保持纯函数可测）：
   - `collectImages(options)` 收集全部 ImageBlock（含 tool-result 嵌套 content）
   - 预解析：adapter.stream 在 buildChatBody 前并行 readImage，得
     `Map<ref, dataUrl | null>`
   - `buildChatBody(options, resolved)`：user 消息含图时 content 切数组形态
     （text + image_url 块按序）；解析失败 → `"[image attachment unavailable]"`
     占位（对齐 dsh 的 OFFLOADED_IMAGE_TEXT 思路，显式可调试）
   - `renderToolResult` 的 image 同样占位（现状是静默忽略）
   - base64 用 Buffer（host 进程）
4. 测试：单测（假 readImage：成功/失败/多图顺序/纯文本不变）、
   E2E（假面板断言请求体 data URL 前缀）
