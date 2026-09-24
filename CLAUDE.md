# CLAUDE.md

llamapad-dsh-plugin：DeepSeek Harness（dsh）的 llamapad LLM 适配器插件仓库。

## 项目约定

- **执行模式**：里程碑/计划先经 writing-plans 细化为 micro-step 计划（`docs/plans/`），再以 subagent
  驱动逐任务实施（每任务派实现 subagent，主会话审查后提交）
- **提交**：中文 Conventional Commits，一任务一提交；分支约定 `dev` 开发、`main` 收口
- **包管理器：pnpm**（2026-08-27 由 npm 迁入，与宿主 dsh 的 profile 同栈）。锁文件
  `pnpm-lock.yaml` 入库，不要再生成 `package-lock.json`。`pnpm-workspace.yaml` 里
  `allowBuilds: {esbuild: false}` 是有意为之——esbuild 的 postinstall 只做平台二进制兜底，
  平台包走 optionalDependencies 已装好，声明它免得每次 install 刷 ERR_PNPM_IGNORED_BUILDS
- **代理**：所有 pnpm/网络命令先
  `export HTTP_PROXY=http://10.22.33.1:20172 HTTPS_PROXY=http://10.22.33.1:20172 NO_PROXY=localhost,127.0.0.1`
  （GPU 服务器出口；旧记的 `127.0.0.1:20171` 是 Mac 开发机地址，在本机不存在）
- **测试**：`pnpm test`（单测）/ `pnpm run test:e2e`（假面板 E2E，无需真实环境）/ `pnpm run typecheck`；
  TDD——先写失败测试再实现
- **打包发布**：内容变更后 `pnpm run release`（清洁检查→门禁→版本递增→构建→`pnpm pack` 出 tgz，
  流程/版本策略/用户侧更新见 `docs/packaging.md`）。产物不入库（.gitignore 忽略 `*.tgz`/`dist/`）；
  0.x 阶段行为/依赖变更 minor、修复 patch；纯随包文档改动用 `pnpm run pack:dsh` 同版本重打。
  本地调试不发布版本：装进 web profile（`dsh plugin --profile web add 本仓库` → link: 软链，
  `pnpm run build` + 重启 dsh 即生效）+ 用户层 `~/.dsh/profiles/web/cordis.patch.yml`；
  **安装版 CLI 的 `--patch` 不解析模块路径行（静默跳过，实测）**，路径直挂仅限 dsh 源码仓库
  场景（examples/dev.example.yml）；同版本 tgz 重 add 不刷新（pnpm 按 spec 缓存）

## 关键约束

- **`LlamapadAdapterOptions` / `PanelGatewayOptions` 会被 `index.ts` 在配置变更时原地改写**：
  面板地址/token 改完即时生效，靠的是这两个 options 对象在运行期被直接换上新的
  `client`/`gate`，不重建 adapter/gateway、不重新注册 provider。因此 adapter 与 gateway
  的每个方法都必须现取 `this.options.*`，不得在构造期把字段拷进实例字段——拷了会静默
  失效，配置改了也不生效，且没有任何报错
- dsh 是 v0.1 技术预览：类型契约以 `node_modules/@deepseek-ai/dsh-llm/lib/types/*.d.ts` 为准
  （文档可能滞后）。2026-08-27 实测过钉精确版本落后于宿主的代价：`dsh-llm` 0.1.x 的运行时在
  派发路径上**无条件** `await adapter.prepareCall(...)`，而 0.0.1-rc.1 的 `LlmAdapter` 基类没有
  这个方法，每次对话都在进入 `stream()` 前抛 `TypeError`。`test/unit/adapter.test.ts` 有守护
  测试；升级 dsh 后先跑它。**框架依赖是 peer 范围 `>=0.1.5-rc.3 <0.1.8-0`，运行时用宿主那一份**；
  devDependencies 钉 0.1.7 这一代用于类型检查；两代差异收在 `src/compat/settings.ts`、
  `rpc-contract.ts` 的 `strict()`、`openai-wire.ts` 的工具结果判定、`src/client/icons.ts`、
  `client/index.tsx` 的双插槽注册；新增宿主代时先跑 `pnpm run test:compat` 并扩展 peer 范围
- **模型状态刷新走 `status-watch.ts`**（2026-09-03 起吸收并替代已删除的 directory-refresh）：
  host 侧常驻 SSE（面板 `/api/v1/events/stream`）事件驱动，`model.*` 事件即时探测、运行中模型
  变化才 `ctx.emit("llm/adapters-updated")`；断流看门狗按节拍用 `getEvents({limit:1})` 核对水位，
  SSE 建连连败 3 次降级回定时轮询（节拍 `statusRefreshMs`）、恢复自动切回。**fleetCache 与
  eventRing 是它的两个副产物**——分别是提示词快照（`fleet-snapshot.ts`）与设置卡片事件流的
  数据源，实例在 apply 内闭包持有（防 fiber 重复装载串次），配置热更不重建、事件环历史不丢，
  别当可随手重建的缓存。`statusRefreshMs: 0` = 整个 watcher 不启动（SSE 也不连，0 的语义是
  「不打扰面板」）
- llamapad API 只读参照：`/mnt/data/github/llamapad/`（跨仓库，不改它）。**接口契约以面板正式文档
  `docs/guide/zh/api.md` 为准**，源码 `src/app/api/v1/` 作为细节佐证。文档里两条与本插件直接相关的
  约定：start 返回 200 不代表模型可用（要轮询 `runtime/status` 的 `ready`）、对已在运行的模型再次
  调用 start 会重建容器而非空操作
- **思考强度由面板中转层负责改写，插件不复刻**：面板在 `/v1/chat/completions` 上按该模型 chat
  template 的真实值域改写 `reasoning_effort`（别名 → 值域内透传 → 就近取整 → 丢弃字段），兜底策略
  保证请求一定不失败；`/v1/models` 的响应带 `x_llamapad.reasoning_effort.{supported,levels}` 声明。
  插件只读声明、只透传取值（`src/reasoning.ts`）。**direct 模式绕过这一层**，值域外的取值会被 jinja
  打成 HTTP 500，因此 direct 下 `resolveModel` 不上报 `reasoning`、`stream` 明确拒绝
- **面板运行时语义已是多模型的**（本插件提前适配面板尚未合并进 dev/main 的
  `feature/multi-model` 分支——面板解除了"同一时刻只运行一个模型"的约束，详见
  `docs/plans/2026-09-21-multi-model-adapt.md` 背景一节）：`GET /api/v1/runtime/status`
  的 `running` 字段还在，但语义已从"唯一在跑的模型"变成**默认模型**（不带 model 字段的
  请求会打给它）；真正的运行集合在 `models[]`（每项自带 `ready`/`hostPort`），老面板没有
  这个字段时由 `running` 合成单元素数组。全仓库判定"某模型是否在跑/该查谁的 ready"一律走
  `panel-client.ts` 的 `runningModels()`/`findRunning()`/`isRunning()`/`defaultModelOf()`
  四个归一函数，不直接读 `status.running`——直接读会在多模型面板上把默认模型之外的
  模型全部误判成"未运行"（这正是适配前的 P0-1/P0-2 两处生产级 bug 的根因）。切换默认
  模型走独立的 `GET/PUT /api/v1/runtime/default-model`（老面板没有这条路由，404 折成
  `PanelError` 的 `UNSUPPORTED` 码）。`chatBehavior` 三档在此基础上决定是否触发 start
  （`strict` 默认/`passthrough`/`auto-switch`，见 `docs/design/chat-vs-lifecycle-decoupling.md`）：
  只有 `auto-switch` 档会调用 start，且**只保证目标模型在跑，绝不为了它停掉别的在跑
  模型**（贴合插件"只做连接与调度，不接管服务端"的用户边界）；插件侧仍用串行门 + 同
  目标合流防并发抖动
- 用户边界：**不做空闲自动停**（插件只做连接与模型调度，不接管服务端）；等待期不注入提示文本
  （会污染历史上下文，依据见 docs/research §5）
- E2E 用假面板（Node http 假服务器），逻辑正确性不依赖真实环境；**API 层真机校准已于 2026-08-25
  在本机 GPU 服务器完成**（usage 计数、reasoning_content、切换延迟、就绪探测语义），结果见
  `docs/manual-smoke.md` 的「真机校准结果」
- **自定义镜像逃生口会打断插件的三条硬依赖**：插件硬依赖 llama.cpp server 的三个行为——
  `/api/v1/proxy/llama/health` 的 503→200 就绪语义、`/slots`（排空判定）、OpenAI 兼容的 SSE
  `/v1/chat/completions`。面板 2026-08-28 起提供 `docker.entrypoint` / `args_override` /
  `extra_args` / `env` / `model_mount` 五个自定义镜像字段（面板设计里明确标为进阶用法、配错自负）。
  用户换成非 llama.cpp-server 的镜像后：排空会优雅降级（`drain.ts` 探测不到 `/slots` 即回
  `unavailable`/`skipped`，已有设计覆盖），但**就绪探测会一路等到 `startTimeoutMs` 超时**、chat
  直接 404。这是「start 报成功但就绪探测超时」的一个已知成因，排查时先确认面板侧有没有配这几个字段

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

**模型选择器运行状态标记已实施**（2026-08-27）：`listModels` 按面板 `status` 字段给运行中模型加
`▶︎`（U+25B6 + 变体选择符 U+FE0E，强制文本形态、防止被渲染成宽窄不一的彩色 emoji）前缀、
给 `missing-file`/`missing-mmproj` 追加提示（纯函数 `describeModel`，`adapter.ts`）——多模型
适配（见下）额外给默认模型加了 `★` 前缀，两个标记互不排斥、可同时出现；
新增 `directory-refresh.ts` 轮询面板运行状态，仅在运行中模型变化时 `ctx.emit("llm/adapters-updated")`
触发浏览器侧目录重拉，间隔由新增 Config 字段 `statusRefreshMs`（默认 5000ms，0 关闭）控制
（directory-refresh 已于 2026-09-03 被 `status-watch.ts` 吸收替代，见「关键约束」）。

**resolveModel 的 contextWindow 改用面板生效配置为权威来源**（2026-08-28）：改读
`GET /api/v1/models/:name/effective` 的 `merged`（`mergeConfig(defaults, overrides)`，同时覆盖
全局默认与模型覆盖两层），修掉一处既有偏差——此前只读模型级 overrides，未单独覆盖 `ctx_size`
的模型会向 dsh 报告「不可知」，而面板内置默认其实是 131072。`docker.args_override` 非空数组时
（生成参数被整体取代，`server.*` 全段失效）不再上报 `context`，宁可省略也不报一个已失效的数字，
`/effective` 与旧的模型级 overrides 回退两条路径均受此约束；`/effective` 端点整个不可用时才回退
到旧的模型级 overrides 路径，回退不会捡回已被 `/effective` 判定为不可知的数字（见 `adapter.ts`
的 `readCtxSize`，两个来源共用它，选源在 `resolveModel`）。同时把 `describeModel` 的缺件提示文案指向面板新增的
文件页「自动寻找」入口。

**第三批功能已全部实施**（2026-09-03，方案见
`docs/design/2026-09-03-multimodal-monitor-events-prompt.md`，五个 micro-step 计划见
`docs/plans/2026-09-03-m1..m5-*.md`）：

- **M1 快赢包**：4+1 工具声明 `isConcurrencySafe`；status/events 终端呈现卡（面板不可达 →
  exitCode 1）；start/stop 打通 RPC 取消通道（卡片在途按钮变「取消等待」）；B 形态 Config 新增
  `toolApproval: allow|ask` 审批门（ask 档经 `tools/pre-execute` 升级为 ask，宿主无审批通道时
  框架折算为拒绝执行）
- **M2 多模态输入**：mmproj 三态门控声明 `inputModalities`（配了 text+image / 没配 text /
  老面板不可知省略）；ImageBlock 经宿主 attachments 服务读字节转 `image_url`（读不出降级显式
  占位文本），proxy/direct 双模式；补钉 `dsh-attachment` 0.1.1-rc.2
- **M3 事件驱动**：`status-watch.ts` 吸收并替代 directory-refresh（SSE 常连 + 看门狗 + 连败
  3 次降级轮询），卡片「最近事件」列表与新事件 Toast，第 5 个工具 `llamapad_events`
  （limit 默认 20 上限 100 / kind 精确过滤）
- **M4 GPU 监控页**：host 侧 monitor RPC（metrics 窗口增量协议 + gpu 快照，cancellation）；
  浏览器侧 `settings.section` 整页（六指标 SVG 曲线、30m/2h/24h/7d 四档、分卡温度功耗、
  增量轮询带取消）
- **M5 提示词快照**：系统提示注入 `llamapad:local-fleet` 分节（英文，running + 可启动清单
  ≤20 条），数据源 fleetCache；Config 新增 `statusPromptSection` 默认 true（隐私：快照随
  系统提示发给远端 provider）；补钉 `dsh-system-prompt` 0.1.1-rc.2

全部测试 497 单测 + 31 假面板 E2E 全绿；真机冒烟清单已记入 `docs/manual-smoke.md`（待执行）。

**多模型并行适配已全部实施**（2026-09-21，方案见
`docs/plans/2026-09-21-multi-model-adapt.md`）：提前适配面板尚未合并进 dev/main 的
`feature/multi-model` 分支（解除"同一时刻只运行一个模型"约束），修掉适配前会静默发生的
六处错配，其中最贵的两处是生产级 bug——P0-1（auto-switch 请求非默认模型时 100% 假超时、
留下幽灵实例占显存）与 P0-2（strict 把在跑的非默认模型误判成"未运行"）。八个任务：
`panel-client.ts` 的多模型契约层与四个归一函数（任务 1）→ routing/route-message 按目标
模型判定（任务 2）→ switching 就绪轮询按目标模型查（任务 3，修 P0-1）→ adapter 的 direct
URL/reasoning 精确匹配/选择器 `★` 默认标记（任务 4，修 P0-3）→ status-watch/fleet-snapshot
运行集合感知（任务 5）→ 卡片运行列表 + 「设为默认」（任务 6）→ 新增
`llamapad_set_default_model` 工具（任务 7）→ 监控页归属标注 + 假面板多模型能力 + 本轮文档
（任务 8）。收尾时另补一处计划遗漏：`llamapad_stop_model` 原本无 `model` 参数、一律停
`status.running`，多模型下用户说"停掉 B"会把默认的 A 停掉（**停错模型比停不了更糟**），
已加可选 `model` 参数，不传仍停默认模型，目标没在跑则回 `stopped:false` 而不退而求其次停别的。
全部测试 622 单测 + 36 假面板 E2E 全绿（含假面板"老面板模式"双向兼容回归）；
真机冒烟需等面板 `feature/multi-model` 分支合并后才能执行，清单已记入
`docs/manual-smoke.md`（只记清单，未打勾）。

**dsh 0.1.5/0.1.7 双版本兼容已实施**（2026-09-24，方案见
`docs/plans/2026-09-24-dsh-dual-compat.md`，调研归档在
`docs/research/2026-09-24-dsh-015-017-settings.md` 与 `docs/research/2026-09-24-dsh-015-017-apis.md`）：
修掉当前在 0.1.7 上「整个插件加载失败」的问题，同一份构建产物同时在 dsh 0.1.5-rc.3 与
0.1.7-rc.1 上加载并正常工作。框架依赖从钉精确版本的 dependencies 改为带版本范围的
peerDependencies，运行时统一用宿主那一份框架。六个兼容点：设置服务两代差异
（`src/compat/settings.ts`，0.1.5 的 `installSection`/`settings.yaml` 与 0.1.7 的
`SettingsForms`/Volatile 字段/`cordis.patch.yml`）、RPC codec 同时带 `schema` 与 `create`
两种校验入口（`rpc-contract.ts` 的 `strict()`）、工具结果两种消息结构都接受（`openai-wire.ts`）、
图标按新名找不到再退旧名（`src/client/icons.ts`）、设置卡片同时注册 `settings.plugin.item`
（0.1.5）与 `plugins.bundle.config`（0.1.7）两个插槽。类型检查以 0.1.7 为准，0.1.5 靠
`scripts/test-compat.mjs`（临时目录装 0.1.5 框架跑单测 + E2E，已纳入 `pnpm run release`
门禁）兜底。全部测试 639 单测 + 36 假面板 E2E 全绿，0.1.5 矩阵 638 单测（1 条 volatile 专用用例跳过）
+ 36 E2E 全绿。两代真机冒烟全部通过（tgz 安装；0.1.5 的对话用干净 DSH_HOME + headless 验证），
见 `docs/manual-smoke.md`「双版本冒烟」。冒烟中顺带修掉 `sharedModelGate` 永远绑定第一个 client、
改 token 后启停仍用旧 token 报 401 的既有 bug（现改用最近一次传入的 client）。

**v0.2.0 已发布**（2026-09-24）：推送 `v*` tag 由 CI（`.github/workflows/release.yml`）跑全量门禁
并创建 GitHub Release，流程见 `docs/packaging.md`「正式发布（CI）」。

**启动中状态已实施**（2026-09-24，设计见面板仓库 `docs/_internal/features/2026-09-24-启动中状态上报-design.md`）：
根因是面板 start 接口要同步做完建容器（本地无镜像先拉取，可能几分钟）和 10 秒存活检测才返回，期间
`runtime/status` 看不到该模型，插件 70 秒超时后又把 abort 报成面板不可达。面板 dev 新增 `starting`
字段（preparing/pulling/creating 三个阶段）；插件新增 `startRequestTimeoutMs`（默认 5 分钟，与
requestTimeoutMs、排空 +10s 取最大值，只放宽不缩短），start 自身超时抛 `START_PENDING`：auto-switch
与工具默认档继续轮询就绪，卡片/`waitReady:false` 不报错。卡片显示「仍在启动中」（已进 runningModels
的模型不重复显示）、手动刷新按钮、过期快照序号守卫，启停在途时立即拉快照并按 2s 轮询。老面板没有
`starting` 时归一为空数组，行为不回归。真机结果见 `docs/manual-smoke.md`「启动中状态冒烟」
