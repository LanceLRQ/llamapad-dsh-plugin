# 配置参考

[English](../en/configuration.md) · [返回 README](../../../README.md)

配置写在 profile 的 `cordis.patch.yml` 里 llamapad 那一行的 `config` 下，写法见[安装与接入](installation.md)。面板地址和 token 也可以直接在设置卡片里填，卡片保存的值优先级更高，改完立即生效。

## LLM 适配器（`llamapad-dsh-plugin`）

| 字段 | 默认值 | 说明 |
|---|---|---|
| `panelUrl` | 必填 | 面板地址，如 `http://192.168.1.10:8080` |
| `token` | 必填 | 面板 API token，`lp_` 开头。建议用 `!!js process.env.LLAMAPAD_TOKEN` 从环境变量读 |
| `panelPublicUrl` | 同 `panelUrl` | 浏览器能访问到的面板地址，给设置卡片的「在浏览器中打开面板」按钮用。`panelUrl` 是 dsh 后端视角的地址，常常是 `127.0.0.1`，dsh 和浏览器不在同一台机器时要单独配 |
| `provider` | `llamapad` | 在 dsh 里注册的 provider 名 |
| `mode` | `proxy` | 数据面模式：`proxy` 或 `direct` |
| `llamaBaseUrl` | — | `direct` 模式下 llama.cpp 的地址 |
| `chatBehavior` | `strict` | `strict` / `passthrough` / `auto-switch`，见[聊天路由](chat-routing.md) |
| `startTimeoutMs` | `300000` | 启动后等待就绪的超时，只在 `auto-switch` 下生效 |
| `pollIntervalMs` | `2000` | 就绪探测间隔，只在 `auto-switch` 下生效 |
| `drainOnSwitch` | `true` | 启动或停止前，是否先等服务端处理完正在推理的请求。`auto-switch` 和设置卡片的启停按钮共用 |
| `drainTimeoutMs` | `60000` | 上面那次等待最长多久 |
| `requestTimeoutMs` | `30000` | 控制面单个请求的超时 |
| `defaultContextWindow` | — | 面板查不到上下文长度时报给 dsh 的兜底值 |
| `statusRefreshMs` | `5000` | 状态刷新节拍。事件模式下是看门狗的检查间隔，降级后是轮询间隔。设为 `0` 完全关闭 |
| `hideStoppedModels` | `false` | 选择器只显示运行中的模型。`auto-switch` 下无效 |
| `statusPromptSection` | `true` | 是否把本地模型清单写进系统提示，见[多模态与系统提示快照](multimodal-and-prompt.md) |

上下文长度取自面板的 `GET /api/v1/models/:name/effective`，也就是全局默认和模型覆盖合并后的生效值。如果模型配置了 `docker.args_override`，启动参数整个被替换，插件无从得知实际的上下文长度，这时干脆不报。

## 管理工具（`llamapad-dsh-plugin/tools`）

工具入口的配置和适配器相互独立，要单独填一份 `panelUrl` / `token`。它还有一个自己的字段：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `toolApproval` | `allow` | 设为 `ask` 时，调用启动、停止、设默认三个工具前要用户确认 |

## 思考强度（reasoning_effort）

`proxy` 模式支持思考强度。每个模型能接受哪些档位由面板根据它的 chat template 声明，dsh 的选择器会直接列出来。值怎么改写、怎么兜底都由面板的中转层处理，选了模板不认的档位也不会报错，面板会就近取整或丢掉这个字段。

档位声明只对在跑的模型有效。所以没启动的模型会列出完整的 `minimal / low / medium / high / xhigh / max`，启动之后才看到它真正支持的那几档。

`direct` 模式不支持思考强度。这个模式绕过了面板中转层，值域外的取值会被 chat template 的 jinja 校验拒掉，返回 HTTP 500。所以 direct 下插件不上报档位，传了思考强度会明确报错。

面板的推理中转路径 `/api/v1/proxy/llama/*` 还有一个短别名 `/llama-proxy/*`。配置里只需要填面板根地址，路径由插件拼接。

## 自定义镜像的注意事项

插件依赖 llama.cpp server 的三个行为：`/health` 从 503 变成 200 表示就绪、`/slots` 接口、OpenAI 兼容的流式 `/v1/chat/completions`。面板允许通过 `docker.entrypoint`、`args_override`、`extra_args`、`env`、`model_mount` 换成自定义镜像。如果换成的不是 llama.cpp server，排空检查会自动跳过，但就绪探测会一直等到 `startTimeoutMs` 超时，聊天请求也会 404。

遇到「启动成功但一直等不到就绪」，先去面板看看这几个字段有没有配。
