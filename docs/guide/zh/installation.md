# 安装与接入

[English](../en/installation.md) · [返回 README](../../../README.md)

本包是一个标准的 [dsh bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md)。装进 dsh profile 后，插件行会自动叠加到配置里，你只需要补上面板地址和 token。

开始之前，先准备好两样东西：

- 一个能访问的 [llamapad](https://github.com/lancelrq/llamapad) 面板，以及在面板里生成的 API token（`lp_` 开头）
- 已安装的 DeepSeek Harness（dsh），并且版本与本包依赖同代，见下文「版本要求」

## 第一步：安装插件

### 桌面版：粘贴地址安装

dsh 桌面版（0.2.0+）不用敲命令，直接在界面里装：

1. 打开左侧「插件」页，点「添加插件」
2. 输入框里粘贴本插件的仓库地址：

   ```text
   https://github.com/LanceLRQ/llamapad-dsh-plugin
   ```

   插件没有发布到 npm，只填包名是装不到的，要粘贴完整的仓库地址
3. 点「安装」。装完在「已安装」列表里找到 llamapad-dsh-plugin，进详情页在「llamapad Model Panel」卡片里直接填面板地址和 token（见[第二步](#第二步填写连接信息)），不必手改配置文件

从仓库地址安装走的是源码构建，和下文 `github:` 源安装是同一套机制，遇到构建脚本的允许提示照做重试即可。另外桌面版对插件**暂不支持自动更新**（界面里也有此提示）：升级时先在插件页卸载，再按同样地址重装一次。

### 命令行：tgz 安装

用 tgz 安装最省事，不需要在本机构建：

```bash
dsh plugin --profile <名> add ./llamapad-dsh-plugin-<版本>.tgz
```

tgz 可以从 GitHub Release 下载，也可以在仓库里自己打（见[开发与调试](development.md)）。

国内访问 GitHub 慢时可用镜像下载（与 GitHub Releases 字节一致，自带 `.sha256` 可校验，由 Cloudflare CDN 分发）：

- 指定版本：`https://download.hutao.wiki/llamapad-dsh-plugin/releases/download/v<版本号>/llamapad-dsh-plugin-<版本号>.tgz`
- 最新版便利路径：`https://download.hutao.wiki/llamapad-dsh-plugin/releases/latest/download/llamapad-dsh-plugin-<版本号>.tgz`


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

本包支持 dsh 0.1.5-rc.3 到 0.2.0.x。`@deepseek-ai/*` 框架依赖声明的是版本范围（peerDependencies），不是精确版本，运行时统一使用宿主自带的那一份。

dsh 0.1.7 及以上（含 0.2.0 桌面版与 CLI）在安装和启动时会拿这个范围和自己的版本比对（预发布版本也参与匹配），不在范围内就拒绝安装并给出提示。dsh 0.1.5 没有这项检查，所以在范围外的 dsh 上强行安装时，问题要到加载或对话时才会暴露。

## 升级提示：默认聊天行为已改为 strict

`chatBehavior` 的默认值是 `strict`：聊天时只使用已经在跑的模型，不会自动启停容器。早期版本的行为是「选了哪个模型就切到哪个」，如果你依赖这种行为，要在配置里显式写上 `chatBehavior: auto-switch`。三档的区别见[聊天路由与模型状态](chat-routing.md)。
