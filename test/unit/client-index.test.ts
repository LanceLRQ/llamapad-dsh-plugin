import { describe, expect, it, vi } from "vitest";

// Card.tsx / MonitorPage.tsx 会经 ./icons 间接 import 真实的
// `@deepseek-ai/dsh-client-ui-primitives`；该包把 clsx 只声明成 devDependency，
// 在 Node/vitest 下直接 import 会解析失败（真实 dsh 宿主里它是 external，由
// window.__ModuleLoader__ 提供，不走这条路径）。这里只测 index.tsx 的插槽注册，
// 不需要真正渲染组件，桩出所有用到的具名导出即可。
vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
  Button: () => null,
  Input: () => null,
  Pill: () => null,
  StateDot: () => null,
  Toast: () => null,
  IconCheckOutlineMedium: undefined,
  IconCheckOutline16: undefined,
  IconChevronDownOutlineMedium: undefined,
  IconChevronDownOutline14: undefined,
  IconLinkOutlineMedium: undefined,
  IconLinkOutline16: undefined,
  IconPlayOutlineMedium: undefined,
  IconPlayOutline16: undefined,
  IconStopFillMedium: undefined,
  IconStopFill16: undefined,
  IconWarningOutlineMedium: undefined,
  IconWarningOutline16: undefined,
  IconCloseOutlineMedium: undefined,
  IconCloseOutline16: undefined,
}));

import { apply } from "../../src/client/index";
import { RPC_PACKAGE, SETTINGS_NAMESPACE } from "../../src/rpc-contract";

/** 最小 fake ctx：照 src/client/index.tsx 用到的 remote.$mount / locale / inject / slots 桩。 */
function fakeCtx() {
  const injected: { name: string; key?: string }[] = [];
  const slots = {
    inject: (name: string, factory: () => () => void) => {
      const dispose = factory();
      return dispose;
    },
    register: vi.fn((entry: { name: string; key?: string }) => {
      injected.push({ name: entry.name, key: entry.key });
      return () => {};
    }),
  };
  const inner = {
    remote: { llamapadPanel: {} },
    slots,
  };
  const ctx = {
    remote: { $mount: vi.fn(async () => async () => {}) },
    locale: {
      register: vi.fn(() => () => {}),
      bind: vi.fn(() => (key: string) => key),
    },
    inject: vi.fn((_deps: string[], cb: (inner: unknown) => () => void) => cb(inner)),
  };
  return { ctx, injected };
}

describe("client index.tsx：设置卡片同时挂到 0.1.5 与 0.1.7 的插槽", () => {
  it("slots.inject 同时注册 settings.plugin.item / plugins.bundle.config / settings.section，key 分别对上两代命名空间", async () => {
    const { ctx, injected } = fakeCtx();
    const dispose = await apply(ctx as any);

    const names = injected.map((i) => i.name);
    expect(names).toContain("settings.plugin.item");
    expect(names).toContain("plugins.bundle.config");
    expect(names).toContain("settings.section");

    const cardEntry = injected.find((i) => i.name === "settings.plugin.item");
    expect(cardEntry?.key).toBe(SETTINGS_NAMESPACE);

    const bundleEntry = injected.find((i) => i.name === "plugins.bundle.config");
    expect(bundleEntry?.key).toBe(RPC_PACKAGE);

    await dispose();
  });
});
