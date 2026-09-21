# 多模型并行适配：micro-step 计划（2026-09-21）

依据：面板 `feature/multi-model` 分支（llamapad HEAD `ce1b742`，2026-09-18，领先 `dev` 33 个
提交，**尚未合并**）的契约调研。八个任务，一任务一提交，TDD。

## 背景：面板改了什么

面板解除了「同一时刻只运行一个模型」的约束（计划文档 `docs/superpowers/plans/2026-09-16-多模型并行.md`
的决策 D1–D12）。对本插件而言，全部变化可以收敛成一句话：

> `GET /api/v1/runtime/status` 的 `running` 字段**还在**，但语义从「唯一运行的模型」变成了
> 「**默认模型**」（面板 `src/server/modelsView.ts:205`、`src/server/runtime.ts:243-245`——
> 那段注释点名了要兼容 `llamapad-dsh-plugin`）。新增的 `models[]` 才是全部在跑的模型，
> 且**每一项都自带 `ready` 与 `hostPort`**（`modelsView.ts:186-200`）。

插件全程只读 `running`、从不带 `?model=`，于是在多模型面板上会出现六处沉默错配（严重度序）：

| # | 现象 | 落点 |
|---|---|---|
| P0-1 | auto-switch 档 100% 假超时，并留下幽灵实例 | `switching.ts:51-55` |
| P0-2 | strict 档把在跑的非默认模型判成「未运行」 | `routing.ts:66-84` |
| P0-3 | direct 模式端口拼错（且 `hostPort` 已改为实际发布端口） | `adapter.ts:239-241` |
| P1-4 | 提示词快照把在跑的模型列进「可启动」，诱导重建容器 | `fleet-snapshot.ts:69` |
| P1-5 | 非默认模型启停不触发目录刷新 | `status-watch.ts:191,202` |
| P1-6 | 卡片与 `llamapad_status` 只看得见默认模型 | `panel-gateway.ts:160`、`tools.ts:221` |

P0-1 的机制值得写清楚，它是最贵的一条：请求模型 B、默认模型是 A → 面板启动 B **且不再停掉
A** → 默认模型仍是 A → `probeReady` 比较 `running.model !== B` 恒为 false → 轮询到
`startTimeoutMs`（默认 300s）抛 `START_TIMEOUT`，**而 B 其实早就跑起来了，还一直占着显存**。

## 设计决策（2026-09-21 用户拍板，实现时不得偏离）

| # | 决策 | 落点 |
|---|---|---|
| A1 | **一律读 `models[]` 找目标模型，不依赖 `?model=`**。`models[]` 每项自带 `ready`/`hostPort`，一次往返拿全，也避开了老面板忽略未知查询参数的歧义 | 任务 1 |
| A2 | **双向兼容**：老面板没有 `models[]` 时，由 `running` 合成单元素数组。归一只有一处（`runningModels()`），全仓库判定都走它 | 任务 1 |
| A3 | `?model=` 只用在**需要精确 `busy` 探测**的地方（面板的 `?busy=1` 只探 `running` 那一项）。老面板忽略该参数、回给唯一模型，而那一档下唯一模型必然就是目标，安全 | 任务 1、2 |
| A4 | **auto-switch 只保证目标模型在跑，绝不停别的模型**（贴合面板新语义与插件既有用户边界「只做连接与模型调度，不接管服务端」）。显存不足导致的失败，在错误文案里列出当前其他在跑模型，提示用户自行去面板停 | 任务 3 |
| A5 | 默认模型控制**纳入本次范围**：只读展示 + 写入入口（第 6 个工具 + 卡片按钮），写入走 `toolApproval` 审批门 | 任务 6、7 |
| A6 | `x_llamapad.reasoning_effort` 改为**按 `id` 在聚合列表里精确匹配目标模型**，找不到才回落 `data[0]`。多模型下这反而比现状更准 | 任务 4 |
| A7 | 指标归属：面板采集器只跟随默认模型、且切换默认模型时曲线**不带边界标记地拼接**（面板 `src/server/locators.ts:207`）。插件不改数据，只在监控页标注归属 | 任务 8 |

**执行约束（每个任务都适用）**：

- TDD：先写失败测试 → 再实现 → 跑 `pnpm test` + `pnpm run typecheck`
- 每个任务结束跑 `pnpm run typecheck`，类型错误不留到下一个任务
- 提交由用户明确指示后才执行；`git add` 与 `git commit` 分两条命令
- 代理：网络命令前 `export HTTP_PROXY=http://10.22.33.1:20172 HTTPS_PROXY=http://10.22.33.1:20172 NO_PROXY=localhost,127.0.0.1`

---

## 任务 1 · panel-client：多模型契约层

**文件**：`src/panel-client.ts`、测试 `test/unit/panel-client.test.ts`

1. `PanelRuntimeStatus` 扩展（全部可选，老面板缺席即为 `undefined`）：
   - `models?: PanelRunningModel[]` —— 全部运行中模型，按启动时间升序
   - `defaultModel?: string | null` —— 不带 `model` 字段的请求会打给谁
   - 把现有 `running` 的内联对象类型提取为 `PanelRunningModel`，追加两个面板新字段：
     `configuredHostPort?: number | null`（配置端口，与 `hostPort` 不同说明启动时被顺延了）、
     `isDefault?: boolean`（面板未直接给，留空由归一层填）
   - `running` 的注释改写：**语义已是「默认模型」**，保留只为兼容；新代码一律走 `runningModels()`
2. 新增导出纯函数（本任务的核心，全仓库唯一归一出处）：
   - `runningModels(status): PanelRunningModel[]` —— `status.models` 在场即用它；
     缺席（老面板）时 `running ? [running] : []`
   - `findRunning(status, model): PanelRunningModel | undefined`
   - `isRunning(status, model): boolean`
   - `defaultModelOf(status): string | null` —— `status.defaultModel` 在场即用；
     缺席时回落 `running?.model ?? null`
3. `runtimeStatus(options)` 支持 `options.model`：拼 `?model=<encodeURIComponent>`，
   与 `busy=1` 用 `URLSearchParams` 组合（两个参数可同时出现）
4. 新增两个默认模型端点：
   - `getDefaultModel(): Promise<{ defaultModel: string | null; models: string[] }>` ← `GET /api/v1/runtime/default-model`
   - `setDefaultModel(name): Promise<void>` ← `PUT /api/v1/runtime/default-model`，body `{ model }`。
     **404 要单独折成 `PanelError(..., "UNSUPPORTED", 404)`**——老面板没有这个路由，
     调用方要能区分「面板太老」与「模型没在跑」；409 沿用既有 `RUNTIME_BUSY` 映射
5. 单测：`runningModels` 的新/老面板两条路径、`findRunning` 命中与落空、
   `defaultModelOf` 回落、`?model=` 与 `?busy=1` 的 URL 组合、default-model 两个端点的
   成功/404/409

---

## 任务 2 · routing + route-message：按目标模型判定

**文件**：`src/routing.ts`、`src/route-message.ts`、测试两份同名

1. `RouteBlockReason` 的 `runningModel: string | null` → `runningModels: string[]`
   （全部在跑的模型名），`kind` 的三态 `no-model`/`mismatch`/`not-ready` 保持不变
2. `decideRoute` 全面改走任务 1 的纯函数：
   - 就绪闸门：`const target = findRunning(status, requestedModel)`；
     `target?.ready === false` 时的拦截条件不变（只拦 `=== false`，缺席仍是「不可知」）。
     auto-switch 且目标不在跑时不拦——要换掉的正是别的东西
   - auto-switch：`isRunning(status, requestedModel)` → proceed；否则 `{action:"start"}`
   - strict：目标在跑 → proceed；一个都没跑 → `no-model`；目标没跑但别的在跑 → `mismatch`
   - passthrough：目标在跑 → proceed；否则发给 `defaultModelOf(status)`（**这是新的落点**：
     过去发给「唯一在跑的那个」，现在发给默认模型，与面板中转层不带 `model` 时的行为一致）；
     没有默认模型 → `no-model`
3. `route-message.ts`：`mismatch` 文案改为列出全部在跑模型（超过 3 个截断为
   `A、B、C 等 N 个`），并在多模型场景下补一句「面板当前默认模型是 X」
4. 单测：老面板单模型的既有用例**全部保持通过**（回归保护），新增多模型矩阵——
   目标在跑/目标没跑但别的在跑/一个都没跑 × 三档

---

## 任务 3 · switching：就绪轮询按目标模型（修 P0-1）

**文件**：`src/switching.ts`、测试 `test/unit/switching.test.ts`

1. `probeReady(client, model)`：`const target = findRunning(await client.runtimeStatus(), model)`
   - `target === undefined` → false（目标还没起来，继续等）
   - `target.ready === undefined` → 回退 `client.llamaHealth()`（老面板路径，语义不变）
   - 否则返回 `target.ready`
   - 头注释改写：说明「面板多模型下 `running` 是默认模型，这里必须按名字找目标项」
2. `ensureOnce` 的前置短路：`status.running?.model === model` → `isRunning(status, model)`
3. **A4 落地**：`START_TIMEOUT` 的错误文案带上当前其他在跑模型——
   `等待 B 就绪超时（300000ms）。当前面板还在运行：A、C；显存不足时可在面板停掉不用的模型再试`。
   其他在跑模型为空时不加这句。文案组装抽成纯函数便于单测
4. 单测：目标非默认模型时能正常判就绪（**这条就是 P0-1 的回归测试**）、
   老面板回退 `llamaHealth` 路径不变、超时文案的两种形态

---

## 任务 4 · adapter：direct URL、reasoning 精确取、选择器标记

**文件**：`src/adapter.ts`、`src/reasoning.ts`、测试两份同名

1. `buildDirectUrl(llamaBaseUrl, status, targetModel)` —— 签名从「单个 running 项」改为
   「整份 status」，内部用 `findRunning` 取 `hostPort`（修 P0-3）。
   注释补一句面板新语义：`hostPort` 现在是**实际发布端口**（冲突时自动顺延），
   配置端口在 `configuredHostPort`，拼 URL 只认前者
2. `stream()` 里 `runningForUrl` 从 `PanelRuntimeStatus["running"]` 改为整份 `status`；
   start 分支重查一次的逻辑保持（切换后端口可能变，这条只增不减）
3. `resolveReasoning` 的门：`status?.running?.model !== model` → `!isRunning(status, model)`
4. **A6**：`parseReasoningInfo(body, model?)` 增加可选模型名——在 `data[]` 里按
   `item.id === model` 精确匹配（面板聚合列表的 `id` 强制为面板模型名，见面板
   `src/lib/models-list.ts:47`），找不到再回落 `data[0]`，`model` 缺省时行为与现状完全一致
5. `describeModel`：默认模型追加标记（`●` 运行中标记之外，默认模型再加 `★`，
   description 里写「默认（不指定模型的请求发给它）」）。需要 `defaultModel` 入参，
   `listModels` 调用处传 `defaultModelOf(status)`；拿不到状态时不标记
6. 单测：direct URL 在「目标是非默认模型」时拼对端口（P0-3 回归）、
   `parseReasoningInfo` 的按 id 命中/回落、`describeModel` 的标记矩阵

---

## 任务 5 · status-watch + fleet-snapshot：运行集合感知

**文件**：`src/status-watch.ts`、`src/fleet-snapshot.ts`、测试两份同名

1. `FleetCache`：`running: string | null` → `running: string[]`（全部在跑，升序）
   + `defaultModel: string | null`；`runningContextWindow?: number` →
   `contextWindows?: Record<string, number>`（按模型名）
2. 状态探测（`status-watch.ts:184-225`）：
   - 变化判定从单值比较改为**集合比较**（排序后 join，任一模型启停都触发
     `ctx.emit("llm/adapters-updated")`，修 P1-5）；默认模型变化也算变化
   - ctx 查询：对全部在跑模型并发 `getEffectiveConfig`，**上限 3 个**（超出不查，
     避免放大请求量），`Promise.allSettled` + 整份丢弃的既有容错语义保持
3. `fleet-snapshot.ts`：
   - `Running:` 段列出全部在跑模型（每个带 quant/context 标注），默认模型标注
     `(default)`；一个都没跑时文案不变
   - 补一行 `Requests without an explicit model go to: <default>`（仅多于一个在跑时出现）
   - 可启动清单剔除**全部**在跑模型（`!cache.running.includes(m.name)`，修 P1-4），
     `MAX_STARTABLE` 截断逻辑不变
4. 单测：集合变化判定的启停矩阵、快照在 0/1/多 模型下的三种文案、可启动清单剔除

---

## 任务 6 · 卡片：RPC 契约扩展 + 运行列表 + 设为默认

**文件**：`src/rpc-contract.ts`、`src/panel-gateway.ts`、`src/client/Card.tsx`、
`src/client/state.ts`、`src/client/locale.ts`、`src/client/rpc.ts`，测试对应

1. `rpc-contract.ts`：
   - 新增 `CardRunningModel { name, displayName, startedAt, ready, isDefault }` + codec
   - `CardSnapshot` 新增 `runningModels: CardRunningModel[]` 与 `defaultModel: string | null`；
     **`running` 与 `startedAt` 保留**（= 默认模型那一项），卡片旧渲染路径不破
   - 新增 RPC 方法契约 `setDefaultModel(model: string)`
2. `panel-gateway.ts`：
   - `buildSnapshot` 用 `runningModels(status)` 填新字段；`running`/`startedAt` 改取
     默认模型那一项
   - `resolvePhase` 保持「整体阶段」语义（基于默认模型），但注释写明多模型下的含义
   - 新增 `setDefaultModel` 方法：调 `client.setDefaultModel`，`UNSUPPORTED`（老面板 404）
     折成中文说明「当前面板版本不支持默认模型切换」，走既有 `describePanelError` 风格
3. `Card.tsx`：运行区从单行改为列表——每行「模型名 · 已加载 N 秒 · ready 点 ·（默认）」，
   非默认行给一个「设为默认」按钮（调用新 RPC，在途禁用，失败走既有 panelError 展示位）。
   只有一个模型在跑时视觉与现状保持一致（不要为多模型把单模型的卡片搞复杂）
4. `locale.ts` 补文案。单测：codec 往返、snapshot 组装、state 纯函数

---

## 任务 7 · tools：状态多模型输出 + 第 6 个工具

**文件**：`src/tools.ts`、测试 `test/unit/tools.test.ts`

1. `llamapad_status`：输出全部在跑模型（每行 `● 名字 · ready/loading · (默认)`），
   `busy` 探测仍针对默认模型并注明；终端呈现卡同步
2. 第 6 个工具 `llamapad_set_default_model`：
   - 入参 `{ model: string }`；`isConcurrencySafe: false`（它改变路由目标，是写操作）
   - **走 `toolApproval` 审批门**（与 start/stop 同一条 `tools/pre-execute` 升级路径）
   - 老面板 404 → 明确回「当前面板版本不支持默认模型切换（需要面板多模型版本）」；
     409（目标没在跑）→ 透传面板说明
   - 注册进 `apply`（`tools.ts:84-88` 那一串）
3. 单测对齐既有五工具风格：成功、模型没在跑、老面板不支持、审批拒绝

---

## 任务 8 · 监控页归属标注 + E2E 假面板 + 文档

**文件**：`src/client/MonitorPage.tsx`、`test/e2e/fake-panel-server.mjs`、
`CLAUDE.md`、`README.md`、`docs/manual-smoke.md`

1. `MonitorPage.tsx`：顶部标注「容器与推理指标来自默认模型 X；切换默认模型后曲线会在
   切换点直接拼接新模型的数据，没有边界标记」（A7，面板 `docs/guide/zh/monitoring.md`
   的原始约束）。GPU 指标标注「整卡口径，多模型同卡时无法拆分归因」
2. `fake-panel-server.mjs`：
   - `runtime/status` 响应加 `models[]` / `defaultModel`，支持 `?model=` 与 `?busy=1` 组合
   - 新增 `GET/PUT /api/v1/runtime/default-model`
   - `/api/v1/proxy/llama/v1/models` 改为按运行集合聚合多条（`id` = 模型名）
   - 保留一个「老面板模式」开关（只回 `running`、default-model 路由 404），
     用于跑双向兼容的 E2E
3. 新增 E2E：多模型场景下 auto-switch 能正常就绪（P0-1）、strict 能对非默认模型对话（P0-2）、
   老面板模式下全部既有用例仍通过（A2 回归）
4. 文档：`CLAUDE.md` 的「关键约束」删掉「单模型运行时」那条、改写为多模型语义与
   `running`=默认模型的说明；README 的行为描述同步；`docs/manual-smoke.md` 加多模型冒烟清单

---

## 验收

- `pnpm test`（单测）+ `pnpm run test:e2e` + `pnpm run typecheck` 全绿
- 双向兼容：假面板的「老面板模式」与「多模型模式」两套 E2E 都过
- 未做：打包发布（`pnpm run release`）由用户决定时机；面板 `feature/multi-model`
  合并前无法做真机冒烟，`docs/manual-smoke.md` 只记清单不打勾
