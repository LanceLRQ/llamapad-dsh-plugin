# 打包与发布（tgz 制品）

> 面向维护者：插件内容变化后如何产出新版可安装制品，以及用户侧如何更新。
> 安装侧的用户文档见 README「安装到 dsh」。

## 三个入口

本包导出三个入口，构建与挂载方式各不相同：

| 入口 | 产物 | Config / inject | 挂载方式 |
|---|---|---|---|
| `.`（A 形态，LLM 适配器） | `dist/index.js` | `src/index.ts` 的 `Config`，`inject:['llm']` | bundle 层 `cordis.patch.yml` 已默认声明（`name: llamapad-dsh-plugin`），随 `dsh plugin add` 自动挂载 |
| `./tools`（B 形态，管理工具） | `dist/tools.js` | `src/tools.ts` 的 `Config`，`inject:['tools']` | **不随 bundle 默认挂载**，需要时在 profile 自己的 `cordis.patch.yml` 里用 `insert:` 追加一条 `name: llamapad-dsh-plugin/tools`（模板见 `examples/profile-patch.example.yml` 注释段），改完重启 dsh |
| `./client`（浏览器端设置卡片） | `dist/client.js` | 无独立 Config；由 `package.json` 的 `dsh.client` 字段声明，宿主按 `exports['./client']` 解析加载，不经 cordis 挂载配置 | 不是插件行，随 A 形态的 fiber 一起被宿主发现；A 形态未配置 `panelUrl`/`token`（`apply()` 提前返回）时不会注册卡片 RPC，卡片也不出现。产物格式与构建约束见下节 |

A、B 两个入口是标准 dsh 插件行，B 入口必须用 `insert:` 形式追加，不能照抄 A 形态那种「按 id
覆盖」的写法——用户层的覆盖只作用于**已存在于组合树里**的条目，而 B 入口没被任何 bundle 层
声明过，写成覆盖会得到 `patch: entry "llamapad-tools" not found` 并**静默不注册**（dsh
0.1.1-rc.2 实测）。

A、B 可以同时挂载，也可以只挂其中一个；各自的 Config 相互独立（各填一份 `panelUrl`/`token`，
互不读取对方），但共享同一份 `panel-client.ts`/`switching.ts`，同一 `panelUrl` 下的启停会经
同一把共享门（`sharedModelGate`），不会出现两个入口互相插队"一边起一边停"。B 入口不默认挂载，
是为了不改变既有用户（只用 A 形态）的行为。

## 浏览器端产物（`./client`）

### exports 必须放行 `./package.json`

`package.json` 的 `exports` 字段除了三个入口本身，还必须有 `"./package.json": "./package.json"`
这一条：宿主 `dsh-client-modules` 的 `resolveMeta` 用 `require.resolve('<包名>/package.json')`
去读 `dsh.client` 字段，`exports` 不放行这条子路径会导致该次解析失败——而失败路径是 `catch`
之后**静默跳过**，不报错、不告警，卡片永远不出现，构建产物齐全也没用。

### `dsh.bundle` 与 `dsh.client` 是并列子字段，不能互相覆盖

`package.json` 的 `dsh` 字段下有两个并列子字段：

- `dsh.bundle.patch`：本包作为 **profile bundle** 时默认要 insert 的 cordis 补丁模板路径
  （`./cordis.patch.yml`）
- `dsh.client`：本包作为**浏览器插件**时的声明（`platform` + `inject` 依赖列表）

两者必须同时挂在同一个 `dsh` 对象下作为并列 key（参照本包当前 `package.json` 的写法）。整体
赋值 `dsh` 字段会把另一个抹掉，症状是 dsh 启动即失败：
`profile bundle "llamapad-dsh-plugin" declares no dsh.bundle in its package.json`。

### 构建约束（结论，细节与逆向依据见设计文档）

`scripts/build.mjs` 第二趟用 `platform:'browser'` + `format:'cjs'` + banner/footer 把
`src/client/index.tsx` 打成 `dist/client.js`，产物格式是
`window.__ModuleLoader__.load({ id, factory })` 惰性 CJS 工厂：

- **只有 7 个 seed 模块能 external**：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`。宿主的模块表是硬编码静态种子表，**require 落空是
  loud throw**，不是静默降级，其余依赖必须真打进产物。`test/e2e/client-bundle-format.test.ts`
  用 `node:vm` 模拟宿主 loader 守住这条。
- **产物缺失或格式不对 = 整个插件（连 A 形态一起）加载失败**，不是「卡片不显示」——`dsh.client`
  是 `package.json` 静态字段，无法条件关闭，所以 `dist/` 虽不入库，装载前必须先 `pnpm run
  build`。这是选择「单包三入口」而非「卡片单独成包」时明确接受的代价。

三条红线（含 minify 的具体后果、seed 模块表的来源）逐条写在 `scripts/build.mjs` 注释里，架构
与四条真机才暴露的硬约束见 [设置卡片设计记录](design/settings-card-design.md)。

### `devDependencies` 里的浏览器端类型专用包

`@deepseek-ai/dsh-client-ui-slots` / `@deepseek-ai/dsh-client-ui-primitives` 只作为
`devDependency` 存在：它们没有独立发布到 profile 的 `node_modules`，而是被打进宿主 shell 的
`dist` 当运行时单例（上面「只有 7 个 seed 模块能 external」正是指它们由宿主注入而非随本包产物
分发），本地装它们只是为了 `tsc`/编辑器的类型检查能过。不要因为「运行时用不到」把它们从
`devDependencies` 里删掉，删了类型检查会失败。

## 何时需要重新打包

任何会进入制品的内容变更：

| 变更 | 随制品方式 | 需要重新打包 |
|---|---|---|
| `src/` 代码 | 构建进 `dist/` | ✅ |
| `cordis.patch.yml`（bundle 层） | 原样随包 | ✅ |
| `package.json`（依赖钉版、入口、files） | 原样随包 | ✅ |
| `README.md` / `examples/` | 原样随包 | ✅（纯文档错字可同版本重打，见下） |
| `docs/`、`test/`、`scripts/` | 不随包 | ❌ 不用打包 |

## 一键重打包

```bash
pnpm run release              # patch 递增（默认）
pnpm run release minor     # 行为/依赖变更（0.x 阶段破坏性改动也用 minor）
pnpm run release 0.2.0     # 显式版本
```

脚本（`scripts/release.mjs`）依次执行：

1. **清洁检查**：工作区必须干净——制品的版本号要能对应到提交；不干净则拒绝（`--allow-dirty` 强制跳过，不建议）
2. **质量门禁**：`typecheck` → 单测 → 假面板 E2E，任一失败即中止
3. **版本递增**：写入 `package.json` 并同步 `package-lock.json` 两处 version
4. **构建**：esbuild 打 `src/` → `dist/{index,tools,client}.js`（Node 侧 `@deepseek-ai/*` 保持
   external，浏览器侧仅 7 个 seed 模块 external，见上「浏览器端产物」）
5. **打包**：`pnpm pack`（prepare 钩子会再构建一次，幂等），产出 `llamapad-dsh-plugin-<版本>.tgz`
6. **输出**：制品路径、sha256、安装/验证命令、建议的提交信息

产物不入库（`.gitignore` 忽略 `*.tgz` 与 `dist/`）。旧版 tgz 脚本**不自动删**——留着可用于
升级链路验证（先 add 旧版再 add 新版），确认无用后手动 rm。

## 版本策略（0.x 阶段）

- 适配器行为变化、契约调整、`@deepseek-ai/*` 钉版升级 → **minor**
- 缺陷修复、默认值微调 → **patch**
- dsh 生态仍在 rc 频繁变动，`@deepseek-ai/*` 必须钉精确版本（见 CLAUDE.md 关键约束）

## 提交惯例

源码改动先按「一任务一提交」落地，再跑 `pnpm run release`，版本变更单独提交（脚本会打印建议的
commit message，如 `release: v0.1.1`）。这样每份制品都能溯源：版本提交 ← 功能提交链。

## 同版本重打

只改了随包的 README / examples、不值得升版本时：

```bash
pnpm run pack:dsh    # 无门禁、不升版本，直接 pnpm pack
```

⚠️ 实测坑：**同版本同文件名的 tgz 重新 `add` 到已装的 profile 不会刷新**——pnpm 按依赖
spec 路径缓存，内容变了但路径没变就跳过重装。要刷新就换文件名（复制改名再 add），或改用
本地目录方式（目录重 add 会刷新，见 README「本地调试（不发布版本）」）。

## 本地调试（不发布版本）

开发期预览不需要 release/pack：**装进 web profile**（`dsh plugin --profile web add 本仓库`，link:
软链，每轮 `pnpm run build` + 重启 dsh 即生效）+ 用户层 `~/.dsh/profiles/web/cordis.patch.yml`。
⚠️ 安装版 dsh 的 `--patch` 不解析模块路径行（`./src/index.ts`、`./dist/index.js`、绝对路径均被
静默忽略，实测确认）；路径直挂仅限从 dsh 源码仓库运行的场景（`examples/dev.example.yml`）。
三种方式对比见 README「本地调试（不发布版本）」。

## 用户侧如何更新到新版

已装旧版的 profile 重新 `add` 新 tgz 即覆盖更新（已实测 0.1.0 → 0.1.1：依赖指向新制品、
`dsh.profile.bundles` 层列表不变不重复、node_modules 实装新版本）：

```bash
dsh plugin --profile <名> add ./llamapad-dsh-plugin-<新版本>.tgz
```

git 安装的用户用新 commit 重新 add（钉 sha，防上游漂移）：

```bash
dsh plugin --profile <名> add github:LanceLRQ/llamapad-dsh-plugin#<新sha>
```

更新后验证：

```bash
dsh --profile <名> --dump-config    # "# == llamapad-dsh-plugin" 层仍在
```

## 分发渠道（任选，都不强制 npm 发号）

- **GitHub Release 附 tgz**：release 脚本产出的制品直接上传，用户下载后 add——首选
- **npm 发布**：`npm publish`（publish 前自动跑 prepare 构建），用户 `dsh plugin add llamapad-dsh-plugin`
