# ui-settings-skills

A dsh plugin that adds a **Skill management** page to Web Settings, organized by workspace.

Built as a fully out-of-tree plugin — the deepseek-harness source stays untouched. It registers a `settings.section` slot (the page appears in Settings → **技能 / Skills**) and serves its skill catalog over its own HTTP route (`ctx.webServer`).

## Install

1. Install the plugin from npm (published as `@dsh-mixxed/dsh-client-ui-settings-skills`):

   ```sh
   dsh plugin --profile web add @dsh-mixxed/dsh-client-ui-settings-skills
   ```

   The package declares `dsh.bundle` (its bundled `cordis.patch.yml`), so `dsh plugin add` automatically appends it to the profile's `dsh.profile.bundles` layer stack and the plugin mounts on the next boot — **no manual `cordis.patch.yml` editing**.

   Upgrading an install that predates the bundle declaration: remove the legacy `ui-settings-skills` row from `$DSH_HOME/profiles/<name>/cordis.patch.yml` — the bundle layer now supplies it, and leaving both would mount the id twice.

2. Restart the profile (new plugins are discovered at boot), then open Settings → **技能 / Skills**.

### Building from source (development / offline)

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
npm pack          # produces dsh-mixxed-dsh-client-ui-settings-skills-<version>.tgz
dsh plugin --profile web add ./dsh-mixxed-dsh-client-ui-settings-skills-<version>.tgz
```

## Features

- One tab per workspace, with global and user-level skills folded into every workspace view
- **Manages only user-level skills (`~/.agents/skills`) and project skills** — preset-loaded (`custom`) and built-in skills are never shown or toggled
- Search box that filters skills by name or description
- Localized scope badges on every row (用户 / User, 工作区 / Workspace)
- Skill descriptions clamp to two lines, with the full text shown on hover
- **Enable/disable toggles** on every managed row — see [Skill toggles](#skill-toggles)

## Skill toggles

Every managed skill row carries a switch. Turning a skill **off**:

- removes it from the model catalog (`tool-skill`) and the `/name` injection boundary,
- removes it from the `/` command menu in the conversation composer,
- takes effect immediately — the next `/` open reflects the change.

Scope semantics:

- **User-level skills** (`~/.agents/skills`) toggle globally across every workspace.
- **Project skills** toggle per workspace: the same skill can stay enabled in one workspace and disabled in another.

State persists in the settings document (`ui-settings-skills.policy` namespace), so it survives profile restarts, and turning a skill back **on** restores it everywhere.

> Preset-loaded (`custom`) and built-in skills are never managed and never shown on the page.

## Verify

```sh
dsh --profile <name> --dump-config | Select-String ui-settings-skills
```

The composed config shows the `ui-settings-skills` row, and `$DSH_HOME/profiles/<name>/package.json` lists `@dsh-mixxed/dsh-client-ui-settings-skills` under `dsh.profile.bundles` (auto-appended by `dsh plugin add`).

After the restart, the Skills page shows one tab per workspace, a search box, and localized skill rows.

## Config (optional)

The plugin runs in the `host` role by default (routes + settings namespace + shadowing provider). A `policy` role registers only the shadowing provider — no namespace, no routes. Override it from your profile's own `cordis.patch.yml` — the user layer is applied after the bundle layer, so an id-targeted patch overrides the bundled mount row:

```yaml
- id: ui-settings-skills
  name: "@dsh-mixxed/dsh-client-ui-settings-skills"
  config:
    role: policy      # default 'host'
```

## License

[MIT](LICENSE)
