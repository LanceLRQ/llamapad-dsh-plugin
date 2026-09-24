# dsh 0.1.5 / 0.1.7 双版本兼容 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 同一份构建产物同时在 dsh 0.1.5-rc.3 与 0.1.7-rc.1 上加载并正常工作（LLM 适配器、管理工具、设置卡片、监控页），修复当前在 0.1.7 上「整个插件加载失败」的问题。

**架构：** 框架依赖从「钉精确版本的 dependencies」改为「带版本范围的 peerDependencies」，运行时统一使用宿主那一份框架（0.1.7 还会按这个范围做兼容性检查）。两代之间有差异的地方都收进小而专注的兼容点，用运行时特征检测选分支：设置服务（`src/compat/settings.ts`）、RPC codec（`strict()` 同时带 `schema` 和 `create`）、工具结果消息（两种结构都接受）、图标（`src/client/icons.ts` 按新名找、找不到再用旧名）、设置卡片插槽（新旧两个插槽都注册）。类型检查以 0.1.7 为准，0.1.5 靠一条双版本测试矩阵兜底。

**技术栈：** TypeScript、cordis、schemastery、vitest、esbuild、pnpm

**规格：** 本计划的依据是两份调研报告（已随本计划归档到 `docs/research/2026-09-24-dsh-015-017-settings.md` 和 `docs/research/2026-09-24-dsh-015-017-apis.md`，任务 7 负责归档）。执行者动手前先读这两份报告。

## 全局约束

- 支持范围：dsh `>=0.1.5-rc.3 <0.1.8-0`。0.1.1 不再支持。
- 运行时 peer（且只有这 4 个）：`@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/dsh-typert-protocol` 用 `>=0.1.5-rc.3 <0.1.8-0`，`@deepseek-ai/schemastery` 用 `^3.18.2`。
- devDependencies 里的 `@deepseek-ai/*` 全部钉到 0.1.7 这一代：`dsh-*` 为 `0.1.7-rc.1`，`cordis` 为 `4.0.4`，`schemastery` 为 `3.18.4`。
- 任何源码都不得运行时 import `@deepseek-ai/dsh-settings`，因为 0.1.5 和 0.1.7 都删掉了 `installSettingsSection`/`settingsNamespace`，ESM 链接阶段就会失败。
- 两代宿主的差异一律用运行时特征检测处理，禁止读取或比较宿主版本号。
- `LlamapadAdapterOptions`/`PanelGatewayOptions` 原地改写的约束保持不变（见 CLAUDE.md「关键约束」）：adapter 与 gateway 每次都现取 `this.options.*`。
- 包管理器是 pnpm，所有网络命令先 `export HTTP_PROXY=http://10.22.33.1:20172 HTTPS_PROXY=http://10.22.33.1:20172 NO_PROXY=localhost,127.0.0.1`。这是 GPU 服务器的出口；在 Mac 开发机上改用 `http://127.0.0.1:20171`，两个都不通就不设代理直连。
- 提交信息使用中文 Conventional Commits，一个任务一个提交。**提交前必须等主会话确认，subagent 不得自行 commit。**
- TDD：先写失败测试，再实现。

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `package.json` / `pnpm-lock.yaml` | peer 范围、devDeps 升代、去掉 `dsh-client-runtime` | 修改 |
| `src/compat/settings.ts` | 设置服务两代差异：`live()`、`plain()`、`bindSettings()` | 创建 |
| `src/index.ts` | Config 里 `panelUrl`/`token` 改为 live，改接 `bindSettings` | 修改 |
| `src/panel-gateway.ts` | 注释里的 settings.yaml 描述改成两代通用说法 | 修改 |
| `src/rpc-contract.ts` | `StrictCodec` 同时带 `schema` 和 `create` | 修改 |
| `src/openai-wire.ts` | 工具结果两种消息结构都接受 | 修改 |
| `src/translate.ts` | `CallId` → `ToolCallId` | 修改 |
| `src/client/icons.ts` | 图标按新名找、找不到用旧名 | 创建 |
| `src/client/Card.tsx` / `MonitorPage.tsx` | 改用 `icons.ts`；Card 支持 `view: "summary"` | 修改 |
| `src/client/index.tsx` / `locale.ts` | 同时注册 `settings.plugin.item` 和 `plugins.bundle.config` | 修改 |
| `scripts/test-compat.mjs` | 在临时副本里装 0.1.5 框架、跑单测和 E2E | 创建 |
| `scripts/release.mjs` | 门禁加上 `test:compat` | 修改 |
| 测试 | `test/unit/compat-settings.test.ts`（新）、`index.test.ts`、`openai-wire.test.ts`、`rpc-contract` 相关、client 相关 | 修改/创建 |
| 文档 | CLAUDE.md、`docs/guide/{zh,en}/installation.md`、`web-ui.md`、`docs/packaging.md`、`docs/manual-smoke.md`、调研归档 | 修改/创建 |

## 任务间预期状态

任务 1 升级依赖后，`typecheck` 和部分测试会变红，要到任务 5 结束才能全部恢复。每个任务的验收只要求**本任务涉及的测试文件全绿**，并且 typecheck 的错误数不能比上一个任务多。任务 5 结束时要求 `pnpm run typecheck`、`pnpm test`、`pnpm run test:e2e` 全部通过。

---

### 任务 1：依赖改为 peer 范围，devDeps 升到 0.1.7

**文件：**
- 修改：`package.json`
- 修改：`pnpm-lock.yaml`（由 pnpm 生成）
- 修改：`src/translate.ts:1,88,104`、`test/unit/openai-wire.test.ts:3,34`

- [ ] **步骤 1：改 `package.json`**

`dependencies` 整段删除，新增 `peerDependencies`：

```json
"peerDependencies": {
  "@deepseek-ai/dsh-llm": ">=0.1.5-rc.3 <0.1.8-0",
  "@deepseek-ai/dsh-tools": ">=0.1.5-rc.3 <0.1.8-0",
  "@deepseek-ai/dsh-typert-protocol": ">=0.1.5-rc.3 <0.1.8-0",
  "@deepseek-ai/schemastery": "^3.18.2"
},
```

`devDependencies` 中的 `@deepseek-ai/*` 改成下面这份，非 `@deepseek-ai` 的条目保持不变。`dsh-client-runtime` 删掉，因为 0.1.5 和 0.1.7 都已不再发布这个包：

```json
"@deepseek-ai/cordis": "4.0.4",
"@deepseek-ai/dsh-api-gateway": "0.1.7-rc.1",
"@deepseek-ai/dsh-attachment": "0.1.7-rc.1",
"@deepseek-ai/dsh-client-locale": "0.1.7-rc.1",
"@deepseek-ai/dsh-client-ui-primitives": "0.1.7-rc.1",
"@deepseek-ai/dsh-client-ui-settings": "0.1.7-rc.1",
"@deepseek-ai/dsh-client-ui-slots": "0.1.7-rc.1",
"@deepseek-ai/dsh-llm": "0.1.7-rc.1",
"@deepseek-ai/dsh-system-prompt": "0.1.7-rc.1",
"@deepseek-ai/dsh-tools": "0.1.7-rc.1",
"@deepseek-ai/dsh-typert-protocol": "0.1.7-rc.1",
"@deepseek-ai/dsh-typert-registry": "0.1.7-rc.1",
"@deepseek-ai/schemastery": "3.18.4",
```

`dsh-settings` 和 `dsh-client-runtime` 都不列。前者任务 2 起不再 import，后者已经不存在。`dsh.client.inject` 数组里删掉 `"@deepseek-ai/dsh-client-runtime"` 这一项，保留另外三项。

- [ ] **步骤 2：安装并确认锁文件**

运行：`pnpm install`
预期：成功，`pnpm-lock.yaml` 更新，不生成 `package-lock.json`。

- [ ] **步骤 3：`CallId` 改名**

`src/translate.ts` 第 1 行：

```ts
import { ToolCallId, LlmError, EMPTY_RESPONSE_CODE } from "@deepseek-ai/dsh-llm";
```

第 88、104 行的 `CallId(acc.id)` 改为 `ToolCallId(acc.id)`。`test/unit/openai-wire.test.ts` 第 3 行改为 `import { ToolCallId } from "@deepseek-ai/dsh-llm";`，第 34 行 `CallId("call_1")` 改为 `ToolCallId("call_1")`。

- [ ] **步骤 4：记录基线**

运行：`pnpm run build && pnpm run typecheck 2>&1 | grep -c "error TS"; pnpm test test/unit/translate.test.ts`
预期：build 成功；translate 测试全绿；typecheck 的错误都集中在 settings、codec、openai-wire、图标这几类，把错误数记进报告，作为之后任务的基线。

- [ ] **步骤 5：提交**（主会话确认后）

```bash
git add package.json pnpm-lock.yaml src/translate.ts test/unit/openai-wire.test.ts
git commit -m "build(deps): 框架依赖改为 peer 范围 >=0.1.5-rc.3 <0.1.8-0，开发依赖升至 0.1.7"
```

---

### 任务 2：设置服务兼容层

**文件：**
- 创建：`src/compat/settings.ts`
- 创建：`test/unit/compat-settings.test.ts`
- 修改：`src/index.ts`（import 区、`Config` 的 `panelUrl`/`token`、`current` 初值、`installSettingsSection` 调用处、`PanelGateway` 构造处、删除文件末尾的 `writeSettings`）
- 修改：`src/panel-gateway.ts:72-77` 注释
- 修改：`test/unit/index.test.ts`（`fakeCtx` 和依赖 `settings.register` 的用例）

背景（出自调研报告第 1、2 节）：

- 0.1.5：`ctx.settings.installSection(owner, ns, schema, entry, { setSource, onChange })`，写入用 `settings.update(ns, patch)`，存到 `settings.yaml`。
- 0.1.7：没有命名空间注册。插件 Config 里 `.volatile()` 的字段可以热更新：loader 就地改写 Volatile 引用，再向插件自身 fiber 发 `loader/volatile-update`。写入用 `settings.update(条目 id, patch)`（只能写 volatile 字段），服务缺席时用 `configEditor.edit(entry, fn)`。条目 id 取 `ctx.fiber.entry.options.id`。自带页面的插件要调用 `settings.configure({ auto: false }, ctx.fiber)`。
- schemastery 是 peer，用的是宿主那一份：0.1.5 宿主是 3.18.2，没有 `.volatile()`；0.1.7 宿主是 3.18.4，有。所以 `live()` 在 0.1.5 上自然退化为普通字段，0.1.5 分支永远拿不到 Volatile。
- Volatile 的识别方式：cosmokit 在对象上挂了 `Symbol.for("cosmokit.volatile.write")`。**动手前先核对**：`grep -n "cosmokit.volatile.write" -r node_modules/@deepseek-ai/cosmokit/`（或在 `node_modules/.pnpm` 里找 cosmokit），确认这个 symbol 是作为 Volatile 实例上的属性键存在的。如果不是，就改用那份源码里导出的 `isVolatile` 判定逻辑，并在报告里说明。

- [ ] **步骤 1：编写失败的测试** `test/unit/compat-settings.test.ts`

```ts
import { describe, expect, it, vi } from "vitest";
import Schema from "@deepseek-ai/schemastery";
import { bindSettings, isVolatile, live, plain } from "../../src/compat/settings";
import { SETTINGS_NAMESPACE } from "../../src/rpc-contract";

const hasVolatile = typeof (Schema.string() as { volatile?: unknown }).volatile === "function";

describe("live / plain", () => {
  it.skipIf(!hasVolatile)("0.1.7：live 字段解析成 Volatile，plain 解包成普通值", () => {
    const S = Schema.object({ a: live(Schema.string()), b: Schema.number().default(1) });
    const parsed = S({ a: "x" }) as Record<string, unknown>;
    expect(isVolatile(parsed.a)).toBe(true);
    expect(plain(parsed)).toEqual({ a: "x", b: 1 });
  });

  it("没有 volatile() 的 schema 原样返回（0.1.5 的 schemastery 3.18.2）", () => {
    const fake = { marker: 1 };
    expect(live(fake)).toBe(fake);
  });

  it("plain 对普通对象是等值拷贝，不改原对象", () => {
    const src = { a: "x", b: 2 };
    const out = plain(src);
    expect(out).toEqual(src);
    expect(out).not.toBe(src);
  });
});

function ctxWith(settings: unknown, extra: Record<string, unknown> = {}) {
  const listeners: Record<string, () => void> = {};
  const ctx: any = {
    fiber: { entry: { options: { id: "llamapad" } } },
    logger: () => ({ warn: vi.fn() }),
    on: vi.fn((name: string, fn: () => void) => { listeners[name] = fn; }),
    effect: vi.fn((fn: () => unknown) => fn()),
    get: vi.fn((name: string) => (name === "settings" ? settings : extra[name])),
    inject: vi.fn((deps: string[], cb: (c: any) => void) => {
      if (deps.includes("settings") && settings !== undefined) cb({ settings, effect: ctx.effect });
    }),
  };
  return { ctx, listeners };
}

describe("bindSettings：0.1.5（installSection）", () => {
  it("用 SETTINGS_NAMESPACE 装配，传入解包后的 entry，写入走 update(ns)", async () => {
    const settings = { installSection: vi.fn(), update: vi.fn(async () => {}) };
    const { ctx } = ctxWith(settings);
    const hooks = { setSource: vi.fn(), onChange: vi.fn() };
    const write = bindSettings(ctx, "SCHEMA", { panelUrl: "u", token: "t" }, hooks);
    expect(settings.installSection).toHaveBeenCalledWith(
      ctx, SETTINGS_NAMESPACE, "SCHEMA", { panelUrl: "u", token: "t" }, hooks,
    );
    await write({ panelUrl: "u2" });
    expect(settings.update).toHaveBeenCalledWith(SETTINGS_NAMESPACE, { panelUrl: "u2" });
  });
});

describe("bindSettings：0.1.7（SettingsForms）", () => {
  it("关掉自动表单；volatile 更新事件触发 onChange；写入走 update(条目 id)", async () => {
    const dispose = vi.fn();
    const settings = { configure: vi.fn(() => dispose), update: vi.fn(async () => {}) };
    const { ctx, listeners } = ctxWith(settings);
    const hooks = { setSource: vi.fn(), onChange: vi.fn() };
    const write = bindSettings(ctx, "SCHEMA", { panelUrl: "u", token: "t" }, hooks);
    expect(settings.configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber);
    listeners["loader/volatile-update"]!();
    expect(hooks.onChange).toHaveBeenCalledTimes(1);
    expect(hooks.setSource).not.toHaveBeenCalled();
    await write({ token: "t2" });
    expect(settings.update).toHaveBeenCalledWith("llamapad", { token: "t2" });
  });

  it("连接没配时提醒旧卡片保存的值需要重新填写", () => {
    const warn = vi.fn();
    const settings = { configure: vi.fn(() => () => {}), update: vi.fn() };
    const { ctx } = ctxWith(settings);
    ctx.logger = () => ({ warn });
    bindSettings(ctx, "SCHEMA", { panelUrl: "", token: "" }, { setSource: vi.fn(), onChange: vi.fn() });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain("settings.yaml.imported");
  });
});

describe("bindSettings：设置服务缺席", () => {
  it("写入退到 configEditor.edit，合并当前配置", async () => {
    const edit = vi.fn(async (_entry: unknown, fn: (c: object) => object) => fn({ panelUrl: "old", mode: "proxy" }));
    const { ctx } = ctxWith(undefined, { configEditor: { edit } });
    const write = bindSettings(ctx, "SCHEMA", { panelUrl: "", token: "" }, { setSource: vi.fn(), onChange: vi.fn() });
    await write({ panelUrl: "new" });
    expect(edit).toHaveBeenCalledTimes(1);
    expect(await edit.mock.results[0]!.value).toEqual({ panelUrl: "new", mode: "proxy" });
  });

  it("设置服务和 configEditor 都没有时，写入明确报错", async () => {
    const { ctx } = ctxWith(undefined);
    const write = bindSettings(ctx, "SCHEMA", { panelUrl: "", token: "" }, { setSource: vi.fn(), onChange: vi.fn() });
    await expect(write({ panelUrl: "x" })).rejects.toThrow(/无法保存/);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/unit/compat-settings.test.ts`
预期：FAIL，报错找不到模块 `../../src/compat/settings`。

- [ ] **步骤 3：实现 `src/compat/settings.ts`**

```ts
// dsh 设置服务的两代差异收在这里，其余代码只见 bindSettings 一个入口。
//
// 0.1.5：插件注册自己的命名空间（installSection），值存在 $DSH_HOME/settings.yaml，
//   经 setSource/onChange 热更新；写入 update(命名空间, patch)。
// 0.1.7：没有命名空间注册。Config 里 .volatile() 的字段由 loader 就地改写 Volatile
//   引用，再向本插件 fiber 发 loader/volatile-update；写入 update(条目 id, patch)，
//   落到 profile 的 cordis.patch.yml。
//
// 分支靠特征检测（有没有 installSection / configure），不比较宿主版本号。
import type { Context } from "@deepseek-ai/cordis";
import { SETTINGS_NAMESPACE } from "../rpc-contract";

const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

interface VolatileLike { get(): unknown }

export function isVolatile(value: unknown): value is VolatileLike {
  return typeof value === "object" && value !== null && VOLATILE_WRITE in value;
}

/**
 * 标记为可热更新的字段。schemastery 是 peer，用的是宿主那份：0.1.7 宿主（3.18.4）
 * 有 volatile()；0.1.5 宿主（3.18.2）没有，原样返回，字段按普通字段处理。
 */
export function live<S>(schema: S): S {
  const candidate = schema as S & { volatile?: () => S };
  return typeof candidate.volatile === "function" ? candidate.volatile() : schema;
}

/** 把 Volatile 字段解包成当前值。0.1.7 上每次都要现取，loader 会就地改写引用。 */
export function plain<T extends object>(config: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) out[key] = isVolatile(value) ? value.get() : value;
  return out as T;
}

export interface SettingsHooks<T> {
  setSource(source: () => T): void;
  onChange(): void;
}

interface SettingsV015 {
  installSection(owner: Context, ns: string, schema: unknown, entry: unknown, hooks: unknown): void;
  update(ns: string, patch: object): Promise<void>;
}

interface SettingsV017 {
  configure(presentation: { auto?: boolean }, owner?: unknown): () => void;
  update(ns: string, patch: object): Promise<void>;
}

interface ConfigEditorLike {
  edit(entry: unknown, next: (current: Record<string, unknown>) => Record<string, unknown>): Promise<unknown>;
}

const isV015 = (s: unknown): s is SettingsV015 =>
  typeof (s as SettingsV015 | undefined)?.installSection === "function";
const isV017 = (s: unknown): s is SettingsV017 =>
  typeof (s as SettingsV017 | undefined)?.configure === "function";

/**
 * 接上宿主的设置服务，返回给设置卡片 saveConnection 用的写入函数。
 * 服务缺席时 hooks 一次都不会被调用，调用方沿用初始配置，插件照常工作。
 */
export function bindSettings<T extends { panelUrl?: unknown; token?: unknown }>(
  ctx: Context, schema: unknown, entry: T, hooks: SettingsHooks<T>,
): (patch: Partial<T>) => Promise<void> {
  const anyCtx = ctx as any;
  // 0.1.7 的热更新事件只投递给本插件 fiber 上的监听器，必须挂在 ctx 本身，
  // 不能挂进下面 inject 出来的子上下文。0.1.5 上这个事件不会出现，挂着无害。
  anyCtx.on("loader/volatile-update", () => hooks.onChange());

  ctx.inject(["settings"], (sctx) => {
    const settings = (sctx as any).settings;
    if (isV015(settings)) {
      settings.installSection(ctx, SETTINGS_NAMESPACE, schema, plain(entry), hooks);
    } else if (isV017(settings)) {
      (sctx as any).effect(() => settings.configure({ auto: false }, anyCtx.fiber));
      const current = plain(entry);
      if (!current.panelUrl || !current.token) {
        anyCtx.logger("llamapad-dsh-plugin").warn(
          "当前 dsh 把插件配置存在 profile 的 cordis.patch.yml 里。旧版设置卡片保存的面板地址和 token"
          + " 留在 $DSH_HOME/settings.yaml.imported 的 llamapad-panel 一节，没有自动迁移，请在设置卡片里重新填写一次。",
        );
      }
    }
  });

  return async (patch) => {
    const settings = anyCtx.get("settings");
    if (isV015(settings)) return settings.update(SETTINGS_NAMESPACE, patch);
    const pluginEntry = anyCtx.fiber?.entry;
    if (isV017(settings) && pluginEntry !== undefined) return settings.update(pluginEntry.options.id, patch);
    const editor = anyCtx.get("configEditor") as ConfigEditorLike | undefined;
    if (typeof editor?.edit === "function" && pluginEntry !== undefined) {
      await editor.edit(pluginEntry, (current) => ({ ...current, ...patch }));
      return;
    }
    throw new Error("dsh 的设置服务不可用，无法保存连接配置。请直接编辑 profile 的 cordis.patch.yml");
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/unit/compat-settings.test.ts`
预期：PASS（0.1.7 的 schemastery 3.18.4 下 `skipIf` 那条会实际执行）。

- [ ] **步骤 5：改写 `test/unit/index.test.ts` 的 fake，让 index 的用例先红**

把 `fakeCtx` 的 `settings` 选项从布尔值改成 `settings?: "v015" | "v017" | false`：

- `"v015"`：`ctx.settings = { installSection: vi.fn((_owner, _ns, _schema, entry, hooks) => { hooks.setSource(() => scopeValue.current ?? entry); hooks.onChange(); }), update: vi.fn(async () => {}) }`
- `"v017"`：`ctx.settings = { configure: vi.fn(() => () => {}), update: vi.fn(async () => {}) }`
- 无论哪种，都给 ctx 补上 `on: vi.fn()`、`get: vi.fn((n) => (n === "settings" && options.settings ? ctx.settings : undefined))`、`logger: () => ({ warn: vi.fn(), info: vi.fn() })`，以及 `fiber: { state: 0, entry: { options: { id: "llamapad" } } }`。
- `ctx.inject` 的 settings 分支改为 `options.settings` 为真值时回调。

原来用 `settings: true` 的用例一律改成 `"v015"`。原来通过 `ctx.settings.register.mock.results[0].value.watch.mock.calls[0][0]` 拿 watch 回调来模拟「settings 层写入」的用例（热更新、热关 statusPromptSection 等），改用这个辅助函数：

```ts
/** 模拟 0.1.5 settings 层的一次提交：改写 scope 值，再调 installSection 收到的 onChange。 */
function commitSettings(ctx: any, next: Record<string, unknown>) {
  ctx.__scopeValue.current = next;
  const hooks = ctx.settings.installSection.mock.calls[0]![4];
  hooks.onChange();
}
```

原来断言 `ctx.settings.register` 被调用一次的用例（「缺 panelUrl/token 时仍然注册 settings」），改成断言 `ctx.settings.installSection` 被调用一次，第二个参数是 `"llamapad-panel"`。

再新增一个 0.1.7 用例：

```ts
it("0.1.7：volatile 更新事件到达后 adapter 换用新 client，不重新注册", () => {
  const ctx = fakeCtx({ settings: "v017" });
  apply(ctx, Config(valid) as any);
  expect(ctx.settings.configure).toHaveBeenCalledWith({ auto: false }, ctx.fiber);
  const adapter = ctx.llm.registerAdapter.mock.calls[0]![1];
  const before = adapter.options.client;
  const onVolatile = ctx.on.mock.calls.find((c: any[]) => c[0] === "loader/volatile-update")![1];
  onVolatile();
  expect(adapter.options.client).toBe(before);   // 值没变，syncConnection 幂等，不换 client
  expect(ctx.llm.registerAdapter).toHaveBeenCalledTimes(1);
});
```

运行：`pnpm test test/unit/index.test.ts`
预期：FAIL，`src/index.ts` 仍然 import 旧的 `installSettingsSection`。

- [ ] **步骤 6：改 `src/index.ts`**

1. 删除 `import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings";`，新增 `import { bindSettings, live, plain } from "./compat/settings";`。
2. `Config` schema 里只把这两项包上 `live(...)`，其余字段不变：

   ```ts
   panelUrl: live(Schema.string().description("llamapad 面板地址，如 http://192.168.1.10:8080")),
   token: live(Schema.string().role("secret").description("llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）")),
   ```

   在 `export const Config` 上方的注释里补一句：panelUrl/token 是 volatile，因为 0.1.7 的设置写入只接受 volatile 字段；设置卡片只写这两项。其余字段在 0.1.7 下被改动时会重启本插件 fiber。
3. `let current: () => Config = () => config;` 改为 `let current: () => Config = () => plain(config);`，上面那段注释改成「初值是组合配置（0.1.7 上会现取 Volatile 的当前值）；0.1.5 挂上设置服务后被 setSource 换成三层合并的值」。
4. 把 `installSettingsSection(ctx, settingsNamespace(SETTINGS_NAMESPACE), Config, config, { ... });` 整段替换为：

   ```ts
   const writeSettings = bindSettings(ctx, Config, config, {
     setSource: (source) => { current = () => plain(source()); },
     onChange: syncConnection,
   });
   ```

   上方注释中与 `installSettingsSection` 有关的描述改成对 `bindSettings` 的描述，其余说明（为什么缺配置也要走到这一步）保留。
5. `new PanelGateway(ctx, gatewayOptions, (patch) => writeSettings(ctx, patch));` 改为 `new PanelGateway(ctx, gatewayOptions, (patch) => writeSettings(patch));`。
6. 删除文件末尾的 `function writeSettings(...)` 及其注释块。从 rpc-contract 的 import 里去掉已不再使用的 `SETTINGS_NAMESPACE`。
7. `src/panel-gateway.ts:72-77` 注释里「落到 $DSH_HOME/settings.yaml 的本插件分节」改为「0.1.5 落到 $DSH_HOME/settings.yaml 的本插件分节，0.1.7 落到 profile 的 cordis.patch.yml」，「真要清得去改 settings.yaml」改为「真要清得去改配置文件」。

- [ ] **步骤 7：运行测试验证通过**

运行：`pnpm test test/unit/index.test.ts test/unit/compat-settings.test.ts test/unit/panel-gateway.test.ts`
预期：PASS。

- [ ] **步骤 8：确认不再有 dsh-settings 运行时引用**

运行：`grep -rn "dsh-settings" src; pnpm run build && grep -c "dsh-settings" dist/index.js`
预期：src 里无匹配；dist 里计数为 0。

- [ ] **步骤 9：提交**（主会话确认后）

```bash
git add src/compat/settings.ts src/index.ts src/panel-gateway.ts test/unit/compat-settings.test.ts test/unit/index.test.ts
git commit -m "feat(compat): 设置服务兼容 dsh 0.1.5 installSection 与 0.1.7 SettingsForms"
```

---

### 任务 3：RPC codec 同时满足两代校验

**文件：**
- 修改：`src/rpc-contract.ts:247-255`（`StrictCodec`、`strict()`）
- 测试：`test/unit/panel-gateway.test.ts`（已有「RPC_CONTRIBUTION 契约不变量」一组，在文件末尾新增一个 describe）

背景：0.1.5 校验 `codec.schema.parse`，0.1.7 校验 `codec.create()` 并调用 `codec.create().parse(value)`（`dsh-typert-registry` 的 `validateCodec`、`dsh-api-gateway` 解析处）。两边都指向同一个 `parse`。

- [ ] **步骤 1：编写失败的测试**

```ts
import { RPC_CONTRIBUTION } from "../../src/rpc-contract";

describe("RPC codec 同时满足 dsh 0.1.5 与 0.1.7 的校验", () => {
  // 描述符形状见 src/rpc-contract.ts 的 Descriptor：result 本身就是 codec，参数的 codec 在 parameters[].codec
  const codecs = RPC_CONTRIBUTION.descriptors.flatMap((d: any) => [d.result, ...d.parameters.map((p: any) => p.codec)]);

  it("每个 strict codec 都有 schema.parse（0.1.5）和 create()（0.1.7），且是同一个 parse", () => {
    expect(codecs.length).toBeGreaterThan(0);
    for (const codec of codecs) {
      expect(typeof codec.schema.parse).toBe("function");
      expect(typeof codec.create).toBe("function");
      expect(codec.create().parse).toBe(codec.schema.parse);
    }
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/unit/panel-gateway.test.ts`
预期：FAIL，`codec.create` 是 undefined。

- [ ] **步骤 3：实现**

```ts
/**
 * dsh 的 TypertCodec 的 strict 分支，本地重述一份，避免浏览器产物 import 运行时包。
 * 两代宿主读的字段不同：0.1.5 校验并调用 schema.parse，0.1.7 校验并调用 create().parse。
 * 两个字段都带上，指向同一个 parse。
 */
export interface StrictCodec<T> {
  readonly mode: "strict";
  readonly typeSymbol: string;
  readonly schema: { parse(value: unknown): T };
  readonly create: () => { parse(value: unknown): T };
}

function strict<T>(typeSymbol: string, parse: (value: unknown) => T): StrictCodec<T> {
  const schema = { parse };
  return { mode: "strict", typeSymbol, schema, create: () => schema };
}
```

文件里只有 `strict()` 一处构造 codec（`grep -n "schema: {" src/rpc-contract.ts` 只命中接口和 `strict()` 本身），其余 codec 常量都经过它，不需要额外改。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/unit/panel-gateway.test.ts; pnpm run typecheck 2>&1 | grep "index.ts" | grep -c "InvocationDescriptor"`
预期：测试 PASS；`InvocationDescriptor` 相关的类型错误数为 0。

- [ ] **步骤 5：提交**（主会话确认后）

```bash
git add src/rpc-contract.ts test/unit/panel-gateway.test.ts
git commit -m "fix(rpc): strict codec 同时提供 schema 与 create，兼容 dsh 0.1.5/0.1.7 的校验"
```

---

### 任务 4：工具结果两种消息结构都接受

**文件：**
- 修改：`src/openai-wire.ts`（`collectImages`、`mapMessage`，以及遍历 `message.content` 时判断 `block.type === "tool-result"` 的地方）
- 测试：`test/unit/openai-wire.test.ts`

背景：0.1.5 把工具结果作为 `ToolResultBlock { type: "tool-result", toolCallId, content, isError? }`，挂在 `role: "user"` 消息的 `content` 里。0.1.7 改成独立的 `ToolResultMessage { role: "tool", toolCallId, content, isError? }`，`ContentBlockMap` 里已经没有 `"tool-result"`。类型按 0.1.7 写，0.1.5 的结构用本地类型描述。动手前先核对 0.1.7 的 `node_modules/@deepseek-ai/dsh-llm/lib/types/message.d.ts` 中 `ToolResultMessage.content` 的类型，确认它和 `renderToolResult` 的入参兼容。

- [ ] **步骤 1：编写失败的测试**（追加到 `test/unit/openai-wire.test.ts`）

```ts
describe("工具结果：两代消息结构输出同一份 wire", () => {
  const expected = { role: "tool", tool_call_id: "call_1", content: "晴" };

  it("0.1.7：role=tool 的独立消息", () => {
    const body = buildChatBody({
      messages: [{ role: "tool", toolCallId: ToolCallId("call_1"), content: [{ type: "text", text: "晴" }] }],
    } as any);
    expect((body.messages as unknown[])).toContainEqual(expected);
  });

  it("0.1.5：user 消息里的 tool-result 块", () => {
    const body = buildChatBody({
      messages: [{ role: "user", content: [{ type: "tool-result", toolCallId: "call_1", content: [{ type: "text", text: "晴" }] }] }],
    } as any);
    expect((body.messages as unknown[])).toContainEqual(expected);
  });

  it("collectImages 能收集到 0.1.7 工具消息里的图片", () => {
    const ref = { id: "img1" };
    const refs = collectImages({
      messages: [{ role: "tool", toolCallId: ToolCallId("call_1"), content: [{ type: "image", attachment: ref }] }],
    } as any);
    expect(refs).toEqual([ref]);
  });
});
```

如果 `buildChatBody`/`collectImages` 在这个测试文件里还没有 import，就补上。如果 `renderToolResult` 对纯文本内容的输出不是 `"晴"`，按它的实际输出调整 `expected`。关键是两条用例得到的结果必须相同。

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/unit/openai-wire.test.ts`
预期：FAIL，0.1.7 那两条用例没有产出 tool 消息，也收集不到图片。

- [ ] **步骤 3：实现**

在 `src/openai-wire.ts` 顶部新增本地类型和判定函数：

```ts
/** 0.1.5 的工具结果：挂在 user 消息 content 里的块。0.1.7 的 ContentBlock 已无此类型。 */
interface LegacyToolResultBlock {
  type: "tool-result";
  toolCallId: string;
  content: readonly ContentBlock[];
}

/** 0.1.7 的工具结果：独立的 role=tool 消息。 */
interface ToolRoleMessage {
  role: "tool";
  toolCallId: string;
  content: readonly ContentBlock[];
}

const isLegacyToolResult = (block: { type: string }): block is LegacyToolResultBlock =>
  block.type === "tool-result";

const isToolRoleMessage = (message: { role: string }): message is ToolRoleMessage =>
  message.role === "tool";
```

`collectImages`：`walk` 里的 `else if (block.type === "tool-result")` 改为 `else if (isLegacyToolResult(block as { type: string })) walk((block as LegacyToolResultBlock).content);`。不需要改循环体 `for (const message of options.messages) walk(message.content);`：0.1.7 的 tool 消息本身有 `content`，里面的图片同样会被收集到。

`mapMessage` 开头（`role === "system"` 分支之前）新增：

```ts
if (isToolRoleMessage(message as { role: string })) {
  const tool = message as unknown as ToolRoleMessage;
  return [{ role: "tool", tool_call_id: tool.toolCallId, content: renderToolResult(tool.content) }];
}
```

原来 `else if (block.type === "tool-result") { out.push(...) }` 的分支改成用 `isLegacyToolResult(block as { type: string })` 判定，分支内部通过 `const legacy = block as unknown as LegacyToolResultBlock;` 读取 `legacy.toolCallId`、`legacy.content`，推入的内容保持不变。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm test test/unit/openai-wire.test.ts test/unit/adapter.test.ts; pnpm run typecheck 2>&1 | grep -c "openai-wire.ts"`
预期：测试 PASS；openai-wire.ts 的类型错误数为 0。

- [ ] **步骤 5：提交**（主会话确认后）

```bash
git add src/openai-wire.ts test/unit/openai-wire.test.ts
git commit -m "fix(wire): 工具结果同时接受 0.1.5 的 tool-result 块与 0.1.7 的 role=tool 消息"
```

---

### 任务 5：浏览器端：图标与设置卡片插槽

**文件：**
- 创建：`src/client/icons.ts`
- 修改：`src/client/Card.tsx:5-12` 的图标 import 及用处；`src/client/MonitorPage.tsx:5-8` 同理
- 修改：`src/client/index.tsx`（插槽注册），`src/client/locale.ts`（新增 `cardSummary` 文案，中英两份）
- 测试：新建 `test/unit/client-icons.test.ts` 和 `test/unit/client-index.test.ts`（client 入口目前没有测试）

背景：0.1.7 的图标名去掉了像素后缀，每个图标有 `Medium` 和 `Regular` 两个变体，尺寸改由 `size` prop 决定；0.1.5 是 `IconXxx16`/`IconXxx14`。设置卡片方面，0.1.5 的「设置 → 插件」页签通过 `settings.plugin.item`（key 是 `SETTINGS_NAMESPACE`）派发；0.1.7 删掉了这个插槽，改由侧栏「插件」页的 `plugins.bundle.config`（key 是包名 `RPC_PACKAGE`，即 `llamapad-dsh-plugin`）承载，渲染时 owner props 是 `{ view: "summary" | "page", form? }`。`slots.inject` 遇到当前宿主未声明的插槽时只是挂起等待，不会报错，所以两个插槽都注册即可。

- [ ] **步骤 1：编写失败的测试** `test/unit/client-icons.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { pickIcon } from "../../src/client/icons";

describe("pickIcon：先找 0.1.7 的新名，再找 0.1.5 的旧名", () => {
  const New = () => null;
  const Old = () => null;

  it("新名存在时用新名", () => {
    expect(pickIcon({ IconCheckOutlineMedium: New, IconCheckOutline16: Old }, "IconCheckOutline", 16)).toBe(New);
  });

  it("只有旧名时用旧名", () => {
    expect(pickIcon({ IconCheckOutline16: Old }, "IconCheckOutline", 16)).toBe(Old);
  });

  it("都没有时返回一个渲染为 null 的组件，而不是 undefined", () => {
    const Fallback = pickIcon({}, "IconCheckOutline", 16);
    expect(typeof Fallback).toBe("function");
    expect((Fallback as () => unknown)()).toBeNull();
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm test test/unit/client-icons.test.ts`
预期：FAIL，找不到模块。

- [ ] **步骤 3：实现 `src/client/icons.ts`**

```ts
// 图标名在 dsh 0.1.7 改过：去掉像素后缀，改成 Medium/Regular 两种描边，尺寸由 size 决定。
// 0.1.5 仍是 IconXxx16 这类旧名。静态具名 import 只能对上其中一代，所以整包取出来按名字找。
import type { ComponentType } from "react";
import * as Primitives from "@deepseek-ai/dsh-client-ui-primitives";

export type IconComponent = ComponentType<{ size?: number; className?: string }>;

const Empty: IconComponent = () => null;

export function pickIcon(lib: Record<string, unknown>, base: string, legacySize: 14 | 16): IconComponent {
  const found = lib[`${base}Medium`] ?? lib[`${base}${legacySize}`];
  return typeof found === "function" || (typeof found === "object" && found !== null)
    ? (found as IconComponent)
    : Empty;
}

const lib = Primitives as unknown as Record<string, unknown>;

export const IconCheck = pickIcon(lib, "IconCheckOutline", 16);
export const IconChevronDown = pickIcon(lib, "IconChevronDownOutline", 14);
export const IconLink = pickIcon(lib, "IconLinkOutline", 16);
export const IconPlay = pickIcon(lib, "IconPlayOutline", 16);
export const IconStop = pickIcon(lib, "IconStopFill", 16);
export const IconWarning = pickIcon(lib, "IconWarningOutline", 16);
export const IconClose = pickIcon(lib, "IconCloseOutline", 16);
```

`typeof found === "object"` 用来兼容 `React.memo`/`forwardRef` 包装出来的组件，它们是对象。

- [ ] **步骤 4：改 Card.tsx / MonitorPage.tsx**

从两个文件对 `@deepseek-ai/dsh-client-ui-primitives` 的具名 import 里去掉全部 `Icon*`（`Button` 等非图标组件保留），改为从 `./icons` 引入对应的 `IconCheck` 等。替换对照：

| 旧名 | 新名 | 用处加的 size |
|---|---|---|
| `IconCheckOutline16` | `IconCheck` | `size={16}` |
| `IconChevronDownOutline14` | `IconChevronDown` | `size={14}` |
| `IconLinkOutline16` | `IconLink` | `size={16}` |
| `IconPlayOutline16` | `IconPlay` | `size={16}` |
| `IconStopFill16` | `IconStop` | `size={16}` |
| `IconWarningOutline16` | `IconWarning` | `size={16}` |
| `IconCloseOutline16` | `IconClose` | `size={16}` |

用处原有的 props（例如 `IconChevronDownOutline14` 上的 className）全部保留。

运行：`pnpm test test/unit/client-icons.test.ts; pnpm run typecheck 2>&1 | grep -c "client/"`
预期：PASS；client 目录的类型错误数为 0。

- [ ] **步骤 5：插槽的失败测试**

在新建的 `test/unit/client-index.test.ts` 里断言：`apply` 之后，`ctx.slots.inject` 被调用时的插槽名同时包含 `"settings.plugin.item"`、`"plugins.bundle.config"`、`"settings.section"`；`plugins.bundle.config` 那次注册的 `key` 等于 `RPC_PACKAGE`，`settings.plugin.item` 那次注册的 `key` 等于 `SETTINGS_NAMESPACE`。fake ctx 照 `src/client/index.tsx` 的依赖（`remote.$mount`、`locale.register/bind`、`inject`、`slots.inject/register`）桩一个最小 ctx，让 `ctx.inject(deps, cb)` 同步回调，`slots.inject(name, factory)` 记录 name 并立即执行 factory。

运行：`pnpm test test/unit/client-index.test.ts`
预期：FAIL，还没有注册 `plugins.bundle.config`。

- [ ] **步骤 6：实现插槽注册**

`src/client/index.tsx` 在 `settings.plugin.item` 那段注册旁边新增一段 `plugins.bundle.config` 注册，写法与已有的那段一致（同一个 `Card` 组件，同样的 `locale: LOCALE_NS` 和 `inject: () => ({ api })`）。不同之处只有 `name: "plugins.bundle.config"`、`key: RPC_PACKAGE`（从 `../rpc-contract` 引入）。新的 disposer 并进合成的总 disposer。文件头注释补一段：0.1.5 走 `settings.plugin.item`，0.1.7 走侧栏「插件」页的 `plugins.bundle.config`；未声明的插槽只会挂起，所以两个都注册。

`Card` 组件的 props 增加可选的 `view?: "summary" | "page"`：`view === "summary"` 时只返回 `<span>{t("cardSummary")}</span>`，不启动轮询；其余情况和现在一样。`locale.ts` 中英两份各新增 `cardSummary`，中文为「连接 llamapad 面板，查看和启停本地模型」，英文为 "Connect to the llamapad panel to view, start, and stop local models"。

- [ ] **步骤 7：全量验证**

运行：`pnpm run build && pnpm run typecheck && pnpm test && pnpm run test:e2e`
预期：全部通过，typecheck 零错误。`test/e2e/client-bundle-format.test.ts` 通过，说明 `dist/client.js` 的 external 依然只有 seed 模块。

- [ ] **步骤 8：提交**（主会话确认后）

```bash
git add src/client/icons.ts src/client/Card.tsx src/client/MonitorPage.tsx src/client/index.tsx src/client/locale.ts test/unit/client-icons.test.ts test/unit/client-index.test.ts
git commit -m "feat(client): 图标按新旧名兼容，设置卡片同时挂到 0.1.5 与 0.1.7 的插槽"
```

---

### 任务 6：双版本测试矩阵

**文件：**
- 创建：`scripts/test-compat.mjs`
- 修改：`package.json` 的 `scripts`（新增 `test:compat`）
- 修改：`scripts/release.mjs:48-51`（门禁里加一步）

- [ ] **步骤 1：实现 `scripts/test-compat.mjs`**

```js
// 双版本测试矩阵：仓库默认对着 0.1.7 这一代做类型检查和测试；本脚本把仓库复制到
// 临时目录，devDependencies 里的框架包换成 0.1.5 这一代，装好后跑单测和假面板 E2E。
// 不跑 typecheck：类型以 0.1.7 为准，0.1.5 只验证运行时行为。
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const LEGACY = {
  dsh: '0.1.5-rc.3',
  '@deepseek-ai/cordis': '4.0.2',
  '@deepseek-ai/schemastery': '3.18.2',
}

const root = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'llamapad-compat-'))
const skip = new Set(['node_modules', 'dist', '.git'])

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error(`[test:compat] 失败：${cmd} ${args.join(' ')}（临时目录保留在 ${dir}）`)
    process.exit(r.status ?? 1)
  }
}

cpSync(root, dir, {
  recursive: true,
  filter: (src) => !skip.has(src.slice(root.length + 1).split(/[\\/]/)[0]) && !src.endsWith('.tgz'),
})

const pkgPath = join(dir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
for (const name of Object.keys(pkg.devDependencies)) {
  if (name in LEGACY) pkg.devDependencies[name] = LEGACY[name]
  else if (name.startsWith('@deepseek-ai/dsh-')) pkg.devDependencies[name] = LEGACY.dsh
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2))
rmSync(join(dir, 'pnpm-lock.yaml'), { force: true })

console.log(`[test:compat] 在 ${dir} 以 dsh ${LEGACY.dsh} 框架运行单测与 E2E`)
run('pnpm', ['install', '--no-frozen-lockfile'])
run('pnpm', ['test'])
run('pnpm', ['run', 'test:e2e'])
rmSync(dir, { recursive: true, force: true })
console.log('[test:compat] 通过')
```

`package.json` 的 `scripts` 新增 `"test:compat": "node scripts/test-compat.mjs"`。

- [ ] **步骤 2：运行矩阵**

运行：`pnpm run test:compat`
预期：在 0.1.5 框架下，单测和 E2E 全部通过。`compat-settings.test.ts` 里依赖 `volatile()` 的那条用例会被 `skipIf` 跳过，这是预期的。如有失败，修复位置应该在任务 2 到 5 引入的兼容点上，不能为了 0.1.5 改动 0.1.7 的路径。把失败原因和修复写进报告。

- [ ] **步骤 3：加进发布门禁**

`scripts/release.mjs` 在 `run('pnpm', ['run', 'test:e2e'])` 之后加一行 `run('pnpm', ['run', 'test:compat'])`，并把第 48 行的日志改为 `'[release] 质量门禁：typecheck / 单测 / E2E / 0.1.5 兼容矩阵'`，文件头第 3 行的流程注释同步加上「0.1.5 兼容矩阵」。

- [ ] **步骤 4：提交**（主会话确认后）

```bash
git add scripts/test-compat.mjs scripts/release.mjs package.json
git commit -m "test(compat): 新增 dsh 0.1.5 兼容测试矩阵并纳入发布门禁"
```

---

### 任务 7：文档与真机验证

真机验证由主会话执行（需要浏览器和本机 dsh），文档部分可以派 subagent。

**文件：**
- 创建：`docs/research/2026-09-24-dsh-015-017-settings.md`、`docs/research/2026-09-24-dsh-015-017-apis.md`（从 scratchpad 里的两份调研报告复制过来，把报告开头的临时路径说明改成「路径均指当时的临时安装目录，仅作溯源」）
- 修改：`CLAUDE.md`「关键约束」中「钉版必须与宿主 dsh 同代」一条：改为「框架依赖是 peer 范围 `>=0.1.5-rc.3 <0.1.8-0`，运行时用宿主那一份；devDependencies 钉 0.1.7 这一代用于类型检查；两代差异收在 `src/compat/settings.ts`、`rpc-contract.ts` 的 `strict()`、`openai-wire.ts` 的工具结果判定、`src/client/icons.ts`、`client/index.tsx` 的双插槽注册；新增宿主代时先跑 `pnpm run test:compat` 并扩展 peer 范围」。同时删除「本包现钉 dsh-attachment / dsh-system-prompt 均 0.1.1-rc.2」这句。「当前阶段」末尾补一段本轮双版本兼容的记录，写法照已有段落。
- 修改：`docs/guide/zh/installation.md` 和 `docs/guide/en/installation.md` 的「版本要求」一节：说明支持 dsh 0.1.5-rc.3 到 0.1.7.x，框架由宿主提供，dsh 0.1.7 安装时会检查版本范围，不在范围内会拒绝安装并给出提示；同时删除「钉精确版本」的旧表述。
- 修改：`docs/guide/zh/web-ui.md` 和 `docs/guide/en/web-ui.md`：卡片位置分两种情况写。dsh 0.1.5 在「设置 → 插件 → 插件配置」；dsh 0.1.7 在侧栏「插件」页的 llamapad-dsh-plugin 详情页。「在卡片里配置连接」一节说明两代的存储位置不同：0.1.5 存 `$DSH_HOME/settings.yaml`，0.1.7 存 profile 的 `cordis.patch.yml`。另外说明从 0.1.5 升级到 0.1.7 后，卡片里保存过的连接需要重新填写一次。
- 修改：`docs/packaging.md`「版本策略」一节补上 peer 范围和 `test:compat`。
- 修改：`docs/manual-smoke.md` 新增「双版本冒烟」清单（内容见下方步骤）。

- [ ] **步骤 1：文档改动**（派 subagent，完成后主会话复核）

- [ ] **步骤 2：0.1.7 真机冒烟**（主会话）

`pnpm run build && pnpm pack`，然后 `dsh plugin --profile web add ./llamapad-dsh-plugin-<版本>.tgz`，用 tgz 装是为了走真实的 peer 解析路径。启动 `dsh web --no-open`，在浏览器里核对以下几项：
1. 插件加载成功，不再出现 `Failed to load plugins`；
2. 模型选择器里有面板上的模型；
3. 侧栏「插件」页的 llamapad-dsh-plugin 详情页里有卡片；
4. 在卡片里保存连接后，`~/.dsh/profiles/web/cordis.patch.yml` 的 llamapad 行写入了新值，插件没有重启（事件列表还在）；
5. 设置导航里有 GPU 监控页；
6. 发一条对话能流式返回。

- [ ] **步骤 3：0.1.5 真机冒烟**（主会话）

`npm i -g @deepseek-ai/dsh@0.1.5-rc.3`，确认 profile 的框架包已降到 0.1.5，然后装同一个 tgz，按步骤 2 的 6 项再核对一遍。区别在于第 3 项的卡片位置是「设置 → 插件 → 插件配置」，第 4 项的写入落在 `$DSH_HOME/settings.yaml` 的 `llamapad-panel` 节。完成后执行 `npm i -g @deepseek-ai/dsh@0.1.7-rc.1` 恢复，再把 web profile 的依赖恢复为 `link:` 本仓库（`dsh plugin --profile web add /Volumes/Data/github/projects/llamapad-dsh-plugin`）。

- [ ] **步骤 4：把冒烟结果记进 `docs/manual-smoke.md`，提交**（主会话确认后）

```bash
git add CLAUDE.md docs/
git commit -m "docs: 双版本兼容说明、调研归档与真机冒烟记录"
```

---

## 不在本计划范围

- 发布版本：本计划完成后，另外执行 `pnpm run release minor`（依赖契约有变，按 0.x 约定升 minor），并创建 GitHub Release。
- 一键安装文档：等真机冒烟通过后再写，是上一轮对话里的另一个需求。
- 0.1.7 下旧 `llamapad-panel` 配置的自动迁移：本计划只打一条 warn 提示用户重新填写（任务 2），不自动搬运。
- `plugins.row.config` 独立行页：没有需要，不做。
