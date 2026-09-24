# llamapad-dsh-plugin 安装指引（给 AI 助手）

[English](../en/ai-install.md) · [返回 README](../../../README.md)

这份文档写给帮用户操作电脑的 AI 助手，例如 Claude Code、Cursor、Codex 这类能执行终端命令的工具。用户把一句话交给你，你照下面的步骤把 llamapad-dsh-plugin 装进用户的 dsh，并配好 llamapad 面板的连接。

人类读者也可以照着手动做，效果一样。

## 执行约定

- 每一步先执行命令，再核对「预期」，和预期不符就按该步的「出错时」处理，处理不了就停下来把输出告诉用户，不要跳步。
- 面板地址和 API token 必须向用户询问，不要猜，也不要从别处搜。
- token 是密钥：不要在回复里回显完整 token，命令输出里出现时用 `***` 代替。
- 修改用户配置文件之前先备份，只改和本插件有关的那一行，其他内容原样保留。
- 用户没要求的可选步骤（挂载管理工具、改默认模型）先问再做。

## 第 0 步：向用户确认三件事

一次问清楚，拿到答案再往下走：

1. **llamapad 面板地址**，例如 `http://192.168.1.10:8080`。面板是 [llamapad](https://github.com/lancelrq/llamapad)，用户需要已经部署好。
2. **面板的 API token**，在面板的「设置」页生成，以 `lp_` 开头。
3. **装进哪个 dsh profile**。不确定就用 `web`，它是 `dsh web` 默认启动的那个。

下文用 `<PANEL_URL>`、`<TOKEN>`、`<PROFILE>` 指代这三个值。面板地址末尾的 `/` 去掉。

## 第 1 步：检查环境

```bash
dsh --version
node --version
```

预期：`dsh` 的版本在 `0.1.5-rc.3` 到 `0.1.7.x` 之间（含预发布版本，例如 `0.1.7-rc.1`）。

出错时：

- 找不到 `dsh` 命令：告诉用户需要先安装 DeepSeek Harness，例如 `npm i -g @deepseek-ai/dsh`，装好后从第 1 步重来。
- 版本低于 0.1.5-rc.3 或高于 0.1.7.x：停下来告诉用户当前版本不在本插件的支持范围内，请用户决定是升级或降级 dsh，还是等插件更新。不要强行安装。

## 第 2 步：确认面板可以访问

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <TOKEN>" <PANEL_URL>/api/v1/models
```

预期：输出 `200`。

出错时：

- `401`：token 不对或已失效，请用户到面板「设置」页重新生成。
- `000` 或超时：这台机器连不上面板。请用户确认地址、端口和网络（面板和 dsh 不在同一台机器时尤其要确认）。
- 其他状态码：把状态码告诉用户，停下。

## 第 3 步：下载最新版安装包

```bash
cd "$(mktemp -d)"
url=$(curl -s https://api.github.com/repos/LanceLRQ/llamapad-dsh-plugin/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*\.tgz"' | cut -d'"' -f4)
echo "$url"
curl -sLO "$url" && curl -sLO "$url.sha256"
shasum -a 256 -c ./*.tgz.sha256 2>/dev/null || sha256sum -c ./*.tgz.sha256
pwd; ls
```

预期：打印出一个以 `.tgz` 结尾的下载地址，校验结果为 `OK`，当前目录里有 `llamapad-dsh-plugin-<版本>.tgz`。记下这个 tgz 的完整路径，下文称为 `<TGZ>`。

出错时：

- `url` 是空的：多半是 GitHub API 被限流或网络不通。可以请用户在浏览器里打开 https://github.com/LanceLRQ/llamapad-dsh-plugin/releases/latest 手动下载 tgz，把文件路径告诉你。
- 校验不是 `OK`：删掉文件重新下载一次，还不对就停下告诉用户。

## 第 4 步：安装到 dsh

```bash
dsh plugin --profile <PROFILE> add <TGZ>
```

预期：最后几行出现 `Done`。出现 `Issues with peer dependencies found` 这样的 WARN 是正常的：插件使用 dsh 自带的框架，不单独安装。

出错时：

- 提示插件与当前 dsh 版本不兼容（incompatible）：回到第 1 步核对版本，不要用 `allow-version` 之类的方式强行放行，除非用户明确同意。
- 这个 profile 之前用 `link:` 方式装过本插件（本地开发时常见）：先删掉旧目录 `rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/node_modules/llamapad-dsh-plugin"`，再重新执行本步。

## 第 5 步：写入连接配置

配置文件是 `${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/cordis.patch.yml`，内容是一个 YAML 列表，每一项是一个插件条目。

先备份：

```bash
f="${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/cordis.patch.yml"
[ -f "$f" ] && cp "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
```

然后编辑这个文件，让它包含下面这一项（文件不存在就新建）：

```yaml
- id: llamapad
  name: llamapad-dsh-plugin
  config:
    panelUrl: <PANEL_URL>
    token: <TOKEN>
```

编辑规则：

- 文件里已经有 `id: llamapad` 的条目：只替换它的 `panelUrl` 和 `token` 两个值，这一项里的其他配置和文件里的其他条目都不动。
- 文件里除注释外只有一行 `[]`：这是 dsh 新建 profile 时生成的空列表。把 `[]` 这一行替换成上面这一项，注释保留。不能直接在 `[]` 后面追加，那样 YAML 会解析失败，dsh 无法启动。
- 文件里有其他条目、但没有 `id: llamapad`：把上面这一项追加到文件末尾。
- 保持 YAML 列表格式，缩进用空格。
- 写完执行 `chmod 600 "$f"`，因为文件里有 token。

## 第 6 步（可选，先问用户）：其他配置

只在用户需要时做，写进同一个文件。

让 dsh 的 agent 默认使用 llamapad 上的某个模型（`<MODEL>` 是面板里的模型配置名，可以从第 2 步那个接口的返回里找 `name` 字段）：

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: llamapad
    model: <MODEL>
```

挂载管理工具，让 agent 能自己查询、启动、停止本地模型。注意这一项必须用 `insert:` 写法，写成普通条目不会生效：

```yaml
- insert:
    - id: llamapad-tools
      name: llamapad-dsh-plugin/tools
      config:
        panelUrl: <PANEL_URL>
        token: <TOKEN>
```

## 第 7 步：验证

```bash
dsh --profile <PROFILE> --dump-config | grep -n -A4 "id: llamapad"
```

预期：能看到 `# == llamapad-dsh-plugin` 这一层，以及 `id: llamapad` 条目下的 `panelUrl`（`token` 的值不要打印到回复里）。

出错时：看不到 `id: llamapad`，通常是改错了 profile 目录，或者 YAML 缩进不对。对照第 5 步检查。

## 完成后告诉用户

用两三句话说明：

- 装好的插件版本、装进的 profile；
- 启动方式：`dsh --profile <PROFILE>`，profile 是 `web` 时直接 `dsh web`；
- 默认只使用面板上已经在运行的模型：先在 llamapad 面板里启动一个模型，再到 dsh 的模型选择器里选它；
- 以后想改面板地址或 token，可以直接在 dsh 里的 llamapad 设置卡片里改。卡片在 dsh 0.1.7 侧栏的「插件」页里，在 0.1.5 的「设置 → 插件 → 插件配置」里。

更多说明见[安装与接入](installation.md)和[配置参考](configuration.md)。

## 升级

以后要升级到新版本，重复第 1、3、4 步即可，第 5 步的配置会保留。
