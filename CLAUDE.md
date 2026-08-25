# CLAUDE.md

llamapad-dsh-plugin：DeepSeek Harness（dsh）的 llamapad LLM 适配器插件仓库。

## 项目约定

- **执行模式**：里程碑/计划先经 writing-plans 细化为 micro-step 计划（`docs/plans/`），再以 subagent
  驱动逐任务实施（每任务派实现 subagent，主会话审查后提交）
- **提交**：中文 Conventional Commits，一任务一提交；分支约定 `dev` 开发、`main` 收口
- **代理**：所有 npm/网络命令先
  `export HTTP_PROXY=http://10.22.33.1:20172 HTTPS_PROXY=http://10.22.33.1:20172 NO_PROXY=localhost,127.0.0.1`
  （GPU 服务器出口；旧记的 `127.0.0.1:20171` 是 Mac 开发机地址，在本机不存在）
- **测试**：`npm test`（单测）/ `npm run test:e2e`（假面板 E2E，无需真实环境）/ `npm run typecheck`；
  TDD——先写失败测试再实现

## 关键约束

- dsh 是 v0.1 技术预览：`@deepseek-ai/*` 依赖**钉精确版本**；类型契约以
  `node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts` 为准（文档可能滞后）
- llamapad API 只读参照：`/mnt/data/github/llamapad/src/app/api/v1/`（跨仓库，不改它）
- 单模型运行时：切换 = start 自带停旧起新；插件侧用串行门 + 同目标合流防并发抖动
- 用户边界：**不做空闲自动停**（插件只做连接与模型调度，不接管服务端）；等待期不注入提示文本
  （会污染历史上下文，依据见 docs/research §5）
- E2E 用假面板（Node http 假服务器），逻辑正确性不依赖真实环境；**API 层真机校准已于 2026-08-25
  在本机 GPU 服务器完成**（usage 计数、reasoning_content、切换延迟、就绪探测语义），结果见
  `docs/manual-smoke.md` 的「真机校准结果」

## 当前阶段

**A 形态（LLM 适配器）已完成**：9 任务全部落地，41 单测 + 4 假面板 E2E 全绿（实施记录与偏差见
计划文件末尾）。**API 层真机校准已完成**（2026-08-25，llamapad M4 环境：三项校准全部通过，
就绪探测 503→200 语义正确且不早报，`translate.ts` 的 reasoning 处理无需改动）。

待办：
- dsh Web UI 挂载的端到端冒烟（`docs/manual-smoke.md` 步骤 1-6）——需在装有 dsh 的机器上执行
- **关注 llamapad M5**：其挂账②计划改造 llama webui 反代，而本插件依赖同一路由的 API 路径
  （`/api/v1/proxy/llama/v1/chat/completions` 与 `/health`），改造时须确认未打断
- B 形态（管理工具插件）按 docs/design 设计稿另行细化实施
