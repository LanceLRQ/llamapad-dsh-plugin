# M1 快赢包：micro-step 计划（2026-09-03）

依据：[2026-09-03 方案](../design/2026-09-03-multimodal-monitor-events-prompt.md) §5。
四个任务，一任务一提交（中文 Conventional Commits）。TDD：先写失败测试再实现。
每个任务完成后 `pnpm test` + `pnpm run typecheck` 全绿。

## Task 1 工具呈现升级（Q1 + Q2）

`src/tools.ts` + `test/unit/tools.test.ts`：

1. 四个工具补 `isConcurrencySafe: () => true`（只读或经共享门串行，可安全并行派发）
2. `llamapad_status`：
   - `output.presentationMeta(args, value)` 原样返回 value（供 presentResult 读取）
   - `presentCall` → terminal 语义卡（`{card:'terminal', title:'llamapad status'}`，
     以 `dsh-tools/lib/types/presentation.d.ts` 的 `TerminalCallView` 实际字段为准）
   - `presentResult` → `{card:'terminal', title, output:<格式化文本行>, exitCode: 0|1}`
     （面板不可达 → exitCode 1）；从 `result.meta` 读 presentationMeta 投影
3. `llamapad_start_model` / `llamapad_stop_model`：`presentCall` →
   `{card:'generic', title:'启动模型 <name>' / '停止当前模型', kind:'execute'}`；
   `llamapad_list_models` 保持 generic（search paths 卡语义是文件路径，不误用）
4. `render()`（喂模型的 content）一律不动

## Task 2 RPC 取消通道（Q3）

`rpc-contract.ts` / `panel-gateway.ts` / `panel-client.ts` / `switching.ts` /
`src/client/{rpc,state,Card,locale}.*` + 对应测试：

1. `Descriptor` 接口补 `cancellation?: { readonly parameter: 'signal' }`；
   start / stop 描述符声明之；snapshot / saveConnection 不带
2. `StartModelOptions` / `StopModelOptions` 补 `signal?: AbortSignal`；
   `panel-client.request()` 合并外部 signal 与既有 timeout：
   `AbortSignal.any` 存在时用之（feature-detect，缺席则只用 timeout，不炸）
3. `switching.ts` 的 `ensureOnce` 把 `options.signal` 透传给 `client.startModel`
   （现状只取消就绪等待，POST 本身不可取消——补上）
4. `PanelGateway.start/stop(model, signal?)`：signal 进 gate.ensure / stopModel；
   catch 里若 signal 已 aborted → 返回快照**不带 panelError**（取消不是故障）
5. 客户端：`PanelRemoteNamespace`/`PanelApi` 的 start/stop 加可选 `signal` 形参；
   `state.ts` 的 `rowActionFor` 改为「在途行可点（变取消按钮），其余行仍禁用」；
   `Card.tsx` 的 `runAction` 持 AbortController，pending 行按钮点击 = abort；
   `locale.ts` 加 cancel 文案（zh/en）
6. 测试：request 合并逻辑（假 fetch 捕获 signal）、gateway abort 分支、
   ensureOnce 透传、client-rpc 形参透传、rowActionFor 新禁用规则

## Task 3 启停审批门（Q5）

`src/tools.ts` + `test/unit/tools.test.ts`：

1. B 形态 Config 加 `toolApproval: 'allow'|'ask'`（默认 allow），静态校验非法值抛错
   （对齐 index.ts 的 assertStaticConfig 模式）
2. `ask` 档注册 `tools/pre-execute` waterfall 监听：
   `const decision = await next();` 后仅当 `decision.kind === 'allow'` 且
   `exec.name` 是 start/stop 工具时升级为 `{kind:'ask', reason}`——洋葱外层包装，
   不吞别人的 deny
3. 测试：fake ctx 捕获监听器；next=allow + start → ask；next=allow + 别的工具 →
   allow；next=deny → deny 原样；toolApproval=allow 时不注册监听

## Task 4 logger 规范化（Q6）

`src/index.ts` + `src/tools.ts`：

1. `console.warn` → `ctx.logger("<插件名>").warn(...)`（cordis `ctx.logger(name)`）
2. 调整对应测试断言（tools.test.ts 若 spy 了 console.warn）

## 验收

- `pnpm test` / `pnpm run typecheck` / `pnpm run build` 全绿
- 手工冒烟项记入 docs/manual-smoke.md 待收尾统一增补（M5 后）
