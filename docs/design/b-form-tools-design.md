# B 形态设计稿：llamapad 管理工具插件

> **实施状态（2026-08-27）**：已落地。4 个工具见 `src/tools.ts`，入口
> `llamapad-dsh-plugin/tools`（`dist/tools.js`），单测 `test/unit/tools.test.ts`、
> E2E `test/e2e/tools-e2e.test.ts`。本文档 §3 示例代码已按实现订正为真实 DSL，
> §4 的 execute 错误语义按实现改为"失败直接 throw"，§6 三项待办已给出结论（见
> 各节标注）。
>
> 用户决策（2026-08-24）：A、B 两形态都要，先做 A（M4 真机未跑）；B 只设计不实现。
> 本文档在 A 形态落地后作为其实施输入，2026-08-27 完成落地。

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

## 3. defineTool 形状（真实 DSL，与 `src/tools.ts` 一致）

`defineTool({ name, description, parameters, output: { schema, render }, execute })`——
除 `timeoutMs`/`isConcurrencySafe`/`presentCall`/`presentResult` 外全部必填。`parameters` 是
「属性名 → 属性 spec」的隐式开放对象根，顶层不写 `additionalProperties`；必填参数写
`required: true`（字面量，写 `false` 会在编译期抛 `JsonSchemaError`），可选参数直接省略
`required`。嵌套对象（`output.schema` 里的对象类型）的 `additionalProperties: boolean` 是必填
字段，每一层都要写。`ContentBlock` 从 `@deepseek-ai/dsh-llm` 导入，文本块形状是
`{ type: 'text', text: string }`。

```ts
import type { Context } from "@deepseek-ai/cordis";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createPanelClient, PanelError } from "./panel-client";

export const name = "llamapad-dsh-plugin/tools";
export const inject = ["tools"];

export function apply(ctx: Context, config: Config) {
  const client = createPanelClient({ baseUrl: config.panelUrl, token: config.token });

  ctx.tools.register(defineTool({
    name: "llamapad_status",
    description: "查看 llamapad 管理的本地模型运行状态（当前运行哪个模型、面板是否可达）。不做任何变更。",
    parameters: {},
    output: {
      schema: {
        type: "object",
        properties: {
          panelReachable: { type: "boolean", required: true },
          running: { type: "boolean", required: true },
          model: { type: "string" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: value.running ? `运行中：${value.model}` : "无模型在运行" }],
    },
    async execute() {
      try {
        const status = await client.runtimeStatus();
        if (!status.running) return { panelReachable: true, running: false };
        return { panelReachable: true, running: true, model: status.running.model };
      } catch (error) {
        if (error instanceof PanelError) return { panelReachable: false, running: false };
        throw error;  // 非 PanelError 的异常仍然照抛，交给框架的 toolErrorResult 兜底
      }
    },
  }));

  // llamapad_start_model：复用 A 形态的共享门 sharedModelGate（同 baseUrl 单例 + 同目标合流）
  // llamapad_stop_model / llamapad_list_models：同构，实现见 src/tools.ts
}
```

## 4. 与 A 形态的共享边界

- **共享**：`panel-client.ts`（REST 封装）、`switching.ts`（ensure 门，经 `sharedModelGate` 按
  `client.baseUrl` 归一为包级单例）——A 先实现，B 直接复用
- **不共享**：Config 入口与插件注册（`inject: ['llm']` vs `['tools']`）；发布形态是同一包的两个
  入口（`.` 与 `./tools`），由用户在 profile 的 `cordis.patch.yml` 决定挂哪个（见
  `docs/packaging.md`「两个入口」）
- 工具的 `execute` **失败直接 throw**：框架的 `toolErrorResult` 会接住任何异常，转成
  `isError:true` + `Error: <message>` 文本喂给模型。不做 `{ error: { code, message } }` 的
  canonical 返回值联合体——那会逼 `output.schema` 用 `oneOf`，白白复杂化，且框架已经提供了
  等价的错误通道。查询类工具（`llamapad_status`）把「面板不可达」当作**有效答案**返回而不是
  异常，是因为对调用方而言这是可预期的正常状态之一，不是基础设施故障。

## 5. 安全与边界

- token 以 `role('secret')` 声明，走 `!!js process.env.LLAMAPAD_TOKEN` 注入，不落配置文件明文
- 工具描述里明确「只影响本地 llamapad 面板管理的模型」，避免模型把它当通用 Docker 管理工具
- 启动等待超时默认 300s（与 A 一致）；`waitReady:false` 提供给模型做乐观启动

## 6. 实施前待办（结论）

1. **`output.schema` DSL 表达力**：不是原始 JSON Schema，而是一套独立的作者态 DSL
   （`ValueSchemaSpec`：`string/number/integer/boolean/null/array/object/json/oneOf`），编译期转成
   受限 JSON Schema 子集。对象类型的 `additionalProperties: boolean` 每层必填；数组 `items` 是
   单个 `ValueSchemaSpec`（无 tuple）。详见 §3 与 `src/tools.ts` 的实际用法。
2. **`llamapad_list_models` 截断策略**：按 name 升序取前 100 条（`LIST_MODELS_LIMIT`），返回
   `total`（真实总数）+ `truncated`（是否被截断），不做 quant/命名空间分组摘要——分组摘要会让
   模型拿到的信息与"具体是哪个模型"脱节，纯截断 + 总数足够模型判断要不要进一步按名查询。
3. **gate 共享**：提升为包级单例 `sharedModelGate(client)`（`switching.ts`），按 `client.baseUrl`
   用 `Map<baseUrl, Gate>` 归一，不是 cordis Service——两个入口（A 的 `index.ts`、B 的
   `tools.ts`）各自 `apply()` 时都调用它，同一 baseUrl 下第一次调用的 client 决定这把门实际绑定
   的语义，之后的调用复用同一实例。选择模块级单例而非 cordis Service 是因为门本身不持有需要
   随插件生命周期回收的资源（无定时器/连接），一个跨调用方共享的纯函数式缓存已经够用。
