/**
 * Skill policy: the durable disable list behind the M2 toggles, plus the
 * shadowing provider logic that enforces it. State lives in a settings
 * namespace; the provider turns disabled entries into rank-0 stub candidates
 * so every consumer of `ctx.skills` (the model catalog, the `/name` injection
 * boundary, and the `skill.list` RPC behind the ui-skill menu) stops seeing
 * them. The settings page reads the same state to render the toggle rows.
 *
 * @module ui-settings-skills/policy
 */

import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillLookupOptions, SkillProvider, SkillProviderControl } from '@deepseek-ai/dsh-skill'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import z from '@deepseek-ai/schemastery'

/** Settings namespace holding the policy document. */
export const POLICY_NS = 'ui-settings-skills.policy'

/** The shadowing provider's registry name (also its wire identity). */
export const POLICY_PROVIDER = 'ui-settings-skills-policy'

/** Snapshot of a disabled skill, enough to render its row and rebuild the stub. */
export interface DisabledSkillEntry {
  readonly description: string
  readonly source: string
}

/** The policy document: user-level disables plus per-workspace disables. */
export interface SkillPolicy {
  /** User-level disabled skills (`~/.agents/skills`), applied to every workspace. */
  readonly user: Readonly<Record<string, DisabledSkillEntry>>
  /** Per-workspace disabled skills (project skills), keyed by WorkspaceId. */
  readonly workspace: Readonly<Record<string, Readonly<Record<string, DisabledSkillEntry>>>>
}

/** One toggle write. */
export interface PolicyUpdate {
  readonly kind: 'user' | 'workspace'
  /** Required for workspace-kind writes. */
  readonly workspaceId?: string
  readonly name: string
  readonly description: string
  readonly source: string
  readonly enabled: boolean
}

export const policySchema = z.object({
  user: z.dict(z.object({
    description: z.string(),
    source: z.string(),
  })),
  workspace: z.dict(z.dict(z.object({
    description: z.string(),
    source: z.string(),
  }))),
})

const EMPTY_POLICY: SkillPolicy = { user: {}, workspace: {} }

/** Read the current policy, tolerating an absent settings service. */
export function readPolicy(ctx: Context): SkillPolicy {
  const settings = ctx.get('settings') as { get?: (ns: string) => unknown } | undefined
  if (settings?.get === undefined) return EMPTY_POLICY
  const value = settings.get(POLICY_NS) as SkillPolicy | undefined
  if (value === undefined) return EMPTY_POLICY
  return { user: value.user ?? {}, workspace: value.workspace ?? {} }
}

/**
 * Apply one toggle write to the policy document. Rewrites the whole user
 * section through `replace` (the policy is small, and deep-merge `update`
 * semantics for removals are unspecified), so a disabled entry is deleted
 * outright and an enabled one is written.
 * @param ctx - plugin context with a settings service.
 * @param update - the toggle write.
 */
export async function updatePolicy(ctx: Context, update: PolicyUpdate): Promise<void> {
  const settings = ctx.get('settings') as { replace?: (ns: string, section: unknown) => Promise<void> } | undefined
  if (settings?.replace === undefined) throw new Error('settings service unavailable')
  const current = readPolicy(ctx)
  const next: {
    user: Record<string, DisabledSkillEntry>
    workspace: Record<string, Record<string, DisabledSkillEntry>>
  } = { user: { ...current.user }, workspace: {} }
  for (const [id, entries] of Object.entries(current.workspace)) next.workspace[id] = { ...entries }
  if (update.kind === 'user') {
    if (update.enabled) delete next.user[update.name]
    else next.user[update.name] = { description: update.description, source: update.source }
  } else {
    if (update.workspaceId === undefined) throw new Error('workspace-kind policy update requires workspaceId')
    const workspaceEntries = { ...(next.workspace[update.workspaceId] ?? {}) }
    if (update.enabled) delete workspaceEntries[update.name]
    else workspaceEntries[update.name] = { description: update.description, source: update.source }
    if (Object.keys(workspaceEntries).length === 0) delete next.workspace[update.workspaceId]
    else next.workspace[update.workspaceId] = workspaceEntries
  }
  await settings.replace(POLICY_NS, next)
}

/** Canonical cwd comparison key; Windows paths compare case-insensitively. */
function canonicalCwd(path: string): string {
  const resolved = resolve(path)
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * The workspace owning this cwd (canonical equal-or-descendant match), if any.
 * @param ctx - plugin context carrying the workspace registry.
 * @param cwd - the lookup cwd.
 * @returns the WorkspaceId, or undefined when no workspace owns the path.
 */
export function workspaceIdForCwd(ctx: Context, cwd: string | undefined): string | undefined {
  if (cwd === undefined) return undefined
  const key = canonicalCwd(cwd)
  const workspaces = ctx.get('workspaceRegistry') as { list?: () => readonly { id: string; path: string }[] } | undefined
  if (workspaces?.list === undefined) return undefined
  for (const workspace of workspaces.list()) {
    const root = canonicalCwd(workspace.path)
    if (key === root || key.startsWith(`${root}\\`) || key.startsWith(`${root}/`)) {
      return workspace.id
    }
  }
  return undefined
}

/**
 * One shadowing provider instance: returns rank-0 stub candidates for every
 * disabled skill visible at the queried cwd. Registered into the layer of the
 * context it receives (the global layer for the host row, an agent's scope
 * layer when mounted through `agent.ctx`), where the registry's same-layer
 * rank tiebreak makes the stub win; `get()` returns undefined so loading a
 * disabled skill fails everywhere.
 * @param ctx - plugin context.
 * @param policy - thunk reading the current policy (read at list time).
 * @returns the provider.
 */
export function createPolicyProvider(
  ctx: Context,
  policy: () => SkillPolicy,
): {
  name: string
  list(options: SkillLookupOptions): Promise<SkillCandidate[]>
  get(candidate: SkillCandidate): Promise<undefined>
} {
  return {
    name: POLICY_PROVIDER,
    async list(options) {
      const current = policy()
      const disabled = new Map<string, DisabledSkillEntry>()
      for (const [name, entry] of Object.entries(current.user)) disabled.set(name, entry)
      const workspaceId = workspaceIdForCwd(ctx, options.cwd)
      if (workspaceId !== undefined) {
        const entries = current.workspace[workspaceId]
        if (entries !== undefined) {
          for (const [name, entry] of Object.entries(entries)) disabled.set(name, entry)
        }
      }
      return [...disabled].map(([name]) => stubCandidate(name))
    },
    async get() {
      return undefined
    },
  }
}

/** The stub candidate replacing a disabled skill in every catalog. */
export function stubCandidate(name: string): SkillCandidate {
  return {
    name,
    description: 'disabled by ui-settings-skills policy',
    invocation: { modelInvocable: false, userInvocable: false },
    source: 'custom',
    provider: POLICY_PROVIDER,
    rank: 0,
    locator: { stub: name },
  }
}

/** Registries the shadowing provider mounts on (the host registry or a preset-owned one). */
export interface PolicyRegisterable {
  readonly registerProvider?: (create: (control: SkillProviderControl) => SkillProvider) => () => void
}

/**
 * Mount the shadowing provider on one registry, holding its invalidation
 * control STRONGLY in `invalidators`.
 *
 * The registry does not retain the `SkillProviderControl` after registration,
 * so a weak-only reference is garbage-collected long before a policy write:
 * the invalidators then dereference nothing, the registry's catalog cache
 * never invalidates, and every `ctx.skills` consumer keeps serving the
 * pre-disable catalog until a profile restart. The returned disposer removes
 * the entry again, so the set never outlives a live registration.
 * @param registry - the registry to mount on.
 * @param invalidators - the strong set of live invalidate closures.
 * @param policyCtx - plugin host context (workspace + settings resolution).
 * @param policy - thunk reading the current policy at list time.
 * @returns the exact disposer that unregisters the provider and drops the invalidator.
 */
export function registerPolicyProvider(
  registry: PolicyRegisterable,
  invalidators: Set<() => void>,
  policyCtx: Context,
  policy: () => SkillPolicy,
): () => void {
  const register = registry.registerProvider
  if (register === undefined) return () => {}
  let invalidate: (() => void) | undefined
  // Method call with the registry as receiver: the real implementation reads
  // `this`, and on a traceable proxy the receiver is what rebinds the
  // registration into the caller's scope layer.
  const disposeProvider = register.call(registry, (control) => {
    invalidate = control.invalidate
    invalidators.add(invalidate)
    return createPolicyProvider(policyCtx, policy)
  })
  return () => {
    disposeProvider()
    if (invalidate !== undefined) invalidators.delete(invalidate)
  }
}

/**
 * Sniff the runtime's scope-tag symbol off a live scoped context.
 *
 * The plugin bundle inlines its own copies of the dsh-* packages while the
 * runtime registry carries its own; `dsh-scope`'s tag is a module-private
 * `Symbol`, so a tag written through an imported copy would be invisible to
 * the runtime's `scopeOf`. The tag is an own property somewhere on the
 * context's prototype chain and the only non-global-registry symbol there
 * (cordis internals all use `Symbol.for`), so it can be recovered and reused
 * through plain object semantics — no harness changes.
 * @param sample - any context the runtime tagged with a scope (an agent ctx).
 * @returns the runtime's scope-tag symbol, or undefined when `sample` carries none.
 */
export function findScopeTag(sample: unknown): symbol | undefined {
  for (let cursor: unknown = sample; cursor !== null && cursor !== undefined && cursor !== Object.prototype; cursor = Object.getPrototypeOf(cursor as object)) {
    for (const sym of Object.getOwnPropertySymbols(cursor as object)) {
      if (Symbol.keyFor(sym) === undefined) return sym
    }
  }
  return undefined
}

/**
 * Mint a context whose scope tag is `key`, on top of `base`.
 * `base.extend` shares the base's fiber, so registrations through the result
 * are owned by the base's lifecycle while the runtime's `scopeOf` resolves
 * the tag to `key`.
 * @param base - plugin context to derive from.
 * @param tag - the runtime's scope-tag symbol (from {@link findScopeTag}).
 * @param key - the scope key to tag with.
 * @returns the scope-tagged context.
 */
export function scopeTaggedContext(base: Context, tag: symbol, key: ScopeKey): Context {
  return base.extend({ [tag]: key } as {})
}
