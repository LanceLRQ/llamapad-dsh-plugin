import { afterEach, describe, expect, it } from "vitest";
import { CARD_CSS, CARD_STYLE_TAG_ID, injectCardStyles } from "../../src/client/styles";

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

describe("CARD_CSS：折叠态与网格布局的关键规则", () => {
  it("列表是两列网格", () => {
    expect(CARD_CSS).toContain("grid-template-columns:repeat(2,minmax(0,1fr))");
  });

  it("列表定高且纵向滚动", () => {
    expect(CARD_CSS).toMatch(/\.llamapad-card__list\{[^}]*max-height:\d+px/);
    expect(CARD_CSS).toMatch(/\.llamapad-card__list\{[^}]*overflow-y:auto/);
  });

  it("窄容器回落单列（设置面板宽度不可控，两列挤不下时要能退）", () => {
    expect(CARD_CSS).toContain("@media (max-width:520px)");
  });

  it("展开态 chevron 旋转 180 度", () => {
    expect(CARD_CSS).toContain(".llamapad-card__chevronOpen{transform:rotate(180deg)}");
  });

  it("标题行是按钮，带键盘焦点环（照抄官方 PluginCard）", () => {
    expect(CARD_CSS).toContain(".llamapad-card__header:focus-visible");
  });

  it("滚动条颜色跟随宿主主题 token，不硬编码", () => {
    expect(CARD_CSS).toContain("--dsw-alias-scrollbar-bg-l2");
  });

  it("连接配置区有独立分隔与纵向排布", () => {
    expect(CARD_CSS).toContain(".llamapad-card__conn{");
  });
});

describe("CARD_CSS：事件流小节", () => {
  it("事件小节有独立分隔线与纵向排布", () => {
    expect(CARD_CSS).toContain(".llamapad-card__events{");
    expect(CARD_CSS).toContain(".llamapad-card__eventsList{");
  });

  it("tone 着色复用既有状态色 token（error 同 actionError、success 同运行行描边）", () => {
    expect(CARD_CSS).toContain(
      ".llamapad-card__event--error{color:var(--dsw-alias-state-error-primary)}",
    );
    expect(CARD_CSS).toContain(
      ".llamapad-card__event--success{color:var(--dsw-alias-state-success-primary)}",
    );
  });

  it("事件时间为等宽数字，分钟跳动时不牵动整行换行", () => {
    expect(CARD_CSS).toMatch(/\.llamapad-card__eventTime\{[^}]*font-variant-numeric:tabular-nums/);
  });
});
