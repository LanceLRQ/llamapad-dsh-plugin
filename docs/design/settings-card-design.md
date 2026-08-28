# dsh 设置卡片（阶段二实施记录）

> 状态：**已实施**（2026-08-27）。对应 [聊天路由与容器生命周期解耦](./chat-vs-lifecycle-decoupling.md) 第 3 节的阶段二。
> 真机验证：无头 Chromium 打开 dsh 设置页，卡片正常渲染、页面零错误；真 token 下
> 启停/切换全部通过，见第 6 节。

## 1. 最终形态与它和原计划的差别

原计划（解耦文档 §3 订正后）是「复刻产物格式 → 一次做到原生设置卡」，并把挂载点设想为
`settings.section`（左侧导航多一项 + 右侧整页）。实际落地时用户定为**两处都要**，且独立页
用 iframe 直接嵌 llamapad 面板以免维护两份 UI。核实后**独立页整个取消**，原因是 iframe 有
两个绕不过去的坑：

1. **iframe 的地址由浏览器解析，不是 host 解析**。配置里的 `panelUrl` 是 host 进程视角的
   地址（常见是 `127.0.0.1`），用户从别的机器打开 dsh 时，iframe 里的 `127.0.0.1` 指向
   **用户自己的机器**。
2. **面板会话 cookie 是 `SameSite=Lax`**（llamapad `src/server/cookie.ts`）。dsh 与 llamapad
   同主机不同端口时没问题（cookie 不区分端口，算 same-site）；**不同主机就是跨站**，浏览器
   既不发 cookie，也会拒收 iframe 里登录时的 `Set-Cookie`——永远停在登录页。

于是最终形态是：

| 位置 | 内容 |
|---|---|
| 设置 → 插件 → 插件配置（`settings.plugin.item`） | 一张卡片：运行状态 + 模型列表 + 启停/切换按钮 + 右上角「在浏览器中打开面板」 |
| 独立页（`settings.section`） | **不做** |

坑 1 的解法仍然保留下来了：新增配置项 `panelPublicUrl`（浏览器可见地址，缺省回落
`panelUrl`），「在浏览器中打开面板」按钮用它。单机部署无感，跨机部署时必须配。

## 2. 架构：浏览器卡片 → host RPC → PanelClient

```
浏览器 (dsh web)                     dsh host 进程                  llamapad 面板
┌────────────────────┐   HTTP POST   ┌──────────────────┐   HTTP    ┌──────────┐
│ Card.tsx           │──/api/llamapad│ PanelGateway     │──────────>│ /api/v1  │
│  ctx.remote        │  Panel/xxx ──>│  (TypertRemote-  │  带 token │          │
│  .llamapadPanel.*  │<──────────────│   Service)       │<──────────│          │
└────────────────────┘  CardSnapshot └──────────────────┘           └──────────┘
                                       PanelClient / ModelGate
                                       token 只存在于这一层
```

**token 与 PanelClient 全程留在 host 进程**，浏览器不直连 llamapad。因此：

- llamapad **不需要加 CORS**（解耦文档 §4 第 3 条的待评估事项就此关闭，仍然不做）
- API token 不进浏览器
- host 侧已有的 `sharedModelGate` 被复用，卡片按钮与聊天路径、B 形态工具共用同一把锁

三个方法（契约唯一出处 `src/rpc-contract.ts`）：`snapshot()` / `start(model)` / `stop(model)`，
**全部返回 `CardSnapshot`**——动作做完顺带回传最新状态，省一次往返也避免中间态闪烁。

### 错误语义：不抛，塞进 `panelError`

面板不可达 / 鉴权失败这类运行期故障**不抛错**。RPC 抛错到浏览器侧只剩
`{ ok:false, error }` 一个壳，信息更少也更难渲染。约定是把中文说明放进
`CardSnapshot.panelError`，其余字段尽最大努力填，让卡片总能画出「面板连不上」**并继续显示
「在浏览器中打开面板」按钮**——那是用户此时唯一的退路。只有 `model` 为空串这类编程错误才抛。

同理，浏览器侧一次轮询失败也**不清空上一份快照**，只在顶部补一条「刷新失败，下方是上次读到
的内容」。否则最需要退路的时刻恰好把退路按钮一起抹掉。

## 3. 四条真机才暴露的硬约束

这四条都不是读文档能得到的，全部由冒烟打出来，按踩到的顺序记录。

### 3.1 `@Remote` 装饰器对第三方插件不可用，且**对齐版本号救不了**

dsh 网关默认用 SRC 反射发现可远程调用的方法：`@Remote()` 装饰器把标记写进
`@deepseek-ai/dsh-typert-protocol` 的**模块级 `WeakMap`**（`const markers = new WeakMap()`），
网关的 `remoteMethods()` 从同一张表里读。

而第三方插件从**自己的** `node_modules` 解析该包，宿主从 dsh 的安装目录解析：

```
插件:    .../llamapad-dsh-plugin/node_modules/.pnpm/@deepseek-ai+dsh-typert-protocol@0.1.1-rc.2.../
宿主:    /root/.nvm/.../dsh/node_modules/@deepseek-ai/dsh-typert-protocol/
```

两份模块实例、**两张 WeakMap**。网关那份永远是空的，`collectSrcClaims()` 收不到端点，
请求直接 404，而且没有任何报错——`claimsEndpoint` 返回 false 就是 404。

> 这与本仓 `prepareCall` 那次版本漂移同源但更狠：那次是鸭子类型判定，**对齐版本号就能修**；
> 模块级状态只要有两份模块实例就必然分裂，**版本一致也没用**。凡是依赖模块级单例
> （WeakMap / Map / Symbol / 计数器）的宿主机制，第三方插件都要假定它不可用。

**可行的通路**：向 `ctx.typert` 注册 strict 描述符。`ctx.typert` 是 cordis 服务，经 DI 拿到的
是宿主那一份实例，`claimsEndpoint` 又优先查 `typert.local`：

```ts
ctx.inject(["typert"], (typertCtx) => {
  typertCtx.typert.register({
    package: RPC_PACKAGE,
    face: "host",
    schemas: [],
    model: { services: [], events: [], objects: [] },
    invocations: RPC_CONTRIBUTION.descriptors,
  });
});
```

装饰器随之成为死代码，已全部删除。连带好处：不再需要为 TC39 装饰器语法在 vitest 里塞
esbuild 降级插件（Vite 8 + Vitest 4 那套转换管线不会自行下探装饰器，测试会 `SyntaxError`）。

`TypertRemoteService` 基类**要保留**：网关的 `validateBinding` 要读实例上的 `typertRemote`，
那是个普通冻结对象、结构化读取，跨模块实例没问题。

### 3.2 `ctx.remote.<自己的命名空间>` 不能写进静态 `inject`

cordis 对 `ctx.remote.<ns>` 有守卫，不声明就取会抛
`cannot get property "remote.llamapadPanel" without inject`，真机表现是 dsh 首页一条
**"Failed to load plugins"**。

但这个服务恰恰是本插件自己 `$mount` 出来的——写进模块顶层的静态 `inject` 会让 apply 永远
等不到自己的产物，死锁。官方包（如 `dsh-client-ui-settings-plugin-inventory`）能把
`remote.pluginInventory` 写进静态 `inject`，是因为**挂载方与消费方是两个不同的插件**
（`dsh-api-remotes` 的 client 半身统一 `$mount` 官方全部契约）。

解法是响应式作用域：

```ts
const disposeMount = await ctx.remote.$mount(RPC_CONTRIBUTION);
ctx.inject(["slots", `remote.${RPC_NAMESPACE}`], (inner) => {
  const api = createPanelApi(inner.remote[RPC_NAMESPACE]);
  return inner.slots.inject("settings.plugin.item", () => inner.slots.register(…));
});
```

### 3.3 `exports` 必须放行 `./package.json`

`dsh-client-modules` 的 `resolveMeta` 用 `require.resolve(\`${包名}/package.json\`)` 去读
`dsh.client`。`exports` 不放行这条子路径时解析会抛，而它 `catch` 之后是**静默跳过**——
不报错、不警告，卡片永远不出现，boot 图里也没有本插件那一行。官方每个 dsh 包的 `exports`
里都有 `"./package.json": "./package.json"`，那不是惯例是必需项。

### 3.4 `dsh.bundle` 与 `dsh.client` 是并列字段，别互相覆盖

`dsh.bundle.patch` 是本包作为 **profile bundle** 时的默认挂载模板；`dsh.client` 是本包作为
**浏览器插件**时的声明。整体赋值 `package.json` 的 `dsh` 字段会把另一个抹掉，症状是 dsh 启动
即失败：`profile bundle "llamapad-dsh-plugin" declares no dsh.bundle in its package.json`。

## 4. 浏览器产物：格式与构建

产物格式很浅，`esbuild` 加 banner/footer 即可复刻，宿主不校验产物由谁打包：

```js
window.__ModuleLoader__.load({
  id: "<npm 包全名>",
  factory: (require) => { var module = { exports: {} }; …; return module.exports; }
});
```

`scripts/build.mjs` 第二趟用 `platform:'browser'` + `format:'cjs'` + banner/footer 产出。三条
红线写在该文件注释里，此处只列结论：

- **只有 7 个 seed 模块能 external**：`react`、`react/jsx-runtime`、`react-dom`、
  `react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`。宿主的模块表是硬编码静态种子表，
  **require 落空是 loud throw**，其余依赖必须真打进产物。`test/e2e/client-bundle-format.test.ts`
  用 `node:vm` 模拟宿主 loader 守住这条。
- **产物缺失 = 整个插件 FAILED**，不是「卡片不显示」。`dsh.client` 是 package.json 静态字段、
  无法条件关闭，所以 `dist/` 虽不入库，**装载前必须先 `pnpm run build`**。这是选择「单包三入口」
  而非「卡片单独成包」时明确接受的代价。
- 依赖 `@deepseek-ai/dsh-client-ui-slots` / `-primitives` 只能作为 **devDependency**：它们没有
  独立发布到 profile 的 node_modules，而是被打进宿主 shell 的 dist 当运行时单例，本地装只为
  类型检查。

## 5. settings namespace：两个常量，不是一个

`RPC_NAMESPACE = "llamapadPanel"`（驼峰）——cordis service key 兼 wire 命名空间，浏览器侧
表现为 `ctx.remote.llamapadPanel.*`，必须是合法 JS 标识符。

`SETTINGS_NAMESPACE = "llamapad-panel"`（kebab）——`settingsNamespace()` 有硬校验
`/^[a-z][a-z0-9-]*$/`，驼峰当场抛 `TypeError`。

它同时是卡片的 slot key：Plugins 页签只渲染「**host 已服务的 settings namespace ∩ 已注册到
`settings.plugin.item` 的卡片**」的交集（dsh 源码注释原文）。所以哪怕本轮不做配置表单，
host 侧也**必须**调 `installSettingsSection` 注册这个 namespace，否则卡片不会被派发，
且同样是静默的。

**配置真源没有变**：注册了 namespace 但不提供表单，没有任何东西会写 `settings.yaml`，
`scope.get()` 拿到的就是 `cordis.patch.yml` 的 entry 配置，行为与做卡片之前逐字一致。
顺带确认了 token 不会泄漏到浏览器——wire 路径上 `dsh-host-apiproxy` 调的是
`settings.describe({ redactSecrets: true })`，`role('secret')` 字段在过线前被结构性剥除，
我们的 `token` 正是直接声明在 object 根上的 secret 字段。

## 6. 真机验收（2026-08-27，dsh 0.1.1-rc.2 + RTX 3090 24GB）

| # | 场景 | 结果 |
|---|---|---|
| ① | 假 token 取快照 | `panelError` = 「llamapad token 无效或未授权…」，其余字段兜底，卡片正常渲染 ✅ |
| ② | 真 token 取快照 | 10 个模型、`panelError: null`；`missing-file` 那行标出缺失且启动按钮置灰 ✅ |
| ③ | 冷启动 qwen3-1p7b-q8（1.7GB） | **10.2s** 返回，`running` 正确、行状态转 `running`、绿框 + 停止按钮 ✅ |
| ④ | 对已在运行的模型再次 start | **27ms** 返回，门控识别目标已在运行、不重复动作 ✅ |
| ⑤ | **切换**：运行中切到 qwen38-27b-heretic（15.4GB） | **10.7s** 返回，旧模型排空后停止、新模型起来，显存 20.3GB ✅ |
| ⑥ | stop（当前空闲） | **0.4–0.7s** 返回，排空探到空闲即停，`running` 归 null ✅ |
| ⑦ | 浏览器渲染 | 绿点 + 运行中模型名 + 「空闲」Pill；控制台零错误 ✅ |

收尾时显存回到 1 MiB、只剩面板容器本身，环境与接手时一致。

**⑤ 暴露的一个已知行为**：`start` 是乐观返回（不做就绪轮询，否则按钮要卡住），所以
RPC 返回时容器已起但 llama-server 未必加载完。本次页缓存是热的、10.7s 就绪，所以没看出
差别；**页缓存冷 + 大模型时**，卡片会显示「正在运行」而 `inferring` 为 `null`
（`/slots` 探不到），Pill 显示「推理状态未知」。这个组合恰好是「容器在跑、模型还在加载」
的诚实表达，但不是显式的「加载中」态 —— 这一条已在 §7 补做。

## 7. 加载中状态（2026-08-28 补做）

补的是 §6 ⑤ 留下的那个洞：冷启动大模型时，卡片说「正在运行 + 推理状态未知」，
用户分不清是在加载还是出了故障。

### 7.1 判定依据：为什么稳态一次额外请求都不用打

真机实测 llama-server 加载 16.5GB 模型（RTX 3090，冷页缓存）的状态码演化：

| 时刻 | `/health` | `/slots` |
|---|---|---|
| 0–0.95s | 连接被拒（端口未 bind） | 连接被拒 |
| 0.95–33.6s | **503** `{"message":"Loading model"}` | **503** 同 body |
| 33.6s 起 | 200 `{"status":"ok"}` | 200 slot 数组 |

**两个端点的状态码全程同步**，这是整套判定的地基：`/slots` 探得通就意味着模型必然
已加载完。于是 `buildSnapshot` 只在唯一一个真正不可知的窗口里多打一次 `/health`：

```
running === null   → idle
busy   !== null    → ready      ← 短路，不打 /health
否则                → llamaHealth() ? ready : starting
```

`busy` 是可选字段，`undefined` 必须先归一到 `null`，否则 `busy !== null` 对
undefined 成立，会把加载中误判成 ready。

同一条实测也在面板 proxy 这层验过（插件走的是它，不是直连）：端口未 bind 时
proxy 回 502「容器端口未就绪」，加载中透传上游 503，就绪后 200 —— 三段都非 200 即
`llamaHealth()` 为 false，判定成立。

**区分不了「真挂了」和「加载中」**：两者在 boolean 层面都是 false。这是有意的取舍
（改 `llamaHealth()` 签名会波及 `src/tools.ts`），代价是挂掉的模型会一直停在
starting —— 配合下面的已耗时显示，用户自己能察觉。

### 7.2 已耗时靠 `startedAt`，而它在面板侧曾经恒为 null

秒数用面板给的容器启动时刻算，不用卡片本地掐表：轮询抖动、组件重挂载、以及
**模型是别的客户端（面板 UI、聊天 auto-switch）启动的**这三种情况下，本地掐表全都不准。

真机验时发现 `runtime/status` 的 `startedAt` 恒为 `null`，根因在面板：
`src/server/adapters/dockerode.ts` 的 `list()` 把它硬编码成 null（注释称
listContainers 不提供 StartedAt —— 属实，但该 API 给了 `Created`），而 mock 适配器
填的是真实值，**单测因此长期全绿，口径分裂到真机才暴露**。

连带影响比卡片严重：`modelsView` 的 `configStale` 依赖它比对漂移，恒 null 意味着
「配置已变更 / 重启后生效」三处提示在真机从未生效过。已在面板侧改用 `Created`
（llamapad 的 start 与 restart 都是先删后建新容器，两者只差几百毫秒），并在
`dockerode.test.ts` 的集成测试里加了回归断言。

### 7.3 卡片行为

| phase | 状态行 | 轮询 |
|---|---|---|
| `idle` | 当前没有模型在运行 | 5s |
| `starting` | ◐ 正在加载模型 {name}（已 {n}s） | **2s**（对齐面板自身启动进度条口径） |
| `ready` | ● 正在运行：{name} + 推理徽标 | 5s |

- 秒数满 60 秒切到「已 N 分 M 秒」；`startedAt` 缺失或解析失败退化成不带耗时的文案。
- `starting` 阶段不画推理徽标 —— 那句「推理状态未知」在加载中是纯噪音。
- 加载中**不禁用按钮**：用户可能想中止一个加载了半天的大模型。
- 换挡与秒表都挂在派生布尔量 `isStarting` 上，不能用整个 `snapshot` 当 effect 依赖 ——
  快照每轮换新对象，那样定时器会「刚建好就被清理重建」，轮询被自己不断打断。

### 7.4 顺带修掉的按钮语义缺陷

`rowActionFor` 原先完全按 `model.status` 现推按钮动作。启动过程中容器一起来
status 就变 `running`，于是**用户点的是启动、按钮却显示「停止中…」**。这个缺陷本就
存在，被 2s 轮询和 starting 态放大成了常见画面。改为：本行有动作在途时，按钮语义取
用户实际发起的那个动作。

同时把「停止中（可能需要等待现有请求处理完毕，最长约 60 秒）…」从按钮挪进卡片提示行 ——
这句话塞在按钮里会把整行撑到换行、把模型名挤成省略号。

### 7.5 真机验收（2026-08-28，冷页缓存 17.9GB 模型）

| # | 观测项 | 结果 |
|---|---|---|
| ① | starting 态渲染 | 「正在加载模型 …（已 3s）」逐秒走到「已 38s」，39.3s 切「正在运行 / 空闲」 ✅ |
| ② | 数字插值 | `{sec}` 正常插值（翻译层实现打包在 dsh 运行时里，只能真机验） ✅ |
| ③ | 轮询提速 | 加载中实测平均 **1.80s**（设计 2s） ✅ |
| ④ | 按钮语义 | RPC 在途显示「启动中…」，pending 清空后转「停止」 ✅ |
| ⑤ | 控制台 | 零错误 ✅ |

首次出现就是「已 3s」而非 0s —— 秒数从容器创建时刻算起，这正是用绝对时刻的价值。

## 8. 已知缺口

- 卡片的**渲染层**没有测试。纯逻辑（状态推导、按钮禁用条件、文案映射、RPC 外壳拆解）在
  `src/client/state.ts` / `rpc.ts` 里已抽成纯函数并有单测，但「轮询失败保留上一份快照」这类
  组件内行为只有真机验证过，没有回归测试——仓库没装 Testing Library，本轮不为此新增依赖。
- 卡片内的**实时状态靠轮询**（加载中 2 秒、其余 5 秒，见 §7），不是推送。第三方无法往
  `API_REMOTE_FORWARDED_EVENTS` 白名单里追加事件名（那是写死在已发布 npm 包里的数组），
  所以推送这条路对我们关闭。轮询只在卡片挂载期间进行，卸载即停。
- 第三方 `settings.section` 的导航图标只能是通用齿轮（`navIcon()` 按 id 硬编码只认
  `models`/`agent-presets`/`plugins`）。本轮不做独立页，暂时无影响，若日后要做需知悉。
