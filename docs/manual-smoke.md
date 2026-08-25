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

- 未在真实 GPU 环境跑过（Mac 无法运行模型）——usage 计数口径（prompt_tokens 含缓存命中）、
  `reasoning_content` 的实际呈现、切换延迟体验，均归 **llamapad M4 真机联调** 时校准
- 等待切换期间 dsh 界面无进度提示（静默）——设计决策：注入文本会污染会话历史上下文，
  依据见 [调研文档](../research/2026-08-24-dsh-plugin-research.md) §5

## 常见故障

| 现象 | 可能原因（错误码） |
|---|---|
| 启动即报 token 相关错误 | `AUTH`：token 无效/未授权（面板设置页重签） |
| 对话报「面板不可达」 | `PANEL_UNREACHABLE`：`panelUrl` 不通或面板进程挂了 |
| 对话报「模型不存在」 | `MODEL_NOT_FOUND`：cordis.yml 里 `model:` 与面板模型名不一致 |
| 对话报文件缺失 | `MODEL_FILES_MISSING`：面板里该模型的 gguf 文件不在盘上 |
| 长时间无响应后报超时 | `START_TIMEOUT`：模型加载超过 `startTimeoutMs`，调大该配置 |
