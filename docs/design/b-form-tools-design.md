# B 形态设计稿：llamapad 管理工具插件（设计先行，暂不实现）

> 用户决策（2026-08-24）：A、B 两形态都要，先做 A（M4 真机未跑）；B 只设计不实现。
> 本文档在 A 形态落地后作为其实施输入，届时再细化为 micro-step 计划。

## 1. 定位

A 形态让 dsh **把 llamapad 管理的本地模型当推理后端**（透明切换）；B 形态反过来：**任何模型**
（包括 DeepSeek 云端）跑的 Agent，把「查看/启停/切换本地模型」当作可调用的**工具**。典型玩法：

- 云端大模型做规划，按需把某个本地模型拉起来跑特定子任务（通过 A 的 provider 路由或自己的 HTTP 调用）
- 运维型对话：「帮我把 qwen3-8b 停了看看显存」→ Agent 调 `llamapad_stop_model`
- 与 A 共存：同一个插件包同时注册 provider 和 tools（分两个插件入口，共享 panel-client）

## 2. 工具清单（v1 候选）

| 工具名 | 参数 | 返回（canonical） | 说明 |
|---|---|---|---|
| `llamapad_status` | 无 | `{ running: { model, displayName, hostPort } \| null, panelReachable: boolean } | null`（不可达） | 当前运行模型 + 面板连通性 |
| `llamapad_list_models` | 无 | `{ models: [{ name, displayName, namespace, quant, sizeBytes, status }] }` | 列全部模型配置 |
| `llamapad_start_model` | `{ model: string, waitReady?: boolean (默认 true), timeoutMs?: number }` | `{ started: true, model } \| { error: { code, message } }` | 启动/切换（单模型语义，自动停旧）；`waitReady:false` 时立即返回 |
| `llamapad_stop_model` | 无 | `{ stopped: true } \| { error }` | 停止当前运行的模型 |

刻意不做：删除模型/文件、改配置、下载管理——高危操作留在 llamapad 面板的人工确认流程里，
工具面只开放**运行时调度**（与用户「插件只做连接和调度，不接管服务端」的边界一致）。

## 3. defineTool 形状（基于已核实的 DSL）

```ts
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createPanelClient, PanelError } from "../panel-client";

export const name = "llamapad-tools";
export const inject = ["tools"];

export function apply(ctx: Context, config: Config) {
  const client = createPanelClient({ baseUrl: config.panelUrl, token: config.token });

  ctx.tools.register(defineTool({
    name: "llamapad_status",
    description: "查看 llamapad 管理的本地模型运行状态（当前运行哪个模型、面板是否可达）。不做任何变更。",
    parameters: {},
    output: {
      schema: { type: "object" },  // 以 dsh 的 schema 表达力为准（见实施时核对 output.schema DSL）
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      try {
        const status = await client.runtimeStatus();
        return { running: status.running ?? null, panelReachable: true };
      } catch (error) {
        if (error instanceof PanelError) return { running: null, panelReachable: false };
        throw error;
      }
    },
  }));

  // llamapad_start_model：复用 A 形态的 createModelGate（同目标合流 + 就绪轮询）
  // llamapad_stop_model / llamapad_list_models：同构，略
}
```

## 4. 与 A 形态的共享边界

- **共享**：`panel-client.ts`（REST 封装）、`switching.ts`（ensure 门）——A 先实现，B 直接复用
- **不共享**：Config 入口与插件注册（`inject: ['llm']` vs `['tools']`）；发布形态上可以是同一包的两个
  入口（`./index` 与 `./tools`），由用户在 cordis.yml 决定挂哪个
- 工具的 `execute` **永远不抛业务错误给模型**：把 PanelError 翻译成 `{ error: { code, message } }`
  的 canonical 返回，让模型自己读到失败原因并决定下一步（工具协议里 throw 是基础设施故障语义）

## 5. 安全与边界

- token 以 `role('secret')` 声明，走 `!!js process.env.LLAMAPAD_TOKEN` 注入，不落配置文件明文
- 工具描述里明确「只影响本地 llamapad 面板管理的模型」，避免模型把它当通用 Docker 管理工具
- 启动等待超时默认 300s（与 A 一致）；`waitReady:false` 提供给模型做乐观启动

## 6. 实施前待办（届时核对）

1. `dsh-tools` 的 `output.schema` DSL 具体表达力（嵌套对象/数组怎么写、是否 JSON Schema 子集）
2. 工具结果大小限制（`llamapad_list_models` 在模型多时的截断策略：按 quant/命名空间分组摘要）
3. 与 A 同进程共存时，B 的 start 工具应走 A 的同一个 `createModelGate` 实例（避免两把锁互相插队）
——需要把 gate 提升为包级单例或经由 cordis service 共享（`class LlamapadGate extends Service`）
