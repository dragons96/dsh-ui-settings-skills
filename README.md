# ui-settings-skills

A dsh plugin that adds a **Skill management** page to Web Settings, organized by workspace.

## Features

- One tab per workspace, with global and user-level skills folded into every workspace view
- Search box that filters skills by name or description
- Localized scope badges on every row (用户 / User, 工作区 / Workspace, 运行时 / Runtime, 自定义 / Custom, 内置 / Bundled)
- Skill descriptions clamp to two lines, with the full text shown on hover
- Read-only in the current version; per-workspace enable/disable is designed but not yet implemented

## Install

1. Build and pack the plugin:

   ```sh
   pnpm install
   pnpm run typecheck
   pnpm test
   pnpm run build
   npm pack          # ui-settings-skills-0.1.0.tgz
   ```

2. Install the package into your profile:

   ```sh
   dsh plugin --profile web add ./ui-settings-skills-0.1.0.tgz
   ```

   (or from the profile directory: `corepack pnpm add ./ui-settings-skills-0.1.0.tgz --dir <profile-dir>`)

3. Mount it in `$DSH_HOME/profiles/<name>/cordis.patch.yml`:

   ```yaml
   - insert:
       - id: ui-settings-skills
         name: ui-settings-skills
   ```

4. Restart the profile and open Settings → **技能 / Skills**.

## Verify

```sh
dsh --profile <name> --dump-config | Select-String ui-settings-skills
```

After the restart, the Skills page shows one tab per workspace, a search box, and localized skill rows.
