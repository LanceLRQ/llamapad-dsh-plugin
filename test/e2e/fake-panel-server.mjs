import { createServer } from "node:http";

/**
 * llamapad 假面板：实现插件用到的 5 个控制面端点 + llama.cpp 反代（health + chat SSE）。
 * 状态机：start 置 running + readyAt；health 在 readyAt 前回 503。
 */
export function createFakePanel({ loadMs = 100 } = {}) {
  const state = { running: null, readyAt: 0, starts: [], chatRequests: [] };
  const MODELS = [
    { name: "qwen-small", displayName: "Qwen 小", namespace: "main", ggufFile: "main/a.gguf", mmprojFile: null, status: "stopped", quant: "Q4_K_M", sizeBytes: 100, fileCount: 1, hostPort: 18080 },
    { name: "qwen-big", displayName: "Qwen 大", namespace: "main", ggufFile: "main/b.gguf", mmprojFile: null, status: "stopped", quant: "Q8_0", sizeBytes: 200, fileCount: 1, hostPort: 18080 },
  ];
  const server = createServer((req, res) => {
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (!/^Bearer lp_/.test(req.headers.authorization ?? "")) return json(401, { error: "unauthorized" });
    const url = new URL(req.url, "http://localhost");
    if (req.method === "GET" && url.pathname === "/api/v1/models") return json(200, { models: MODELS });
    if (req.method === "GET" && url.pathname === "/api/v1/runtime/status") {
      return json(200, { running: state.running ? { model: state.running, hostPort: 18080 } : null });
    }
    const startMatch = /^\/api\/v1\/models\/([^/]+)\/start$/.exec(url.pathname);
    if (req.method === "POST" && startMatch) {
      const name = decodeURIComponent(startMatch[1]);
      if (!MODELS.some((m) => m.name === name)) return json(404, { error: `模型不存在: ${name}` });
      state.starts.push(name);
      state.running = name;
      state.readyAt = Date.now() + loadMs;
      return json(200, { id: `cid-${state.starts.length}` });
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
