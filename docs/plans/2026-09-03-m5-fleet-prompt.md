# M5 提示词快照：micro-step 计划（2026-09-03）

依据：[2026-09-03 方案](../design/2026-09-03-multimodal-monitor-events-prompt.md) F1。
一个任务一提交。TDD。

## Task 1 fleet 快照分节

1. 补钉依赖 `@deepseek-ai/dsh-system-prompt@0.1.1-rc.2`（pnpm store 已有实例，
   即宿主 dsh-agent 在用；与 dsh-llm 同代）
2. 新模块 `src/fleet-snapshot.ts`：`renderFleetSnapshot(cache: FleetCache | null): string`
   纯函数——英文（消费方是模型，与 harness identity 一致）；内容：running model
   （name/quant）+ 可启动清单（name/quant，至多 20 条 + `… and N more`）+ 一句
   工具提示（"may be available"，B 形态没挂时也不撒谎）；空缓存/无模型 → 空串
   （renderPrompt 丢弃空 section，天然降级）
3. `src/index.ts`：Config 加 `statusPromptSection: boolean` 默认 true；
   `ctx.inject(["systemPrompt"], sctx => sctx.systemPrompt.section({name:
   "llamapad:local-fleet", order: 50, text: () => renderFleetSnapshot(fleetCache.get())}))`
   ——动态注入，服务缺席时功能静默关闭、插件照常；text 函数每次组装同步求值
4. 单测：renderFleetSnapshot 各形态（含截断、空态）；注入路径的存在性测试（fake
   ctx.inject 捕获回调）

## 验收

`pnpm test` + `pnpm run typecheck` + `pnpm run build` 全绿；系统提示里可见
fleet 快照（真机冒烟项，收尾统一记）。
