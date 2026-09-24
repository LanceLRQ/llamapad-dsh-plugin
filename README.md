# llamapad-dsh-plugin

中文 · [English](README.en.md)

把 [llamapad](https://github.com/lancelrq/llamapad) 管理的本地 llama.cpp 模型接入 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）。

装好之后，面板上的模型会出现在 dsh 的模型选择器里，选中就能聊天。另外还提供一组 Agent 工具（查看、启动、停止本地模型），以及设置页里的一张面板卡片和一个 GPU 监控页。llamapad 本身不需要做任何改动。

## 功能

- 本地模型直接当 dsh 的 provider 用，支持流式输出、思考强度、贴图输入
- 默认只使用已经在跑的模型，聊天过程不会触发启停；需要时可以改成自动启动
- 支持面板同时运行多个模型，选择器上用 `▶︎` 标出运行中的模型，用 `★` 标出默认模型
- 面板状态靠事件推送更新，模型启停后选择器很快就能反映出来
- 设置卡片：查看运行状态、启停模型、在卡片里直接配置连接
- GPU 监控页：吞吐、显存、利用率、温度等曲线
- 管理工具：让 Agent 自己查询、启停本地模型，可以要求先经过人工确认

## 让 dsh 自己安装

在 dsh 里新开一个会话，把下面这句话发给它。它会先问你面板地址和 token，然后自己完成下载、安装和配置，装好后重启 dsh 即可。其他能执行命令的 AI 助手也可以照这份说明来装：

```text
请阅读 https://raw.githubusercontent.com/LanceLRQ/llamapad-dsh-plugin/main/docs/guide/zh/ai-install.md ，按里面的步骤帮我安装并配置 llamapad-dsh-plugin。
```

## 快速开始

需要先准备：一个能访问的 llamapad 面板和它的 API token，以及已安装好的 dsh（版本要求见[安装与接入](docs/guide/zh/installation.md#版本要求)）。

1. 安装插件：

   ```bash
   dsh plugin --profile <名> add ./llamapad-dsh-plugin-<版本>.tgz
   # 或者：dsh plugin --profile <名> add github:LanceLRQ/llamapad-dsh-plugin
   ```

2. 在 `$DSH_HOME/profiles/<名>/cordis.patch.yml` 里填上面板地址和 token：

   ```yaml
   - id: llamapad
     name: llamapad-dsh-plugin
     config:
       panelUrl: http://192.168.1.10:8080
       token: !!js process.env.LLAMAPAD_TOKEN
   ```

   这一步也可以跳过，启动 dsh 后在「设置 → 插件 → 插件配置」的 llamapad 卡片里填。

3. 启动 `dsh web`，在模型选择器里选一个面板上的模型开始对话。

默认的 `strict` 模式只使用已经在跑的模型。所以第一次用之前，先去面板启动一个模型，或者在设置卡片里点启动。

## 文档

| 文档 | 内容 |
|---|---|
| [AI 安装指引](docs/guide/zh/ai-install.md) | 给 dsh 执行的分步安装说明，人也可以照着做 |
| [安装与接入](docs/guide/zh/installation.md) | 安装、连接配置、挂载管理工具、升级、版本要求 |
| [配置参考](docs/guide/zh/configuration.md) | 全部配置项、思考强度、自定义镜像的注意事项 |
| [聊天路由与模型状态](docs/guide/zh/chat-routing.md) | `chatBehavior` 三档、多模型、选择器标记、状态刷新 |
| [管理工具](docs/guide/zh/tools.md) | 6 个 Agent 工具与审批设置 |
| [设置卡片与监控页](docs/guide/zh/web-ui.md) | 网页端卡片和 GPU 监控页 |
| [多模态与系统提示快照](docs/guide/zh/multimodal-and-prompt.md) | 贴图输入、系统提示里的本地模型清单与隐私说明 |
| [开发与调试](docs/guide/zh/development.md) | 构建、本地调试、测试、开发记录索引 |

## 相关项目

- [llamapad](https://github.com/lancelrq/llamapad)：本插件对接的 llama.cpp 模型管理面板
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：插件的宿主

## 许可证

[MIT](LICENSE)
