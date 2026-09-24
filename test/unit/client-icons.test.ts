import { describe, expect, it, vi } from "vitest";

// `@deepseek-ai/dsh-client-ui-primitives` 在真实 dsh 宿主里是运行时 external（由宿主的
// window.__ModuleLoader__ 提供），npm 包本身把 clsx 只声明成 devDependency，在这里直接
// import 会在 Node/vitest 下解析失败（`Cannot find package 'clsx'`）。测试只关心
// pickIcon 这个纯函数，桩一个空模块即可，不需要真正的图标实现。
vi.mock("@deepseek-ai/dsh-client-ui-primitives", () => ({
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
