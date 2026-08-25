# 手工冒烟手册（dsh Web UI 挂载验证）

> 目的：在真实 dsh Web UI 里验证插件加载、模型选择器出现 llamapad 模型、对话走通。
> 自动化 E2E（假面板）已覆盖逻辑正确性；本手册验证「挂载 + 真实链路」。

## 前置

1. **dsh 仓库**：克隆 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
   并完成从源码运行的一次性准备（见其 docs 的 quickstart，`pnpm install` 等）
2. **llamapad 面板**：已部署并可访问；设置页创建一个 API Token（`lp_` 开头）；面板里至少有一个
   模型配置（文件就绪、可启动）
3. 网络：dsh 所在机器能访问面板地址（`panelUrl`）

## 步骤

1. 复制 `examples/cordis.yml`，改两处：
   - `name:` 改为本仓库 `src/index.ts` 的**绝对路径**
   - `panelUrl:` 改为面板实际地址；`agent-loop` 里的 `model:` 改为面板里实际存在的模型名
2. 在 dsh 仓库根目录启动：

   ```bash
   LLAMAPAD_TOKEN=lp_xxxxxxxxx pnpm dsh web --patch /path/to/llamapad-dsh-plugin/examples/cordis.yml
   ```

3. 打开 `http://127.0.0.1:3080`
4. 在模型选择器里应能看到 llamapad 的模型（显示名 = 面板 displayName，描述带命名空间与量化）
5. 选一个模型发起对话：
   - **冷启动**：首次响应前会静默等待模型加载（大模型 1-2 分钟以上，受 `startTimeoutMs` 约束，
     默认 300s）——这是物理加载时间，不是插件问题
   - **切换**：换选另一个模型再对话，面板里旧容器停止、新容器启动（观察 llamapad 页面可见）
   - 回复应正常流式输出；带工具调用的 agent 行为正常
6. 反向验证：面板里手动停掉模型，再在 dsh 发消息——插件应重新拉起（快路径失效即走完整 ensure）

## 已知边界（截至 A 形态完成时）

- ~~未在真实 GPU 环境跑过~~ **已于 2026-08-25 在 GPU 服务器（RTX 3090，llamapad M4 真机联调环境）完成
  API 层校准**，结果见下节「真机校准结果」。dsh Web UI 挂载的端到端冒烟（本手册步骤 1-6）仍待执行
- 等待切换期间 dsh 界面无进度提示（静默）——设计决策：注入文本会污染会话历史上下文，
  依据见 [调研文档](../research/2026-08-24-dsh-plugin-research.md) §5


## 真机校准结果（2026-08-25，llamapad v0.1.0-rc / RTX 3090 / Qwen3.6-35B-A3B）

用 `lp_` token 直接打面板 API 复现插件的调用链，校准 A 形态遗留的三项：

**控制面**（`PanelClient` 的 5 个方法 + 就绪探测，全部 Bearer 鉴权）：

| 端点 | 结果 |
|---|---|
| `GET /api/v1/models` | 200，字段与 `PanelModelView` 一致（name/displayName/namespace/quant/sizeBytes/hostPort/status） |
| `GET /api/v1/models/:name` | 200 |
| `GET /api/v1/runtime/status` | 200，`{running:{model,displayName,hostPort}}` 与 `PanelRuntimeStatus` 一致 |
| `POST /api/v1/models/:name/start` | 200；不存在的模型 → **404**（与 `codeFor` 的 MODEL_NOT_FOUND 映射一致） |
| `GET /api/v1/proxy/llama/health` | 见下「就绪探测」 |
| 无 token 访问 | **401**（与 AUTH 映射一致） |

**就绪探测语义（关键，此前未验证）**：模型加载中 `/api/v1/proxy/llama/health` 返回 **503** 而非 200，
`llamaHealth()` 的 `res.ok` 为 false → 正确继续轮询；就绪后转 200，且**此时立即发推理请求即成功**
（不早报）。27B 冷启动实测 **t+40s** 转 200，远低于 `startTimeoutMs` 默认 300s。

注意两种启动路径的耗时分布不同，插件均能正确处理：
- **冷启动**：`startModel()` 快速返回 → health 503 → 轮询至 200（27B 实测 40s）
- **热启动**（模型文件在 page cache）：`startModel()` 内部阻塞至就绪才返回（35B 实测约 31s）→ 返回后 health 立即 200

**校准项①usage 计数**：需请求带 `stream_options.include_usage`。末帧 usage 形如
`{"completion_tokens":1032,"prompt_tokens":21,"total_tokens":1053,"prompt_tokens_details":{"cached_tokens":0}}`
——`prompt_tokens_details.cached_tokens` 确实存在，口径疑问可关闭。

**校准项②reasoning_content**：`translate.ts` 的处理**正确无需改动**。实测一次带思考的对话：
779 帧 `delta.reasoning_content` → 249 帧 `delta.content`，切换点清晰，插件会先开 reasoning 块再开 text 块。

⚠️ 两个使用注意：
1. **是否产生 `reasoning_content` 取决于 llamapad 侧模型配置的 `enable_thinking`**（llamapad M4 已改为经容器
   env `LLAMA_CHAT_TEMPLATE_KWARGS` 注入，`--reasoning-format none` 被证伪不等价）。关掉思考则无 reasoning 块。
2. **`max_tokens` 给小了会全是 reasoning 没有 content**——实测 `max_tokens:300` 时思考未结束即截断，
   300 帧全为 reasoning_content、content 帧数为 0。dsh 侧配置 max tokens 时需给思考留出预算。

**校准项③切换延迟**：见上「就绪探测」。默认 `startTimeoutMs: 300000` 对 27B/35B 级别模型有充足余量。

**依赖的 llamapad 修复**：proxy 模式依赖 llamapad M4 的缺陷 #3 修复（`PANEL_LLAMA_HOST`，
面板容器内 127.0.0.1 不通向兄弟容器发布端口）。llamapad 早于该修复的版本，容器化部署下 proxy 模式不可用。


## 常见故障

| 现象 | 可能原因（错误码） |
|---|---|
| 启动即报 token 相关错误 | `AUTH`：token 无效/未授权（面板设置页重签） |
| 对话报「面板不可达」 | `PANEL_UNREACHABLE`：`panelUrl` 不通或面板进程挂了 |
| 对话报「模型不存在」 | `MODEL_NOT_FOUND`：cordis.yml 里 `model:` 与面板模型名不一致 |
| 对话报文件缺失 | `MODEL_FILES_MISSING`：面板里该模型的 gguf 文件不在盘上 |
| 长时间无响应后报超时 | `START_TIMEOUT`：模型加载超过 `startTimeoutMs`，调大该配置 |
