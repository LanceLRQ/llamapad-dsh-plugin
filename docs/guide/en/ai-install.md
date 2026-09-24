# llamapad-dsh-plugin install guide (for dsh to run)

[中文](../zh/ai-install.md) · [Back to README](../../../README.en.md)

This guide is written for dsh (DeepSeek Harness) itself: the user hands you one sentence in a dsh session, and you use your terminal tool to follow the steps below, installing llamapad-dsh-plugin into the user's dsh and connecting it to their llamapad panel. Any other AI assistant that can run terminal commands can follow it too.

A human can follow it by hand too, with the same result.

## Ground rules

- For each step, run the commands, then check the "Expected" result. If it doesn't match, follow that step's "If it fails" notes. If you can't resolve it, stop and show the user the output. Don't skip steps.
- Ask the user for the panel address and API token. Don't guess them or look them up elsewhere.
- The token is a secret: never echo the full token in your replies; replace it with `***` when it shows up in command output.
- Back up the user's config file before changing it, and only change the entry that belongs to this plugin. Leave everything else as it is.
- Ask before doing any optional step the user didn't request (mounting the management tools, changing the default model).

## Step 0: confirm three things with the user

Ask all three at once and wait for the answers:

1. **The llamapad panel address**, e.g. `http://192.168.1.10:8080`. The panel is [llamapad](https://github.com/lancelrq/llamapad); the user needs to have it deployed already.
2. **The panel's API token**, generated on the panel's Settings page. It starts with `lp_`.
3. **Which dsh profile to install into.** If unsure, use `web`, the profile `dsh web` starts by default.

Below, these are `<PANEL_URL>`, `<TOKEN>`, and `<PROFILE>`. Drop any trailing `/` from the panel address.

## Step 1: check the environment

```bash
dsh --version
node --version
```

Expected: the `dsh` version is between `0.1.5-rc.3` and `0.1.7.x`, prereleases included (e.g. `0.1.7-rc.1`).

If it fails:

- `dsh` isn't found: tell the user they need to install DeepSeek Harness first, e.g. `npm i -g @deepseek-ai/dsh`, then start over from step 1.
- The version is below 0.1.5-rc.3 or above 0.1.7.x: stop and tell the user this dsh version is outside the plugin's supported range. Let them decide whether to upgrade or downgrade dsh, or wait for a plugin update. Don't force the install.

## Step 2: make sure the panel is reachable

```bash
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer <TOKEN>" <PANEL_URL>/api/v1/models
```

Expected: prints `200`.

If it fails:

- `401`: the token is wrong or expired. Ask the user to generate a new one on the panel's Settings page.
- `000` or a timeout: this machine can't reach the panel. Ask the user to check the address, port, and network, especially when the panel and dsh run on different machines.
- Any other status: tell the user the status code and stop.

## Step 3: download the latest package

```bash
cd "$(mktemp -d)"
url=$(curl -s https://api.github.com/repos/LanceLRQ/llamapad-dsh-plugin/releases/latest \
  | grep -o '"browser_download_url": *"[^"]*\.tgz"' | cut -d'"' -f4)
echo "$url"
curl -sLO "$url" && curl -sLO "$url.sha256"
shasum -a 256 -c ./*.tgz.sha256 2>/dev/null || sha256sum -c ./*.tgz.sha256
pwd; ls
```

Expected: prints a download URL ending in `.tgz`, the checksum reports `OK`, and the current directory contains `llamapad-dsh-plugin-<version>.tgz`. Note the full path of that tgz; it's `<TGZ>` below.

If it fails:

- `url` is empty: usually the GitHub API is rate-limited or the network is down. Ask the user to open https://github.com/LanceLRQ/llamapad-dsh-plugin/releases/latest in a browser, download the tgz, and give you the file path.
- The checksum isn't `OK`: delete the files and download again. If it still fails, stop and tell the user.

## Step 4: install into dsh

```bash
dsh plugin --profile <PROFILE> add <TGZ>
```

Expected: `Done` in the last few lines. A WARN like `Issues with peer dependencies found` is normal: the plugin uses the framework that ships with dsh instead of installing its own.

If it fails:

- It says the plugin is incompatible with the current dsh: go back to step 1 and check the version. Don't bypass the check with `allow-version` or similar unless the user explicitly agrees.
- This profile had the plugin installed via `link:` before (common during local development): remove the old directory first with `rm -rf "${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/node_modules/llamapad-dsh-plugin"`, then rerun this step.

## Step 5: write the connection config

The config file is `${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/cordis.patch.yml`. It holds a YAML list, one item per plugin entry.

Back it up first:

```bash
f="${DSH_HOME:-$HOME/.dsh}/profiles/<PROFILE>/cordis.patch.yml"
[ -f "$f" ] && cp "$f" "$f.bak.$(date +%Y%m%d%H%M%S)"
```

Then edit the file so it contains this item (create the file if it doesn't exist):

```yaml
- id: llamapad
  name: llamapad-dsh-plugin
  config:
    panelUrl: <PANEL_URL>
    token: <TOKEN>
```

Editing rules:

- The file already has an `id: llamapad` item: replace only its `panelUrl` and `token` values. Leave the rest of that item and all other items untouched.
- Apart from comments, the file contains just one line, `[]`: that's the empty list dsh writes when it creates a profile. Replace the `[]` line with the item above and keep the comments. Don't append after `[]`; the YAML would fail to parse and dsh wouldn't start.
- The file has other items but no `id: llamapad`: append the item above to the end of the file.
- Keep the YAML list format and indent with spaces.
- Afterwards run `chmod 600 "$f"`, since the file now contains the token.

## Step 6 (optional, ask first): other settings

Only do these if the user wants them, in the same file.

Make dsh's agent use a llamapad model by default (`<MODEL>` is the model's config name on the panel; look for the `name` field in the response from the step 2 endpoint):

```yaml
- id: agent-default-model
  name: '@deepseek-ai/dsh-agent-default-model'
  config:
    provider: llamapad
    model: <MODEL>
```

Mount the management tools so the agent can list, start, and stop local models itself. This item must use the `insert:` form; written as a plain item it has no effect:

```yaml
- insert:
    - id: llamapad-tools
      name: llamapad-dsh-plugin/tools
      config:
        panelUrl: <PANEL_URL>
        token: <TOKEN>
```

## Step 7: verify

```bash
dsh --profile <PROFILE> --dump-config | grep -n -A4 "id: llamapad"
```

Expected: you see the `# == llamapad-dsh-plugin` layer and the `panelUrl` under the `id: llamapad` item. Don't print the `token` value in your reply.

If it fails: no `id: llamapad` usually means you edited the wrong profile directory, or the YAML indentation is off. Check against step 5.

## Tell the user when you're done

In two or three sentences, cover:

- the installed plugin version and the profile it went into;
- dsh must be restarted before the plugin loads. If you are the dsh running on this very profile, remind the user to quit the current dsh and start it again;
- how to start it: `dsh --profile <PROFILE>`, or just `dsh web` when the profile is `web`;
- by default the plugin only uses models already running on the panel: start a model in llamapad first, then pick it in dsh's model picker;
- to change the panel address or token later, use the llamapad settings card inside dsh. On dsh 0.1.7 it's on the Plugins page in the sidebar; on 0.1.5 it's under Settings → Plugins → Plugin configuration.

More details: [Installation and setup](installation.md) and [Configuration reference](configuration.md).

## Upgrading

To upgrade later, repeat steps 1, 3, and 4. The config from step 5 is kept.
