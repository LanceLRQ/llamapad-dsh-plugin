# Settings card and monitor page

[中文](../zh/web-ui.md) · [Back to README](../../../README.en.md)

The plugin adds two things to the dsh web UI: a llamapad card on the settings page, and a GPU monitor page in the settings navigation.

## Settings card

Located under dsh's "Settings -> Plugins -> Plugin configuration", alongside the official terminal, agent loop, and web search cards. The card shows up even without `panelUrl` / `token` configured; it just displays "not connected".

The card has:

- Title row: click to collapse or expand; collapsing stops polling the panel.
- "Open panel in browser" button: jumps to the full llamapad panel.
- Running status: when only one model is running, shows a single line indicating whether it's inferring. When multiple are running, shows a running list, each line with the model name, how long it's been loaded, readiness, and either a default marker or a "set as default" button. All "set as default" buttons are disabled while a switch is in progress, to avoid conflicting clicks.
- Model list: a two-column card grid, scrolling within the list past about 4 rows. Becomes a single column when the window is narrower than 520px.
- Start/stop button per model: starting one doesn't stop other running models. While waiting, the button turns into "cancel waiting"; clicking it aborts the request without showing an error.
- Connection settings: panel address, API token, and a save button.
- Recent events: recent operations on the panel, such as model start/stop, unexpected exits, download completion. Failures are shown in red, successes in green. A toast pops up in the bottom right on new events and disappears after about 3 seconds.

### Configuring the connection in the card

Fill in the address and token under "Connection settings" and save; this writes to this plugin's own section in `$DSH_HOME/settings.yaml`, without touching `cordis.yml`. Values here take priority over `cordis.yml` and apply immediately on save, no dsh restart needed.

Leaving the token field blank keeps the existing value, matching how dsh's own password fields behave, so there's no "clear token" action in the card. The panel address can't be left blank; clearing it leaves the card unable to reach the panel at all.

### The token is never exposed to the browser

The card fetches data through an RPC on the dsh backend (`ctx.remote.llamapadPanel.*`), and the backend uses its own stored token to call the panel. The browser never gets the token and never talks to the panel directly, so llamapad doesn't need CORS enabled. See the [settings card design record](../../design/settings-card-design.md) (Chinese) for architecture details.

### Stopping a model that is inferring

The start/stop button uses the `drainOnSwitch` and `drainTimeoutMs` config fields. When stopping a model that's currently inferring, the server waits up to `drainTimeoutMs` (60 seconds by default) to finish in-flight requests, and the button shows a waiting state during that time.

### Cross-machine deployment

`panelUrl` is the address the dsh backend uses to reach the panel, while "open panel in browser" opens in your own browser. When dsh and the browser aren't on the same machine, set `panelPublicUrl` to an address the browser can reach. Single-machine deployments can ignore this.

## GPU monitor page

Placed after the official settings pages in dsh's settings navigation.

The page has six curves: tokens/s, KV cache tokens, GPU VRAM, GPU utilization, container CPU, and container memory. Below that are per-GPU detail cards showing VRAM, utilization, temperature, and power draw. The time range can be switched between 30 minutes, 2 hours, 24 hours, and 7 days.

- The 30-minute and 2-hour ranges refresh every 5 seconds, matching the panel's 5-second sampling. The 24-hour and 7-day ranges refresh every 60 seconds, since the panel aggregates at 15-minute intervals and refreshing faster wouldn't produce new data.
- Each refresh only fetches data points newer than the last fetch. Switching time ranges or leaving the page immediately cancels any in-flight request.
- When nvidia-smi can't report temperature or power, that field is simply omitted, not filled with 0.

Two limitations in multi-model scenarios, both coming from how the panel collects data, which the plugin can't change:

- Container and inference metrics only track the default model. The card header states which model the data comes from. After switching the default model, the curves continue directly with the new model's data, with no boundary marker in between.
- GPU data is a whole-card reading. When multiple models share one card, it can't be split out per model.
