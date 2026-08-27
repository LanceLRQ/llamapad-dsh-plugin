# 聊天路由与容器生命周期解耦（A 形态修订）

> 状态：**阶段一（第 2 节）已实施**（2026-08-27，`chatBehavior` 三档 + 排空参数 + 动态端口拼接，
> 80 单测 + 5 假面板 E2E 全绿）。**阶段二（第 3 节）亦已实施**（2026-08-27），但最终形态与本节
> 规划不同——实施记录与四条真机才暴露的硬约束见 [dsh 设置卡片](./settings-card-design.md)。
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

## 3. 阶段二：生命周期控制的显式入口

> **2026-08-27 实施后回填**：本节的门槛判断（浏览器端产物格式是唯一门槛、跨过后卡片增量成本
> 不大）**成立**——产物格式确实只是 `window.__ModuleLoader__.load({id, factory})` 一层薄壳，
> esbuild 加 banner/footer 即可复刻。但本节没有预见到的是另外四条约束，每一条都足以让卡片
> **静默不出现**或让整个插件加载失败：`@Remote` 装饰器依赖模块级 WeakMap 因而对第三方不可用
> （且对齐版本号救不了）、`ctx.remote.<自己的命名空间>` 写进静态 inject 会与自己的 `$mount`
> 死锁、`exports` 必须放行 `./package.json`、`dsh.bundle` 与 `dsh.client` 会互相覆盖。
> 详见 [dsh 设置卡片](./settings-card-design.md) 第 3 节。
>
> 另有两处与本节设想不同：挂载点最终用 `settings.plugin.item`（Plugins 页签内的卡片）而非
> `settings.section`（独立页取消，原因是 iframe 方案撞上 `SameSite=Lax` 与「iframe 地址由浏览器
> 解析」两个坑）；第 3 档「实时状态」**一并做掉了**，走宿主 RPC 转发而非浏览器直连，因此
> 下面第 4 节第 3 条的 CORS 最终**确定不做**。

> **2026-08-27 核实订正**：本节最初按「三级成本阶梯」规划（原始记录保留在下方小节），把第 1 步
> 判定为「零成本」。经用真实 npm 包核实 dsh 的 settings 域实现，这个判断不成立——**第 1、2 步
> 实际是同一道门槛，不存在免费的那一步**。订正依据：
>
> - `installSettingsSection(ctx, ns, schema, entry, hooks): void` 注册的只是一条数据 namespace
>   （把插件配置接入 `ctx.settings` 存取层，可持久化到 `settings.yaml`），返回 `void`，没有任何
>   UI 句柄。只写 host 侧、不提供浏览器模块时，用户在 dsh 设置界面里**什么都看不到**——不是
>   空壳，是彻底不出现。官方自己发布的 `@deepseek-ai/dsh-agent-default-model` 就是这样一个
>   「有 namespace、无页面」的真实在产例子（其 `package.json` 没有 `dsh` 字段、没有
>   `exports["./client"]`）
> - 设置领域底座 `@deepseek-ai/dsh-client-ui-settings` 的 host 半身是空函数
>   （`export declare function apply(): void`，注释原文 "no host-side behavior for the
>   settings domain base plugin"），全部 slot 渲染逻辑只存在于 `./client` 子路径
> - 没有 schemastery → 表单的自动渲染器。官方最「表单化」的 Models 页面是按 namespace 名字
>   硬编码的两套手写布局（键是 `llm-deepseek` / `llm-pi-ai`），换个 namespace 名不会自动获得
>   任何卡片。因此「把外链塞进配置项 description」这条退化路径也不成立——没有任何组件会读取
>   并展示 schema 字段的 description
> - 要露出哪怕一个链接，都必须提供声明了 `dsh.client`（`platform:"web"` + 有效
>   `exports["./client"]`）、产物为 `window.__ModuleLoader__.load({id, factory})` 惰性 CJS
>   工厂格式的浏览器端包，并调用 `ctx.slots.inject('settings.section', …)`。官方 tsdown
>   preset 至今未作为独立 npm 包发布，外部仓库必须自行逆向复刻
> - 而且这是个二元开关：声明了 `dsh.client` 但产物缺失/格式不对，会 loud throw，**整个插件
>   加载失败**，不只是设置卡片不显示
> - 新旧版（0.0.1-rc.1 / 0.1.1-rc.2）在这些结论上没有任何破坏性变化，不存在「升级后就不需要
>   浏览器侧代码」的转机。新版还把设置外壳从 `dsh-client-ui-settings` 拆到了独立包
>   `dsh-client-ui-settings-general`
>
> 真实成本结构因此不是三级阶梯，而是「不做 / 复刻产物格式后一次做到卡片 / 再解决实时状态」，
> 见下方「订正后」小节；原始的三级阶梯记录整体保留在其后，供追溯当初的判断过程。

### 订正后：两级门槛 + 一个后续增量

1. **不做**：维持现状——用户需要生命周期操作时自行打开 llamapad 面板（书签/记住地址），dsh
   内不提供任何入口。零开发成本，也是当前实际状态。
2. **复刻产物格式，一次做到原生设置卡**：浏览器侧 client module 的产物格式（`dsh.client`
   声明 + `window.__ModuleLoader__.load({id, factory})` 惰性 CJS 工厂）需要自行逆向复刻——
   这是唯一的门槛，一旦跨过，做「一个外链」和做「token 配置 + 启停/切换按钮调 PanelClient 的
   完整卡片」的增量工作量差别不大（都要写 slot 注入 + 渲染），没有理由只做前者。宿主侧仍用
   `installSettingsSection` 接入配置存取。**先做专项调研 spike 摸清产物格式，再一次性做卡片**。
3. **实时状态**：卡片内嵌实时运行状态，需要解决浏览器直连面板 API 的 CORS，或改走 host RPC
   转发——留到卡片可用之后再评估（见第 4 节第 3 条）。

### 原始记录（按成本三级阶梯，已被上方订正）

1. **零成本版**：「打开 llamapad 面板」外链入口（悬浮按钮/settings 卡里的跳转）。llamapad
   自带完整启停/切换 UI 与实时状态，任何 dsh 内嵌入口最终都只是替用户开网页——先把这一步做掉。
2. **原生设置卡**：宿主侧 `installSettingsSection` 注册卡片（token 配置 + 启停/切换按钮调
   PanelClient）。前置缺口：浏览器侧要走 client modules，官方 tsdown 预设未发布、产物格式
   （loader lazy-CJS 工厂）需自行复刻——**先做专项调研 spike 再排期**。
3. **完成态**：原生卡内嵌实时状态（解决浏览器直连面板 CORS 或走 host RPC 之后）。

与本仓库 [B 形态设计稿](./b-form-tools-design.md) 的关系：本方案把 B 形态中「生命周期的显式
UI 操作」提前部分兑现；B 形态其余管理功能（文件/下载等）范围不变。

## 4. 服务端侧关联事项（llamapad，供一并调整时参考）

**第 1、2 条已落地**（llamapad 侧与插件侧阶段一同批实现），插件侧按下述冻结契约调用；**第 3 条
CORS 不在此列**——阶段一未使用浏览器直连面板 API，此项明确不做，是否需要处理留到阶段二第 2/3
步涉及时再评估：

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
3. **CORS**：**最终确定不做**（2026-08-27 阶段二实施后关闭）。阶段二的卡片走「浏览器 →
   dsh host RPC → PanelClient」，token 与 PanelClient 全程留在 host 进程、浏览器不直连面板，
   因此 llamapad 侧一行不用改，也不必把 token 发到浏览器。

## 5. 决策记录

- 2026-08-27：方向定稿——阶段一以 `chatBehavior` 三档解耦（默认 strict），阶段二沿三级阶梯推进；
  默认档变更属破坏性变化，0.x 阶段直接切换默认值并在 changelog 标注。
- 2026-08-27：阶段一实施完成——两个开放问题定案见第 2 节；服务端排空/忙碌查询契约冻结见第 4 节；
  80 单测 + 5 假面板 E2E 全绿，README/CLAUDE.md 同步。
- 2026-08-27（阶段二实施）：形态定为 Plugins 页签内的一张卡片（`settings.plugin.item`），
  独立页与 iframe 方案取消（`SameSite=Lax` 跨主机不可用 + iframe 地址由浏览器解析）；
  实时状态一并做掉，走宿主 RPC 转发，CORS 确定不做。实施中推翻了「用 `@Remote` 装饰器暴露
  host 方法」这条官方路径——它依赖模块级 WeakMap，第三方插件与宿主是两份模块实例，
  改为向 `ctx.typert` 注册 strict 描述符。详见 [dsh 设置卡片](./settings-card-design.md)。
- 2026-08-27（核实订正）：第 3 节「三级成本阶梯」经用真实 npm 包核实 dsh 的 settings 域实现，
  订正为「两级门槛 + 一个后续增量」——`installSettingsSection` 只注册数据 namespace、无 UI
  句柄，浏览器侧不提供 client module 时设置界面不会出现任何入口；「零成本外链」与「原生设置卡」
  实际是同一道门槛（浏览器端产物格式），不存在免费的第一步，详见第 3 节订正说明。同时更正第 4
  节标题措辞：CORS（第 3 条）不在「已落地」之列，是阶段二的待评估事项，阶段一明确未做。
