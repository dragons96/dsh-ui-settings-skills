# ui-settings-skills

Out-of-tree dsh plugin: a **Skill management** page in Web Settings — one tab per workspace (global and user-level skills folded in), a search box, and per-skill localized scope badges.

No deepseek-harness source is modified: the plugin is a dual-face npm package (node half + `dsh.client` browser half) installed into a profile and mounted by that profile's own `cordis.patch.yml`. Design rationale lives in [DESIGN.md](DESIGN.md).

## Plugin contract (dsh conventions followed)

- **Dual-face package**: `src/index.ts` is the node half (host-side `apply`); `src/client/index.ts` is the browser half, discovered through the `dsh.client` manifest and served as one bundle.
- **`package.json`**: name `ui-settings-skills`, `"type": "module"`, `exports` with `.` (node half) and `./client` (browser bundle), `dsh.client = { platform: 'web', inject: [...] }`, `files: ["lib"]`.
- **Client bundle contract**: the built `lib/client.js` calls `window.__ModuleLoader__.load({ id, factory })` and resolves platform modules (`react`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-ui-slots`, `@deepseek-ai/dsh-client-ui-primitives`, …) through the injected module table — no globals, no import map. CSS Modules are compiled by lightningcss and inlined as one `<style data-plugin>` tag at factory execution.
- **Registrations are effects**: the route registers through `ctx.effect()` (disposal unregisters it), the settings page through `ctx.slots.inject('settings.section', …)`, dictionaries through `ctx.locale.register`. No module-level side effects.
- **i18n**: the `settings.skillManagement` locale namespace with `en`/`zh` dictionaries, `LocaleNamespaceMap` declaration merging, and the renderer-bound `t` from `PropsLocale` — the ui-settings house pattern.
- **UI**: the page follows the house ui-settings style (760px column, section title, plugin-inventory search field, underline tabs, pill badges) and reuses `@deepseek-ai/dsh-client-ui-primitives` (`Tooltip`, `IconSearchOutline16`).

## Layout

| Path | Role |
|---|---|
| `src/index.ts` | Node half: `ctx.webServer` route `GET /plugin/settings-skills/catalog` aggregating `ctx.skills` into one view per workspace |
| `src/wire.ts` | Type-only wire contract shared by both halves |
| `src/client/index.ts` | Browser half: registers the `settings.section` page "skill-management" |
| `src/client/SkillManagementSection.tsx` | The page: workspace tabs, search, localized scope badges, loading/error/empty states |
| `src/client/locales.ts` | `en`/`zh` dictionaries plus the `sourceLabelKey` mapping |
| `scripts/build.mjs` | esbuild builds `lib/index.js` + `lib/client.js` |
| `DESIGN.md` | Design document (dimension model, M2 toggle contract) |

## Dimensions

The web-app bundle disables the host-plane skill providers (`skill-filesystem` / `skill-badge` / `tool-skill` are `disabled: true` there) — skills come from **agent presets**, which register providers into each agent's scope layer. The catalog exposes **one view per workspace**; every workspace folds in the global layer, the current user's user-level rows (`user-agents` / `user-dsh` from every live agent's scoped view), the workspace's per-`cwd` global view, and the scoped views of its live sessions (the workspace record owns the session mapping; per-session granularity is never shown). A failing session is contained inside its workspace; a workspace whose per-cwd view fails degrades to an error-bearing view.

## Model Experience

- **What the model sees**: nothing. The page is a browser settings surface; the host half only reads `ctx.skills` / `ctx.workspaceRegistry` / `ctx.agents` and never enters a model request.
- **Token effect**: none.
- **KV Cache effect**: none — the plugin neither assembles nor sends a provider request.

## Build, test, pack

```sh
corepack pnpm install
pnpm run typecheck
pnpm test
pnpm run build
npm pack          # ui-settings-skills-0.1.0.tgz
```

DevDependencies pin the published `@deepseek-ai/*@0.1.0-rc.6` type set, aligned with the installed dsh runtime; bump them together with the harness version.

## Install into a profile

1. Install the package (choose one):
   - `dsh plugin --profile web add ./ui-settings-skills-0.1.0.tgz` (needs pnpm on PATH), or
   - `corepack pnpm add ./ui-settings-skills-0.1.0.tgz --dir <profile-dir>` in the profile directory (keep the pnpm major version consistent with the profile's existing `node_modules`).
2. Append to `$DSH_HOME/profiles/<name>/cordis.patch.yml` (the profile's own layer — not repo code):

   ```yaml
   - insert:
       - id: ui-settings-skills
         name: ui-settings-skills
   ```

3. Verify the row composes: `dsh --profile <name> --dump-config | Select-String ui-settings-skills`
4. Restart the profile (new plugins are discovered at boot), open Settings → **技能 / Skills**.

Plugin-set changes need a restart (`client-modules` caches package verdicts); bundle content changes after a running boot need the HMR `rebuilt()` path. The `skill-dev` test profile under `$DSH_HOME/profiles/skill-dev` exercises the plugin with a host-plane `skill-filesystem-host` insert so the workspace views have data without live sessions.

## API

`GET /plugin/settings-skills/catalog` → `{ dimensions: [{ kind: 'workspace', id, title, skills: SkillRow[], error? }] }` with `SkillRow = { name, description, whenToUse?, source, provider, modelInvocable, userInvocable, resourceBaseKind? }`. Errors are `{ error: { code, message } }` with 4xx/5xx (405 for non-GET, 404 for unknown routes).

## Verification against a live instance

```sh
dsh --profile <name> --port 3800
# then:
curl http://127.0.0.1:3800/                          # __DSH_BOOT__ contains the ui-settings-skills entry
curl http://127.0.0.1:3800/plugins/ui-settings-skills/client.js   # 200 JS
curl http://127.0.0.1:3800/plugin/settings-skills/catalog         # 200 JSON dimensions
```

## Known Limitations and Deferred Work

- **M2 (per-workspace enable/disable) is not implemented.** The contract is designed in `DESIGN.md` §7; the enforcement mechanism is a rank-0 shadowing skill provider whose semantic boundaries need a separate review.
- **Web compositions have an empty global layer** (by product design the providers live behind agent presets), so workspace views rely on live sessions — a workspace with no live session and no host-plane provider shows no skills.
- **Plugin-set changes need a restart** (`client-modules` caches package verdicts per name and never expires them); the search filters the active workspace only.
- **Version coupling**: the type/dev dependency set pins the installed dsh runtime (`0.1.0-rc.6`); upgrading the harness requires bumping the devDependencies and rebuilding.
