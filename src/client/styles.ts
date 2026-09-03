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
// 视觉一致。折叠交互补齐后，cardOpen / chevron 那组样式同样照抄官方 PluginCard 的结构
// （见下方 CARD_CSS 顶部注释），只是类名带上 llamapad 前缀避免与官方样式表撞名。
// 卡片之间的外边距不在这里管：settings.plugin.item 的宿主容器（ConfigurablePluginsTab）
// 本身是一个 `gap:10px` 的 flex 列表，我们的卡片作为其直接子项已经自动享有那份间距，
// 自己再加 margin 只会让间距变得比官方卡之间的更宽。
// 官方 CSS 里 .failed 用的 --dsw-alias-label-error 在当前安装的主题包
// （@deepseek-ai/dsh-client-ui-theme 0.1.1-rc.2）里并未定义（浏览器会静默忽略，
// 相当于没设颜色），所以错误文案继续用本文件已验证过的 --dsw-alias-state-error-primary。
//
// 折叠态（__header 变按钮、chevron、cardOpen）与列表的网格/定高滚动是这次改动新增，
// 结构与交互继续照抄官方 PluginCard（useState + IconChevronDownOutline14 +
// chevronOpen 旋转），primitives 没有 Grid/ScrollArea，滚动条样式只能自己写。
// 导出 CARD_CSS 是让 client-styles.test.ts 能断言这几条关键规则不被误删——组件本身
// 在本仓库测不了（node 环境无 jsdom），网格列数/定高/溢出滚动是这次改动能自动化守住的全部。
//
// 事件流小节（__events 族）同样沿用本文件既有体系：tone 着色只用已验证过的状态色
// token——error 与 __actionError 同一个 --dsw-alias-state-error-primary，success 与
// 运行行描边（__row[data-running]）同一个 --dsw-alias-state-success-primary（StateDot
// 的 done 色也取自它），neutral 落 __rowMeta 的 --dsw-alias-label-tertiary 灰；不引入
// 新色彩变量。时间是等宽数字（tabular-nums），分钟跳动时行宽不抖。
export const CARD_CSS = `
.llamapad-card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;transition:border-color .16s,background .16s}
.llamapad-card:hover{border-color:var(--dsw-alias-label-dimmed)}
.llamapad-card__header{appearance:none;width:100%;font:inherit;color:inherit;text-align:left;cursor:pointer;background:0 0;border:0;border-radius:12px;display:flex;align-items:center;gap:12px;padding:14px 16px}
.llamapad-card__header:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-2px}
.llamapad-card__headText{display:flex;flex-direction:column;flex:1;gap:4px;min-width:0}
.llamapad-card__title{color:var(--dsw-alias-label-primary);font-size:15px;font-weight:600;line-height:1.4}
.llamapad-card__subtitle{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.llamapad-card__chevron{color:var(--dsw-alias-label-tertiary);flex:none;transition:transform .16s}
.llamapad-card__chevronOpen{transform:rotate(180deg)}
.llamapad-cardOpen{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-label-dimmed)}
.llamapad-card__body{border-top:1px solid var(--dsw-alias-border-l2);margin:0 16px;padding:14px 0 16px;display:flex;flex-direction:column;gap:12px}
.llamapad-card__openRow{display:flex;justify-content:flex-end}
.llamapad-card__hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
.llamapad-card__banner{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-radius:8px;padding:8px 10px}
.llamapad-card__status{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-label-secondary)}
.llamapad-card__actionError{margin:0;color:var(--dsw-alias-state-error-primary)}
.llamapad-card__list{list-style:none;margin:0;padding:0;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;max-height:320px;overflow-y:auto;scrollbar-color:var(--dsw-alias-scrollbar-bg-l2) transparent}
.llamapad-card__list::-webkit-scrollbar{width:8px}
.llamapad-card__list::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2);border-radius:4px}
.llamapad-card__list::-webkit-scrollbar-thumb:hover{background:var(--dsw-alias-scrollbar-hover-l2)}
.llamapad-card__row{display:flex;flex-direction:column;align-items:stretch;gap:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:8px;padding:10px}
.llamapad-card__row[data-running="true"]{border-color:var(--dsw-alias-state-success-primary)}
.llamapad-card__rowInfo{display:flex;flex-direction:column;gap:2px;min-width:0}
.llamapad-card__rowName{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.llamapad-card__rowMeta{color:var(--dsw-alias-label-tertiary);font-size:12px}
.llamapad-card__rowMissing{color:var(--dsw-alias-state-warn-primary);font-size:12px}
.llamapad-card__conn{display:flex;flex-direction:column;gap:10px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.llamapad-card__connField{display:flex;flex-direction:column;gap:4px}
.llamapad-card__connLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.llamapad-card__connActions{display:flex;justify-content:flex-end;align-items:center;gap:8px}
.llamapad-card__events{display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:12px}
.llamapad-card__eventsTitle{color:var(--dsw-alias-label-secondary);font-size:12px}
.llamapad-card__eventsList{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}
.llamapad-card__event{display:flex;align-items:baseline;gap:8px;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5}
.llamapad-card__eventTime{flex:none;font-variant-numeric:tabular-nums}
.llamapad-card__eventText{min-width:0}
.llamapad-card__event--error{color:var(--dsw-alias-state-error-primary)}
.llamapad-card__event--success{color:var(--dsw-alias-state-success-primary)}
@media (max-width:520px){.llamapad-card__list{grid-template-columns:1fr}}
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

/* ------------------------------------------------------------------ *
 * 监控页（settings.section 整页）
 *
 * 与卡片样式分两个标签注入而不是并进 CARD_CSS：监控页与设置卡片是两个独立的
 * slot 注册（settings.section / settings.plugin.item），宿主可能只挂其中之一——
 * 并在一起会让只开卡片的那页也白背一份监控 CSS；判重也各管各的，谁先挂谁先注。
 * token 用法对齐既有体系：横幅同 __banner 的 error 配色，数值 tabular-nums 防轮询
 * 抖动；曲线 svg（__spark）块级铺满卡宽，viewBox 均匀缩放（高度按比例跟缩，末点
 * 圆不变形）。三卡两列网格与卡片的 __list 同构，断点放宽到 720px——整页栏宽比
 * 卡片列表宽，两列曲线更容易先挤。
 * ------------------------------------------------------------------ */
export const MONITOR_STYLE_TAG_ID = "llamapad-dsh-plugin/monitor.css";

export const MONITOR_CSS = `
.llamapad-monitor{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.llamapad-monitor__header{display:flex;align-items:center;gap:12px;flex-wrap:wrap}
.llamapad-monitor__title{margin:0;font-size:16px;font-weight:600;line-height:1.4}
.llamapad-monitor__ranges{display:flex;gap:6px;margin-left:auto}
.llamapad-monitor__banner{display:flex;align-items:center;gap:8px;color:var(--dsw-alias-state-error-primary);background:color-mix(in srgb, var(--dsw-alias-state-error-primary) 10%, transparent);border-radius:8px;padding:8px 10px}
.llamapad-monitor__grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
.llamapad-monitor__card{border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-3);border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:12px}
.llamapad-monitor__cardTitle{color:var(--dsw-alias-label-secondary);font-size:13px;font-weight:600}
.llamapad-monitor__metric{display:flex;flex-direction:column;gap:4px}
.llamapad-monitor__metricHead{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.llamapad-monitor__metricLabel{color:var(--dsw-alias-label-secondary);font-size:12px}
.llamapad-monitor__metricValue{font-variant-numeric:tabular-nums;font-weight:500}
.llamapad-monitor__spark{display:block;width:100%;height:auto}
.llamapad-monitor__gpuRows{display:flex;flex-direction:column;gap:4px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:10px}
.llamapad-monitor__gpuRow{color:var(--dsw-alias-label-tertiary);font-size:12px;font-variant-numeric:tabular-nums}
.llamapad-monitor__hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.5}
@media (max-width:720px){.llamapad-monitor__grid{grid-template-columns:1fr}}
`;

/** 注入模式与 injectCardStyles 一模一样（判重标签不同），理由见其上方注释。 */
export function injectMonitorStyles(): void {
  if (typeof document === "undefined") return;
  if (document.querySelector(`style[data-plugin-css=${JSON.stringify(MONITOR_STYLE_TAG_ID)}]`) !== null) return;
  const tag = document.createElement("style");
  tag.dataset["plugin"] = "llamapad-dsh-plugin";
  tag.dataset["pluginCss"] = MONITOR_STYLE_TAG_ID;
  tag.textContent = MONITOR_CSS;
  document.head.appendChild(tag);
}
