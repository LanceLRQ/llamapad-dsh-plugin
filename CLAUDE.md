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
  `node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts` 为准（文档可能滞后）。
  **钉版必须与宿主 dsh 同代**——构建把 `@deepseek-ai/*` 全部 external，运行时由 pnpm 按本包钉版
  落盘，落后于宿主就是两份框架并存。2026-08-27 实测过代价：`dsh-llm` 0.1.x 的运行时在派发路径上
  **无条件** `await adapter.prepareCall(...)`，而 0.0.1-rc.1 的 `LlmAdapter` 基类没有这个方法，
  每次对话都在进入 `stream()` 前抛 `TypeError`。`test/unit/adapter.test.ts` 有守护测试；
  升级 dsh 后先跑它
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
需显式配置 `chatBehavior: auto-switch`。

**B 形态（管理工具插件）已实施**（2026-08-27）：独立入口 `llamapad-dsh-plugin/tools`
（`inject:['tools']`，产物 `dist/tools.js`），4 个工具见 `src/tools.ts`。与 A 形态共享
`panel-client` 与切换门——门已改为按 `baseUrl` 归一的包级单例（`sharedModelGate`），两个入口
不会各持一把锁互相插队。B 入口**不随 bundle 默认挂载**，用户层必须用 `insert:` 追加
（按 id 覆盖只作用于组合树里已有的条目，写成覆盖会静默不注册）。

**依赖已升到 0.1.1-rc.2**（2026-08-27）：`dsh-llm` 0.0.1-rc.1 → 0.1.1-rc.2、新增
`dsh-tools` 0.1.1-rc.2；`src/` 零改动。起因见「关键约束」的 `prepareCall`。

**真机冒烟已完成**（2026-08-27，dsh 0.1.1-rc.2 + llamapad v0.1.1-rc）：装 CLI + 软链挂载、
A/B 双入口组合树正确、完整对话流式走通（冷启动首字 10.5s、84 个 text-delta、finish stop）、
4 个工具经真实 `ToolRuntime` 管线跑通且输出过框架 schema 校验。结果见
`docs/manual-smoke.md`「真机冒烟结果」。全部测试 111 单测 + 9 假面板 E2E 全绿。

待办：
- 阶段二：生命周期控制的显式入口。**「零成本外链」那一步已被核实推翻**——host 侧单独注册在
  设置界面里什么都不显示，露出任何内容都要自行复刻浏览器端 client module 的产物格式（官方
  tsdown preset 未发布）。订正后的门槛结构见设计文档第 3 节；下一步是产物格式的专项调研 spike
- **关注 llamapad M5**：其挂账②计划改造 llama webui 反代，而本插件依赖同一路由的 API 路径
  （`/api/v1/proxy/llama/v1/chat/completions` 与 `/health`），改造时须确认未打断
- 打包发布：本轮改动尚未 `npm run release`（版本未递增、未出 tgz）
