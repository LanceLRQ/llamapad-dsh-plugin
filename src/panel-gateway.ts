/**
 * 设置卡片的 host 半身：把 PanelClient / ModelGate 包成五个 RPC 方法
 * （snapshot / start / stop / saveConnection / monitor），交给 dsh 的 Typert Gateway
 * 按 SRC 反射对外暴露。
 * 契约（命名空间/方法名/形参名）唯一出处在 rpc-contract.ts，本文件只管实现——
 * 改契约字段名要同步改这里的方法/形参名，两边脱节是运行期 400，编译期查不出来。
 *
 * 错误语义：五个方法都不因为"面板不可达/鉴权失败/写入失败"这类运行期故障抛错——RPC 抛错在
 * 浏览器侧只剩 { ok:false, error } 一个壳，信息更少也更难渲染，卡片没法照着画状态。
 * 约定改为把中文说明塞进 CardSnapshot.panelError（monitor 塞进 MonitorSnapshot.panelError），
 * 其余字段尽最大努力填（拿不到就 models:[] / running:null / inferring:null），让卡片总能画出"面板连不上"并继续显示
 * 按钮。只有 model 为空串 / 面板地址为空白 / range 非法这类"根本无法执行"的输入才允许抛。
 */
import type { Context } from "@deepseek-ai/cordis";
import { TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { RPC_NAMESPACE, toCardEvent, type CardModel, type CardSnapshot, type MonitorSnapshot, type RuntimePhase } from "./rpc-contract";
import { PanelError, type MetricsRange, type PanelClient, type PanelModelView, type PanelEvent } from "./panel-client";
import type { ModelGate } from "./switching";

/**
 * ⚠️ 这个对象会被 index.ts 在配置变更时**原地改写**（面板地址/token 改完即时生效，
 * 不重建 gateway、不重新注册 provider）。因此 gateway 的每个方法都必须现取
 * `this.options.xxx`，**不要**在构造期把字段拷进实例字段——那样配置改了也不生效，
 * 而且是静默失效，没有任何报错。
 */
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
  /** 当前 token，只用来判定 CardSnapshot.connection.tokenConfigured——绝不下发到浏览器。 */
  token: string;
  /**
   * 最近面板事件的惰性 getter（status-watch 维护的事件环）。同样必须现取
   * `this.options.events`（返回的函数内部闭包环实例），而不是构造期拷贝快照——
   * 环是活的，拷走一份就永远停在构造那一刻。缺省时快照的 events 为空数组。
   */
  events?: () => PanelEvent[];
}

/** saveConnection 落盘走的口子：把补丁合并进本插件的 settings 分节，见 index.ts 的 writeSettings。 */
export type SettingsWriter = (patch: Record<string, unknown>) => Promise<void>;

export class PanelGateway extends TypertRemoteService {
  constructor(
    ctx: Context,
    private readonly options: PanelGatewayOptions,
    private readonly writeSettings: SettingsWriter,
  ) {
    super(ctx, RPC_NAMESPACE);
  }

  async snapshot(): Promise<CardSnapshot> {
    return this.buildSnapshot();
  }

  /**
   * 保存连接配置。落到 $DSH_HOME/settings.yaml 的本插件分节，覆盖 cordis.yml 那层
   * （优先级由宿主保证）。写入成功后 index.ts 的 onChange 会把 client 换掉，
   * 所以这里直接返回新快照即可，不必自己重建什么。
   *
   * token 留空 = 不改动它（沿用官方 SecretField 的语义：草稿留空写入什么都不做，
   * 保留已存的值）。因此"清空 token"这个手势故意不提供——真要清得去改 settings.yaml，
   * 这与官方对 secret 字段的处理一致。
   */
  async saveConnection(panelUrl: string, token: string): Promise<CardSnapshot> {
    const url = panelUrl.trim();
    // 空地址会让插件彻底失联，而卡片本身正是唯一的补救入口——放行等于把梯子抽掉
    if (url === "") throw new TypeError("llamapad 设置卡片: 面板地址不能为空");
    const patch: Record<string, unknown> = { panelUrl: url };
    if (token.trim() !== "") patch["token"] = token.trim();
    try {
      await this.writeSettings(patch);
    } catch (error) {
      return { ...(await this.buildSnapshot()), panelError: describePanelError(error) };
    }
    return this.buildSnapshot();
  }

  /**
   * 方法名必须与 rpc-contract.ts 里描述符的 method 逐字一致——网关拿到描述符后是
   * receiver[descriptor.method](...) 直接取属性调用的，对不上是运行期 500。
   * 形参名反而不重要：wire 字段名由描述符的 parameters[].wire 写死，不再经宿主
   * 的 SRC 形参名推导（那条路对第三方插件走不通，见 index.ts 里 typert 注册的注释）。
   *
   * 末位 signal 是描述符 cancellation 声明出来的传输层取消通道（不进 wire 参数，
   * 由网关注入到业务形参之后）：浏览器侧暴露为 start(model, signal?)，一路传给
   * gate.ensure，用来掐断可能长达 60s+ 的排空等待。
   */
  async start(model: string, signal?: AbortSignal): Promise<CardSnapshot> {
    if (!model) throw new TypeError("llamapad 设置卡片: model 不能为空");
    try {
      await this.options.gate.ensure(model, {
        // 乐观启动：发出即返回，不做就绪轮询——按钮不能被就绪轮询卡住。不能改用
        // timeoutMs:0 表达同一件事，见 switching.ts 顶部注释：同目标 ensure 会合流，
        // 0ms 预算会被聊天路径等其他等待者继承而立刻 START_TIMEOUT。
        waitReady: false,
        ...this.drainOptions(),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      // 用户取消不是故障：不塞 panelError（那会画红色横幅），只回一份最新快照，
      // 让卡片安静地回到当前状态。判定依据是 signal 自身而非错误类型——abort 在
      // panel-client 里已被折成 PANEL_UNREACHABLE，靠错误分不出「取消」和「真挂」。
      if (signal?.aborted === true) return this.buildSnapshot();
      return { ...(await this.buildSnapshot()), panelError: describePanelError(error) };
    }
    return this.buildSnapshot();
  }

  /** 方法名须与描述符的 method 一致，理由同 start()；末位 signal 语义亦同。 */
  async stop(model: string, signal?: AbortSignal): Promise<CardSnapshot> {
    if (!model) throw new TypeError("llamapad 设置卡片: model 不能为空");
    try {
      await this.options.client.stopModel(model, {
        ...this.drainOptions(),
        ...(signal !== undefined ? { signal } : {}),
      });
    } catch (error) {
      if (signal?.aborted === true) return this.buildSnapshot();
      return { ...(await this.buildSnapshot()), panelError: describePanelError(error) };
    }
    return this.buildSnapshot();
  }

  /** 方法名须与描述符的 method 一致，理由同 start()；末位 signal 语义亦同。 */
  async monitor(range: string, since: number | undefined, signal?: AbortSignal): Promise<MonitorSnapshot> {
    // range 非法属于「根本无法执行」的输入，对齐 model 为空串直接抛的先例——描述符
    // 的 RANGE_CODEC 在 wire 层已拦一道，这里是直调路径（单测/未来复用）的兜底
    if (range !== "30m" && range !== "2h" && range !== "24h" && range !== "7d") {
      throw new TypeError(`llamapad 监控: range 必须是 30m/2h/24h/7d 之一，当前: ${JSON.stringify(range)}`);
    }
    // metrics 窗口与 gpu/stats 并发拉取，allSettled 而不是 all：监控页要能画
    // 「指标连不上」并继续显示 GPU 半边（反之亦然），任一半失败都不拖累另一半
    const [windowResult, gpuResult] = await Promise.allSettled([
      this.options.client.getMetricsWindow(range as MetricsRange, {
        ...(since !== undefined ? { since } : {}),
        ...(signal !== undefined ? { signal } : {}),
      }),
      this.options.client.getGpuStats(signal !== undefined ? { signal } : undefined),
    ]);
    const series = windowResult.status === "fulfilled" ? windowResult.value.series : {};
    // metrics 半边失败时 mode 只能给 full：delta 的语义是「追加到已有曲线」，没有
    // 基础数据时浏览器必须走整窗替换（full）才不会把空缺当成「无新点」静默吞掉
    const mode = windowResult.status === "fulfilled" ? windowResult.value.mode : "full";
    const gpu = gpuResult.status === "fulfilled" ? gpuResult.value : null;
    // 取消不是故障（切页/切档的常规手势）：panel-client 已把 abort 折成
    // PANEL_UNREACHABLE、与真挂了分不开，与 start/stop 同一条取消语义——看
    // signal 自身而非错误类型，aborted 时不塞 panelError（不画红色横幅）
    const cancelled = signal?.aborted === true;
    const panelError = cancelled ? null
      : windowResult.status === "rejected"
        ? describePanelError(windowResult.reason)
        : gpuResult.status === "rejected"
          ? describePanelError(gpuResult.reason)
          : null;
    return { series, gpu, mode, serverTs: Date.now(), panelError };
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
      connection: {
        panelUrl: this.options.panelUrl,
        // 只报「配没配」，token 本身一个字符都不下发（浏览器侧也没有任何用它的地方）
        tokenConfigured: this.options.token.trim() !== "",
      },
      // 事件环经 toCardEvent 投影后随快照下发（PanelEvent → CardEvent 的字段裁剪，
      // 见 rpc-contract.ts 的 toCardEvent 注释）；环未接线（statusRefreshMs=0）为空数组
      events: (this.options.events?.() ?? []).map(toCardEvent),
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
    // 与 switching.ts 的就绪判定同口径：优先用 runtime/status 的 ready（省一次往返），
    // 老面板缺这个字段时才回退 /health 探测
    const status = await this.options.client.runtimeStatus();
    if (status.running?.ready !== undefined) return status.running.ready ? "ready" : "starting";
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
    // 这三个码的 message 本身就是完整的中文说明（面板不可达的地址、"运行时忙：正在启动
    // 模型 X，请等待…"、面板对拒绝启动的解释），套上"面板请求失败"的壳只会自相矛盾——
    // RUNTIME_BUSY 时面板并没有失败，只是忙。其余码仍需兜一层：listModels/runtimeStatus
    // 的 401 透传的是面板返回的裸 "unauthorized"，摆到卡片里等于什么都没说（见函数头注释）
    if (error.code === "PANEL_UNREACHABLE" || error.code === "RUNTIME_BUSY" || error.code === "START_REJECTED") {
      return error.message;
    }
    return `面板请求失败（${error.code}${error.status === undefined ? "" : ` ${String(error.status)}`}）：${error.message}`;
  }
  return error instanceof Error ? error.message : "面板请求失败：未知错误";
}
