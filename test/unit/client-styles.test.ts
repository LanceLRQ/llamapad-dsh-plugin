import { afterEach, describe, expect, it } from "vitest";
import { CARD_STYLE_TAG_ID, injectCardStyles } from "../../src/client/styles";

// 卡片的 CSS 注入抄的是官方 dsh-client-ui-settings-general 的判重写法：
// <style data-plugin-css="..."> + document.querySelector 判重。这里不装 jsdom，
// 手搭一个最小假 document 就够验证「只插一次」这条关键行为。
function fakeDocument() {
  const created: { dataset: Record<string, string>; textContent: string }[] = [];
  const appended: unknown[] = [];
  let existing: unknown = null;
  const doc = {
    querySelector: () => existing,
    createElement: () => {
      const tag = { dataset: {} as Record<string, string>, textContent: "" };
      created.push(tag);
      return tag;
    },
    head: {
      appendChild: (tag: unknown) => {
        appended.push(tag);
        existing = tag;
      },
    },
  };
  return { doc, created, appended };
}

const originalDocument = globalThis.document;

afterEach(() => {
  if (originalDocument === undefined) {
    // @ts-expect-error 测试环境本就没有 document，用完即删，不留痕迹
    delete globalThis.document;
  } else {
    globalThis.document = originalDocument;
  }
});

describe("injectCardStyles", () => {
  it("document 不存在时（node 测试环境）安全跳过，不抛错", () => {
    // @ts-expect-error 显式模拟无 DOM 环境
    delete globalThis.document;
    expect(() => injectCardStyles()).not.toThrow();
  });

  it("首次调用插入一个带标记的 style 标签", () => {
    const { doc, created, appended } = fakeDocument();
    // @ts-expect-error 只需要用到的三个方法，不必是真实 Document
    globalThis.document = doc;
    injectCardStyles();
    expect(created).toHaveLength(1);
    expect(appended).toHaveLength(1);
    expect(created[0]?.dataset["pluginCss"]).toBe(CARD_STYLE_TAG_ID);
    expect(created[0]?.textContent.length).toBeGreaterThan(0);
  });

  it("重复调用判重，不会插入第二次", () => {
    const { doc, created } = fakeDocument();
    // @ts-expect-error 同上
    globalThis.document = doc;
    injectCardStyles();
    injectCardStyles();
    expect(created).toHaveLength(1);
  });
});
