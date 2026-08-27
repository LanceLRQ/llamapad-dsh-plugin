# 聊天路由与容器生命周期解耦（A 形态修订）

> 状态：**阶段一（第 2 节）已实施**（2026-08-27，`chatBehavior` 三档 + 排空参数 + 动态端口拼接，
> 80 单测 + 5 假面板 E2E 全绿）。**阶段二（第 3 节）未启动**，按成本阶梯待排期。
> 背景：2026-08-27 实测预览后发现 A 形态「选模型即切容器」的隐含语义与产品设想相悖，本文记录差异、目标行为与分阶段修改方案。

## 1. 问题：在途对话会被切换杀死

现行为：dsh 里选中另一个模型的下一个请求进入 `stream()` 时，适配器无条件 `gate.ensure()`
（`src/adapter.ts`），而 llamapad start 接口自带「停旧起新」——旧容器停止的瞬间，
**尚未输出完的那条 SSE 流直接断掉**。`switching.ts` 的串行门只防并发抖动，不保护在途推理。

这不是缺陷而是当初 A 形态的隐含取舍，但与用户的原始设想冲突：

| 维度 | 用户设想 | 当前实现 |
|---|---|---|
| 对话通道 | 连接「当前正在跑的中转服务」 | 选谁就连谁，选择动作触发容器切换 |
| 容器生命周期 | 显式操作（设置页卡片/悬浮按钮入口） | 隐式：选模型 ≙ 启停指令 |
| 在途输出 | 切换不影响进行中的对话 | 切换必杀在途流 |

本质分歧：**「选模型」应当只是路由标签，不承载控制语义；控制权独立存在。**

## 2. 阶段一：聊天与控制解耦（纯 host 侧，无 UI 工作）

新增配置项 `chatBehavior`，三档：

| 档位 | 行为 | 适用 |
|---|---|---|
| `"strict"`（**改为默认**） | 请求模型 ≠ 运行中模型 → 报错引导去操作；无模型在跑 → 报「请先启动」。聊天路径**完全不调 start/stop**，在途流绝对安全 | 共享 GPU / 多会话 |
| `"passthrough"` | 有模型在跑就发给它（名字对不上也照发）；没跑则同上报错 | 单人"连现在的中转服务"式使用 |
| `"auto-switch"` | 完整保留现行 A 形态行为（选谁起谁） | 独占 GPU 的单人场景 |

配套改动：

- 错误码新增 `MODEL_NOT_RUNNING`（沿用 `EnsureError → LlmError` 映射链：`switching.ts` 的
  `EnsureErrorCode` 与 `adapter.ts` 的 `mapEnsureError` 白名单都已加）
- `startTimeoutMs` / `pollIntervalMs` 仅在 `auto-switch` 档生效（schema 描述已同步）
- 测试：`src/routing.ts` 的 `decideRoute()` 纯函数、判定矩阵全覆盖（`test/unit/routing.test.ts`）；
  门逻辑复用现有单测基础
- README 定位语已改述为三档说明，并标注默认档变更为破坏性变化

### 两个开放问题的定案（实施时落地）

1. **`passthrough` × `direct` 组合**：采用动态拼接——主机名取自 `llamaBaseUrl`，端口取
   `runtimeStatus().running.hostPort`；拿不到 hostPort 时原样回落到 `llamaBaseUrl`（`adapter.ts`
   的 `buildDirectUrl()`）。这同时修掉了一个既有隐患：`auto-switch` 档切到 host_port 不同的
   模型时，静态 `llamaBaseUrl` 会指向已经停掉的旧端口——现在 `direct` 模式的 `start` 分支会在
   `gate.ensure()` 之后重新查一次 `runtimeStatus()` 取最新端口（`proxy` 模式走面板反代、不看
   hostPort，不做这次多余往返）。
2. **dsh 模型选择器的标签语义**：不做任何 UI 提示，错误消息已经说清「运行中是谁、请求的是谁、
   下一步怎么做」，足够消除歧义。

## 3. 阶段二：生命周期控制的显式入口（按成本三级阶梯）

1. **零成本版**：「打开 llamapad 面板」外链入口（悬浮按钮/settings 卡里的跳转）。llamapad
   自带完整启停/切换 UI 与实时状态，任何 dsh 内嵌入口最终都只是替用户开网页——先把这一步做掉。
2. **原生设置卡**：宿主侧 `installSettingsSection` 注册卡片（token 配置 + 启停/切换按钮调
   PanelClient）。前置缺口：浏览器侧要走 client modules，官方 tsdown 预设未发布、产物格式
   （loader lazy-CJS 工厂）需自行复刻——**先做专项调研 spike 再排期**。
3. **完成态**：原生卡内嵌实时状态（解决浏览器直连面板 CORS 或走 host RPC 之后）。

与本仓库 [B 形态设计稿](./b-form-tools-design.md) 的关系：本方案把 B 形态中「生命周期的显式
UI 操作」提前部分兑现；B 形态其余管理功能（文件/下载等）范围不变。

## 4. 服务端侧关联事项（llamapad，供一并调整时参考）

**均已落地**（llamapad 侧与插件侧阶段一同批实现），插件侧按下述冻结契约调用：

1. **优雅切换/排空**：`POST /api/v1/models/:name/start` 接受可选体
   `{ drain?: boolean, drainTimeoutMs?: number }`，响应追加 `drain: { drained, reason }`。
   `auto-switch` 档调用时默认带上（`drainOnSwitch` 配置默认 `true`，`drainTimeoutMs` 默认
   `60000`）。`reason` 取值固定为 `idle` / `timeout` / `unavailable` / `skipped`；**只要请求
   里传了 `drain`，响应就一定带 `drain` 字段**（冷启动无旧容器可停时为 `skipped`），调用方
   不必区分"字段缺席"与"没排空"。`panel-client.ts` 的 `startModel()` 单次调用超时相应覆盖为
   `max(requestTimeoutMs, drainTimeoutMs + 10_000)`（只传 `drain` 不传超时时按服务端默认
   60s 计算），避免排空未完客户端先 abort。
2. **忙碌状态查询**：`GET /api/v1/runtime/status?busy=1` 响应追加
   `busy: { inferring: boolean, slotsRunning: number } | null`（`null` = 不可知，不是"不忙"）。
   `strict`/`passthrough` 档的报错文案在 `inferring === true` 时补一句"目标机器正在推理中"；
   `auto-switch` 档不查询（不会走到报错分支，省一次开销）。
3. **CORS**：阶段二第 2/3 步涉及时再评估，阶段一未使用浏览器直连面板 API。

## 5. 决策记录

- 2026-08-27：方向定稿——阶段一以 `chatBehavior` 三档解耦（默认 strict），阶段二沿三级阶梯推进；
  默认档变更属破坏性变化，0.x 阶段直接切换默认值并在 changelog 标注。
- 2026-08-27：阶段一实施完成——两个开放问题定案见第 2 节；服务端排空/忙碌查询契约冻结见第 4 节；
  80 单测 + 5 假面板 E2E 全绿，README/CLAUDE.md 同步。
