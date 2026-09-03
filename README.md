# llamapad-dsh-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 LLM 适配器插件：
把 [llamapad](https://github.com/LanceLRQ/llamapad) 管理的本地 llama.cpp 模型接入 dsh——在 dsh 的
模型选择器里按名字选用，插件按 `chatBehavior` 档位把「选模型」与「容器启停」解耦（默认档下聊天
路径完全不触发启停，在途输出流不会被切换打断），llamapad 侧零改动。

本包导出**三个入口**：`llamapad-dsh-plugin`（A 形态，LLM 适配器）、
`llamapad-dsh-plugin/tools`（B 形态，管理工具——让任意模型驱动的 Agent 查询/启停本地模型）与
`llamapad-dsh-plugin/client`（浏览器端设置卡片，见下「设置卡片」一节）。A、B 是两个独立的 dsh
插件行，可以只挂一个也可以两个同挂；`./client` 不是插件行，随 A 形态自动加载，无需单独配置。

**状态：A 形态 + 聊天路由解耦（阶段一）+ B 形态管理工具 + 设置卡片（阶段二）均已实现并通过
全部测试，并已在真实 dsh + GPU 环境完成端到端冒烟。第三批（阶段三，2026-09-03）也已全部
实现并通过全部测试（497 单测 + 31 假面板 E2E），内容：工具呈现升级与并发安全声明、RPC 取消
通道（卡片「取消等待」）、B 形态启停审批门、多模态输入（贴图）、SSE 事件驱动刷新、GPU 监控页、
系统提示本地模型场快照——真机冒烟清单见手册（待执行）。**
计划与实施记录见 [docs/plans/2026-08-24-a-form-adapter.md](docs/plans/2026-08-24-a-form-adapter.md)；
聊天路由三档与设置卡片的设计与落地记录见
[docs/design/chat-vs-lifecycle-decoupling.md](docs/design/chat-vs-lifecycle-decoupling.md)与
[docs/design/settings-card-design.md](docs/design/settings-card-design.md)；
B 形态工具见 [docs/design/b-form-tools-design.md](docs/design/b-form-tools-design.md)；
第三批的设计与实施记录见
[docs/design/2026-09-03-multimodal-monitor-events-prompt.md](docs/design/2026-09-03-multimodal-monitor-events-prompt.md)
与 `docs/plans/2026-09-03-m1..m5-*.md`（五个里程碑计划）；
真机冒烟步骤与结果见 [docs/manual-smoke.md](docs/manual-smoke.md)。

> ⚠️ **依赖版本必须与宿主 dsh 同代**：构建把 `@deepseek-ai/*` 全部 external，运行时由 pnpm 按
> 本包 `package.json` 的钉版落盘。落后于宿主时会装出第二份框架，宿主拿新接口调旧基类当场崩
> （实测：`dsh-llm` 0.1.x 的运行时无条件调用 `adapter.prepareCall`，而 0.0.1-rc.1 的基类没有
> 这个方法）。本包现在还钉了 `dsh-attachment` / `dsh-system-prompt`（均 0.1.1-rc.2，多模态
> 输入与系统提示快照消费的宿主服务），升级 dsh 时这两个同样要同步。

> ⚠️ **破坏性变化**：`chatBehavior` 默认值为 `strict`（0.x 阶段直接切换默认值，不做过渡期）。
> 若你依赖旧版「选模型即切容器」的自动切换行为，请在配置里显式设置 `chatBehavior: auto-switch`。

> ⚠️ **`dist/` 不入库，装载前必须先构建**：`package.json` 一旦声明 `dsh.client`（浏览器端设置
> 卡片入口），宿主找不到 `dist/client.js` 就会让**整个插件加载失败**——连 A 形态 LLM 适配器
> 一起挂掉，不是「卡片不显示」这么轻。tarball / git 安装会经 `prepare` 钩子自动构建；但用
> `link:` 软链本地调试或直接跑源码时，**启动 dsh 前必须先手动 `pnpm run build`** 一次，之后
> 每轮改动同理（见下「本地调试」）。

## 工作方式

- **控制面**（列模型 / 启停 / 状态 / 就绪探测）：llamapad REST API（`Authorization: Bearer lp_xxx`）
- **数据面**（`/v1/chat/completions` SSE）双模式：
  - `proxy`（默认）：走 llamapad 面板反代——dsh 与 GPU 服务器不在同一网络时，llama.cpp 端口无需暴露
  - `direct`：同机低延迟场景直连 llama.cpp
- **聊天路由 `chatBehavior` 三档**（决定「选模型」与「容器启停」的耦合程度）：
  - `strict`（**默认**）：请求的模型与运行中的不一致，或没有模型在跑，一律报错引导去 llamapad
    面板操作；聊天路径**完全不调 start**，在途输出流绝对安全。适合共享 GPU / 多会话场景
  - `passthrough`：有模型在跑就发给它（名字对不上也照发，实际转发给运行中的那个模型）；没有
    模型在跑时报错。适合「只想连上现在这个中转服务」的单人场景
  - `auto-switch`：保留旧版「选谁起谁」行为，start 自带停旧起新（`drainOnSwitch` 默认让服务端
    等待在途推理排空后再切）。适合独占 GPU 的单人场景
- 插件内串行门 + 同目标合流避免并发抖动（仅 `auto-switch` 档会触发 start）
- 切换等待期**静默**（不往对话注入提示文本——那会污染历史上下文，见
  [调研文档](docs/research/2026-08-24-dsh-plugin-research.md) §5）
- **模型选择器上的运行状态标记**：运行中的模型名前会有 `▶︎` 前缀（实心播放三角，带
  U+FE0E 变体选择符强制取文本形态，避免在部分系统被渲染成彩色 emoji）；`missing-file`/
  `missing-mmproj`（配置了但文件缺失）的模型会在说明文字后追加提示——选中这类模型
  必然在启动时 422，提前标出来省一次踩坑。标记由面板事件驱动刷新：插件 host 侧常驻
  一条 SSE 连接（面板 `/api/v1/events/stream`），`model.*` 事件（启停、异常退出）一到
  立即探测一次面板运行状态，只在"当前运行中的模型"发生变化时才通知 dsh 重拉模型目录
  （浏览器侧目录本身不轮询，只在收到通知时重拉）——刷新延迟从「一个轮询间隔」降到
  「一次推送 + 一次探测」。SSE 建连连续失败 3 次自动降级回定时轮询、面板恢复后自动切回
  事件驱动（降级轮询的节拍仍是 `statusRefreshMs`）；常连接的静默断流由看门狗兜底（按
  节拍读一眼最新事件 id 核对水位，发现流落后即重连补齐）。`statusRefreshMs: 0` 仍是
  **完全关闭**——连 SSE 也不连（0 的语义是「不打扰面板」，常驻连接违背它），关闭后标记
  会停在插件启动那一刻的旧值，不再跟随面板侧的启停更新。`hideStoppedModels`
  开启后选择器只列出运行中的模型（默认关闭，没有模型在跑时选择器会是空的）；
  `chatBehavior: auto-switch` 档下该开关被忽略并打一条 console 警告——那一档要靠选中
  未启动的模型来触发自动启动，藏起来会让整档不可用

## B 形态：管理工具（`llamapad-dsh-plugin/tools`）

独立入口，`inject: ['tools']`，与 A 形态共享 `panel-client` 与切换门（同一 `panelUrl` 下共用一把
锁，两个入口不会互相插队「一边起一边停」）。5 个工具：

| 工具 | 参数 | 说明 |
|---|---|---|
| `llamapad_status` | 无 | 面板是否可达、有没有模型在跑、是否有在途推理。忙碌状态不可知时**省略**相关字段而不是报成"不忙" |
| `llamapad_list_models` | 无 | 列全部模型配置，至多 100 条（按名称升序），`total`/`truncated` 如实反映截断 |
| `llamapad_events` | `limit`/`kind` 可选 | 查询面板操作事件历史（模型启停/异常退出、下载、配置变更等），排障用——如回答"模型为什么停了"。`limit` 默认 20、上限 100；`kind` 精确过滤事件类型（如 `model.exit` 只看容器异常退出） |
| `llamapad_start_model` | `model` 必填；`waitReady`/`drain`/`timeoutMs` 可选 | 启动/切换（单模型语义自动停旧起新）。`drain` 默认 `true`，切换不打断在途输出 |
| `llamapad_stop_model` | `drain`/`drainTimeoutMs` 可选 | 停止当前运行的模型。没有模型在跑时返回 `stopped:false` 而不是报错 |

刻意**不开放**删除模型/文件、改配置、下载管理——高危操作留在 llamapad 面板的人工确认流程里。
工具失败直接抛错，由 dsh 转成模型可读的错误文本。

五个工具都声明了 `isConcurrencySafe`（只读查询，或启停经共享门串行/合流），可被宿主安全地
并入并行组。调用与结果呈现：`llamapad_status` 是终端卡语义（等价一条 `llamapad status` 命令，
面板不可达 → `exitCode: 1`，UI 用退出状态徽标呈现）；`llamapad_events` 的结果同样以终端卡
输出多行事件（每行 `[时间] 类型 描述`，按时间倒序）；启停工具的调用卡带 `execute` 标记
（改变面板运行状态的操作）。

**启停审批门 `toolApproval`**（B 形态独有配置，默认 `allow`）：设为 `ask` 后，Agent 调用
`llamapad_start_model` / `llamapad_stop_model` 需先经用户确认（框架的 approval 通道）；宿主
没有审批通道时，框架会把 `ask` 折算为**拒绝执行**——确认门绝不会静默放行。共享 GPU 场景
建议 `ask`（启停会影响别的会话）。

## 设置卡片

dsh 的**设置 → 插件 → 插件配置**页签里会有一张 llamapad 卡片（与官方的终端 / Agent 循环 /
网页搜索三张卡并列）——**无论 A 形态是否已经配好 `panelUrl`/`token`，卡片都会出现**：未配置
时显示未连接态，直接在卡片里填连接信息保存即可，不需要先去改 cordis.yml 再重启 dsh。内容：

- 标题行整行是一个可点击的折叠按钮（默认展开），点击收起/展开，chevron 旋转指示状态；
  收起时停止轮询面板
- 内容区顶部「在浏览器中打开面板」按钮，跳转到完整的 llamapad 面板
- 运行状态（有没有模型在跑、是否正在推理）
- 模型列表：卡片式两列网格，超过约 4 行时列表内部定高（320px）滚动，卡片本身不被撑高；
  dsh 窗口窄于 520px 时回落单列
- 每行一个启动/停止按钮（单模型语义，点启动即切换）；**在途等待时按钮变「取消等待」**——
  点击即中止这次等待（AbortSignal 经 host RPC 的取消通道一路传到面板 HTTP 请求），按钮
  恢复原状、不报错误横幅（用户主动取消不算故障）
- 底部「连接设置」区：面板地址与 API token 两个输入框 + 保存按钮
- 底部「最近事件」列表：面板最近发生的操作事件（模型启停/异常退出、下载完成等，来自
  插件的事件环，为空时整节不渲染），失败类（`model.exit` / `model.start_failed` /
  `download.failed` 等）标红、成功类（`model.start` / `download.complete`）标绿；轮询发现
  新事件时弹一条 Toast 轻提醒（约 3 秒自灭，多条排队逐条展示，不打断对话）

**卡片内可直接配置连接**：面板地址与 token 不必预先写进 cordis.yml——在「连接设置」区填好
保存即可，写入 `$DSH_HOME/settings.yaml` 里本插件的独立分节（不碰 cordis.yml），优先级高于
cordis.yml，**改完立即生效，不用重启 dsh**。token 输入框留空表示保持已配置的值不变（沿用
官方 SecretField 的语义），因此没有单独的「清空 token」入口；面板地址留空会被拒绝保存——
清空地址会让卡片本身失去唯一的补救入口。

**token 与面板连接全程留在 dsh host 进程**：卡片经 host RPC（`ctx.remote.llamapadPanel.*`）
向宿主要数据，宿主再用已有的 `PanelClient`/`token` 去调 llamapad；浏览器全程拿不到 token、
不直连 llamapad——因此 **llamapad 不需要加 CORS**。架构图与四条真机才踩到的硬约束见
[设置卡片设计记录](docs/design/settings-card-design.md)。

启停按钮复用 `drainOnSwitch` / `drainTimeoutMs` 两个既有配置项（不再局限于 `auto-switch`
档）：停止一个正在推理的模型时，服务端最长会排空等待 `drainTimeoutMs`（默认 60 秒），期间
按钮显示等待文案。

> ⚠️ **跨机部署要配 `panelPublicUrl`**：`panelUrl` 是 dsh host 进程视角的地址（常见
> `127.0.0.1`），而「在浏览器中打开面板」是在**用户浏览器**里打开的——dsh 与浏览器不在同一台
> 机器时二者不是一回事。给 `panelPublicUrl` 填浏览器能访问到的面板地址即可；单机部署两者
> 一致，可以不配。构建前置要求见文首「`dist/` 不入库」的提示。

## 多模态输入（贴图）

配了 mmproj（视觉投影器）的模型可以接收图片输入。插件按面板模型配置的 `mmprojFile`
字段向 dsh 声明 `inputModalities`，三态门控：

- 配置了 mmproj 且文件在 → `["text", "image"]`，dsh 聊天输入框随之开放贴图
- 没配 mmproj，或配了但文件缺失（`missing-mmproj`）→ `["text"]`
- 老面板的响应里没有该字段（不可知）→ 整个省略，不冒充任何一种能力

链路：dsh 聊天里贴的图（ImageBlock）→ 宿主 attachments 服务读出字节 → 转 `image_url`
（base64 data URL）随消息发给 llama.cpp，`proxy` / `direct` 两种模式都支持。图片读不出来
（attachments 服务缺席、存储层校验不过等）时**降级为显式占位文本**（`[image attachment
unavailable]`）而不是静默丢图——模型至少知道这里本该有一张图，排障也看得见；工具结果里
的图片同样以占位文本降级。GIF / WebP 等格式能否被吃掉以 llama.cpp 的解码能力为准。

## GPU 监控页

dsh 设置导航里的整页监控（注册进 `settings.section` slot，条目排在官方设置页之后）。
内容：tokens/s、KV cache tokens、GPU 显存、GPU 利用率、容器 CPU、容器内存六条 SVG
曲线，外加分卡明细（每张卡的显存占用/利用率/温度/功耗）。时间窗四档可切：
30m / 2h / 24h / 7d。

- 轮询节拍匹配数据分辨率：30m/2h 档 5 秒（5s 采样 ring），24h/7d 档 60 秒（15min
  聚合桶，快了纯空转）
- 轮询是**增量**的：带上次水位 `since` 只取新点拼接，窗口滚动到点自动整窗重拉；
  切页 / 切档时在途请求即刻取消，组件挂载即轮询、离开页面即停
- 温度/功耗解析不到（nvidia-smi 不报）时该段省略而不是补 0——「65°C」和「温度未知」
  是两回事

## 系统提示快照（混合路由）

插件向 dsh 的系统提示注入一个 `llamapad:local-fleet` 分节（英文，消费方是模型）：正在
跑什么模型、还能启动哪些（可启动清单至多 20 条，超出以计数提示）。任何 provider 的
模型——包括云端模型——都能在系统提示里看到本地模型场，进而自行把合适的任务引导到本地
模型，或直接调 `llamapad_start_model` 拉起（"云端大脑 + 本地算力"混合路由的地基）。数据
来自事件驱动刷新器顺手维护的舰队缓存，每次组装系统提示时同步求值，注册一次即永远反映
最新状态；面板不可达 / 还没探测成功时这一节自动缺席（不会谎报"本地没有模型"）。

配置开关 `statusPromptSection`（默认 `true`）。**隐私说明**：快照会作为系统提示的一部分
发给会话使用的 provider——会话走云端模型时等于把本地 GPU 上有什么模型告诉了云端服务商，
介意请关闭。

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `panelUrl` | 必填 | llamapad 面板地址，如 `http://192.168.1.10:8080` |
| `token` | 必填 | llamapad API token（`lp_` 开头；用 `!!js process.env.LLAMAPAD_TOKEN` 注入） |
| `panelPublicUrl` | — | 浏览器可见的面板地址，供设置卡片「在浏览器中打开面板」按钮使用；缺省回落 `panelUrl`。`panelUrl` 是 dsh host 进程视角的地址（常见 `127.0.0.1`），按钮却是在用户浏览器里打开的，跨机部署时二者不是一回事；单机部署可以不配 |
| `provider` | `llamapad` | provider 路由名 |
| `mode` | `proxy` | `proxy` / `direct` |
| `llamaBaseUrl` | — | direct 模式的 llama.cpp 基地址 |
| `chatBehavior` | `strict` | 聊天路由档位：`strict` / `passthrough` / `auto-switch`（见上「工作方式」） |
| `startTimeoutMs` | `300000` | 切换后等待就绪超时（仅 `auto-switch` 档生效） |
| `pollIntervalMs` | `2000` | 就绪探测间隔（仅 `auto-switch` 档生效） |
| `drainOnSwitch` | `true` | 切换/停止前是否让服务端排空在途推理；`auto-switch` 档的自动切换与设置卡片的启停按钮共用这一个开关 |
| `drainTimeoutMs` | `60000` | 排空等待的最长时间（`drainOnSwitch=true` 时生效）；`auto-switch` 档与设置卡片启停按钮共用同一个数字 |
| `requestTimeoutMs` | `30000` | 面板控制面单请求超时 |
| `defaultContextWindow` | — | 模型未配置 ctx_size 时的兜底 |
| `statusRefreshMs` | `5000` | 刷新模型选择器运行状态的节拍（毫秒）：SSE 事件驱动模式下是断流看门狗的探测间隔，SSE 连败降级后是轮询间隔；`0` 完全关闭（连 SSE 也不连）。仅影响选择器上的运行中标记，不影响对话 |
| `hideStoppedModels` | `false` | 开启后模型选择器只显示运行中的模型；`chatBehavior: auto-switch` 档下该开关被忽略（那一档要靠选中未启动的模型触发自动启动），忽略时会打一条 console 警告 |
| `statusPromptSection` | `true` | 系统提示是否包含本地模型场快照分节（见上「系统提示快照（混合路由）」）。隐私考量：关闭后该分节不再随系统提示发给远端 provider |

B 形态（`llamapad-dsh-plugin/tools`）另有独有配置 `toolApproval`（默认 `allow`；`ask` 档下
Agent 调用启停工具需用户确认，宿主无审批通道时折算为拒绝执行，见上「B 形态」）。

挂载示例见 [examples/cordis.yml](examples/cordis.yml)。

### 思考强度（reasoning_effort）

`proxy` 模式（默认）支持思考强度：档位由面板按模型 chat template 的真实值域声明，dsh 的选择器
直接列出可选档。取值改写与兜底全部由面板中转层负责——选到模板不认的档位不会失败，面板会就近
改写或丢弃该字段。

面板的档位声明只对**当前运行中**的模型有效（中转层用运行中容器的模型组装响应），因此未运行的
模型会列出完整枚举 `minimal / low / medium / high / xhigh / max`，切换过去之后再看到的才是该模型
的真实值域。

`direct` 模式**不支持**：该模式直连 llama.cpp，绕过面板中转层，值域外的取值会被模型 chat
template 的 jinja 校验打成 HTTP 500。此模式下插件不上报档位，传入思考强度会明确报错。

> 面板的推理中转前缀 `/api/v1/proxy/llama/*` 另有短地址别名 `/llama-proxy/*`，两者行为完全一致。
> 插件配置里只填面板根地址（`panelUrl`），路径由插件自行拼接，无需关心用哪种写法。

## 安装到 dsh

本包是标准 [dsh bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)
（`package.json` 声明 `dsh.bundle.patch`，运行时产物已预构建进 `dist/`）。装好后层会自动叠加，
无需改任何代码；唯一要做的配置是把 `panelUrl`/`token` 写进你自己的 patch 层（见下）。

**方式一：tarball 安装（推荐，零构建权限）**

```bash
# 仓库根目录打包（或直接用 Release 里附带的 tgz）
pnpm run release         # 门禁 + 版本递增 + 构建 → llamapad-dsh-plugin-<版本>.tgz
# 仅改了随包文档、不升版本时：pnpm run pack:dsh

# 装进一个 dsh profile
dsh plugin --profile <名> add ./llamapad-dsh-plugin-<版本>.tgz
```

**方式二：GitHub / 本地目录安装**

```bash
dsh plugin --profile <名> add github:LanceLRQ/llamapad-dsh-plugin   # 或本地 checkout 路径
```

git/目录安装拿的是源码，pnpm 会跑本包的 `prepare` 脚本现场构建；pnpm ≥10 默认拒绝执行依赖的
构建脚本，按 dsh 的提示把它打印出的包名加进 profile 的 `pnpm-workspace.yaml` 再重跑一次：

```yaml
allowBuilds:
  llamapad-dsh-plugin: true
```

**安装后配置（两种方式都要做这一步）**

bundle 层只注册插件行、不带配置。编辑 profile 目录的 `cordis.patch.yml`
（`$DSH_HOME/profiles/<名>/cordis.patch.yml`），按 id 覆盖 llamapad 行——
完整模板见包内 [examples/profile-patch.example.yml](examples/profile-patch.example.yml)：

```yaml
- id: llamapad
  name: llamapad-dsh-plugin
  config:
    panelUrl: http://192.168.1.10:8080
    token: !!js process.env.LLAMAPAD_TOKEN
```

要把 agent 的默认模型指向 llamapad，在同一文件里再覆盖 `agent-default-model` 行（实测有效）：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: llamapad
    model: <面板里的模型配置名>
```

要挂 **B 形态管理工具**，在同一文件里追加下面这段。注意必须用 `insert:`——用户层的「按 id 覆盖」
只作用于已存在于组合树里的条目，而 B 入口没被 bundle 层声明过，写成覆盖会得到
`patch: entry "llamapad-tools" not found` 并**静默不注册**：

```yaml
- insert:
    - id: llamapad-tools
      name: llamapad-dsh-plugin/tools
      config:
        panelUrl: http://192.168.1.10:8080
        token: !!js process.env.LLAMAPAD_TOKEN
```

没配 `panelUrl`/`token` 就启动不会拖垮 dsh，但 A、B 两个入口的行为不同：A 形态（LLM 适配器）
照常注册，模型选择器与设置卡片都会出现，卡片显示未连接态，可以直接在卡片「连接设置」区填好
保存，不需要重启 dsh；B 形态（管理工具）不受此影响，仍是打一条警告后跳过工具注册，补好配置
需要重启 dsh 才生效。

**验证**

```bash
dsh --profile <名> --dump-config   # 应看到 "# == llamapad-dsh-plugin" 层与 llamapad 行
dsh web                            # 模型选择器出现面板里的模型
```

注意：未配置就启动 / 启动后仍看不到模型时，先确认上面两步都做了；配置未生效最常见的原因是
用户层的行少了 `id: llamapad` 或写到了错误的 profile 目录。

## 本地调试（不发布版本）

**方式一（推荐，已实测）：装进 web profile，`dsh web` 直接用**

```bash
# 一次性：本仓库作为 link: 软链依赖装进默认 web profile（dsh web 启动的就是它）
dsh plugin --profile web add /绝对路径/llamapad-dsh-plugin
# 配置写用户层 ~/.dsh/profiles/web/cordis.patch.yml（模板 examples/profile-patch.example.yml），然后：
dsh web        # http://127.0.0.1:3080
```

软链意味着每轮改动只需 `pnpm run build` + 重启 dsh，**无需重新 add**。
⚠️ 实测坑一：安装版 dsh（npx/全局）的 `--patch` **不解析模块路径行**——`./src/index.ts`、
`./dist/index.js`、绝对路径都会被**静默忽略**（不加载、不报错、服务照常起），别用
`dsh web --patch examples/dev.yml` 调试；判断插件是否加载，看启动日志有无
`[llamapad-dsh-plugin]` 输出。
⚠️ 实测坑二：**同版本 tgz** 重 `add` 不刷新（pnpm 按 spec 缓存）；目录 link 方式无此问题。

**方式二（仅 dsh 源码仓库场景）：`--patch` 直挂 TS 源码**

从 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码检出运行
`pnpm dsh web --patch /绝对路径/examples/dev.example.yml` 时可用（其开发 loader 支持路径加载
TS），模板见 [examples/dev.example.yml](examples/dev.example.yml)，本地私有副本
`examples/dev.yml` 已 gitignore。

**方式三：测试回路**——`pnpm test` / `pnpm run test:e2e`（假面板），改适配器逻辑的主回路，
不需要 dsh 与真实面板。

## 开发

```bash
pnpm install   # 需代理时先 export HTTP_PROXY/HTTPS_PROXY=http://10.22.33.1:20172
pnpm run build         # esbuild 打包 src/ → dist/{index,tools,client}.js（Node 侧 @deepseek-ai/* 保持 external）
pnpm test              # 单元测试
pnpm run test:e2e      # 假面板 E2E（无需真实 llamapad / GPU）
pnpm run typecheck
pnpm run release         # 重新打包：门禁 + 版本递增 + 构建 + tgz（详见 docs/packaging.md）
pnpm pack              # prepare 钩子自动先 build，产出可安装 tgz
```

## 文档索引

- [A 形态实施计划](docs/plans/2026-08-24-a-form-adapter.md)（含实施记录）
- [聊天路由与生命周期解耦](docs/design/chat-vs-lifecycle-decoupling.md)
  ——阶段一（`chatBehavior` 三档 + 在途流保护）与阶段二（设置卡片）均已实施
- [设置卡片设计记录](docs/design/settings-card-design.md)——架构、四条真机硬约束、已知缺口
- [第三批方案：多模态 / 监控 / 事件 / 提示词快照](docs/design/2026-09-03-multimodal-monitor-events-prompt.md)
  与五个里程碑计划：[M1 快赢包](docs/plans/2026-09-03-m1-quick-wins.md)（工具呈现升级 /
  RPC 取消 / 审批门）、[M2 多模态输入](docs/plans/2026-09-03-m2-multimodal.md)、
  [M3 事件驱动](docs/plans/2026-09-03-m3-events.md)、[M4 GPU 监控页](docs/plans/2026-09-03-m4-monitor.md)、
  [M5 提示词快照](docs/plans/2026-09-03-m5-fleet-prompt.md)
- [手工冒烟手册](docs/manual-smoke.md)
- [dsh 插件调研归档](docs/research/2026-08-24-dsh-plugin-research.md)（契约细节 + UX 评估依据）
- [B 形态（管理工具插件）设计稿](docs/design/b-form-tools-design.md)（已实施，见上「B 形态」一节）
