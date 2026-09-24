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
