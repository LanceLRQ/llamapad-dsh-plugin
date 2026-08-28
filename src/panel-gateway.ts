/**
 * 设置卡片的 host 半身：把 PanelClient / ModelGate 包成三个 RPC 方法
 * （snapshot / start / stop），交给 dsh 的 Typert Gateway 按 SRC 反射对外暴露。
 * 契约（命名空间/方法名/形参名）唯一出处在 rpc-contract.ts，本文件只管实现——
 * 改契约字段名要同步改这里的方法/形参名，两边脱节是运行期 400，编译期查不出来。
 *
 * 错误语义：三个方法都不因为"面板不可达/鉴权失败"这类运行期故障抛错——RPC 抛错在
 * 浏览器侧只剩 { ok:false, error } 一个壳，信息更少也更难渲染，卡片没法照着画状态。
 * 约定改为把中文说明塞进 CardSnapshot.panelError，其余字段尽最大努力填（拿不到就
 * models:[] / running:null / inferring:null），让卡片总能画出"面板连不上"并继续显示
 * 按钮。只有 model 为空串这类编程错误才允许抛。
 */
import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { RPC_NAMESPACE, type CardModel, type CardSnapshot, type RuntimePhase } from "./rpc-contract";
import { PanelError, type PanelClient, type PanelModelView } from "./panel-client";
import type { ModelGate } from "./switching";

export interface PanelGatewayOptions {
  client: PanelClient;
  gate: ModelGate;
  /** host 进程视角的面板地址；跨机部署时可能是 127.0.0.1，浏览器打不开。 */
  panelUrl: string;
  /** 浏览器可见的面板地址，缺省回落 panelUrl（见 index.ts 的 Config.panelPublicUrl）。 */
  panelPublicUrl?: string;
  /** 手动启停按钮沿用与 auto-switch 档相同的排空偏好（见 index.ts 的 Config.drainOnSwitch）。 */
  drainOnSwitch?: boolean;
  drainTimeoutMs?: number;
}

export class PanelGateway extends TypertRemoteService {
  constructor(ctx: Context, private readonly options: PanelGatewayOptions) {
    super(ctx, RPC_NAMESPACE);
  }

  async snapshot(): Promise<CardSnapshot> {
    return this.buildSnapshot();
  }

  /**
   * 方法名必须与 rpc-contract.ts 里描述符的 method 逐字一致——网关拿到描述符后是
   * receiver[descriptor.method](...) 直接取属性调用的，对不上是运行期 500。
   * 形参名反而不重要：wire 字段名由描述符的 parameters[].wire 写死，不再经宿主
   * 的 SRC 形参名推导（那条路对第三方插件走不通，见 index.ts 里 typert 注册的注释）。
   */
  async start(model: string): Promise<CardSnapshot> {
    if (!model) throw new TypeError("llamapad 设置卡片: model 不能为空");
    try {
      await this.options.gate.ensure(model, {
        // 乐观启动：发出即返回，不做就绪轮询——按钮不能被就绪轮询卡住。不能改用
        // timeoutMs:0 表达同一件事，见 switching.ts 顶部注释：同目标 ensure 会合流，
        // 0ms 预算会被聊天路径等其他等待者继承而立刻 START_TIMEOUT。
        waitReady: false,
        ...this.drainOptions(),
      });
    } catch (error) {
      return { ...(await this.buildSnapshot()), panelError: describePanelError(error) };
    }
    return this.buildSnapshot();
  }

  /** 方法名须与描述符的 method 一致，理由同 start()。 */
  async stop(model: string): Promise<CardSnapshot> {
    if (!model) throw new TypeError("llamapad 设置卡片: model 不能为空");
    try {
      await this.options.client.stopModel(model, this.drainOptions());
    } catch (error) {
      return { ...(await this.buildSnapshot()), panelError: describePanelError(error) };
    }
    return this.buildSnapshot();
  }

  /** start/stop 共用的排空参数组装，只在配置了对应字段时才带上（panel-client.ts 的可选字段语义）。 */
  private drainOptions(): { drain?: boolean; drainTimeoutMs?: number } {
    const { drainOnSwitch, drainTimeoutMs } = this.options;
    return {
      ...(drainOnSwitch !== undefined ? { drain: drainOnSwitch } : {}),
      ...(drainTimeoutMs !== undefined ? { drainTimeoutMs } : {}),
    };
  }

  /**
   * 组装一份 CardSnapshot：listModels 与 runtimeStatus({busy:true}) 并发取，
   * 用 allSettled 而不是 Promise.all——任一失败都不该拖累另一半，也不该让本方法抛错。
   */
  private async buildSnapshot(): Promise<CardSnapshot> {
    const [modelsResult, statusResult] = await Promise.allSettled([
      this.options.client.listModels(),
      this.options.client.runtimeStatus({ busy: true }),
    ]);
    const models = modelsResult.status === "fulfilled" ? modelsResult.value.map(toCardModel) : [];
    const running = statusResult.status === "fulfilled" ? statusResult.value.running?.model ?? null : null;
    const startedAt = statusResult.status === "fulfilled" ? statusResult.value.running?.startedAt ?? null : null;
    // busy 是 runtimeStatus({busy:true}) 才会填的字段，undefined（面板未按此模式响应）
    // 归一到 null，与"探测失败/不可知"同等对待，phase 判定只关心它是不是 null。
    const busy = statusResult.status === "fulfilled" ? statusResult.value.busy ?? null : null;
    const inferring = busy?.inferring ?? null;
    const phase = await this.resolvePhase(running, busy);
    const panelError = modelsResult.status === "rejected"
      ? describePanelError(modelsResult.reason)
      : statusResult.status === "rejected"
        ? describePanelError(statusResult.reason)
        : null;
    return {
      models,
      running,
      phase,
      startedAt,
      inferring,
      openUrl: this.options.panelPublicUrl || this.options.panelUrl,
      panelError,
    };
  }

  /**
   * phase 判定，依据是真机实测出的 /health 与 /slots 状态码同步性（见
   * rpc-contract.ts 的 RuntimePhase 注释）：/slots 探得通就意味着模型必然已加载完，
   * 所以稳态（有 busy 结果）下完全不需要另外确认，只有"有模型在跑但 busy 不可知"
   * 这唯一的加载窗口才值得多打一次 /health。
   *
   * busy 不可知有两种成因——面板没按 busy 模式响应、或 runtimeStatus 本身失败——
   * 到这里已经统一折算成 null，处理方式相同。
   */
  private async resolvePhase(
    running: string | null,
    busy: { inferring: boolean; slotsRunning: number } | null,
  ): Promise<RuntimePhase> {
    if (running === null) return "idle";
    if (busy !== null) return "ready";
    // llamaHealth() 内部已经把网络异常等一切失败折算成 false，这里无法区分
    // "面板 proxy 端口未就绪的 502"与"加载中透传的 503"——两者都非 200。真挂了的
    // 模型会一直卡在 starting，配合卡片上的已耗时用户能自行判断，不必为此改
    // llamaHealth() 的签名（它还被 src/tools.ts 复用）。
    return (await this.options.client.llamaHealth()) ? "ready" : "starting";
  }
}

/** CardModel 是 PanelModelView 的子集，只留卡片真会渲染的字段（见 rpc-contract.ts）。 */
function toCardModel(model: PanelModelView): CardModel {
  return {
    name: model.name,
    displayName: model.displayName,
    namespace: model.namespace,
    quant: model.quant,
    status: model.status,
  };
}

/**
 * 把异常折算成卡片直接可显示的一句话。
 *
 * 不能无脑透传 message：panel-client 的 startModel/stopModel 抛的是中文说明，但
 * listModels/runtimeStatus 走的是 `readError(res)`，401 时透传的是面板返回的裸
 * "unauthorized"——真机上实测就是这个值，摆到设置卡片里等于什么都没说。按 code 兜一层。
 */
function describePanelError(error: unknown): string {
  if (error instanceof PanelError) {
    if (error.code === "AUTH") return "llamapad token 无效或未授权，请检查插件配置里的 token";
    if (error.code === "PANEL_UNREACHABLE") return error.message;
    return `面板请求失败（${error.code}${error.status === undefined ? "" : ` ${String(error.status)}`}）：${error.message}`;
  }
  return error instanceof Error ? error.message : "面板请求失败：未知错误";
}
