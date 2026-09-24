# 安装与接入

[English](../en/installation.md) · [返回 README](../../../README.md)

本包是一个标准的 [dsh bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)。装进 dsh profile 后，插件行会自动叠加到配置里，你只需要补上面板地址和 token。

开始之前，先准备好两样东西：

- 一个能访问的 [llamapad](https://github.com/lancelrq/llamapad) 面板，以及在面板里生成的 API token（`lp_` 开头）
- 已安装的 DeepSeek Harness（dsh），并且版本与本包依赖同代，见下文「版本要求」

## 第一步：安装插件

用 tgz 安装最省事，不需要在本机构建：

```bash
dsh plugin --profile <名> add ./llamapad-dsh-plugin-<版本>.tgz
```

tgz 可以从 GitHub Release 下载，也可以在仓库里自己打（见[开发与调试](development.md)）。

也可以直接从 GitHub 或本地目录装：

```bash
dsh plugin --profile <名> add github:LanceLRQ/llamapad-dsh-plugin
```

这种方式装的是源码，pnpm 会跑 `prepare` 脚本现场构建。pnpm 10 起默认不执行依赖的构建脚本，dsh 会提示你把包名加进 profile 的 `pnpm-workspace.yaml`，照做后重跑一次：

```yaml
allowBuilds:
  llamapad-dsh-plugin: true
```

## 第二步：填写连接信息

bundle 层只负责注册插件行，不带任何配置。编辑 profile 目录下的 `cordis.patch.yml`（路径是 `$DSH_HOME/profiles/<名>/cordis.patch.yml`），按 id 覆盖 llamapad 这一行：

```yaml
- id: llamapad
  name: llamapad-dsh-plugin
  config:
    panelUrl: http://192.168.1.10:8080
    token: !!js process.env.LLAMAPAD_TOKEN
```

完整模板在 [examples/profile-patch.example.yml](../../../examples/profile-patch.example.yml)，全部配置项见[配置参考](configuration.md)。

也可以先不写这一步。没配连接信息时 dsh 照常启动，设置页里的 llamapad 卡片会显示「未连接」，在卡片底部填好地址和 token 保存就能用，不用重启。详见[设置卡片与监控页](web-ui.md)。

## 可选：让 agent 默认用本地模型

在同一个文件里再覆盖 `agent-default-model` 这一行：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: llamapad
    model: <面板里的模型配置名>
```

## 可选：挂载管理工具

管理工具（`llamapad-dsh-plugin/tools`）默认不挂载。需要时在同一个文件里追加：

```yaml
- insert:
    - id: llamapad-tools
      name: llamapad-dsh-plugin/tools
      config:
        panelUrl: http://192.168.1.10:8080
        token: !!js process.env.LLAMAPAD_TOKEN
```

这里必须写成 `insert:`。「按 id 覆盖」只对组合树里已有的条目生效，而 bundle 层并没有声明过工具入口。写成覆盖的话，dsh 会报 `patch: entry "llamapad-tools" not found`，然后不注册任何工具，也没有其他提示。

工具入口没配 `panelUrl`/`token` 时只会打一条警告、跳过注册，补好配置后要重启 dsh。工具清单见[管理工具](tools.md)。

## 第三步：验证

```bash
dsh --profile <名> --dump-config   # 能看到 "# == llamapad-dsh-plugin" 层和 llamapad 行
dsh web                            # 模型选择器里出现面板上的模型
```

看不到模型时，多半是这两个原因：用户层那一行漏了 `id: llamapad`，或者改错了 profile 目录。

## 升级

已经装过的 profile，重新 `add` 新版 tgz 就会覆盖更新：

```bash
dsh plugin --profile <名> add ./llamapad-dsh-plugin-<新版本>.tgz
```

用 git 安装的，建议钉住 commit，避免上游变动：

```bash
dsh plugin --profile <名> add github:LanceLRQ/llamapad-dsh-plugin#<commit>
```

有一个坑：同版本、同文件名的 tgz 重新 `add` 不会刷新，因为 pnpm 按路径缓存。需要刷新就给文件改个名再装。

## 版本要求

本包对 `@deepseek-ai/*` 依赖钉的是精确版本，而且必须与宿主 dsh 同代。构建时这些依赖全部 external，运行时由 pnpm 按本包的钉版安装。如果本包钉的版本比宿主旧，就会出现两份框架并存，宿主拿新接口去调旧基类，直接报错。我们实际遇到过：`dsh-llm` 0.1.x 的运行时每次对话都会调用 `adapter.prepareCall`，而 0.0.1-rc.1 的基类没有这个方法。

当前钉版是 0.1.1-rc.2，包括 `dsh-llm`、`dsh-tools`、`dsh-attachment`、`dsh-system-prompt`。

## 升级提示：默认聊天行为已改为 strict

`chatBehavior` 的默认值是 `strict`：聊天时只使用已经在跑的模型，不会自动启停容器。早期版本的行为是「选了哪个模型就切到哪个」，如果你依赖这种行为，要在配置里显式写上 `chatBehavior: auto-switch`。三档的区别见[聊天路由与模型状态](chat-routing.md)。
