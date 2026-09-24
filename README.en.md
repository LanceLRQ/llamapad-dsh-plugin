# llamapad-dsh-plugin

[中文](README.md) · English

Connects local llama.cpp models managed by [llamapad](https://github.com/lancelrq/llamapad) to [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (dsh).

Once installed, the panel's models show up in dsh's model picker, and you can chat with them directly. The plugin also ships a set of agent tools (list, start, stop local models), a settings card, and a GPU monitor page in the web UI. llamapad itself needs no changes.

## Features

- Local models work as a dsh provider directly, with streaming output, reasoning effort, and image input
- By default only uses models that are already running; chatting never triggers start/stop, but this can be switched to auto-start
- Supports multiple models running on the panel at once; the picker marks running models with `▶︎` and the default model with `★`
- Panel status updates via events, so the picker reflects model start/stop quickly
- Settings card: view running status, start/stop models, configure the connection directly in the card
- GPU monitor page: throughput, VRAM, utilization, temperature, and other curves
- Management tools: let the agent query, start, and stop local models itself, optionally gated behind human approval

## Let dsh install it for you

Start a new session in dsh and send it the sentence below. It will ask you for the panel address and token, then download, install, and configure the plugin itself; restart dsh afterwards. Any other AI assistant that can run commands can follow the same guide:

```text
Read https://raw.githubusercontent.com/LanceLRQ/llamapad-dsh-plugin/main/docs/guide/en/ai-install.md and follow its steps to install and configure llamapad-dsh-plugin for me.
```

## Quick start

You need: a reachable llamapad panel and its API token, and dsh already installed (version requirements in [Installation and setup](docs/guide/en/installation.md#version-requirements)).

1. Install the plugin:

   ```bash
   dsh plugin --profile <profile> add ./llamapad-dsh-plugin-<version>.tgz
   # or: dsh plugin --profile <profile> add github:LanceLRQ/llamapad-dsh-plugin
   ```

2. Fill in the panel address and token in `$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

   ```yaml
   - id: llamapad
     name: llamapad-dsh-plugin
     config:
       panelUrl: http://192.168.1.10:8080
       token: !!js process.env.LLAMAPAD_TOKEN
   ```

   You can also skip this step and fill it in after starting dsh, in the llamapad card under "Settings -> Plugins -> Plugin configuration".

3. Start `dsh web`, and pick a panel model in the model picker to start chatting.

The default `strict` mode only uses models that are already running. So before your first chat, go start a model on the panel, or click start in the settings card.

## Documentation

| Doc | Content |
|---|---|
| [AI install guide](docs/guide/en/ai-install.md) | Step-by-step install instructions for dsh to run; humans can follow them too |
| [Installation and setup](docs/guide/en/installation.md) | Install, connection config, mounting the management tools, upgrading, version requirements |
| [Configuration reference](docs/guide/en/configuration.md) | All config fields, reasoning effort, notes on custom images |
| [Chat routing and model status](docs/guide/en/chat-routing.md) | The three `chatBehavior` modes, multiple models, picker markers, status refresh |
| [Management tools](docs/guide/en/tools.md) | The 6 agent tools and approval settings |
| [Settings card and monitor page](docs/guide/en/web-ui.md) | The web UI card and the GPU monitor page |
| [Multimodal input and prompt snapshot](docs/guide/en/multimodal-and-prompt.md) | Image input, the local model list in the system prompt, privacy notes |
| [Development and debugging](docs/guide/en/development.md) | Build, local debugging, tests, index of development records |

## Related projects

- [llamapad](https://github.com/lancelrq/llamapad): the llama.cpp model management panel this plugin connects to
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): the plugin's host

## License

[MIT](LICENSE)
