// 运行时 CSS 注入：抄官方 dsh-client-ui-settings-general 的判重写法
// （<style data-plugin-css="..."> + document.querySelector 判重）。本仓库的构建
// 没有 CSS Modules 插件（scripts/build.mjs 是纯 esbuild，见其顶部注释），
// 所以样式写成普通字符串常量，而不是官方那种 `\0dsh-css:` 虚拟模块产物。
export const CARD_STYLE_TAG_ID = "llamapad-dsh-plugin/card.css";

// 外框（.llamapad-card / __header / __title / __body）的边框、圆角、内边距、标题字号
// 字重与分隔线缩进，逐值抄自官方 PluginCard 的 CSS
// （/root/.dsh/profiles/node_modules/@deepseek-ai/dsh-client-ui-settings-plugins/lib/client.js，
// 类名 .YyYd_a_card / .YyYd_a_header / .YyYd_a_name / .YyYd_a_body），
// 这样与「终端 / Agent 循环 / 网页搜索」三张官方卡在同一个 settings.plugin.item 列表里
// 视觉一致。我们这张卡没有折叠交互（是实时状态而非配置表单，折起来没意义），所以只搬了
// 常驻展开时的样子——不需要 cardOpen / chevron 那组折叠态样式。
// 卡片之间的外边距不在这里管：settings.plugin.item 的宿主容器（ConfigurablePluginsTab）
// 本身是一个 `gap:10px` 的 flex 列表，我们的卡片作为其直接子项已经自动享有那份间距，
// 自己再加 margin 只会让间距变得比官方卡之间的更宽。
// 官方 CSS 里 .failed 用的 --dsw-alias-label-error 在当前安装的主题包
// （@deepseek-ai/dsh-client-ui-theme 0.1.1-rc.2）里并未定义（浏览器会静默忽略，
// 相当于没设颜色），所以错误文案继续用本文件已验证过的 --dsw-alias-state-error-primary。
const CARD_CSS = `
.llamapad-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;transition:border-color .16s,background .16s}
.llamapad-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.llamapad-card__header{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:14px 16px}
.llamapad-card__title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.llamapad-card__body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0 16px;display:flex;flex-direction:column;gap:12px}
.llamapad-card__hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.llamapad-card__banner{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-radius:8px;padding:8px 10px}
.llamapad-card__status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
.llamapad-card__actionError{margin:0;color:var(--dsw-alias-state-error-primary)}
.llamapad-card__list{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:6px}
.llamapad-card__row{display:flex;align-items:center;justify-content:space-between;gap:12px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:8px 10px}
.llamapad-card__row[data-running="true"]{border-color:var(--dsw-alias-state-success-primary)}
.llamapad-card__rowInfo{display:flex;flex-direction:column;gap:2px;min-width:0}
.llamapad-card__rowName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llamapad-card__rowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.llamapad-card__rowMissing{color:var(--dsw-alias-state-warn-primary);font-size:12px}
`;

export function injectCardStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(CARD_STYLE_TAG_ID)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "llamapad-dsh-plugin";
  tag.dataset["pluginCss"] = CARD_STYLE_TAG_ID;
  tag.textContent = CARD_CSS;
  document.head.appendChild(tag);
}
