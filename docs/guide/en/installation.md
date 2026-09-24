# Installation and setup

[中文](../zh/installation.md) · [Back to README](../../../README.en.md)

This package is a standard [dsh bundle](https://github.com/deepseek-ai/deepseek-harness/blob/main/docs/user/develop/basic/publish.md). Once installed into a dsh profile, the plugin entry is automatically layered into the config; you only need to fill in the panel address and token.

Before you start, get two things ready:

- A reachable [llamapad](https://github.com/lancelrq/llamapad) panel, and an API token generated in the panel (starts with `lp_`)
- DeepSeek Harness (dsh) already installed, at a version matching this package's pinned dependencies (see "Version requirements" below)

## Step 1: install the plugin

Installing from a tgz is the easiest path, no local build needed:

```bash
dsh plugin --profile <profile> add ./llamapad-dsh-plugin-<version>.tgz
```

The tgz can be downloaded from a GitHub Release, or built yourself in this repo (see [Development and debugging](development.md)).

You can also install directly from GitHub or a local directory:

```bash
dsh plugin --profile <profile> add github:LanceLRQ/llamapad-dsh-plugin
```

This installs from source, and pnpm runs the `prepare` script to build it on the spot. Since pnpm 10, build scripts of dependencies are not run by default; dsh will prompt you to add the package name to the profile's `pnpm-workspace.yaml`, then re-run:

```yaml
allowBuilds:
  llamapad-dsh-plugin: true
```

## Step 2: fill in connection info

The bundle layer only registers the plugin entry, with no config attached. Edit the `cordis.patch.yml` in the profile directory (path: `$DSH_HOME/profiles/<profile>/cordis.patch.yml`), overriding the llamapad entry by id:

```yaml
- id: llamapad
  name: llamapad-dsh-plugin
  config:
    panelUrl: http://192.168.1.10:8080
    token: !!js process.env.LLAMAPAD_TOKEN
```

The full template is at [examples/profile-patch.example.yml](../../../examples/profile-patch.example.yml); all config fields are in the [Configuration reference](configuration.md).

You can also skip this step for now. Without connection info, dsh starts normally and the llamapad card on the settings page shows "not connected"; fill in the address and token at the bottom of the card and save, no restart needed. See [Settings card and monitor page](web-ui.md).

## Optional: make the agent default to a local model

In the same file, override the `agent-default-model` entry as well:

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: llamapad
    model: <model name in the panel>
```

## Optional: mount the management tools

The management tools (`llamapad-dsh-plugin/tools`) are not mounted by default. Add this to the same file when needed:

```yaml
- insert:
    - id: llamapad-tools
      name: llamapad-dsh-plugin/tools
      config:
        panelUrl: http://192.168.1.10:8080
        token: !!js process.env.LLAMAPAD_TOKEN
```

This must be written as `insert:`. "Override by id" only works on entries that already exist in the composition tree, and the bundle layer never declares a tools entry. If you write it as an override, dsh reports `patch: entry "llamapad-tools" not found` and registers no tools at all, with no other hint.

If the tools entry has no `panelUrl`/`token` configured, it just logs a warning and skips registration; after filling in the config, restart dsh. See [Management tools](tools.md) for the tool list.

## Step 3: verify

```bash
dsh --profile <profile> --dump-config   # should show the "# == llamapad-dsh-plugin" layer and the llamapad entry
dsh web                                 # panel models show up in the model picker
```

If models don't show up, the two usual causes are: the user layer entry is missing `id: llamapad`, or you edited the wrong profile directory.

## Upgrading

For an already-installed profile, re-running `add` with the new tgz overwrites it:

```bash
dsh plugin --profile <profile> add ./llamapad-dsh-plugin-<new-version>.tgz
```

For a git install, pinning to a commit is recommended to avoid upstream changes:

```bash
dsh plugin --profile <profile> add github:LanceLRQ/llamapad-dsh-plugin#<commit>
```

One gotcha: re-`add`ing a tgz with the same version and filename does not refresh it, because pnpm caches by path. Rename the file if you need it to refresh.

## Version requirements

This package pins exact versions of the `@deepseek-ai/*` dependencies, and they must match the host dsh's generation. These dependencies are all external at build time, and installed at their pinned versions by pnpm at runtime. If this package's pinned versions are older than the host's, two copies of the framework end up coexisting, and the host calls the new interface against the old base class, which fails outright. We actually hit this: `dsh-llm` 0.1.x's runtime calls `adapter.prepareCall` on every conversation, but the `LlmAdapter` base class in 0.0.1-rc.1 has no such method.

The currently pinned version is 0.1.1-rc.2, covering `dsh-llm`, `dsh-tools`, `dsh-attachment`, and `dsh-system-prompt`.

## Upgrade note: default chat behavior is now strict

`chatBehavior` now defaults to `strict`: chat only uses models that are already running, and never auto-starts or stops containers. Earlier versions behaved as "switch to whichever model you pick"; if you rely on that behavior, set `chatBehavior: auto-switch` explicitly in your config. See [Chat routing and model status](chat-routing.md) for the differences between the three modes.
