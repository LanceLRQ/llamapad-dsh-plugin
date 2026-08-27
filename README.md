# llamapad-dsh-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 LLM 适配器插件：
把 [llamapad](https://github.com/LanceLRQ/llamapad) 管理的本地 llama.cpp 模型接入 dsh——在 dsh 的
模型选择器里按名字选用，插件自动完成「停旧起新 → 等待就绪 → 转发推理流量」，llamapad 侧零改动。

**状态：A 形态（LLM 适配器）已实现并通过全部测试（41 单测 + 4 假面板 E2E），API 层已在真实 GPU 环境校准。**
计划与实施记录见 [docs/plans/2026-08-24-a-form-adapter.md](docs/plans/2026-08-24-a-form-adapter.md)；
真机冒烟步骤见 [docs/manual-smoke.md](docs/manual-smoke.md)。

## 工作方式

- **控制面**（列模型 / 启停 / 状态 / 就绪探测）：llamapad REST API（`Authorization: Bearer lp_xxx`）
- **数据面**（`/v1/chat/completions` SSE）双模式：
  - `proxy`（默认）：走 llamapad 面板反代——dsh 与 GPU 服务器不在同一网络时，llama.cpp 端口无需暴露
  - `direct`：同机低延迟场景直连 llama.cpp
- 切换由 llamapad 的单模型语义承担（start 自带停旧起新）；插件内串行门 + 同目标合流避免并发抖动
- 切换等待期**静默**（不往对话注入提示文本——那会污染历史上下文，见
  [调研文档](docs/research/2026-08-24-dsh-plugin-research.md) §5）

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `panelUrl` | 必填 | llamapad 面板地址，如 `http://192.168.1.10:8080` |
| `token` | 必填 | llamapad API token（`lp_` 开头；用 `!!js process.env.LLAMAPAD_TOKEN` 注入） |
| `provider` | `llamapad` | provider 路由名 |
| `mode` | `proxy` | `proxy` / `direct` |
| `llamaBaseUrl` | — | direct 模式的 llama.cpp 基地址 |
| `startTimeoutMs` | `300000` | 切换后等待就绪超时（大模型加载要 1-2 分钟以上） |
| `pollIntervalMs` | `2000` | 就绪探测间隔 |
| `requestTimeoutMs` | `30000` | 面板控制面单请求超时 |
| `defaultContextWindow` | — | 模型未配置 ctx_size 时的兜底 |

挂载示例见 [examples/cordis.yml](examples/cordis.yml)。

## 安装到 dsh

本包是标准 [dsh bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)
（`package.json` 声明 `dsh.bundle.patch`，运行时产物已预构建进 `dist/`）。装好后层会自动叠加，
无需改任何代码；唯一要做的配置是把 `panelUrl`/`token` 写进你自己的 patch 层（见下）。

**方式一：tarball 安装（推荐，零构建权限）**

```bash
# 仓库根目录打包（或直接用 Release 里附带的 tgz）
npm run release         # 门禁 + 版本递增 + 构建 → llamapad-dsh-plugin-<版本>.tgz
# 仅改了随包文档、不升版本时：npm run pack:dsh

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

要把 agent 的默认模型指向 llamapad，在同一文件里再覆盖 `agent-loop` 行（模板同上）。没配
`panelUrl`/`token` 就启动也不会拖垮 dsh：插件打一条警告后跳过注册，补好配置重启即可。

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

软链意味着每轮改动只需 `npm run build` + 重启 dsh，**无需重新 add**。
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

**方式三：测试回路**——`npm test` / `npm run test:e2e`（假面板），改适配器逻辑的主回路，
不需要 dsh 与真实面板。

## 开发

```bash
npm install   # 需代理时先 export HTTP_PROXY/HTTPS_PROXY=http://10.22.33.1:20172
npm run build         # esbuild 打包 src/ → dist/index.js（@deepseek-ai/* 保持 external）
npm test              # 单元测试
npm run test:e2e      # 假面板 E2E（无需真实 llamapad / GPU）
npm run typecheck
npm run release         # 重新打包：门禁 + 版本递增 + 构建 + tgz（详见 docs/packaging.md）
npm pack              # prepare 钩子自动先 build，产出可安装 tgz
```

## 文档索引

- [A 形态实施计划](docs/plans/2026-08-24-a-form-adapter.md)（含实施记录）
- [聊天路由与生命周期解耦（方向定稿，未实施）](docs/design/chat-vs-lifecycle-decoupling.md)
  ——在途流保护 + `chatBehavior` 三档 + 显式生命周期入口的修订方案
- [手工冒烟手册](docs/manual-smoke.md)
- [dsh 插件调研归档](docs/research/2026-08-24-dsh-plugin-research.md)（契约细节 + UX 评估依据）
- [B 形态（管理工具插件）设计稿](docs/design/b-form-tools-design.md)（暂不实现）
