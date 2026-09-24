# 管理工具

[English](../en/tools.md) · [返回 README](../../../README.md)

`llamapad-dsh-plugin/tools` 是一个独立的插件入口，给 dsh 的 Agent 提供一组工具，用来查看和启停本地模型。不管 Agent 背后用的是本地模型还是云端模型，都可以调用这些工具。挂载方法见[安装与接入](installation.md#可选挂载管理工具)。

它和 LLM 适配器共用同一个面板客户端和同一把启停锁（按 `panelUrl` 区分），两个入口不会出现一边启动一边停止的情况。

## 工具列表

| 工具 | 参数 | 作用 |
|---|---|---|
| `llamapad_status` | 无 | 面板是否可达，列出所有在跑的模型、是否就绪、哪个是默认。只探测默认模型是否在忙，探测不到时省略这项，不会误报成「空闲」 |
| `llamapad_list_models` | 无 | 按名称列出全部模型配置，最多 100 条，`total` 和 `truncated` 反映是否截断 |
| `llamapad_events` | `limit`、`kind`，均可选 | 查面板的事件记录，排障时用得上，比如回答「模型为什么停了」。`limit` 默认 20、最多 100；`kind` 按类型精确过滤，如 `model.exit` 只看容器异常退出 |
| `llamapad_start_model` | `model` 必填；`waitReady`、`drain`、`timeoutMs` 可选 | 启动模型。老面板会先停掉旧的再起新的，多模型面板只保证目标在跑，不影响其他模型。`drain` 默认开启，不打断正在输出的对话 |
| `llamapad_stop_model` | `model`、`drain`、`drainTimeoutMs`，均可选 | 停止指定模型，不传 `model` 就停默认模型。目标没在跑时返回 `stopped:false`，不会改去停别的模型 |
| `llamapad_set_default_model` | `model` 必填 | 切换面板的默认模型。目标必须已在跑，否则面板返回 409。老面板会提示需要多模型版本 |

删除模型或文件、修改配置、管理下载这些操作没有做成工具。它们风险高，留在面板里由人来确认比较稳妥。

工具出错时直接抛出异常，dsh 会把它转成模型能读懂的错误信息。

## 并发与呈现

除 `llamapad_set_default_model` 外，其余五个工具都声明了 `isConcurrencySafe`，dsh 可以把它们放进同一批并行调用。查询类工具本来就只读，启停经过共享锁串行化。设默认模型改的是全局路由目标，所以不参与并行。

在界面上，`llamapad_status` 显示成一张终端卡，面板不可达时退出码是 1。`llamapad_events` 也用终端卡，每行一条 `[时间] 类型 描述`，最新的排在最前。启动、停止、设默认三个工具的调用卡带有 `execute` 标记，提示它们会改变面板状态。

## 审批：toolApproval

把 `toolApproval` 设为 `ask` 后，Agent 调用启动、停止、设默认三个工具前，dsh 会先弹出确认。如果宿主没有审批通道，框架会把 `ask` 当作拒绝，不会在没人确认的情况下执行。

多人共用 GPU 时建议开启。这些操作会影响其他人的会话。
