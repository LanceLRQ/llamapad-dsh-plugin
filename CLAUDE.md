# CLAUDE.md

llamapad-dsh-plugin：DeepSeek Harness（dsh）的 llamapad LLM 适配器插件仓库。

## 项目约定

- **执行模式**：里程碑/计划先经 writing-plans 细化为 micro-step 计划（`docs/plans/`），再以 subagent
  驱动逐任务实施（每任务派实现 subagent，主会话审查后提交）
- **提交**：中文 Conventional Commits，一任务一提交；分支约定 `dev` 开发、`main` 收口
- **代理**：所有 npm/网络命令先
  `export HTTP_PROXY=http://127.0.0.1:20171 HTTPS_PROXY=http://127.0.0.1:20171 NO_PROXY=localhost,127.0.0.1`
- **测试**：`npm test`（单测）/ `npm run test:e2e`（假面板 E2E，无需真实环境）/ `npm run typecheck`；
  TDD——先写失败测试再实现

## 关键约束

- dsh 是 v0.1 技术预览：`@deepseek-ai/*` 依赖**钉精确版本**；类型契约以
  `node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts` 为准（文档可能滞后）
- llamapad API 只读参照：`/Volumes/github/projects/llamapad/src/app/api/v1/`（跨仓库，不改它）
- 单模型运行时：切换 = start 自带停旧起新；插件侧用串行门 + 同目标合流防并发抖动
- 用户边界：**不做空闲自动停**（插件只做连接与模型调度，不接管服务端）；等待期不注入提示文本
  （会污染历史上下文，依据见 docs/research §5）
- Mac 无法跑真实模型：E2E 用假面板（Node http 假服务器）；真机校准项（usage 计数、
  reasoning_content、切换延迟）归 M4

## 当前阶段

A 形态（LLM 适配器）计划已定稿：`docs/plans/2026-08-24-a-form-adapter.md`，待逐任务执行。
B 形态（管理工具插件）只有设计稿（`docs/design/`），A 落地后再细化实施。
