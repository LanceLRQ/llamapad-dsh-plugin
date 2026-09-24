import { createServer } from "node:http";

/**
 * llamapad 假面板：实现插件用到的控制面端点 + 事件端点（查询/SSE）+ 监控端点
 * （metrics 窗口 / GPU 快照）+ llama.cpp 反代（health + chat SSE）。状态机：start 置
 * running + readyAt；health 在 readyAt 前回 503。start/stop 路由会像真实面板一样写
 * model.* 事件并推给挂着的 SSE 订阅者。
 *
 * `multiModel` 开关（默认 false = 老面板模式）：本插件是在面板 `feature/multi-model`
 * 分支尚未合并进 dev/main 前提前适配的（见 docs/plans/2026-09-21-multi-model-adapt.md
 * 背景一节），假面板因此要能演出两种面板的差异，供 E2E 做双向兼容回归：
 * - false（老面板模式，也是默认值——不改这个默认，才能保证本文件其余既有 E2E
 *   用例（adapter-e2e / tools-e2e / status-watch-e2e）不动一行代码继续通过）：
 *   `runtime/status` 只回 `running` 单值（无 `models[]`/`defaultModel`），
 *   start 对已有运行模型是"停旧起新"（同一时刻只有一个 running），
 *   default-model 路由整条不存在（落到文件尾的通用 404），
 *   `/v1/models` 反代只回一条（`id` = 当前唯一运行的模型）。
 * - true（新面板/多模型模式）：`state.runtime`（Map，键为模型名）记录全部运行中
 *   模型各自的就绪时刻/端口/启动时刻，start 只新增不驱逐（面板解除了"同一时刻
 *   只运行一个模型"的约束，正是本次适配要修的六处错配的根源）；`state.defaultModel`
 *   独立维护——只有"当前没有任何默认模型"时 start 才会顺手把新模型设成默认
 *   （对齐面板"起第一个模型就会有默认"的实际行为），此后只能通过
 *   `PUT default-model` 显式切换，stop 掉默认模型会把默认清空而不是自动顶替下一个
 *   （面板真实语义含糊，取最简单、最不会误导测试的假设）。
 *
 * `supportsStarting` 开关（默认 true）：与 `multiModel` 是两条独立的轴——`starting`
 * 字段来自面板 dev/main 主线（与 `feature/multi-model` 分支无关），老面板（两个开关
 * 都可能是 false）没有这个字段。为 false 时 `runtime/status` 响应体里连 `starting`
 * 键本身都不写（不是写一个空数组）——对齐 panel-client.ts `PanelStartingModel` 注释里
 * "老面板缺这个字段时才回退"的措辞，也让「老面板模式该长什么样」不用去读源码默认值
 * 就能从响应体本身确认。
 *
 * start 挂起（`state.startHoldMs`，Map<模型名, 毫秒数>）：由测试在调用 start 前写入，
 * 命中后 start 请求不会立即完成——先把该模型记进 `state.pendingStarts`（此时
 * `runtime/status` 的 `starting` 数组会带上它，`stage` 固定给 `"pulling"`，对应真机
 * 「本地无镜像先拉取」的最长阶段，简化模型不细分三阶段），再进入等待：
 * - 数值是有限数：`setTimeout` 到点自动完成（模拟"拉镜像用了 N ms"）。
 * - 数值是 `Infinity`：不设定时器，只能由测试调用 `releaseStart(model)`（本文件顶层
 *   返回值的一个函数，不是 `state` 字段——它是"放行"这个动作而不是可读写的状态）手动
 *   放行，用于测试要在挂起期间精确控制断言时机（先查一次快照确认仍在 starting，
 *   再放行确认转入 models）而不是赌一个刚好够长的延迟。
 * `releaseStart` 对定时器挂起的模型同样有效（提前放行、清掉尚未触发的定时器），
 * 对没有挂起中请求的模型名是安全的空操作。
 */

/** 各窗口时长（毫秒），与真实面板 window.ts 的 RANGE_DEFS 同值——from 计算要用 */
const RANGE_DEFS = { "30m": 30 * 60_000, "2h": 2 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };

/** 与真实面板 resolutionForRange 同款：≤2h 走 5s ring、更长走 15min 聚合桶 */
const resolutionForRange = (range) => (range === "30m" || range === "2h" ? "5s" : "15m");

export function createFakePanel({ loadMs = 100, multiModel = false, supportsStarting = true } = {}) {
  const seedNow = Date.now();
  const state = {
    running: null, readyAt: 0, starts: [], stops: [], chatRequests: [], busy: null,
    events: [], eventStreams: new Set(), eventConnections: 0,
    /** 老面板模式(false，默认)/多模型模式(true) 开关，见文件头注释；只读，创建后不切档 */
    multiModel,
    /** `starting` 字段开关（默认 true），见文件头注释；只读，创建后不切档 */
    supportsStarting,
    /** start 挂起配置：模型名 → 毫秒数（有限值=定时放行，Infinity=只能手动 releaseStart）。
     *  可写，测试在调用 start 前设置；命中后见文件头「start 挂起」段落 */
    startHoldMs: new Map(),
    /** 挂起中的 start 请求，键为模型名，值 { action, since, stage }；随 runtime/status 的
     *  `starting` 字段一起投影（见 runtime/status 处理逻辑）。测试通常只读不写。 */
    pendingStarts: new Map(),
    /** 内部：挂起请求的放行回调，供顶层返回的 releaseStart(model) 调用；测试不直接碰它 */
    startReleasers: new Map(),
    /**
     * 多模型模式专用：全部运行中模型各自的运行态（键=模型名）。`running`/`readyAt`
     * 两个老字段在多模型模式下不再被这里的逻辑写入——两套状态分轨保存，不混着用
     * 一份字段，免得「哪个字段在哪种模式下是权威的」变成要记忆的隐性规则。
     */
    runtime: new Map(),
    /** 多模型模式专用：不带 model 字段的请求会打给谁；一个模型都没跑时为 null */
    defaultModel: null,
    // ---- 监控端点的假件 ----
    /** metrics 窗口请求的留痕（range 原样 + since 原始字符串），断言 query 拼装用 */
    metricsRequests: [],
    /**
     * 时序数据（真实面板是 5s ring，这里直接给可断言的小份集合）。真实面板恒含
     * 全部指标键（buildWindowPayload 补空数组），这里给六个监控键 + 两个插件不
     * 消费的 host.* 键——后者专供 e2e 验证「投影裁剪：多余键不随 MonitorSnapshot 下发」。
     * 时间戳取启动时刻的近侧偏移：delta 的三否决之一是「水位滑出 30m 窗口」，
     * 测试进程生命周期内（秒级）这些点始终在窗内，判定不受执行时刻影响。
     */
    metricsSeries: {
      "infer.tokens_per_sec": [
        { ts: seedNow - 60_000, value: 10 },
        { ts: seedNow - 30_000, value: 12.5 },
        { ts: seedNow - 10_000, value: 13 },
      ],
      "infer.kv_cache_tokens": [{ ts: seedNow - 60_000, value: 2048 }],
      "gpu.mem_used_mib": [{ ts: seedNow - 60_000, value: 1024 }],
      "gpu.util_percent": [],
      "container.cpu_percent": [{ ts: seedNow - 60_000, value: 42 }],
      "container.mem_percent": [],
      "host.cpu_percent": [{ ts: seedNow - 60_000, value: 3 }],
      "host.load1": [],
    },
    /** 故障注入：true 时 metrics 窗口回 500（e2e 测「一半失败另一半照发」） */
    failMetrics: false,
    /** 故障注入：true 时 gpu/stats 回 500 */
    failGpu: false,
    /** gpu/stats 三态（真实面板透传 nvidia-smi 探测结论），默认 available */
    gpuStatus: "available",
    /** 分卡明细；第二张卡温度/功耗给 null——真机 nvidia-smi 解析不到就是这个值 */
    gpuDevices: [
      { index: 0, memUsedMib: 1024, memTotalMib: 24564, utilPercent: 42, tempC: 61, powerW: 250.5 },
      { index: 1, memUsedMib: 512, memTotalMib: 24564, utilPercent: 7, tempC: null, powerW: null },
    ],
  };
  let nextEventId = 1;
  /** 写一条事件并推给全部 SSE 订阅者（真实面板 eventsStream.ts 的最小同构） */
  const emitEvent = (kind, message) => {
    const event = { id: nextEventId++, ts: Date.now(), kind, message };
    state.events.push(event);
    const frame = `data: ${JSON.stringify({ type: "event", ...event })}\n\n`;
    for (const res of state.eventStreams) res.write(frame);
  };
  const MODELS = [
    { name: "qwen-small", displayName: "Qwen 小", namespace: "main", ggufFile: "main/a.gguf", mmprojFile: null, status: "stopped", quant: "Q4_K_M", sizeBytes: 100, fileCount: 1, hostPort: 18080 },
    { name: "qwen-big", displayName: "Qwen 大", namespace: "main", ggufFile: "main/b.gguf", mmprojFile: null, status: "stopped", quant: "Q8_0", sizeBytes: 200, fileCount: 1, hostPort: 18081 },
  ];
  /**
   * 多模型模式下 `/v1/models` 反代按模型分别声明思考强度值域（面板 A6 决策要求
   * 按 `id` 精确匹配到目标模型自己的声明）。两个模型给出不同的 levels/rounding——
   * 纯粹是为了让 E2E 断言"确实取的是目标模型自己的声明，不是随手把聚合列表第一条
   * 拿来用"，不代表真实面板对不同模型的声明差异有什么规律。
   */
  const REASONING_DECLARATIONS = {
    "qwen-small": { levels: ["xhigh", "medium", "low"], rounding: "down" },
    "qwen-big": { levels: ["high", "medium", "low", "minimal"], rounding: "nearest" },
  };
  /** `runtime/status` 的 `starting` 字段：把 `state.pendingStarts` 投影成面板 wire 形状；
   *  只在 `state.supportsStarting` 为 true 时才会被调用方挂到响应体上（见两处状态分支）。 */
  const buildStartingList = () => [...state.pendingStarts.entries()].map(([model, info]) => ({
    model,
    displayName: MODELS.find((m) => m.name === model)?.displayName,
    action: info.action,
    since: info.since,
    stage: info.stage,
  }));
  const server = createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!/^Bearer lp_/.test(req.headers.authorization ?? "")) return json(401, { error: "unauthorized" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/models") return json(200, { models: MODELS });
    const effectiveMatch = /^\/api\/v1\/models\/([^/]+)\/effective$/.exec(url.pathname);
    if (req.method === "GET" && effectiveMatch) {
      const name = decodeURIComponent(effectiveMatch[1]);
      if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
      // 假面板只喂插件读 merged.server.ctx_size 用得到的最小形状；defaults/params/overriddenKeys
      // 插件不读，给空值占位即可
      return json(200, { defaults: {}, merged: { docker: {}, server: { ctx_size: 131072 } }, params: {}, overriddenKeys: [] });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/runtime/status") {
      if (state.multiModel) {
        // 多模型模式：models[] 是全部在跑模型各自的运行态；running 仍然给出（兼容
        // 字段），但只反映 defaultModel 那一项——这正是插件要适配的新语义本身
        // （见 panel-client.ts PanelRuntimeStatus.running 的注释）。
        const models = [...state.runtime.entries()].map(([model, info]) => ({
          model, hostPort: info.hostPort, ready: Date.now() >= info.readyAt, startedAt: info.startedAt,
        }));
        const defaultEntry = state.defaultModel !== null
          ? models.find((m) => m.model === state.defaultModel) ?? null
          : null;
        const body = {
          running: defaultEntry,
          models,
          defaultModel: state.defaultModel,
        };
        // ?model= 只用于精确 busy 探测（A3 决策）：老面板忽略这个参数、只探
        // running 那一项；这里同样只探一项——传了 model 探目标模型，没传探默认模型，
        // 两者都探不到（模型没在跑/没有默认）时 busy 是「不可知」而非「不忙」
        if (url.searchParams.get("busy") === "1") {
          const busyTarget = url.searchParams.get("model") ?? state.defaultModel;
          body.busy = busyTarget !== null && state.runtime.has(busyTarget) ? state.busy : null;
        }
        // `starting` 开关，见文件头「supportsStarting」段落——为 false 时连键都不写，
        // 不是写一个空数组
        if (state.supportsStarting) body.starting = buildStartingList();
        return json(200, body);
      }
      // 老面板模式（默认）：ready 与下面 /health 的判定同源（都看 readyAt），这样
      // loadMs 这一个参数就同时控制两条路径，不会出现「health 说没好、status 说好了」
      // 的自相矛盾。running/busy 两个字段保持原样字节不动——本文件其余既有 E2E 用例
      // 的前提；`starting` 是后加的独立字段，追加不影响这条前提
      const body = {
        running: state.running
          ? { model: state.running, hostPort: 18080, ready: Date.now() >= state.readyAt }
          : null,
      };
      if (url.searchParams.get("busy") === "1") body.busy = state.busy;
      if (state.supportsStarting) body.starting = buildStartingList();
      return json(200, body);
    }
    if (url.pathname === "/api/v1/runtime/default-model") {
      // 老面板模式下这条路由整个不存在（面板多模型分支才有），落到文件尾的通用
      // 404——不用专门分支表达"不存在"，缺席即不存在才是最贴近真实老面板的写法
      if (!state.multiModel) return json(404, { error: "not found" });
      if (req.method === "GET") {
        return json(200, { defaultModel: state.defaultModel, models: [...state.runtime.keys()] });
      }
      if (req.method === "PUT") {
        let body = "";
        req.on("data", (c) => { body += c; });
        req.on("end", () => {
          let parsed = {};
          try { parsed = body ? JSON.parse(body) : {}; } catch { parsed = {}; }
          const model = parsed.model;
          // 409（不是 404）：路由本身存在，只是目标模型没在运行——与
          // panel-client.ts defaultModelError 的 409→RUNTIME_BUSY 映射对应
          if (typeof model !== "string" || !state.runtime.has(model)) {
            return json(409, { error: `模型未在运行，无法设为默认: ${model}` });
          }
          state.defaultModel = model;
          return json(200, {});
        });
        return;
      }
      return json(404, { error: "not found" });
    }
    const startMatch = /^\/api\/v1\/models\/([^/]+)\/start$/.exec(url.pathname);
    if (req.method === "POST" && startMatch) {
      let body = "";
      req.on("data", (c) => { body += c; });
      // 客户端等挂起等不及、自己 AbortSignal.timeout 先触发时会主动断开连接——
      // 不装这个监听器，之后（延迟结束/手动 releaseStart 触发时）往一个已经断开的
      // socket 上 res.end() 会抛一个没人接的 'error' 事件，直接崩掉测试进程
      res.on("error", () => {});
      req.on("end", () => {
        const name = decodeURIComponent(startMatch[1]);
        if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
        let drainReq = {};
        try { drainReq = body ? JSON.parse(body) : {}; } catch { drainReq = {}; }
        // 对已在运行的模型再来一次 start 是「重建」而不是「首次启动」（面板真实语义，
        // 见文件头引用的 docs/guide/zh/api.md 说明）；要在挂起/完成两条路径共用，
        // 必须在这里（挂起状态尚未改动 running/runtime 前）就判定完，不能等 finishStart
        // 里再判——那时状态已经被写过了
        const action = (state.multiModel ? state.runtime.has(name) : state.running === name)
          ? "restart" : "start";
        const finishStart = () => {
          state.starts.push(name);
          if (state.multiModel) {
            // 多模型模式的核心行为（P0-1 的根因所在）：start 只新增这一个模型的
            // 运行态，绝不驱逐 state.runtime 里已有的其它模型——面板解除了「同一
            // 时刻只运行一个模型」的约束，旧「停旧起新」的假设不再成立
            const configuredHostPort = MODELS.find((m) => m.name === name)?.hostPort ?? 18080;
            state.runtime.set(name, {
              hostPort: configuredHostPort,
              readyAt: Date.now() + loadMs,
              startedAt: new Date().toISOString(),
            });
            // 只有「当前没有任何默认模型」时才顺手把新模型设成默认——对齐面板
            // 「起第一个模型就会有默认」的实际行为；此后只能靠 PUT default-model
            // 显式切换，不能被后续的 start 悄悄改掉（否则测不出 P0-1/P0-2 想验证的
            // 「目标不是默认也该正常工作」）
            if (state.defaultModel === null) state.defaultModel = name;
          } else {
            state.running = name;
            state.readyAt = Date.now() + loadMs;
          }
          emitEvent("model.start", `启动 ${name}`);
          const resBody = { id: `cid-${state.starts.length}` };
          if (drainReq.drain !== undefined || drainReq.drainTimeoutMs !== undefined) {
            // reason 必须落在服务端契约的四个值内（idle/timeout/unavailable/skipped）；
            // 假面板没有真实在途推理，对应真机的冷启动场景 → skipped
            resBody.drain = { drained: true, reason: "skipped" };
          }
          try { json(200, resBody); } catch { /* 客户端已经等不及断开了，回不回都无所谓 */ }
        };
        const holdMs = state.startHoldMs.get(name);
        if (holdMs === undefined) return finishStart();
        // 挂起：先把这个模型记进 pendingStarts（runtime/status 的 starting 数组会
        // 立即带上它），再等——见文件头「start 挂起」段落
        const since = new Date().toISOString();
        state.pendingStarts.set(name, { action, since, stage: "pulling" });
        let timer = null;
        const release = () => {
          if (timer !== null) clearTimeout(timer);
          state.pendingStarts.delete(name);
          state.startHoldMs.delete(name);
          state.startReleasers.delete(name);
          finishStart();
        };
        state.startReleasers.set(name, release);
        if (Number.isFinite(holdMs)) timer = setTimeout(release, holdMs);
        // holdMs === Infinity：不设定时器，只能靠测试调用顶层 releaseStart(name) 放行
      });
      return;
    }
    const stopMatch = /^\/api\/v1\/models\/([^/]+)\/stop$/.exec(url.pathname);
    if (req.method === "POST" && stopMatch) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const name = decodeURIComponent(stopMatch[1]);
        if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
        let drainReq = {};
        try { drainReq = body ? JSON.parse(body) : {}; } catch { drainReq = {}; }
        state.stops.push(name);
        if (state.multiModel) {
          // 只摘掉这一个模型，不牵连其它在跑模型（stop 的多模型对称语义）。
          // 停掉的恰好是默认模型时清空默认而不是自动顶替下一个——面板真实语义
          // 含糊，取最简单、最不会诱导测试写出错误期望的假设
          state.runtime.delete(name);
          if (state.defaultModel === name) state.defaultModel = null;
        } else {
          // stopModel 对无容器幂等成功（服务端语义），假面板同样不校验"是不是当前运行的那个"
          state.running = null;
          state.readyAt = 0;
        }
        emitEvent("model.stop", `停止 ${name}`);
        const resBody = { ok: true };
        if (drainReq.drain !== undefined || drainReq.drainTimeoutMs !== undefined) {
          // reason 必须落在服务端契约的四个值内（idle/timeout/unavailable/skipped）；
          // 假面板没有真实在途推理，对应真机的冷启动/已空闲场景 → idle
          resBody.drain = { drained: true, reason: "idle" };
        }
        return json(200, resBody);
      });
      return;
    }
    // 监控时序窗口：range 非法 400；delta 三否决与真实面板 planWindowQuery 同构
    // （since 缺失/非数字、24h/7d 的 15m 聚合桶、水位滑出窗口），插件侧零判断、
    // 只认响应里的 mode——假件必须把这套判定原样演出来，e2e 才测得到「插件对
    // 服务端否决的正确反应」（如 24h 带仍回 full）
    if (req.method === "GET" && url.pathname === "/api/v1/metrics/window") {
      if (state.failMetrics) return json(500, { error: "metrics 注入失败" });
      const range = url.searchParams.get("range");
      if (!Object.hasOwn(RANGE_DEFS, range)) return json(400, { error: "invalid range" });
      state.metricsRequests.push({ range, since: url.searchParams.get("since") });
      const from = Date.now() - RANGE_DEFS[range];
      const resolution = resolutionForRange(range);
      const sinceRaw = url.searchParams.get("since");
      const since = sinceRaw === null || sinceRaw === "" ? null : Number(sinceRaw);
      const delta = since !== null && Number.isFinite(since) && resolution === "5s" && since >= from;
      const series = {};
      for (const [metric, points] of Object.entries(state.metricsSeries)) {
        series[metric] = delta ? points.filter((p) => p.ts > since) : points;
      }
      return json(200, { range, from, resolution, series, mode: delta ? "delta" : "full" });
    }
    // GPU 当前值快照：三态 + 分卡明细 + 显存合计（空卡组为 null，同 sumGpuTotals）。
    // samples 字段照真实面板给上——插件投影不声明即丢弃，e2e 顺带验证它不随快照下发
    if (req.method === "GET" && url.pathname === "/api/v1/gpu/stats") {
      if (state.failGpu) return json(500, { error: "gpu 注入失败" });
      if (state.gpuStatus !== "available") {
        return json(200, { available: false, status: state.gpuStatus, samples: null, devices: [], totals: null });
      }
      const devices = state.gpuDevices;
      const totals = devices.length === 0 ? null : devices.reduce(
        (acc, d) => ({ memUsedMib: acc.memUsedMib + d.memUsedMib, memTotalMib: acc.memTotalMib + d.memTotalMib }),
        { memUsedMib: 0, memTotalMib: 0 },
      );
      return json(200, {
        available: true,
        status: "available",
        devices,
        totals,
        samples: { "gpu.mem_used_mib": { value: 1024, ts: Date.now() - 1_000 } },
      });
    }
    // 事件查询：ts 倒序、limit 默认 20（与真实面板 /api/v1/events 契约一致）。
    // kind 过滤顺手实现，虽然插件当前只用 limit
    if (req.method === "GET" && url.pathname === "/api/v1/events") {
      const limit = Math.max(1, Math.min(100, Number(url.searchParams.get("limit") ?? 20) || 20));
      const kind = url.searchParams.get("kind");
      const events = state.events
        .filter((e) => !kind || e.kind === kind)
        .slice(-limit)
        .reverse();
      return json(200, { events });
    }
    // 事件 SSE 流：连接即发 snapshot（最近 20 条，ts 倒序），此后增量 event 帧，
    // 连接保持打开（真实面板 15s 心跳注释行对客户端解析不可见，这里省略不影响契约）
    if (req.method === "GET" && url.pathname === "/api/v1/events/stream") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const snapshot = state.events.slice(-20).reverse();
      res.write(`data: ${JSON.stringify({ type: "snapshot", events: snapshot })}\n\n`);
      state.eventStreams.add(res);
      state.eventConnections += 1;
      req.on("close", () => {
        state.eventStreams.delete(res);
      });
      return;
    }
    // 面板中转层给 /v1/models 注入的思考强度声明（llamapad lib/proxy-rewrite.ts 的
    // enhanceModelsResponse）。无模型在跑时面板回 503，这里照做
    if (req.method === "GET" && url.pathname === "/api/v1/proxy/llama/v1/models") {
      if (state.multiModel) {
        // 多模型模式：聚合列表按运行集合逐条给出，id = 模型名（面板
        // src/lib/models-list.ts 的契约）——插件按 id 精确匹配到目标模型自己的
        // 声明（A6），不再是"运行中只有一个、随便拿第一条就是它"
        const names = [...state.runtime.keys()];
        if (names.length === 0) return json(503, { error: "没有运行中的模型", hint: "/models" });
        return json(200, {
          object: "list",
          data: names.map((name) => ({
            id: name,
            object: "model",
            supported_parameters: ["reasoning_effort"],
            x_llamapad: {
              reasoning_effort: { supported: true, aliases: {}, ...REASONING_DECLARATIONS[name] },
            },
          })),
        });
      }
      if (!state.running) return json(503, { error: "没有运行中的模型", hint: "/models" });
      return json(200, {
        object: "list",
        data: [{
          id: state.running,
          object: "model",
          supported_parameters: ["reasoning_effort"],
          x_llamapad: {
            reasoning_effort: { supported: true, levels: ["xhigh", "medium", "low"], aliases: {}, rounding: "down" },
          },
        }],
      });
    }
    if (req.method === "GET" && url.pathname === "/api/v1/proxy/llama/health") {
      if (state.multiModel) {
        // 多模型模式下 probeReady 不会回退到这条端点（models[] 的 ready 字段
        // 一直在场），这里只需给个不撒谎的最小实现：只要有任意模型就绪即可
        const anyReady = [...state.runtime.values()].some((info) => Date.now() >= info.readyAt);
        return anyReady ? json(200, { status: "ok" }) : json(503, { status: "loading" });
      }
      return Date.now() >= state.readyAt && state.running ? json(200, { status: "ok" }) : json(503, { status: "loading" });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/proxy/llama/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        state.chatRequests.push(parsed);
        // 多模型模式：只要目标模型在运行集合里就放行，不再要求它恰好是"唯一在
        // 跑的那个"（这正是 P0-2 要验证的——strict 档请求非默认但在跑的模型）
        const notRunning = state.multiModel
          ? !state.runtime.has(parsed.model)
          : parsed.model !== state.running;
        if (notRunning) return json(409, { error: `running=${state.multiModel ? [...state.runtime.keys()].join(",") : state.running}` });
        const frames = [
          `{"choices":[{"delta":{"reasoning_content":"思考"}}]}`,
          `{"choices":[{"delta":{"content":"你好"}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":""}}]}}]}`,
          `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"city\\":\\"北京\\"}"}}]}}]}`,
          `{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
          `{"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":34}}`,
          `[DONE]`,
        ];
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const f of frames) res.write(`data: ${f}\n\n`);
        res.end();
      });
      return;
    }
    json(404, { error: "not found" });
  });
  /**
   * 放行一个挂起中的 start 请求（见文件头「start 挂起」段落）。对定时器挂起
   * （`state.startHoldMs` 给的是有限数）与纯手动挂起（`Infinity`）同样有效——
   * 两者内部都是同一个 `release` 回调，提前调用会先清掉尚未触发的定时器。
   * 目标模型当前没有挂起中的请求时是安全的空操作（不抛错），方便测试在
   * "可能已经自然完成"的场景下无脑调用。
   */
  const releaseStart = (name) => state.startReleasers.get(name)?.();
  return { server, state, releaseStart };
}
