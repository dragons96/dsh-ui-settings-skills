/**
 * Wire contract for the ui-settings-skills catalog API. The host half produces
 * it; the browser half consumes it over the plugin's HTTP route. Keep this
 * file type-only: both halves import it and it must never carry runtime code
 * into a bundle.
 */

/** One skill row as the browser renders it. */
export interface SkillRow {
  /** Kebab-case skill name. */
  readonly name: string
  /** Short routing description. */
  readonly description: string
  /** Optional extra routing guidance. */
  readonly whenToUse?: string
  /** Scope label: project-dsh / project-agents / runtime / user-dsh / user-agents / custom / bundled. */
  readonly source: string
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Whether the model-facing catalog includes this skill. */
  readonly modelInvocable: boolean
  /** Whether the human-facing catalog includes this skill. */
  readonly userInvocable: boolean
  /** Provider-specific resource-base kind, when the skill carries one. */
  readonly resourceBaseKind?: string
  /** True when this skill is disabled by the policy (the toggle renders off). */
  readonly disabled?: boolean
  /** Which policy scope disabled this row; present when disabled. */
  readonly disabledScope?: 'user' | 'workspace'
}

/** One workspace's catalog view (the only dimension the page shows). */
export interface DimensionView {
  readonly kind: 'workspace'
  /** WorkspaceId. */
  readonly id: string
  /** Workspace display title. */
  readonly title: string
  /** Sorted skill rows: the global layer, user-level rows, per-cwd rows, and live-session views, folded together. */
  readonly skills: readonly SkillRow[]
  /** Present when this workspace's catalog could not be collected. */
  readonly error?: { readonly code: string; readonly message: string }
}

/** GET /plugin/settings-skills/catalog response value. */
export interface CatalogResponse {
  readonly dimensions: readonly DimensionView[]
}

/** One toggle write sent to PUT /plugin/settings-skills/policy. */
export interface PutPolicyRequest {
  /** user = a `~/.agents/skills` skill (applies to every workspace); workspace = a project skill of one workspace. */
  readonly kind: 'user' | 'workspace'
  /** Required when kind is workspace. */
  readonly workspaceId?: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly enabled: boolean
}

/** Uniform plugin-route error body. */
export interface ErrorResponse {
  readonly error: { readonly code: string; readonly message: string }
}
