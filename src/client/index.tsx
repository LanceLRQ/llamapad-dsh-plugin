// 浏览器端设置卡片入口：挂 RPC 契约、注册词典，把卡片组件注册进
// settings.plugin.item slot（按 SETTINGS_NAMESPACE 这个 key 派发，见 rpc-contract.ts），
// 并把监控页注册进 settings.section slot（整页 + 左侧导航条目，宿主 shell 自动渲染）。
//
// ctx 保持 any：dsh 动态挂载的 remote 命名空间在本仓库没有真实的生成类型可用
// （生成该类型的包不在本插件依赖范围内），勉强手写 declare module 去凑合 SlotMap /
// TypertRemoteNamespaceMap 的合并声明既拿不到真正的类型安全，还要负担生成式类型的
// 精确匹配（尤其 slots.register 那组高度依赖泛型推导的重载），性价比很低。真正需要
// 类型安全的地方——RPC 返回值、卡片状态推导——已经在 rpc.ts / state.ts 里用具体类型
// 兜住了，边界处这一层薄薄的 any 是唯一现实的选择。
import { RPC_CONTRIBUTION, RPC_NAMESPACE, SETTINGS_NAMESPACE } from "../rpc-contract";
import { Card } from "./Card";
import { MonitorPage } from "./MonitorPage";
import { createPanelApi, type PanelRemoteNamespace } from "./rpc";
import { LOCALE_NS, en, zh } from "./locale";

export const inject = ["slots", "remote", "locale"];

export async function apply(ctx: any): Promise<() => Promise<void>> {
  const disposeMount = await ctx.remote.$mount(RPC_CONTRIBUTION);
  const disposeLocale: () => void = ctx.locale.register(LOCALE_NS, { zh, en });
  // 监控页导航条目的文案：label 声明成 thunk（slots 的 SlotLabel 契约），每次 read
  // 重新解析——bind 出来的 translate 在调用时才读当前语言，语言切换后导航文字自动
  // 跟上，不需要重新注册
  const boundT = ctx.locale.bind(LOCALE_NS);

  // 命名空间不能写进模块顶层的静态 inject：cordis 对 `ctx.remote.<ns>` 有守卫
  // （不声明就取会抛 `cannot get property "remote.x" without inject`，真机上表现为
  // dsh 首页一条 "Failed to load plugins"），但这个服务恰恰是本函数自己 $mount 出来的
  // ——静态声明会让 apply 永远等不到自己的产物，死锁。官方包（如 settings-plugin-inventory）
  // 能把 `remote.x` 写进静态 inject，是因为挂载方与消费方是两个不同的插件。
  //
  // 这里改用 ctx.inject(deps, cb) 的响应式作用域：$mount 完成后依赖满足，回调才跑，
  // 回调里的 inner ctx 已经声明了该依赖，取属性合法。
  const disposeScope: () => void = ctx.inject(
    ["slots", `remote.${RPC_NAMESPACE}`],
    (inner: any) => {
      const api = createPanelApi(inner.remote[RPC_NAMESPACE] as PanelRemoteNamespace);
      const disposeCardSlot = inner.slots.inject("settings.plugin.item", () =>
        inner.slots.register(
          {
            name: "settings.plugin.item",
            key: SETTINGS_NAMESPACE,
            locale: LOCALE_NS,
            inject: () => ({ api }),
          },
          Card,
        ),
      );
      // 整页监控：一个 list 条目就是一页设置页，导航条目由宿主 shell 按 id/order/
      // label 自动渲染，注册即出现，无需其他接线。order 60 刻意排在官方设置页
      // （general/appearance 等惯例低值段）之后——第三方页缀在官方页后面，别插队。
      // owner props 的 close 由 shell 注入（MonitorPageProps.close），组件挂载即
      // 轮询、卸载即停，轮询生命周期天然跟着「设置面板开没开到本页」走。
      const disposeMonitorSlot = inner.slots.inject("settings.section", () =>
        inner.slots.register(
          {
            name: "settings.section",
            id: "llamapad-monitor",
            order: 60,
            label: () => boundT("monitorTitle"),
            locale: LOCALE_NS,
            inject: () => ({ api }),
          },
          MonitorPage,
        ),
      );
      // 合成一个总 disposer：ctx.inject 的回调只认单个返回值（它是 plugin.apply 的
      // 形状），两个 slot 各自的清理收拢在这里
      return () => {
        disposeCardSlot();
        disposeMonitorSlot();
      };
    },
  );

  return async () => {
    disposeScope();
    disposeLocale();
    await disposeMount();
  };
}
