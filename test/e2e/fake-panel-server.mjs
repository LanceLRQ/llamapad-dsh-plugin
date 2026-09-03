import { createServer } from "node:http";

/**
 * llamapad 假面板：实现插件用到的控制面端点 + 事件端点（查询/SSE）+ llama.cpp 反代
 * （health + chat SSE）。状态机：start 置 running + readyAt；health 在 readyAt 前回 503。
 * start/stop 路由会像真实面板一样写 model.* 事件并推给挂着的 SSE 订阅者。
 */
export function createFakePanel({ loadMs = 100 } = {}) {
  const state = {
    running: null, readyAt: 0, starts: [], stops: [], chatRequests: [], busy: null,
    events: [], eventStreams: new Set(), eventConnections: 0,
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
