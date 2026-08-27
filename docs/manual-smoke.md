# 手工冒烟手册（dsh Web UI 挂载验证）

> 目的：在真实 dsh Web UI 里验证插件加载、模型选择器出现 llamapad 模型、对话走通、
> 设置卡片正常挂载与派发。自动化 E2E（假面板）已覆盖逻辑正确性；本手册验证「挂载 + 真实链路」。

## 前置

1. **dsh**：两条路都行——
   - **装 CLI**（推荐，实测更省事）：`npm i -g @deepseek-ai/dsh@<版本>`，然后
     `dsh plugin --profile web add /path/to/llamapad-dsh-plugin`（软链装入 web profile），
     配置写进 `$DSH_HOME/profiles/web/cordis.patch.yml`（默认 `~/.dsh`）
   - **克隆源码**：克隆 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
     并完成从源码运行的一次性准备（见其 docs 的 quickstart，`pnpm install` 等）；
     只有这条路能用 `--patch` 直接挂 `src/*.ts` 的绝对路径（安装版 CLI 会静默跳过模块路径行）
2. **llamapad 面板**：已部署并可访问；设置页创建一个 API Token（`lp_` 开头）；面板里至少有一个
   模型配置（文件就绪、可启动）
3. 网络：dsh 所在机器能访问面板地址（`panelUrl`）
4. **版本对齐（关键）**：插件 `package.json` 钉的 `@deepseek-ai/dsh-llm` 必须与宿主 dsh 同代。
   构建把 `@deepseek-ai/*` 全部 external，运行时由 pnpm 按插件自己的钉版落盘——版本落后于宿主时
   会装出第二份框架，宿主拿新接口调旧基类而崩（详见下节「真机冒烟结果」的第 ① 条）

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
   - **默认档（`chatBehavior: strict`，本手册未额外配置时的实际行为）**：聊天路径完全不调
     start/stop。先去 llamapad 面板手动启动这个模型，再在 dsh 发消息——回复应正常流式输出，
     带工具调用的 agent 行为正常，且不会有"冷启动等待"（模型已在跑，请求直接转发）。若选择器里
     选的模型与面板运行中的不一致，或面板当时没有任何模型在跑，插件应**立即报错**而不是等待或
     切换，文案见 `decideRoute()`（如"当前运行的是 X，请求的是 Y……strict 档不会自动切换，请到
     llamapad 面板启动目标模型，或把 chatBehavior 改为 auto-switch"）——这是设计行为，不是 bug
   - **验证冷启动 / 自动切换**：需要在 cordis.yml 里显式加 `chatBehavior: auto-switch` 并重启
     dsh，再重复本步骤：
     - 冷启动：首次响应前会静默等待模型加载（大模型 1-2 分钟以上，受 `startTimeoutMs` 约束，
       默认 300s）——这是物理加载时间，不是插件问题
     - 切换：换选另一个模型再对话，面板里旧容器停止、新容器启动（观察 llamapad 页面可见）
   - **`passthrough` 档**（如需验证）：面板有模型在跑就把请求转发给它，哪怕选择器里选的是别的
     模型名也不会触发切换——回复内容实际来自面板当前运行的那个模型，不代表选择器选中的那个
6. 反向验证（需要 `chatBehavior: auto-switch`）：面板里手动停掉模型，再在 dsh 发消息——插件应
   重新拉起（快路径失效即走完整 ensure）。**默认档（`strict`）与 `passthrough` 档下这一步不成立**：
   面板没有模型在跑时两者都直接报错"当前没有模型在运行，请先到 llamapad 面板启动一个模型……"，
   插件不会替用户按下启动键——同样是设计行为

## 已知边界（截至 A 形态完成时）

- ~~未在真实 GPU 环境跑过~~ **已于 2026-08-25 在 GPU 服务器（RTX 3090，llamapad M4 真机联调环境）完成
  API 层校准**，结果见下节「真机校准结果」。~~dsh Web UI 挂载的端到端冒烟仍待执行~~
  **已于 2026-08-27 完成挂载与派发链路冒烟**，见下节「真机冒烟结果」
- 等待切换期间 dsh 界面无进度提示（静默）——仅 `auto-switch` 档触发 start 时才会有等待；
  `strict`/`passthrough` 档不等待，不满足路由条件时直接报错（见上「步骤」5/6）。静默这一设计
  决策本身：注入文本会污染会话历史上下文，依据见
  [调研文档](../research/2026-08-24-dsh-plugin-research.md) §5


## 真机冒烟结果（2026-08-27，dsh 0.1.1-rc.2 / llamapad v0.1.1-rc / 模型 qwen3-1p7b-q8）

装 CLI 那条路走通：`dsh plugin --profile web add <本仓库>` 软链装入，用户层
`cordis.patch.yml` 同时挂 A、B 两个入口，`dsh --profile web --dump-config` 组合树正确、
`dsh --profile web --no-open` 启动无告警。

| # | 验证 | 结果 |
|---|---|---|
| ① | **版本错位复现** | 宿主 `LlmRuntime` 0.1.1-rc.2 + 旧基类 0.0.1-rc.1 的适配器 → `TypeError: registration.adapter.prepareCall is not a function`。新版 `LlmAdapter` 加了 `prepareCall`，宿主派发路径无条件调用它 |
| ② | 依赖对齐后 `prepareCall` | 通过 |
| ③ | `listProviders` / `listModels` | `llamapad` 已注册；列出面板 10 个模型 |
| ④ | **完整对话（`adapterStream`）** | 冷启动首字 10.5s（含模型加载）、总耗时 14.4s；84 个 `text-delta`，`block-start`/`block-end` 各 1、`usage` 1、`finish` 1；`finish.kind = stop`；`usage = {inputTokens:14, outputTokens:89}`；正文正常 |
| ⑤ | B 形态 4 个工具注册 | `llamapad_status` / `llamapad_list_models` / `llamapad_start_model` / `llamapad_stop_model` |
| ⑥ | **工具经真实 `ToolRuntime` 调用** | status（运行中·空闲）→ list（10 个）→ stop 带排空（`排空：idle`）→ status（无模型）→ 再次 stop（`stopped:false` 不报错）→ start `waitReady:false` → status（运行中）。全程 `isError=false`，**输出通过框架的 `output.schema` 真校验**（无 `INVALID_TOOL_OUTPUT`） |

挂载写法有一处坑：B 入口没被任何 bundle 层声明过，用户层必须用 `insert:` 追加，
照抄 A 形态的「按 id 覆盖」写法会得到 `patch: entry "llamapad-tools" not found` 并
**静默不注册**。模板见 `examples/profile-patch.example.yml`。

## 设置卡片冒烟（2026-08-27，dsh 0.1.1-rc.2）

验证第三个入口（`./client`，浏览器端设置卡片）挂载与派发链路。设计与架构见
[设置卡片设计记录](design/settings-card-design.md)。

**前置**：`pnpm run build`——**必须**执行，`package.json` 一旦声明 `dsh.client`，
宿主找不到 `dist/client.js` 会让整个插件（连 A 形态一起）加载失败（见 README 文首提示）。

**启动**：

```bash
cd /root/.dsh/profiles/web
LLAMAPAD_TOKEN=lp_xxxxxxxxx nohup dsh --profile web > /tmp/dsh-web.log 2>&1 &
```

dsh 监听 `http://127.0.0.1:3080`。

**不开浏览器也能验的三条**（用 `curl --noproxy '*'`）：

1. 产物被宿主路由：

   ```bash
   curl -s --noproxy '*' -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:3080/plugins/llamapad-dsh-plugin/client.js
   curl -s --noproxy '*' -I http://127.0.0.1:3080/plugins/llamapad-dsh-plugin/client.js | grep -i content-type
   ```

   应 200，`content-type: text/javascript`（实测 `text/javascript; charset=utf-8`）。

2. 进了 boot 图：

   ```bash
   curl -s --noproxy '*' http://127.0.0.1:3080/ | grep -o '"id":"llamapad-dsh-plugin"'
   ```

   `/` 的 HTML 里 `__DSH_BOOT__` 的 entries 应含 `"id":"llamapad-dsh-plugin"` 这一条，能匹配到即算通过。

3. host RPC 通：

   ```bash
   RPCID=$(cat /proc/sys/kernel/random/uuid)
   curl -s --noproxy '*' -X POST http://127.0.0.1:3080/api/llamapadPanel/snapshot \
     -H 'content-type: application/json' \
     -d "{\"type\":\"client-request\",\"rpcId\":\"$RPCID\",\"method\":\"llamapadPanel/snapshot\",\"payload\":{\"args\":{}}}"
   ```

   应返回 `{"type":"server-response","rpcId":"<同一个>","result":{"ok":true,"value":{...CardSnapshot...}}}`。
   用无效 token 时 `panelError` 应是「llamapad token 无效或未授权，请检查插件配置里的 token」——
   实测确认，这条同时验证了错误路径（面板不可达/鉴权失败不抛错，塞进 `panelError` 由卡片显示）。

**浏览器验证**：dsh 开屏有一层「内测声明」引导弹层，遮罩会拦截点击，先点「继续」关掉；再点
侧栏「设置」→「插件」→「插件配置」，卡片在官方三张卡（终端 / Agent 循环 / 网页搜索）下方。

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
| 对话报「当前没有模型在运行」/「strict 档不会自动切换」 | `MODEL_NOT_RUNNING`：默认 `strict`（或 `passthrough`）档下，运行中模型与请求不一致，或面板未启动任何模型——设计行为，不是插件故障；去面板操作，或按需把 `chatBehavior` 改为 `auto-switch` |
