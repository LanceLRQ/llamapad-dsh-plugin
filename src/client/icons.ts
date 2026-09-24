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
