# llamapad-dsh-plugin

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的 LLM 适配器插件：
把 [llamapad](https://github.com/LanceLRQ/llamapad) 管理的本地 llama.cpp 模型接入 dsh——在 dsh 的
模型选择器里按名字选用，插件自动完成「停旧起新 → 等待就绪 → 转发推理流量」，llamapad 侧零改动。

**状态：规划完成，实施中。** 计划见 [docs/plans/2026-08-24-a-form-adapter.md](docs/plans/2026-08-24-a-form-adapter.md)。

## 工作方式

- **控制面**（列模型 / 启停 / 状态 / 就绪探测）：llamapad REST API（`Authorization: Bearer lp_xxx`）
- **数据面**（`/v1/chat/completions` SSE）双模式：
  - `proxy`（默认）：走 llamapad 面板反代——dsh 与 GPU 服务器不在同一网络时，llama.cpp 端口无需暴露
  - `direct`：同机低延迟场景直连 llama.cpp
- 切换由 llamapad 的单模型语义承担（start 自带停旧起新）；插件内串行门 + 同目标合流避免并发抖动
- 切换等待期**静默**（不往对话注入提示文本——那会污染历史上下文，见
  [调研文档](docs/research/2026-08-24-dsh-plugin-research.md) §5）

## 配置

| 字段 | 默认 | 说明 |
|---|---|---|
| `panelUrl` | 必填 | llamapad 面板地址，如 `http://192.168.1.10:8080` |
| `token` | 必填 | llamapad API token（`lp_` 开头；用 `!!js process.env.LLAMAPAD_TOKEN` 注入） |
| `provider` | `llamapad` | provider 路由名 |
| `mode` | `proxy` | `proxy` / `direct` |
| `llamaBaseUrl` | — | direct 模式的 llama.cpp 基地址 |
| `startTimeoutMs` | `300000` | 切换后等待就绪超时（大模型加载要 1-2 分钟以上） |
| `pollIntervalMs` | `2000` | 就绪探测间隔 |
| `requestTimeoutMs` | `30000` | 面板控制面单请求超时 |
| `defaultContextWindow` | — | 模型未配置 ctx_size 时的兜底 |

挂载示例见 [examples/cordis.yml](examples/cordis.yml)（待 Task 6 落地）。

## 开发

```bash
npm install   # 需代理时先 export HTTP_PROXY/HTTPS_PROXY=http://127.0.0.1:20171
npm test              # 单元测试
npm run test:e2e      # 假面板 E2E（无需真实 llamapad / GPU）
npm run typecheck
```

## 文档索引

- [A 形态实施计划](docs/plans/2026-08-24-a-form-adapter.md)
- [dsh 插件调研归档](docs/research/2026-08-24-dsh-plugin-research.md)（契约细节 + UX 评估依据）
- [B 形态（管理工具插件）设计稿](docs/design/b-form-tools-design.md)（暂不实现）
