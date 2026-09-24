# Development and debugging

[中文](../zh/development.md) · [Back to README](../../../README.en.md)

## Common commands

```bash
pnpm install
pnpm run build       # esbuild bundles src/ into dist/{index,tools,client}.js
pnpm test            # unit tests
pnpm run test:e2e    # fake-panel E2E, no real llamapad or GPU needed
pnpm run typecheck
pnpm run release     # check -> test -> bump version -> build -> produce tgz
```

The package manager is pnpm; `pnpm-lock.yaml` is committed to the repo.

## The package's three entry points

| Entry | Output | Purpose |
|---|---|---|
| `llamapad-dsh-plugin` | `dist/index.js` | LLM adapter, mounted automatically with the bundle |
| `llamapad-dsh-plugin/tools` | `dist/tools.js` | Management tools, needs a manual `insert:` |
| `llamapad-dsh-plugin/client` | `dist/client.js` | Browser-side settings card and monitor page, loaded together with the adapter, no separate config needed |

## Build before starting dsh

`dist/` is not committed to the repo. `package.json` declares `dsh.client`, and when the host can't find `dist/client.js`, the whole plugin fails to load, including the LLM adapter, not just the card.

Installing via tgz or git triggers the `prepare` hook to build automatically. When debugging with a `link:` symlink or running from source directly, run `pnpm run build` once before starting dsh, and again after every code change.

## Local debugging

### Recommended: install into the web profile

```bash
# One-time only: install this repo as a link: dependency into the web profile (dsh web uses it by default)
dsh plugin --profile web add /absolute/path/llamapad-dsh-plugin
# Config goes in ~/.dsh/profiles/web/cordis.patch.yml, template at examples/profile-patch.example.yml
dsh web        # http://127.0.0.1:3080
```

Since it's a symlink, after this every change only needs `pnpm run build` and a dsh restart, no need to re-add.

Two gotchas we actually ran into:

- The `--patch` flag of an installed dsh (via npx or global install) doesn't resolve module paths. `./src/index.ts`, `./dist/index.js`, or an absolute path are all silently ignored: no error, and the service starts normally. So don't use `dsh web --patch examples/dev.yml` for debugging that way. Check whether the plugin loaded by looking for `[llamapad-dsh-plugin]` in the startup log.
- Re-adding a tgz at the same version doesn't refresh it, since pnpm caches by path. Using a directory link avoids this problem.

### Mounting TS source directly in the dsh source repo

If you're running from the [deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) source, its dev loader can load TS directly:

```bash
pnpm dsh web --patch /absolute/path/examples/dev.example.yml
```

Template at [examples/dev.example.yml](../../../examples/dev.example.yml). A local private copy, `examples/dev.yml`, is already in gitignore.

### Running tests only

When changing adapter logic, the fastest way to verify is `pnpm test` plus `pnpm run test:e2e`. E2E uses a fake panel written in Node, with no dependency on dsh or a real environment.

## Packaging and release

Versioning strategy, the `release` script's steps, and the browser-side build constraints are all documented in [docs/packaging.md](../../packaging.md) (Chinese).

## Development records

These are the design drafts and implementation plans from development; they are only available in Chinese:

- [dsh plugin research](../../research/2026-08-24-dsh-plugin-research.md): dsh contract details and UX trade-off rationale
- [LLM adapter implementation plan](../../plans/2026-08-24-a-form-adapter.md)
- [Chat routing and lifecycle decoupling](../../design/chat-vs-lifecycle-decoupling.md)
- [Settings card design record](../../design/settings-card-design.md)
- [Management tools design draft](../../design/b-form-tools-design.md)
- [Multimodal, monitoring, events, prompt snapshot design](../../design/2026-09-03-multimodal-monitor-events-prompt.md), and its five milestone plans: [M1](../../plans/2026-09-03-m1-quick-wins.md), [M2](../../plans/2026-09-03-m2-multimodal.md), [M3](../../plans/2026-09-03-m3-events.md), [M4](../../plans/2026-09-03-m4-monitor.md), [M5](../../plans/2026-09-03-m5-fleet-prompt.md)
- [Multi-model parallel adaptation plan](../../plans/2026-09-21-multi-model-adapt.md)
- [Manual smoke test handbook](../../manual-smoke.md)
