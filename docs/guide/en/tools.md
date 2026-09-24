# Management tools

[中文](../zh/tools.md) · [Back to README](../../../README.en.md)

`llamapad-dsh-plugin/tools` is a separate plugin entry that gives dsh's agent a set of tools to view and start/stop local models. Any agent can call these tools, regardless of whether it's backed by a local or a cloud model. See [Installation and setup](installation.md#optional-mount-the-management-tools) for how to mount it.

It shares the same panel client and the same start/stop lock as the LLM adapter (keyed by `panelUrl`), so the two entries never end up with one starting a model while the other stops it.

## Tool list

| Tool | Parameters | What it does |
|---|---|---|
| `llamapad_status` | none | Whether the panel is reachable, lists all running models, whether each is ready, and which is the default. Only probes whether the default model is busy; when that can't be probed, it's omitted rather than being misreported as "idle" |
| `llamapad_list_models` | none | Lists all model configs by name, up to 100 entries; `total` and `truncated` indicate whether it was cut off |
| `llamapad_events` | `limit`, `kind`, both optional | Queries the panel's event log, useful for troubleshooting things like "why did the model stop". `limit` defaults to 20, max 100; `kind` filters by exact type, e.g. `model.exit` for only container exits |
| `llamapad_start_model` | `model` required; `waitReady`, `drain`, `timeoutMs` optional | Starts a model. Older panels stop the old one before starting the new one; multi-model panels only guarantee the target is running, without affecting other models. `drain` is on by default, so it doesn't interrupt an in-flight conversation. With `waitReady:false`, a timeout on the start request itself (common on the panel's first image pull, see `startRequestTimeoutMs` in the configuration reference) doesn't count as a failed call — it still returns `started:true` |
| `llamapad_stop_model` | `model`, `drain`, `drainTimeoutMs`, all optional | Stops the given model; without `model` it stops the default. If the target isn't running, it returns `stopped:false` rather than stopping some other model instead |
| `llamapad_set_default_model` | `model` required | Switches the panel's default model. The target must already be running, otherwise the panel returns 409. Older panels report that a multi-model version is required |

Deleting models or files, editing config, and managing downloads are not exposed as tools. These are high-risk operations, better left in the panel for a human to confirm.

When a tool errors, it throws directly; dsh converts it into an error message the model can read.

## Concurrency and presentation

Except for `llamapad_set_default_model`, the other five tools declare `isConcurrencySafe`, so dsh can batch them into the same parallel call. The query tools are read-only by nature, and start/stop are serialized through the shared lock. Setting the default model changes the global routing target, so it doesn't participate in parallel calls.

In the UI, `llamapad_status` renders as a terminal card, with exit code 1 when the panel is unreachable. `llamapad_events` also uses a terminal card, one line per event as `[time] kind description`, most recent first. The call cards for start, stop, and set-default carry an `execute` marker, flagging that they change panel state.

## Approval: toolApproval

With `toolApproval` set to `ask`, dsh pops a confirmation before the agent can call the start, stop, or set-default tools. If the host has no approval channel available, the framework treats `ask` as a denial, and won't run the tool without confirmation.

Recommended when multiple people share a GPU, since these operations affect other people's sessions.
