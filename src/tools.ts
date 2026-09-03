/**
 * B 形态：llamapad 管理工具（供任意模型驱动的 Agent 调用查询/启停本地模型）。
 * 与 A 形态（./index.ts）共享 panel-client.ts 的 REST 封装与 switching.ts 的共享门，
 * 但走独立的插件入口（inject: ['tools']），Config 也互相独立、互不读取对方。
 *
 * 边界（与 CLAUDE.md「用户边界」一致）：只做运行时调度的查询与启停，不做删除模型/
 * 文件、改配置、下载管理等高危操作——那些留在 llamapad 面板的人工确认流程里。
 *
 * 失败语义：查询类工具把"面板不可达"当作有效答案返回（不抛错）；启停类工具的真实
 * 故障（模型不存在、鉴权失败等）直接 throw——框架的 toolErrorResult 会接住，转成
 * isError + 错误文本喂给模型，不需要在这里另建一套 { error } 返回值联合体。
 */
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { createPanelClient, PanelError, type PanelClient } from "./panel-client";
import { sharedModelGate, type ModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  pollIntervalMs: number;
  toolApproval: string;
}

export const Config: Schema<Partial<Config>, Config> = Schema.object({
  // 不用 .required()：bundle 安装后用户总要先补配置再重启，缺配置不该拖垮整个 dsh 启动
  panelUrl: Schema.string().description("llamapad 面板地址，如 http://192.168.1.10:8080"),
  token: Schema.string().role("secret").description(
    "llamapad API token（lp_ 开头；建议 cordis.yml 里用 !!js process.env.LLAMAPAD_TOKEN 注入）",
  ),
  requestTimeoutMs: Schema.number().default(30000).description("面板控制面单请求超时（毫秒）"),
  startTimeoutMs: Schema.number().default(300000).description(
    "llamapad_start_model 等待模型就绪的超时（毫秒）默认值；工具调用参数 timeoutMs 可逐次覆盖",
  ),
  pollIntervalMs: Schema.number().default(2000).description("就绪探测轮询间隔（毫秒）"),
  toolApproval: Schema.string().default("allow").description(
    "启停工具审批档位：allow（默认）=Agent 调用 llamapad_start_model / llamapad_stop_model 直接执行；"
    + "ask=执行前需用户确认（宿主无审批通道时会拒绝执行）。共享 GPU 场景建议 ask——启停影响别的会话",
  ),
});

export const name = "llamapad-dsh-plugin/tools";
export const inject = ["tools"];

/** 列模型结果的硬上限：框架没有内置的结果大小/截断机制，超大返回值要自己截。 */
export const LIST_MODELS_LIMIT = 100;

export function apply(ctx: Context, config: Config) {
  // 静态校验（对齐 index.ts 的 assertStaticConfig 模式）：写错的档位名是编程/配置错误，
  // 不是「还没填」——静默回落 allow 会把用户要的确认门悄悄变成直通，越早抛越好。
  if (config.toolApproval !== "allow" && config.toolApproval !== "ask") {
    throw new Error(`toolApproval 必须是 allow 或 ask，当前: ${config.toolApproval}`);
  }

  if (!config.panelUrl || !config.token) {
    // 命名 logger 而非裸 console.warn：日志进入宿主的日志体系（可过滤/可定级），
    // 比绕过框架直接写 stdout 的 console 更可观测
    ctx.logger("llamapad-dsh-plugin/tools").warn(
      "[llamapad-dsh-plugin/tools] 尚未配置 panelUrl / token，已跳过工具注册。" +
      "请在 profile 的 cordis.patch.yml 里补 llamapad-dsh-plugin/tools 的配置（模板见包内 " +
      "examples/profile-patch.example.yml），改完重启 dsh。",
    );
    return;
  }
  const client = createPanelClient({
    baseUrl: config.panelUrl,
    token: config.token,
    ...(config.requestTimeoutMs ? { requestTimeoutMs: config.requestTimeoutMs } : {}),
  });
  // 共享门：与 A 形态（index.ts）的 provider 共用同一把锁，避免同一面板出现两把锁
  // 各自判断"要不要起/停"而互相插队（见 switching.ts 的 sharedModelGate 注释）
  const gate = sharedModelGate(client);

  ctx.tools.register(buildStatusTool(client));
  ctx.tools.register(buildListModelsTool(client));
  ctx.tools.register(buildStartModelTool(client, gate, config));
  ctx.tools.register(buildStopModelTool(client));

  // 审批门（toolApproval: ask）：共享 GPU 场景下启停模型会影响其他会话，Agent 的
  // 自主调用值得过一道用户确认。只升 allow 不动 deny——先 await next() 再升级是洋葱
  // 外层的包装语义：下游（含更内层监听器）已经 deny 的调用保持拒绝（原因原样透传，
  // 不覆盖成我们自己的文案），只有下游放行的启停调用才升级为 ask，交由框架的
  // approval 服务转成用户确认（宿主无 approval 通道时框架会把 ask 折算为 deny）。
  // allow 档不注册监听：waterfall 上少一跳，零开销也零干扰。监听器不依赖 this
  // （事件类型标 this: Scoped<ToolRuntime>，普通箭头函数即可）。
  if (config.toolApproval === "ask") {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const decision = await next();
      if (decision.kind === "allow"
          && (exec.name === "llamapad_start_model" || exec.name === "llamapad_stop_model")) {
        return { kind: "ask", reason: "llamapad 模型启停需要用户确认（toolApproval: ask）" };
      }
      return decision;
    });
  }
}

// ---- llamapad_status ----

/** presentResult 从 result.meta 读回的投影形状（execute 返回值经 JSON 持久化后的样子）。 */
interface StatusProjection {
  panelReachable: boolean;
  running: boolean;
  model?: string;
  displayName?: string;
  hostPort?: number;
  inferring?: boolean;
  slotsRunning?: number;
}

/**
 * meta 随会话日志持久化，回放时可能来自旧版本 schema（字段缺席或多余），不能把
 * unknown 直接断言成 execute 的返回类型——按字段逐个收窄，形状对不上就返回
 * undefined，让呈现层回退默认卡而不是把编造的状态当真。
 */
function readStatusProjection(meta: unknown): StatusProjection | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const { panelReachable, running, model, displayName, hostPort, inferring, slotsRunning } =
    meta as Record<string, unknown>;
  if (typeof panelReachable !== "boolean" || typeof running !== "boolean") return undefined;
  return {
    panelReachable,
    running,
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof displayName === "string" ? { displayName } : {}),
    ...(typeof hostPort === "number" ? { hostPort } : {}),
    ...(typeof inferring === "boolean" ? { inferring } : {}),
    ...(typeof slotsRunning === "number" ? { slotsRunning } : {}),
  };
}

/**
 * 终端卡的输出。首行口径与 render() 一致（喂模型与人看的结论不该打架），往下再
 * 分行列出 displayName / hostPort / slot 明细——终端卡有输出空间，人读的卡片可以
 * 比喂模型的单行摘要更详细。
 */
function formatStatusOutput(status: StatusProjection): string {
  if (!status.panelReachable) return "llamapad 面板不可达";
  if (!status.running) return "当前没有模型在运行";
  // busy 不可知（undefined）时不带后缀，也不列 slot 行——同 execute 的取舍，不伪造
  const busySuffix = status.inferring === undefined ? "" : status.inferring ? "，正在推理" : "，空闲";
  const nameSuffix = status.displayName === undefined ? "" : `（${status.displayName}）`;
  return [
    `运行中：${status.model}${nameSuffix}${busySuffix}`,
    ...(status.hostPort === undefined ? [] : [`宿主机端口：${status.hostPort}`]),
    ...(status.slotsRunning === undefined ? [] : [`处理中 slot：${status.slotsRunning}`]),
  ].join("\n");
}

export function buildStatusTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_status",
    description:
      "查看 llamapad 面板当前运行状态：是否有本地模型在跑、跑的是哪个、面板是否可达。只读，不做任何" +
      "变更。只影响本地 llamapad 面板管理的模型，不是通用 Docker 管理工具。",
    parameters: {},
    // 只读：一次 runtimeStatus 查询，无进程内共享可变状态，可安全并入并行组
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          panelReachable: { type: "boolean", required: true, description: "面板控制面是否可达" },
          running: { type: "boolean", required: true, description: "当前是否有模型在运行" },
          model: { type: "string", description: "运行中的模型名（running 为 true 时才有）" },
          displayName: { type: "string", description: "运行中模型的展示名" },
          hostPort: { type: "integer", description: "运行中模型的宿主机端口" },
          inferring: { type: "boolean", description: "是否有在途推理（仅忙碌状态可探知时才有）" },
          slotsRunning: { type: "integer", description: "处理中的 slot 数（仅忙碌状态可探知时才有）" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        if (!value.panelReachable) return [{ type: "text", text: "llamapad 面板不可达" }];
        if (!value.running) return [{ type: "text", text: "当前没有模型在运行" }];
        const busySuffix = value.inferring === undefined ? "" : value.inferring ? "，正在推理" : "，空闲";
        return [{ type: "text", text: `运行中：${value.model}${busySuffix}` }];
      },
      // 回放路径上 presentResult 只能从 meta 读回结构化投影（content 是喂模型的单行
      // 摘要，多行终端输出无法从它无损重建），而 status 值本身就是 lossless JSON，
      // 原样投影即可，不必再精选字段
      presentationMeta: (_args, value) => value,
    },
    // 状态查询的语义等同一条 `llamapad status` 命令：有输出、有成败（面板可达与否
    // 映射为 exitCode），terminal 卡让 UI 用退出状态徽标呈现「面板不可达」
    presentCall: () => ({
      card: "terminal",
      title: "llamapad status",
      description: "查询 llamapad 面板运行状态（只读）",
    }),
    presentResult: (_args, result) => {
      const status = readStatusProjection(result.meta);
      if (!status) return undefined;
      return {
        card: "terminal",
        title: "llamapad status",
        output: formatStatusOutput(status),
        exitCode: status.panelReachable ? 0 : 1,
      };
    },
    async execute() {
      let status;
      try {
        status = await client.runtimeStatus({ busy: true });
      } catch (error) {
        if (error instanceof PanelError) return { panelReachable: false, running: false };
        throw error;
      }
      if (!status.running) return { panelReachable: true, running: false };
      const { model, displayName, hostPort } = status.running;
      return {
        panelReachable: true,
        running: true,
        model,
        ...(displayName !== undefined ? { displayName } : {}),
        ...(hostPort != null ? { hostPort } : {}),
        // busy 为 null 代表"不可知"而非"不忙"，此时省略 inferring/slotsRunning——
        // 省略优于伪造成 false，模型不该把"不可知"读成"确定空闲"
        ...(status.busy ? { inferring: status.busy.inferring, slotsRunning: status.busy.slotsRunning } : {}),
      };
    },
  });
}

// ---- llamapad_list_models ----

export function buildListModelsTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_list_models",
    description:
      `列出 llamapad 面板管理的全部本地模型配置。最多返回 ${LIST_MODELS_LIMIT} 条（按名称升序），` +
      "超过时 truncated 为 true、total 为真实总数。只影响本地 llamapad 面板管理的模型。",
    parameters: {},
    // 只读：一次列表查询，无副作用，可安全并入并行组。呈现保持默认卡——search 卡的
    // 语义是文件路径列表，套在模型清单上会让 UI 误渲染
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          models: {
            type: "array",
            required: true,
            description: `模型列表（截断后，至多 ${LIST_MODELS_LIMIT} 条）`,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", required: true, description: "模型配置名（唯一标识）" },
                displayName: { type: "string", required: true },
                namespace: { type: "string", required: true },
                quant: { type: "string", description: "量化格式，未知时省略该字段" },
                sizeBytes: { type: "integer", required: true },
                status: { type: "string", required: true },
              },
            },
          },
          total: { type: "integer", required: true, description: "真实总数（未截断）" },
          truncated: { type: "boolean", required: true, description: "是否因超过上限被截断" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => {
        const names = value.models.map((m) => m.name).join(", ") || "（无）";
        const suffix = value.truncated ? `（已截断，仅显示前 ${value.models.length} / ${value.total} 条）` : "";
        return [{ type: "text", text: `共 ${value.total} 个模型${suffix}：${names}` }];
      },
    },
    async execute() {
      const all = await client.listModels();
      const sorted = [...all].sort((a, b) => a.name.localeCompare(b.name));
      const sliced = sorted.slice(0, LIST_MODELS_LIMIT);
      return {
        models: sliced.map((m) => ({
          name: m.name,
          displayName: m.displayName,
          namespace: m.namespace,
          ...(m.quant != null ? { quant: m.quant } : {}),
          sizeBytes: m.sizeBytes,
          status: m.status,
        })),
        total: all.length,
        truncated: all.length > LIST_MODELS_LIMIT,
      };
    },
  });
}

// ---- llamapad_start_model ----

export function buildStartModelTool(
  client: PanelClient,
  gate: ModelGate,
  config: { startTimeoutMs: number; pollIntervalMs: number },
): ToolDefinition {
  return defineTool({
    name: "llamapad_start_model",
    description:
      "启动或切换 llamapad 面板管理的本地模型（单模型运行时语义：自动停旧起新）。只影响本地 llamapad " +
      "面板管理的模型，不是通用 Docker 管理工具；不做删除模型、改配置等操作。",
    parameters: {
      model: { type: "string", required: true, description: "llamapad 面板里的模型配置名（非展示名）" },
      waitReady: {
        type: "boolean",
        description: "是否等待模型就绪后再返回，默认 true；false 时乐观启动，不等就绪立即返回",
      },
      drain: {
        type: "boolean",
        description: "切换前是否让服务端排空在途推理，默认 true（与聊天路由切换的默认行为一致）",
      },
      timeoutMs: { type: "integer", description: "等待就绪的超时（毫秒），默认沿用插件配置的 startTimeoutMs" },
    },
    // 启动经共享门（switching.ts）串行/合流：同目标并发 ensure 只触发一次 start，
    // 不同目标按队列顺序在单模型运行时下收敛，不会互相插队——可安全并入并行组
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          started: { type: "boolean", required: true },
          model: { type: "string", required: true },
          waitedReady: { type: "boolean", required: true, description: "是否等到了就绪确认" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: "text",
        text: `已启动 ${value.model}${value.waitedReady ? "（已就绪）" : "（未等待就绪，可能仍在加载）"}`,
      }],
    },
    // 启停是改变面板运行状态的操作：kind:'execute' 让 UI 给执行类处理；模型名是
    // 调用里唯一值得一眼看到的信息，已进标题，rawInput 不再重复整份参数
    presentCall: (args) => ({ card: "generic", title: `启动模型 ${args.model}`, kind: "execute" }),
    async execute(args, exec) {
      const waitReady = args.waitReady ?? true;
      const drain = args.drain ?? true;
      await gate.ensure(args.model, {
        signal: exec.signal,
        waitReady,
        timeoutMs: args.timeoutMs ?? config.startTimeoutMs,
        pollIntervalMs: config.pollIntervalMs,
        ...(drain ? { drain: true } : {}),
      });
      // 乐观启动时补探一次：waitedReady 如实反映健康状态，而不是硬编码成 false
      // （llamaHealth 自吞异常返回 false，探不到即按未就绪算）
      const waitedReady = waitReady ? true : await client.llamaHealth();
      return { started: true, model: args.model, waitedReady };
    },
  });
}

// ---- llamapad_stop_model ----

export function buildStopModelTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_stop_model",
    description:
      "停止 llamapad 面板当前运行的本地模型。没有模型在跑时视为已达成终态，返回 stopped:false 而非报错。" +
      "只影响本地 llamapad 面板管理的模型，不是通用 Docker 管理工具。",
    parameters: {
      drain: { type: "boolean", description: "停止前是否让服务端排空在途推理，默认 true" },
      drainTimeoutMs: { type: "integer", description: "排空等待的最长时间（毫秒），默认沿用服务端设置（60000）" },
    },
    // 停止是幂等的终态操作：并发派发时后到者查到的多已是「没有模型在跑」，而
    // stopped:false 本就是合法答案，终态收敛一致；进程内无共享可变状态——可并入并行组
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          stopped: { type: "boolean", required: true },
          model: { type: "string", description: "被停止的模型名（stopped 为 true 时才有）" },
          drainReason: { type: "string", description: "排空结果：idle / timeout / unavailable / skipped" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{
        type: "text",
        text: value.stopped
          ? `已停止 ${value.model}${value.drainReason ? `（排空：${value.drainReason}）` : ""}`
          : "当前没有模型在运行，无需停止",
      }],
    },
    // 目标模型要等查询后才知道（stop 不带模型参数），标题固定描述操作本身；
    // kind:'execute' 标示这是改变面板运行状态的操作
    presentCall: () => ({ card: "generic", title: "停止当前模型", kind: "execute" }),
    async execute(args) {
      const status = await client.runtimeStatus();
      if (!status.running) return { stopped: false };
      const drain = args.drain ?? true;
      const result = await client.stopModel(status.running.model, {
        ...(drain ? { drain: true } : {}),
        ...(args.drainTimeoutMs !== undefined ? { drainTimeoutMs: args.drainTimeoutMs } : {}),
      });
      return {
        stopped: true,
        model: status.running.model,
        ...(result.drain ? { drainReason: result.drain.reason } : {}),
      };
    },
  });
}
