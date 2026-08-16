# ui-settings-skills

A dsh plugin that adds a **Skill management** page to Web Settings, organized by workspace.

Built as a fully out-of-tree plugin — the deepseek-harness source stays untouched. It registers a `settings.section` slot (the page appears in Settings → **技能 / Skills**) and serves its skill catalog over its own HTTP route (`ctx.webServer`).

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

## Install

1. Build and pack the plugin:

   ```sh
   pnpm install
   pnpm run typecheck
   pnpm test
   pnpm run build
   npm pack          # dsh-mixxed-dsh-client-ui-settings-skills-0.1.1.tgz
   ```

2. Install the package into your profile:

   ```sh
   dsh plugin --profile web add ./dsh-mixxed-dsh-client-ui-settings-skills-0.1.1.tgz
   ```

   (or from the profile directory: `corepack pnpm add ./dsh-mixxed-dsh-client-ui-settings-skills-0.1.1.tgz --dir <profile-dir>`)

   (or once published to npm: `corepack pnpm add @dsh-mixxed/dsh-client-ui-settings-skills --dir <profile-dir>`)

3. Mount it in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ui-settings-skills              # plugin id (unchanged)
         name: "@dsh-mixxed/dsh-client-ui-settings-skills" # npm package name
   ```

4. Restart the profile and open Settings → **技能 / Skills**.

## Verify

```sh
dsh --profile <name> --dump-config | Select-String ui-settings-skills
```

After the restart, the Skills page shows one tab per workspace, a search box, and localized skill rows.

## License

[MIT](LICENSE)
