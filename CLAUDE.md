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
- **打包发布**：内容变更后 `npm run release`（清洁检查→门禁→版本递增→构建→`npm pack` 出 tgz，
  流程/版本策略/用户侧更新见 `docs/packaging.md`）。产物不入库（.gitignore 忽略 `*.tgz`/`dist/`）；
  0.x 阶段行为/依赖变更 minor、修复 patch；纯随包文档改动用 `npm run pack:dsh` 同版本重打。
  本地调试不发布版本：装进 web profile（`dsh plugin --profile web add 本仓库` → link: 软链，
  `npm run build` + 重启 dsh 即生效）+ 用户层 `~/.dsh/profiles/web/cordis.patch.yml`；
  **安装版 CLI 的 `--patch` 不解析模块路径行（静默跳过，实测）**，路径直挂仅限 dsh 源码仓库
  场景（examples/dev.example.yml）；同版本 tgz 重 add 不刷新（pnpm 按 spec 缓存）

## 关键约束

- dsh 是 v0.1 技术预览：`@deepseek-ai/*` 依赖**钉精确版本**；类型契约以
  `node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts` 为准（文档可能滞后）
- llamapad API 只读参照：`/mnt/data/github/llamapad/src/app/api/v1/`（跨仓库，不改它）
- 单模型运行时：切换 = start 自带停旧起新，**但是否触发切换由 `chatBehavior` 三档决定**
  （`strict` 默认/`passthrough`/`auto-switch`，见 `docs/design/chat-vs-lifecycle-decoupling.md`）；
  只有 `auto-switch` 档会调用 start，插件侧用串行门 + 同目标合流防并发抖动
- 用户边界：**不做空闲自动停**（插件只做连接与模型调度，不接管服务端）；等待期不注入提示文本
  （会污染历史上下文，依据见 docs/research §5）
- E2E 用假面板（Node http 假服务器），逻辑正确性不依赖真实环境；**API 层真机校准已于 2026-08-25
  在本机 GPU 服务器完成**（usage 计数、reasoning_content、切换延迟、就绪探测语义），结果见
  `docs/manual-smoke.md` 的「真机校准结果」

## 当前阶段

**A 形态（LLM 适配器）已完成**：9 任务全部落地（实施记录与偏差见计划文件末尾）。**API 层真机
校准已完成**（2026-08-25，llamapad M4 环境：三项校准全部通过，就绪探测 503→200 语义正确且不
早报，`translate.ts` 的 reasoning 处理无需改动）。
**已 bundle 化**（2026-08-27）：`dsh.bundle.patch` + dist 预构建，支持 `dsh plugin add` tgz
安装/升级（真实 CLI 验证过安装与覆盖更新），打包见 `docs/packaging.md`。

**聊天路由与生命周期解耦阶段一已实施**（2026-08-27）：`chatBehavior` 三档（`strict` 新默认 /
`passthrough` / `auto-switch`）+ 排空参数 + `passthrough`×`direct` 动态端口拼接，详见
`docs/design/chat-vs-lifecycle-decoupling.md`。**默认值变更属破坏性变化**：依赖旧版自动切换行为
需显式配置 `chatBehavior: auto-switch`。全部测试 80 单测 + 5 假面板 E2E 全绿。阶段二（显式生命
周期入口）未启动，见设计文档第 3 节。

待办：
- 阶段二：生命周期控制的显式入口（零成本外链 → 原生设置卡 → 完成态），按设计文档第 3 节的成本
  阶梯排期
- dsh Web UI 挂载的端到端冒烟（`docs/manual-smoke.md` 步骤 1-6）——web profile 软链挂载链路
  已于 2026-08-27 真机验证（bundle 层+用户层配置生效），完整对话冒烟待面板可用后执行
- **关注 llamapad M5**：其挂账②计划改造 llama webui 反代，而本插件依赖同一路由的 API 路径
  （`/api/v1/proxy/llama/v1/chat/completions` 与 `/health`），改造时须确认未打断
- B 形态（管理工具插件）按 docs/design 设计稿另行细化实施
