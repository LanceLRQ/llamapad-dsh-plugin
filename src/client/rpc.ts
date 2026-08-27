// 把 dsh Remote 面的「返回 Result、不抛错」外壳拆开，转成卡片好用的 Promise<T>/抛错形状。
// 之所以不直接把 ctx.remote[RPC_NAMESPACE] 传给组件：dsh 动态挂载的 remote 命名空间在
// 这个仓库里没有真实的生成类型可用（生成产物不在本插件的依赖范围内），穿一层这里手写的
// PanelRemoteNamespace 接口，组件与测试就只面对我们自己声明的形状，不必陪绑宿主的动态类型。
import type { CardSnapshot } from "../rpc-contract";

interface RemoteFailure {
  readonly code: string;
  readonly message: string;
}

/** dsh RemoteResult 的本地重述：只取用得到的两个分支，避免引入运行时协议包。 */
type RemoteResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: RemoteFailure };

/** ctx.remote[RPC_NAMESPACE] 的最小形状——与 rpc-contract.ts 的三个方法一一对应。 */
export interface PanelRemoteNamespace {
  snapshot(): Promise<RemoteResult<CardSnapshot>>;
  start(model: string): Promise<RemoteResult<CardSnapshot>>;
  stop(model: string): Promise<RemoteResult<CardSnapshot>>;
}

/** 卡片真正调用的接口：拆完外壳、失败已经是 Error，调用方只需要 try/catch。 */
export interface PanelApi {
  snapshot(): Promise<CardSnapshot>;
  start(model: string): Promise<CardSnapshot>;
  stop(model: string): Promise<CardSnapshot>;
}

async function unwrap<T>(result: Promise<RemoteResult<T>>, label: string): Promise<T> {
  const resolved = await result;
  if (!resolved.ok) {
    throw new Error(`llamapad ${label} 失败: ${resolved.error.code}: ${resolved.error.message}`);
  }
  return resolved.value;
}

export function createPanelApi(namespace: PanelRemoteNamespace): PanelApi {
  return {
    snapshot: () => unwrap(namespace.snapshot(), "snapshot"),
    start: (model) => unwrap(namespace.start(model), "start"),
    stop: (model) => unwrap(namespace.stop(model), "stop"),
  };
}
