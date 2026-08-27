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

**方式一：`--patch` 直挂源码（推荐——零构建零打包，不动 profile）**

```bash
# 在本仓库根目录执行；两种挂法任选：
dsh web --patch ./examples/dev.example.yml   # 免修改：panelUrl/token/model 全走环境变量
# 或复制私有副本 examples/dev.yml（已 gitignore），写死自己的真实值：
dsh web --patch ./examples/dev.yml
```

模板见 [examples/dev.example.yml](examples/dev.example.yml)：`name` 用相对路径直指 `src/index.ts`
（已实测 npx 安装的 dsh CLI 也能加载 TS 源码，相对路径按 dsh 工作目录解析）；本地私有副本
`examples/dev.yml` 已被 .gitignore 忽略，写真实地址/token 不会被提交。改完代码重启 dsh 即生效，
`--patch` 作为 argv 层叠加在当前 profile 之上，验证「源码 + 显式配置」组合最顺手。

**方式二：dev profile + 本地目录安装（贴近真实安装形态，发版前演练用）**

```bash
npm run build
dsh plugin --profile dev add /绝对路径/llamapad-dsh-plugin
# 每轮改动后：npm run build && 重新执行同一条 add（实测目录重 add 会刷新实装拷贝）
```

⚠️ 注意坑：**同版本 tgz** 重新 `add` **不会**刷新——pnpm 按依赖 spec 路径缓存，文件名不变
就跳过重装（实测确认）。要刷新已装的 tgz，换文件名（如复制改名 `-dev1.tgz`）或改用目录方式。

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
- [手工冒烟手册](docs/manual-smoke.md)
- [dsh 插件调研归档](docs/research/2026-08-24-dsh-plugin-research.md)（契约细节 + UX 评估依据）
- [B 形态（管理工具插件）设计稿](docs/design/b-form-tools-design.md)（暂不实现）
