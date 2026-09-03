import { createServer } from "node:http";

/**
 * llamapad 假面板：实现插件用到的控制面端点 + 事件端点（查询/SSE）+ 监控端点
 * （metrics 窗口 / GPU 快照）+ llama.cpp 反代（health + chat SSE）。状态机：start 置
 * running + readyAt；health 在 readyAt 前回 503。start/stop 路由会像真实面板一样写
 * model.* 事件并推给挂着的 SSE 订阅者。
 */

/** 各窗口时长（毫秒），与真实面板 window.ts 的 RANGE_DEFS 同值——from 计算要用 */
const RANGE_DEFS = { "30m": 30 * 60_000, "2h": 2 * 3_600_000, "24h": 24 * 3_600_000, "7d": 7 * 24 * 3_600_000 };

/** 与真实面板 resolutionForRange 同款：≤2h 走 5s ring、更长走 15min 聚合桶 */
const resolutionForRange = (range) => (range === "30m" || range === "2h" ? "5s" : "15m");

export function createFakePanel({ loadMs = 100 } = {}) {
  const seedNow = Date.now();
  const state = {
    running: null, readyAt: 0, starts: [], stops: [], chatRequests: [], busy: null,
    events: [], eventStreams: new Set(), eventConnections: 0,
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
    { name: "qwen-big", displayName: "Qwen 大", namespace: "main", ggufFile: "main/b.gguf", mmprojFile: null, status: "stopped", quant: "Q8_0", sizeBytes: 200, fileCount: 1, hostPort: 18080 },
  ];
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
      // ready 与下面 /health 的判定同源（都看 readyAt），这样 loadMs 这一个参数就同时
      // 控制两条路径，不会出现「health 说没好、status 说好了」的自相矛盾
      const body = {
        running: state.running
          ? { model: state.running, hostPort: 18080, ready: Date.now() >= state.readyAt }
          : null,
      };
      if (url.searchParams.get("busy") === "1") body.busy = state.busy;
      return json(200, body);
    }
    const startMatch = /^\/api\/v1\/models\/([^/]+)\/start$/.exec(url.pathname);
    if (req.method === "POST" && startMatch) {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const name = decodeURIComponent(startMatch[1]);
        if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
        let drainReq = {};
        try { drainReq = body ? JSON.parse(body) : {}; } catch { drainReq = {}; }
        state.starts.push(name);
        state.running = name;
        state.readyAt = Date.now() + loadMs;
        emitEvent("model.start", `启动 ${name}`);
        const resBody = { id: `cid-${state.starts.length}` };
        if (drainReq.drain !== undefined || drainReq.drainTimeoutMs !== undefined) {
          // reason 必须落在服务端契约的四个值内（idle/timeout/unavailable/skipped）；
          // 假面板没有真实在途推理，对应真机的冷启动场景 → skipped
          resBody.drain = { drained: true, reason: "skipped" };
        }
        return json(200, resBody);
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
        // stopModel 对无容器幂等成功（服务端语义），假面板同样不校验"是不是当前运行的那个"
        state.running = null;
        state.readyAt = 0;
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
      return Date.now() >= state.readyAt && state.running ? json(200, { status: "ok" }) : json(503, { status: "loading" });
    }
    if (req.method === "POST" && url.pathname === "/api/v1/proxy/llama/v1/chat/completions") {
      let body = "";
      req.on("data", (c) => { body += c; });
      req.on("end", () => {
        const parsed = JSON.parse(body);
        state.chatRequests.push(parsed);
        if (parsed.model !== state.running) return json(409, { error: `running=${state.running}` });
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
  return { server, state };
}
