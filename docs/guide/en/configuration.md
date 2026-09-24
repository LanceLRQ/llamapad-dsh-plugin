# Configuration reference

[中文](../zh/configuration.md) · [Back to README](../../../README.en.md)

Config lives under the `config` key of the llamapad entry in the profile's `cordis.patch.yml`; see [Installation and setup](installation.md) for the syntax. The panel address and token can also be filled in directly in the settings card; values saved from the card take priority and apply immediately.

## LLM adapter (`llamapad-dsh-plugin`)

| Field | Default | Description |
|---|---|---|
| `panelUrl` | required | Panel address, e.g. `http://192.168.1.10:8080` |
| `token` | required | Panel API token, starts with `lp_`. Recommended to read it from an env var with `!!js process.env.LLAMAPAD_TOKEN` |
| `panelPublicUrl` | same as `panelUrl` | The panel address reachable from the browser, used by the settings card's "open panel in browser" button. `panelUrl` is the address as seen by the dsh backend, often `127.0.0.1`; configure this separately when dsh and the browser aren't on the same machine |
| `provider` | `llamapad` | The provider name registered in dsh |
| `mode` | `proxy` | Data-plane mode: `proxy` or `direct` |
| `llamaBaseUrl` | — | The llama.cpp address in `direct` mode |
| `chatBehavior` | `strict` | `strict` / `passthrough` / `auto-switch`, see [Chat routing](chat-routing.md) |
| `startTimeoutMs` | `300000` | Timeout waiting for readiness after start, only applies under `auto-switch` |
| `pollIntervalMs` | `2000` | Readiness polling interval, only applies under `auto-switch` |
| `drainOnSwitch` | `true` | Whether to wait for the server to finish in-flight inference requests before starting or stopping. Shared by `auto-switch` and the settings card's start/stop buttons |
| `drainTimeoutMs` | `60000` | Max time to wait for the drain above |
| `requestTimeoutMs` | `30000` | Timeout for a single control-plane request |
| `defaultContextWindow` | — | Fallback context window reported to dsh when the panel can't provide one |
| `statusRefreshMs` | `5000` | Status refresh cadence. In event mode this is the watchdog's check interval; after degrading, it's the polling interval. Set to `0` to disable entirely |
| `hideStoppedModels` | `false` | Only show running models in the picker. Has no effect under `auto-switch` |
| `statusPromptSection` | `true` | Whether to write the local model list into the system prompt, see [Multimodal input and prompt snapshot](multimodal-and-prompt.md) |

Context window length comes from the panel's `GET /api/v1/models/:name/effective`, i.e. the merged effective value of global defaults and per-model overrides. If a model has `docker.args_override` configured, the startup arguments are replaced entirely, and the plugin can't determine the actual context window, so it doesn't report one.

## Management tools (`llamapad-dsh-plugin/tools`)

The tools entry's config is independent from the adapter's; you need to fill in a separate `panelUrl` / `token`. It also has its own field:

| Field | Default | Description |
|---|---|---|
| `toolApproval` | `allow` | When set to `ask`, the start, stop, and set-default tools require user confirmation before running |

## Reasoning effort (reasoning_effort)

`proxy` mode supports reasoning effort. Which levels each model accepts is declared by the panel based on its chat template, and dsh's picker lists them directly. How the value is rewritten or falls back is all handled by the panel's relay layer; picking a level the template doesn't recognize won't error. The panel rounds to the nearest supported level or drops the field.

Level declarations only apply to running models. So a model that isn't started lists the full `minimal / low / medium / high / xhigh / max`, and only shows the levels it actually supports once started.

`direct` mode does not support reasoning effort. This mode bypasses the panel's relay layer, and an out-of-range value gets rejected by the chat template's jinja validation, returning HTTP 500. So under `direct` the plugin doesn't report levels, and passing a reasoning effort value errors explicitly.

The panel's inference relay path `/api/v1/proxy/llama/*` also has a short alias, `/llama-proxy/*`. Config only needs the panel's root address; the plugin appends the path.

## Notes on custom images

The plugin depends on three behaviors of the llama.cpp server: `/health` going from 503 to 200 to signal readiness, the `/slots` endpoint, and the OpenAI-compatible streaming `/v1/chat/completions`. The panel allows swapping in a custom image via `docker.entrypoint`, `args_override`, `extra_args`, `env`, and `model_mount`. If the swapped-in image isn't llama.cpp server, the drain check auto-skips, but readiness probing will wait all the way to the `startTimeoutMs` timeout, and chat requests will 404.

If you hit "start succeeded but readiness never comes", check whether these fields are configured on the panel.
