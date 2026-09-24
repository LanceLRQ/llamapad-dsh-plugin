# 开发与调试

[English](../en/development.md) · [返回 README](../../../README.md)

## 常用命令

```bash
pnpm install
pnpm run build       # esbuild 把 src/ 打成 dist/{index,tools,client}.js
pnpm test            # 单元测试
pnpm run test:e2e    # 假面板 E2E，不需要真实的 llamapad 和 GPU
pnpm run typecheck
pnpm run release     # 检查 → 测试 → 升版本 → 构建 → 出 tgz
```

包管理器用 pnpm，`pnpm-lock.yaml` 已提交到仓库。

## 包的三个入口

| 入口 | 产物 | 用途 |
|---|---|---|
| `llamapad-dsh-plugin` | `dist/index.js` | LLM 适配器，随 bundle 自动挂载 |
| `llamapad-dsh-plugin/tools` | `dist/tools.js` | 管理工具，需要手动 `insert:` |
| `llamapad-dsh-plugin/client` | `dist/client.js` | 浏览器端的设置卡片和监控页，随适配器一起加载，不需要单独配置 |

## 先构建再启动 dsh

`dist/` 不提交到仓库。`package.json` 里声明了 `dsh.client`，宿主找不到 `dist/client.js` 时，整个插件都会加载失败，包括 LLM 适配器，不只是卡片不显示。

用 tgz 或 git 安装时 `prepare` 钩子会自动构建。用 `link:` 软链调试或直接跑源码时，启动 dsh 前要先手动执行一次 `pnpm run build`，之后每次改代码也一样。

## 本地调试

### 推荐：装进 web profile

```bash
# 只需执行一次：把本仓库作为 link: 依赖装进 web profile（dsh web 默认用它）
dsh plugin --profile web add /绝对路径/llamapad-dsh-plugin
# 配置写在 ~/.dsh/profiles/web/cordis.patch.yml，模板见 examples/profile-patch.example.yml
dsh web        # http://127.0.0.1:3080
```

因为是软链，之后每次改动只需 `pnpm run build`，再重启 dsh，不用重新 add。

实际踩过的两个坑：

- 安装版 dsh（npx 或全局安装）的 `--patch` 不解析模块路径。`./src/index.ts`、`./dist/index.js`、绝对路径都会被忽略，不报错，服务照常启动，所以别用 `dsh web --patch examples/dev.yml` 调试。判断插件有没有加载，看启动日志里有没有 `[llamapad-dsh-plugin]`。
- 同版本的 tgz 重新 add 不会刷新，pnpm 按路径缓存。用目录 link 方式就没有这个问题。

### 在 dsh 源码仓库里直接挂 TS 源码

如果你是从 [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 源码运行的，它的开发 loader 能直接加载 TS：

```bash
pnpm dsh web --patch /绝对路径/examples/dev.example.yml
```

模板见 [examples/dev.example.yml](../../../examples/dev.example.yml)。本地私有副本 `examples/dev.yml` 已经加进 gitignore。

### 只跑测试

改适配器逻辑时，最快的验证方式是 `pnpm test` 加 `pnpm run test:e2e`。E2E 用的是 Node 写的假面板，不依赖 dsh 和真实环境。

## 打包与发布

版本策略、`release` 脚本的执行步骤、浏览器端产物的构建约束，都写在 [docs/packaging.md](../../packaging.md)。

## 开发记录

这些是开发过程中的设计稿和实施计划，只有中文：

- [dsh 插件调研](../../research/2026-08-24-dsh-plugin-research.md)：dsh 契约细节与 UX 取舍依据
- [LLM 适配器实施计划](../../plans/2026-08-24-a-form-adapter.md)
- [聊天路由与生命周期解耦](../../design/chat-vs-lifecycle-decoupling.md)
- [设置卡片设计记录](../../design/settings-card-design.md)
- [管理工具设计稿](../../design/b-form-tools-design.md)
- [多模态、监控、事件、提示词快照方案](../../design/2026-09-03-multimodal-monitor-events-prompt.md)，以及五个里程碑计划：[M1](../../plans/2026-09-03-m1-quick-wins.md)、[M2](../../plans/2026-09-03-m2-multimodal.md)、[M3](../../plans/2026-09-03-m3-events.md)、[M4](../../plans/2026-09-03-m4-monitor.md)、[M5](../../plans/2026-09-03-m5-fleet-prompt.md)
- [多模型并行适配计划](../../plans/2026-09-21-multi-model-adapt.md)
- [手工冒烟手册](../../manual-smoke.md)
