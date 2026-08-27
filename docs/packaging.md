# 打包与发布（tgz 制品）

> 面向维护者：插件内容变化后如何产出新版可安装制品，以及用户侧如何更新。
> 安装侧的用户文档见 README「安装到 dsh」。

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
npm run release              # patch 递增（默认）
npm run release -- minor     # 行为/依赖变更（0.x 阶段破坏性改动也用 minor）
npm run release -- 0.2.0     # 显式版本
```

脚本（`scripts/release.mjs`）依次执行：

1. **清洁检查**：工作区必须干净——制品的版本号要能对应到提交；不干净则拒绝（`--allow-dirty` 强制跳过，不建议）
2. **质量门禁**：`typecheck` → 单测 → 假面板 E2E，任一失败即中止
3. **版本递增**：写入 `package.json` 并同步 `package-lock.json` 两处 version
4. **构建**：esbuild 打 `src/` → `dist/index.js`（`@deepseek-ai/*` 保持 external）
5. **打包**：`npm pack`（prepare 钩子会再构建一次，幂等），产出 `llamapad-dsh-plugin-<版本>.tgz`
6. **输出**：制品路径、sha256、安装/验证命令、建议的提交信息

产物不入库（`.gitignore` 忽略 `*.tgz` 与 `dist/`）。旧版 tgz 脚本**不自动删**——留着可用于
升级链路验证（先 add 旧版再 add 新版），确认无用后手动 rm。

## 版本策略（0.x 阶段）

- 适配器行为变化、契约调整、`@deepseek-ai/*` 钉版升级 → **minor**
- 缺陷修复、默认值微调 → **patch**
- dsh 生态仍在 rc 频繁变动，`@deepseek-ai/*` 必须钉精确版本（见 CLAUDE.md 关键约束）

## 提交惯例

源码改动先按「一任务一提交」落地，再跑 `npm run release`，版本变更单独提交（脚本会打印建议的
commit message，如 `release: v0.1.1`）。这样每份制品都能溯源：版本提交 ← 功能提交链。

## 同版本重打

只改了随包的 README / examples、不值得升版本时：

```bash
npm run pack:dsh    # 无门禁、不升版本，直接 npm pack
```

⚠️ 实测坑：**同版本同文件名的 tgz 重新 `add` 到已装的 profile 不会刷新**——pnpm 按依赖
spec 路径缓存，内容变了但路径没变就跳过重装。要刷新就换文件名（复制改名再 add），或改用
本地目录方式（目录重 add 会刷新，见 README「本地调试（不发布版本）」）。

## 本地调试（不发布版本）

开发期预览不需要 release/pack：`--patch` 直挂源码（`examples/dev-preview.yml`，npx 安装的
dsh CLI 也能加载 TS 源码，重启 dsh 生效），或 dev profile 装本地目录后每轮 `npm run build`
+ 重 `add`。三种方式的对比与实测结论见 README「本地调试（不发布版本）」。

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
