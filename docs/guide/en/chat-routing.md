# Chat routing and model status

[中文](../zh/chat-routing.md) · [Back to README](../../../README.en.md)

## How the plugin talks to the panel

There are two channels between the plugin and the panel.

- Control plane: listing models, start/stop, status, readiness probing. These go through llamapad's REST API, with `Authorization: Bearer lp_xxx` on each request.
- Data plane: the SSE streaming output of `/v1/chat/completions`, in two modes:
  - `proxy` (default): relayed through the panel. Use this when dsh and the GPU server aren't on the same network, since llama.cpp's port doesn't need to be exposed.
  - `direct`: connects to llama.cpp directly, suited to same-machine deployments where you want to shave off a hop of latency. The cost is losing reasoning effort support, see [Configuration reference](configuration.md#reasoning-effort-reasoning_effort).

The plugin doesn't modify anything in llamapad; it only calls the endpoints llamapad exposes.

## Multiple models running at once

Newer panels allow running multiple models at once (the panel's `feature/multi-model` branch, not yet merged into main; this plugin adapted to it ahead of time). On such a panel:

- `running` in `runtime/status` means the default model, the one that gets requests without a model name;
- the actual set of running models is listed in `models[]`.

Older panels don't have the `models[]` field; the plugin treats the single running model as the default, and behavior stays as before.

## chatBehavior: does selecting a model trigger start/stop

When you select a model in dsh and send a message, how the plugin handles it depends on `chatBehavior`.

| Mode | Target model running | Target model not running | Suited for |
|---|---|---|---|
| `strict` (default) | Send directly | Error, prompting you to start it on the panel | Multiple people sharing a GPU, multiple concurrent sessions |
| `passthrough` | Send directly | Redirect to the panel's default model; error if there's no default | Just connecting to whatever service is currently up |
| `auto-switch` | Send directly | Auto-start it, send once ready | One person with sole use of the GPU |

A few more notes:

- Under `strict`, the chat path never calls start. An in-flight conversation won't be interrupted by someone else switching models. The target model works as long as it's in the running set; it doesn't need to be the default.
- `auto-switch` only guarantees the target model is running; it never stops other models to make room. The plugin only handles connection and scheduling, not managing server-side resources for you. If VRAM runs out, start fails, and the error message lists which models are still holding VRAM, and you need to stop them manually on the panel.
- Before starting, the plugin waits by default for the server to finish in-flight inference requests (`drainOnSwitch`, up to `drainTimeoutMs`).
- The plugin holds an internal serial lock; concurrent requests to start the same model get merged into a single start, avoiding repeated start/stop cycles.
- No prompt text is injected into the conversation while waiting for a model to become ready, since that would pollute the history. See [research doc](../../research/2026-08-24-dsh-plugin-research.md) (Chinese) §5.

## Switching the default model

The target model must already be running. Two entry points:

- The `llamapad_set_default_model` management tool, see [Management tools](tools.md)
- The "set as default" button in the settings card's running list, see [Settings card and monitor page](web-ui.md)

Older panels don't support this operation; the plugin will tell you a multi-model panel is required.

## Markers in the model picker

- `▶︎` means the model is running. This intentionally includes the U+FE0E variation selector, to keep some systems from rendering it as a colored emoji.
- `★` means the default model; the description text also appends "default (requests without a model name go here)". Both markers can appear together, e.g. `▶︎ ★ qwen3-8b`.
- If a model is configured but its file is missing (`missing-file` / `missing-mmproj`), a note is appended to the description. Such a model is guaranteed to return 422 on start, so flagging it up front saves you a wasted attempt.

With `hideStoppedModels` on, the picker only shows running models. `auto-switch` ignores this setting and logs a warning, because that mode relies on selecting a not-yet-started model to trigger the start. Hiding those models would make the mode useless.

## How status stays current

The plugin keeps a persistent SSE connection open on the dsh backend, subscribed to the panel's `/api/v1/events/stream`. When a `model.*` event arrives (start, stop, unexpected exit), the plugin immediately checks running status once. Only if the running set actually changed does it notify dsh to re-pull the model directory. The browser side never polls.

Two fallbacks:

- After 3 consecutive SSE connection failures, it falls back to periodic polling, and switches back to event mode automatically once the panel recovers.
- If the connection drops silently without an error, a watchdog checks the latest event id on the `statusRefreshMs` cadence, and reconnects to catch up if it's behind.

`statusRefreshMs: 0` disables this entirely, including the SSE connection. With it off, the markers in the picker stay frozen at whatever state they were in when the plugin started.
