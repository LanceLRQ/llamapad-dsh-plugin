// 浏览器端设置卡片入口：挂 RPC 契约、注册词典，把卡片组件注册进
// settings.plugin.item slot（按 SETTINGS_NAMESPACE 这个 key 派发，见 rpc-contract.ts）。
//
// ctx 保持 any：dsh 动态挂载的 remote 命名空间在本仓库没有真实的生成类型可用
// （生成该类型的包不在本插件依赖范围内），勉强手写 declare module 去凑合 SlotMap /
// TypertRemoteNamespaceMap 的合并声明既拿不到真正的类型安全，还要负担生成式类型的
// 精确匹配（尤其 slots.register 那组高度依赖泛型推导的重载），性价比很低。真正需要
// 类型安全的地方——RPC 返回值、卡片状态推导——已经在 rpc.ts / state.ts 里用具体类型
// 兜住了，边界处这一层薄薄的 any 是唯一现实的选择。
import { RPC_CONTRIBUTION, RPC_NAMESPACE, SETTINGS_NAMESPACE } from "../rpc-contract";
import { Card } from "./Card";
import { createPanelApi, type PanelRemoteNamespace } from "./rpc";
import { LOCALE_NS, en, zh } from "./locale";

export const inject = ["slots", "remote", "locale"];

export async function apply(ctx: any): Promise<() => Promise<void>> {
  const disposeMount = await ctx.remote.$mount(RPC_CONTRIBUTION);
  const disposeLocale: () => void = ctx.locale.register(LOCALE_NS, { zh, en });

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
      return inner.slots.inject("settings.plugin.item", () =>
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
    },
  );

  return async () => {
    disposeScope();
    disposeLocale();
    await disposeMount();
  };
}
