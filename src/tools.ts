/**
 * B 形态：llamapad 管理工具（供任意模型驱动的 Agent 调用查询/启停本地模型）。
 * 与 A 形态（./index.ts）共享 panel-client.ts 的 REST 封装与 switching.ts 的共享门，
 * 但走独立的插件入口（inject: ['tools']），Config 也互相独立、互不读取对方。
 *
 * 边界（与 CLAUDE.md「用户边界」一致）：只做运行时调度的查询与启停，不做删除模型/
 * 文件、改配置、下载管理等高危操作——那些留在 llamapad 面板的人工确认流程里。
 *
 * 失败语义：status 把"面板不可达"当作有效答案返回（不抛错——可达性本身就是它要
 * 回答的问题）；list_models / events 等清单查询与启停工具的真实故障（面板不可达、
 * 模型不存在、鉴权失败等）直接 throw——框架的 toolErrorResult 会接住，转成
 * isError + 错误文本喂给模型，不需要在这里另建一套 { error } 返回值联合体。
 */
import type { Context } from "@deepseek-ai/cordis";
import Schema from "@deepseek-ai/schemastery";
import { defineTool, type ToolDefinition } from "@deepseek-ai/dsh-tools";
import { createPanelClient, defaultModelOf, isRunning, PanelError, runningModels, type PanelClient } from "./panel-client";
import { EnsureError, sharedModelGate, type ModelGate } from "./switching";

export interface Config {
  panelUrl: string;
  token: string;
  requestTimeoutMs: number;
  startTimeoutMs: number;
  startRequestTimeoutMs: number;
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
  startRequestTimeoutMs: Schema.number().default(300000).description(
    "启动请求等待面板返回的最长时间（毫秒）；面板首次拉取镜像可能要几分钟。只影响 start 请求本身，" +
    "不改变 startTimeoutMs（就绪等待）的语义",
  ),
  pollIntervalMs: Schema.number().default(2000).description("就绪探测轮询间隔（毫秒）"),
  toolApproval: Schema.string().default("allow").description(
    "写操作工具审批档位：allow（默认）=Agent 调用 llamapad_start_model / llamapad_stop_model / "
    + "llamapad_set_default_model 直接执行；ask=执行前需用户确认（宿主无审批通道时会拒绝执行）。"
    + "共享 GPU 场景建议 ask——启停影响别的会话，切换默认模型还会改变不带模型名的请求打给谁",
  ),
});

export const name = "llamapad-dsh-plugin/tools";
export const inject = ["tools"];

/** 列模型结果的硬上限：框架没有内置的结果大小/截断机制，超大返回值要自己截。 */
export const LIST_MODELS_LIMIT = 100;

/** 事件查询的默认条数与硬上限，与面板 /api/v1/events 的契约一致（limit 默认 20、
 * 上限 100）。两端各守一次：工具侧先钳一道再发请求，面板即便不守约（旧版本忽略
 * limit 参数全量返回），返回值也不会超出 output schema 承诺的至多 100 条。 */
export const EVENTS_DEFAULT_LIMIT = 20;
export const EVENTS_LIMIT = 100;

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
  ctx.tools.register(buildEventsTool(client));
  ctx.tools.register(buildStartModelTool(client, gate, config));
  ctx.tools.register(buildStopModelTool(client));
  ctx.tools.register(buildSetDefaultModelTool(client));

  // 审批门（toolApproval: ask）：共享 GPU 场景下启停模型、切换默认模型都会影响其他
  // 会话（后者改的是"不带模型名的请求打给谁"这个全局路由目标），Agent 的自主调用
  // 值得过一道用户确认。只升 allow 不动 deny——先 await next() 再升级是洋葱外层的
  // 包装语义：下游（含更内层监听器）已经 deny 的调用保持拒绝（原因原样透传，不覆盖
  // 成我们自己的文案），只有下游放行的启停/切换调用才升级为 ask，交由框架的
  // approval 服务转成用户确认（宿主无 approval 通道时框架会把 ask 折算为 deny）。
  // allow 档不注册监听：waterfall 上少一跳，零开销也零干扰。监听器不依赖 this
  // （事件类型标 this: Scoped<ToolRuntime>，普通箭头函数即可）。
  if (config.toolApproval === "ask") {
    ctx.on("tools/pre-execute", async (exec, next) => {
      const decision = await next();
      if (decision.kind === "allow"
          && (exec.name === "llamapad_start_model" || exec.name === "llamapad_stop_model"
              || exec.name === "llamapad_set_default_model")) {
        return { kind: "ask", reason: "llamapad 模型启停/切换默认模型需要用户确认（toolApproval: ask）" };
      }
      return decision;
    });
  }
}

// ---- llamapad_status ----

/** 单个在跑模型的行投影（execute 返回的 models[] 每项，与 presentResult 回放读回的形状同构）。 */
interface StatusModelEntry {
  model: string;
  displayName?: string;
  /** 省略 = 不可知（老面板缺该字段），渲染时按 loading 处理，不冒充"已就绪" */
  ready?: boolean;
  isDefault: boolean;
}

/** presentResult 从 result.meta 读回的投影形状（execute 返回值经 JSON 持久化后的样子）。
 *  model/displayName/hostPort 三个扁平字段固定指向"默认模型"那一项（不带 model 字段的
 *  请求会打给它），models 是全部在跑模型的完整清单——两者信息有重叠，保留扁平字段是
 *  为了兼容原先只关心"默认模型状态"的调用点，不必都去解析 models 数组。 */
interface StatusProjection {
  panelReachable: boolean;
  running: boolean;
  /** running 为 true 时才有，按面板返回顺序（启动时间升序）列出全部在跑模型 */
  models?: StatusModelEntry[];
  model?: string;
  displayName?: string;
  hostPort?: number;
  inferring?: boolean;
  slotsRunning?: number;
}

/**
 * meta 随会话日志持久化，回放时可能来自旧版本 schema（字段缺席或多余），不能把
 * unknown 直接断言成 execute 的返回类型——按字段逐个收窄，形状对不上就返回
 * undefined，让呈现层回退默认卡而不是把编造的状态当真。models 数组同理逐项收窄，
 * 任一行形状坏掉就整体判定失败（对齐 readEventsProjection 的取舍）。
 */
function readStatusProjection(meta: unknown): StatusProjection | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const { panelReachable, running, models, model, displayName, hostPort, inferring, slotsRunning } =
    meta as Record<string, unknown>;
  if (typeof panelReachable !== "boolean" || typeof running !== "boolean") return undefined;
  let narrowedModels: StatusModelEntry[] | undefined;
  if (models !== undefined) {
    if (!Array.isArray(models)) return undefined;
    narrowedModels = [];
    for (const entry of models) {
      if (typeof entry !== "object" || entry === null) return undefined;
      const { model: entryModel, displayName: entryDisplayName, ready, isDefault } =
        entry as Record<string, unknown>;
      if (typeof entryModel !== "string" || typeof isDefault !== "boolean") return undefined;
      if (entryDisplayName !== undefined && typeof entryDisplayName !== "string") return undefined;
      if (ready !== undefined && typeof ready !== "boolean") return undefined;
      narrowedModels.push({
        model: entryModel,
        ...(entryDisplayName !== undefined ? { displayName: entryDisplayName } : {}),
        ...(ready !== undefined ? { ready } : {}),
        isDefault,
      });
    }
  }
  return {
    panelReachable,
    running,
    ...(narrowedModels !== undefined ? { models: narrowedModels } : {}),
    ...(typeof model === "string" ? { model } : {}),
    ...(typeof displayName === "string" ? { displayName } : {}),
    ...(typeof hostPort === "number" ? { hostPort } : {}),
    ...(typeof inferring === "boolean" ? { inferring } : {}),
    ...(typeof slotsRunning === "number" ? { slotsRunning } : {}),
  };
}

/** 单个在跑模型的一行：`● 名字（展示名） · ready/loading · (默认)`。ready 不可知
 *  （undefined，老面板缺该字段）按 loading 处理——容器在跑不代表模型已可用，
 *  宁可显得保守也不能冒充"已就绪"；isDefault 才追加 (默认) 后缀。 */
function formatModelLine(entry: StatusModelEntry): string {
  const nameSuffix = entry.displayName === undefined ? "" : `（${entry.displayName}）`;
  const readyWord = entry.ready === true ? "ready" : "loading";
  const defaultSuffix = entry.isDefault ? " · (默认)" : "";
  return `● ${entry.model}${nameSuffix} · ${readyWord}${defaultSuffix}`;
}

/**
 * 基础多行文本：面板不可达 / 无模型在跑 / 全部在跑模型逐行列出 + busy 探测范围说明。
 * render()（喂模型）与 presentResult 的终端输出共用这份基础格式，两边口径不会打架
 * （对齐 formatEventsLines 的取舍）；presentResult 在此基础上叠加默认模型的端口/slot
 * 明细，终端卡有输出空间，人读的卡片可以比喂模型的摘要更详细。
 *
 * busy 探测只探默认模型（面板 busy=1 只探 running 那一项），不代表其它在跑模型的忙闲，
 * 因此这行必须点明"仅针对默认模型"，不能让读者误以为是全局忙闲；inferring 缺席
 * （不可知）时不加这行，不伪造成"空闲"。
 */
function formatStatusLines(status: StatusProjection): string {
  if (!status.panelReachable) return "llamapad 面板不可达";
  if (!status.running || status.models === undefined || status.models.length === 0) {
    return "当前没有模型在运行";
  }
  const lines = status.models.map(formatModelLine);
  if (status.inferring !== undefined) {
    lines.push(`busy 探测仅针对默认模型：${status.inferring ? "正在推理" : "空闲"}`);
  }
  return lines.join("\n");
}

/** presentResult 专用：在共享的逐行列表之上叠加默认模型的端口/slot 明细。 */
function formatStatusOutput(status: StatusProjection): string {
  const base = formatStatusLines(status);
  if (!status.panelReachable || !status.running) return base;
  const extra = [
    ...(status.hostPort === undefined ? [] : [`默认模型宿主机端口：${status.hostPort}`]),
    ...(status.slotsRunning === undefined ? [] : [`默认模型处理中 slot：${status.slotsRunning}`]),
  ];
  return extra.length > 0 ? `${base}\n${extra.join("\n")}` : base;
}

export function buildStatusTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_status",
    description:
      "查看 llamapad 面板当前运行状态：全部在跑的本地模型、各自是否就绪、哪个是默认模型" +
      "（不带模型名的对话请求会打给它）、面板是否可达。只读，不做任何变更。只影响本地 llamapad " +
      "面板管理的模型，不是通用 Docker 管理工具。",
    parameters: {},
    // 只读：一次 runtimeStatus 查询，无进程内共享可变状态，可安全并入并行组
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          panelReachable: { type: "boolean", required: true, description: "面板控制面是否可达" },
          running: { type: "boolean", required: true, description: "当前是否有任意模型在运行" },
          models: {
            type: "array",
            description: "全部在跑模型（running 为 true 时才有，按启动时间升序）",
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                model: { type: "string", required: true, description: "模型配置名" },
                displayName: { type: "string", description: "展示名，未知时省略" },
                ready: { type: "boolean", description: "是否已就绪，不可知（老面板）时省略" },
                isDefault: { type: "boolean", required: true, description: "是否为当前默认模型" },
              },
            },
          },
          model: { type: "string", description: "默认模型名（该模型确实在跑时才有）" },
          displayName: { type: "string", description: "默认模型的展示名" },
          hostPort: { type: "integer", description: "默认模型的宿主机端口" },
          inferring: {
            type: "boolean",
            description: "默认模型是否有在途推理（busy 探测只探默认模型，仅可探知时才有）",
          },
          slotsRunning: { type: "integer", description: "默认模型处理中的 slot 数（仅可探知时才有）" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: formatStatusLines(value) }],
      // 回放路径上 presentResult 只能从 meta 读回结构化投影（content 是喂模型的文本，
      // 多行终端输出要能无损重建），而 status 值本身就是 lossless JSON，原样投影
      // 即可，不必再精选字段
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
      // 全部在跑模型统一走 runningModels() 归一（老面板由 running 合成单元素数组，
      // isDefault 已由它按 defaultModelOf() 回填），不再只读 status.running
      const running = runningModels(status);
      if (running.length === 0) return { panelReachable: true, running: false };
      const models: StatusModelEntry[] = running.map((m) => ({
        model: m.model,
        ...(m.displayName !== undefined ? { displayName: m.displayName } : {}),
        ...(m.ready !== undefined ? { ready: m.ready } : {}),
        isDefault: m.isDefault === true,
      }));
      const defaultEntry = running.find((m) => m.isDefault) ?? null;
      return {
        panelReachable: true,
        running: true,
        models,
        ...(defaultEntry !== null ? {
          model: defaultEntry.model,
          ...(defaultEntry.displayName !== undefined ? { displayName: defaultEntry.displayName } : {}),
          ...(defaultEntry.hostPort != null ? { hostPort: defaultEntry.hostPort } : {}),
        } : {}),
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

// ---- llamapad_events ----

/** presentResult 从 result.meta 读回的投影形状（execute 返回值经 JSON 持久化后的样子）。 */
interface EventsProjection {
  events: Array<{ id: number; ts: number; kind: string; message: string }>;
  total: number;
}

/**
 * meta 随会话日志持久化，回放时可能来自旧版本 schema（字段缺席或多余）。按字段逐个
 * 收窄，事件行里有任何一项形状对不上就整体返回 undefined，让呈现层回退默认卡——
 * 排障场景里把半编造的事件行当真比看不到卡片更糟（对齐 status 的 readStatusProjection）。
 */
function readEventsProjection(meta: unknown): EventsProjection | undefined {
  if (typeof meta !== "object" || meta === null) return undefined;
  const { events, total } = meta as Record<string, unknown>;
  if (!Array.isArray(events) || typeof total !== "number") return undefined;
  const narrowed: EventsProjection["events"] = [];
  for (const event of events) {
    if (typeof event !== "object" || event === null) return undefined;
    const { id, ts, kind, message } = event as Record<string, unknown>;
    if (typeof id !== "number" || typeof ts !== "number"
        || typeof kind !== "string" || typeof message !== "string") {
      return undefined;
    }
    narrowed.push({ id, ts, kind, message });
  }
  return { events: narrowed, total };
}

/**
 * 毫秒时间戳 → 本地时间 YYYY-MM-DD HH:mm。时区取舍：工具在 host 进程里跑，Date
 * 按宿主机时区解释——排障看的是「用户自己经历过的时刻」（「模型为什么凌晨三点停了」），
 * 本地时区正是想要的口径。手写补零格式而非 toLocaleString：后者的输出随运行环境的
 * locale/ICU 漂移（宽窄年、逗号分隔都见过），喂模型的文本要一个稳定可解析的形状。
 */
function formatEventTime(ts: number): string {
  const date = new Date(ts);
  const p2 = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`
    + ` ${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

/** 调用卡与结果卡共用的标题；kind 过滤拼进标题，一眼看出这次查的是哪类事件。 */
function eventsTitle(kind: unknown): string {
  // presentResult 的回放路径上 args 只做软校验，kind 可能已不是 string——
  // 非字符串时宁可不拼，也不把垃圾值渲染进人看的标题
  return typeof kind === "string" && kind ? `查询 llamapad 事件（${kind}）` : "查询 llamapad 事件";
}

/**
 * 事件的多行文本：每行 `[YYYY-MM-DD HH:mm] kind message`（面板按 ts 倒序返回，原样
 * 即「最新在上」）。render（喂模型）与 presentResult 的 terminal 输出共用一份格式化，
 * 两边口径不会打架——对齐 status 的「首行口径一致」原则。
 */
function formatEventsLines(requestedLimit: number | undefined, value: EventsProjection): string {
  if (value.events.length === 0) return "没有匹配的事件";
  const lines = value.events.map((e) => `[${formatEventTime(e.ts)}] ${e.kind} ${e.message}`);
  // 超限提示：请求的 limit 被钳到上限时，面板返回的「正好 100 条」不是「只有 100 条」，
  // 不提示的话模型会把截断读成全集（面板不提供全量真实总数，这里只能提示钳制事实）
  if (requestedLimit !== undefined && requestedLimit > EVENTS_LIMIT) {
    lines.push(`（limit ${requestedLimit} 超过上限 ${EVENTS_LIMIT}，已按前 ${EVENTS_LIMIT} 条返回）`);
  }
  return lines.join("\n");
}

export function buildEventsTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_events",
    description:
      "查询 llamapad 面板的操作事件历史（模型启停/异常退出、下载、配置变更等），排障用——如回答" +
      `"模型为什么停了"。只读。不传参数返回最近 ${EVENTS_DEFAULT_LIMIT} 条，limit 可调（上限 ${EVENTS_LIMIT}，` +
      "超出按上限处理），kind 精确过滤事件类型（如 model.exit 只看容器异常退出）。",
    parameters: {
      limit: {
        type: "integer",
        description: `返回最近多少条事件，默认 ${EVENTS_DEFAULT_LIMIT}，上限 ${EVENTS_LIMIT}（更大的值按上限处理）`,
      },
      kind: {
        type: "string",
        description: "事件类型精确过滤（非子串匹配），如 model.exit / model.stop / download.failed；不传返回全部类型",
      },
    },
    // 只读：一次 events 查询，无副作用、无进程内共享可变状态，可安全并入并行组
    isConcurrencySafe: () => true,
    output: {
      schema: {
        type: "object",
        properties: {
          events: {
            type: "array",
            required: true,
            description: `事件列表（按时间倒序，至多 ${EVENTS_LIMIT} 条）`,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                id: { type: "integer", required: true, description: "事件自增 id" },
                ts: { type: "integer", required: true, description: "事件时间戳（毫秒，Epoch UTC）" },
                kind: { type: "string", required: true, description: "事件类型，如 model.exit" },
                message: { type: "string", required: true, description: "人类可读的事件描述" },
              },
            },
          },
          // total = 返回条数而非全量真实总数：面板 events 接口不提供全量计数，
          // 不伪造一个查不到的数字（截断与否由 limit 钳制 + 超限提示表达）
          total: { type: "integer", required: true, description: "返回条数（= events.length）" },
        },
        additionalProperties: false,
      },
      render: (args, value) => [{ type: "text", text: formatEventsLines(args.limit, value) }],
      // 与 status 同理：value 本身就是 lossless JSON，原样投影进 meta 供回放重建终端卡
      presentationMeta: (_args, value) => value,
    },
    // 排障查询不是终端命令语义，generic 卡即可；kind 进标题标明过滤范围
    presentCall: (args) => ({ card: "generic", title: eventsTitle(args.kind) }),
    presentResult: (args, result) => {
      const projection = readEventsProjection(result.meta);
      if (!projection) return undefined;
      return {
        card: "terminal",
        title: eventsTitle(args.kind),
        output: formatEventsLines(
          // 回放路径 args 只做软校验，limit 先收窄再进格式化（超限提示要用它做比较）
          typeof args.limit === "number" ? args.limit : undefined,
          projection,
        ),
        // 查询本身成功即 0：空结果是「没有匹配的事件」的合法答案，不是失败
        exitCode: 0,
      };
    },
    async execute(args) {
      // 先钳后发：超上限的 limit 不透传给面板（旧面板可能忽略参数全量返回），
      // 返回行再 slice 一道兜底，保证 output schema 承诺的「至多 100 条」恒成立
      const limit = Math.min(args.limit ?? EVENTS_DEFAULT_LIMIT, EVENTS_LIMIT);
      const events = await client.getEvents({ limit, ...(args.kind ? { kind: args.kind } : {}) });
      // 显式投影四个契约字段：面板将来加字段也不会撑破 additionalProperties:false
      const projected = events.slice(0, EVENTS_LIMIT).map((e) => ({
        id: e.id,
        ts: e.ts,
        kind: e.kind,
        message: e.message,
      }));
      return { events: projected, total: projected.length };
    },
  });
}

// ---- llamapad_start_model ----

export function buildStartModelTool(
  client: PanelClient,
  gate: ModelGate,
  config: { startTimeoutMs: number; pollIntervalMs: number; startRequestTimeoutMs?: number },
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
      try {
        await gate.ensure(args.model, {
          signal: exec.signal,
          waitReady,
          timeoutMs: args.timeoutMs ?? config.startTimeoutMs,
          pollIntervalMs: config.pollIntervalMs,
          ...(config.startRequestTimeoutMs !== undefined
            ? { startRequestTimeoutMs: config.startRequestTimeoutMs } : {}),
          ...(drain ? { drain: true } : {}),
        });
      } catch (error) {
        // 乐观启动（waitReady:false）下 start 请求本身超时（面板仍在处理，见
        // switching.ts 的 START_PENDING）不是失败——请求确实已经发出，与「服务端已
        // 确认」这件事无关，本就不承诺过。渲染文案已是「未等待就绪，可能仍在加载」，
        // 正常返回即可，不必让调用方把这当一次工具失败
        if (waitReady === false && error instanceof EnsureError && error.code === "START_PENDING") {
          return { started: true, model: args.model, waitedReady: false };
        }
        throw error;
      }
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
      "停止 llamapad 面板上运行的本地模型。不传 model 时停默认模型；面板可同时运行多个模型，" +
      "要停某个具体的模型就把它的配置名传进 model。目标没在跑时视为已达成终态，返回 stopped:false 而非报错。" +
      "只影响本地 llamapad 面板管理的模型，不是通用 Docker 管理工具。",
    parameters: {
      model: {
        type: "string",
        description: "要停止的模型配置名；不传时停默认模型（面板上不带模型名的请求会落到的那个）",
      },
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
    // 不传 model 时目标要等查询后才知道，标题只好描述操作本身；传了就直接点名，
    // 用户在确认框里看得见要停的是谁。kind:'execute' 标示这是改变面板运行状态的操作
    presentCall: (args) => ({
      card: "generic",
      title: typeof (args as { model?: unknown }).model === "string"
        ? `停止 ${(args as { model: string }).model}`
        : "停止默认模型",
      kind: "execute",
    }),
    async execute(args) {
      const status = await client.runtimeStatus();
      // 目标：显式指定的那个，或默认模型。多模型面板上这个区分是必须的——不带参数
      // 一律停 status.running 的老写法，在用户说「停掉 B」时会把默认的 A 停掉，
      // 停错模型比停不了更糟
      const target = args.model ?? defaultModelOf(status);
      // 指定的模型没在跑与「一个都没跑」同样是终态（stop 是幂等操作），都回
      // stopped:false——绝不因为目标不在就退而求其次去停别的模型
      if (target === null || !isRunning(status, target)) return { stopped: false };
      const drain = args.drain ?? true;
      const result = await client.stopModel(target, {
        ...(drain ? { drain: true } : {}),
        ...(args.drainTimeoutMs !== undefined ? { drainTimeoutMs: args.drainTimeoutMs } : {}),
      });
      return {
        stopped: true,
        model: target,
        ...(result.drain ? { drainReason: result.drain.reason } : {}),
      };
    },
  });
}

// ---- llamapad_set_default_model ----

export function buildSetDefaultModelTool(client: PanelClient): ToolDefinition {
  return defineTool({
    name: "llamapad_set_default_model",
    description:
      "切换 llamapad 面板的默认模型——不带模型名的对话请求会打给它。目标模型必须已经在运行" +
      "（用 llamapad_start_model 先启动），否则面板会拒绝切换。只影响本地 llamapad 面板管理的" +
      "模型，不是通用 Docker 管理工具；需要面板多模型版本，老面板不支持这个操作。",
    parameters: {
      model: { type: "string", required: true, description: "要设为默认的模型配置名（须已在运行）" },
    },
    // 不声明 isConcurrencySafe：省略即被框架当作互斥（只有显式返回 true 才能并入
    // 并行组）。这个操作会改变"不带模型名的请求打给谁"这一全局路由目标，是写操作，
    // 不能与其它调用无序交织
    output: {
      schema: {
        type: "object",
        properties: {
          switched: { type: "boolean", required: true },
          model: { type: "string", required: true, description: "已设为默认的模型名" },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: "text", text: `已将默认模型切换为 ${value.model}` }],
    },
    // 与启停同属改变面板路由/运行状态的操作：kind:'execute' 让 UI 走执行类处理；
    // 目标模型名已进标题，rawInput 不必重复整份参数
    presentCall: (args) => ({ card: "generic", title: `切换默认模型为 ${args.model}`, kind: "execute" }),
    async execute(args) {
      try {
        await client.setDefaultModel(args.model);
      } catch (error) {
        // 404 是"面板太老，压根没有这个功能"，读者是调用这个工具的 Agent——面板那句
        // 面向端点本身的说明（"面板不支持默认模型接口"）不够直白，换一句点明"要切换
        // 默认模型需要先升级面板"的话；保留 PanelError 类型与 UNSUPPORTED 码，
        // 调用方仍能按码分支（对齐 panel-gateway.ts describePanelError 的同一改写取舍）
        if (error instanceof PanelError && error.code === "UNSUPPORTED") {
          throw new PanelError("当前面板版本不支持默认模型切换（需要面板多模型版本）", "UNSUPPORTED", 404);
        }
        // 409（目标模型没在跑）等其余故障照抛：面板的 message 本身就是完整说明，
        // 框架的 toolErrorResult 会原样转成错误文本喂给模型（对齐文件头注释的失败语义）
        throw error;
      }
      return { switched: true, model: args.model };
    },
  });
}
