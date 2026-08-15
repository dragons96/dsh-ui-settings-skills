/**
 * Regression tests for the enforcement plumbing:
 *  - `registerPolicyProvider` holds invalidation controls STRONGLY (the
 *    WeakRef-only predecessor let GC collect them, leaving the registry's
 *    collect cache stale after a policy write — the disabled skill stayed in
 *    the `/` catalog until a profile restart);
 *  - the shadowing stub wins in the STANDING layer, the layer cold reads
 *    scope to (`skill.list` for a session with no live agent resolves the
 *    view scope to the preset's standing key, whose chain never reaches an
 *    agent-layer entry);
 *  - `findScopeTag`/`scopeTaggedContext` mint a ctx the registry's `scopeOf`
 *    resolves to the requested key.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry, { isUserInvocable, type SkillCandidate } from '@deepseek-ai/dsh-skill'
import { createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import { findScopeTag, registerPolicyProvider, scopeTaggedContext } from '../src/policy.ts'

function realCandidate(): SkillCandidate {
  return {
    name: 'demo-skill',
    description: 'a real skill',
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'user-agents',
    provider: 'real-provider',
    rank: 600,
    locator: {},
  }
}

/** The skill-filesystem-shaped provider a preset contributes. */
const realProvider = {
  name: 'real-provider',
  async list() {
    return [realCandidate()]
  },
  async get() {
    return undefined
  },
}

/** Names a user-facing catalog shows. */
function userVisible(registry: SkillRegistry, options?: { scope?: ScopeKey }): Promise<string[]> {
  return registry.list(options).then(skills => skills.filter(isUserInvocable).map(skill => skill.name))
}

describe('registerPolicyProvider', () => {
  it('holds invalidators strongly, invalidates the collect cache on a policy flip, and removes them on dispose', async () => {
    const root = new Context()
    root.provide('workspaceRegistry', { list: () => [] })
    const registry = new SkillRegistry(root, {})

    // Real provider + policy stub both in the global layer; rank 0 wins the
    // same-layer tie once the policy flips.
    registry.registerProvider(() => realProvider)
    const invalidators = new Set<() => void>()
    const user: Record<string, { description: string; source: string }> = {}
    const policy = { user, workspace: {} as Record<string, Record<string, { description: string; source: string }>> }
    const dispose = registerPolicyProvider(registry, invalidators, root, () => policy)

    expect(await userVisible(registry)).toEqual(['demo-skill'])

    user['demo-skill'] = { description: 'a real skill', source: 'user-agents' }
    for (const invalidate of [...invalidators]) invalidate()

    // The re-collected catalog serves the rank-0 stub, which is not
    // user-invocable: the disabled skill disappears from the `/` catalog.
    expect(await userVisible(registry)).toEqual([])

    expect(invalidators.size).toBe(1)
    dispose()
    expect(invalidators.size).toBe(0)
  })

  it('returns a no-op disposer for a registry without registerProvider', () => {
    const invalidators = new Set<() => void>()
    const dispose = registerPolicyProvider({}, invalidators, {} as never, () => ({ user: {}, workspace: {} }))
    expect(dispose).toBeInstanceOf(Function)
    expect(invalidators.size).toBe(0)
    dispose()
  })
})

describe('standing-layer shadowing', () => {
  it('hides a disabled skill from the cold (standing-scope) view and the live (agent) view', async () => {
    const root = new Context()
    root.provide('workspaceRegistry', { list: () => [] })
    const registry = new SkillRegistry(root, {})

    // The preset's standing mount, exactly as agent-presets mints it.
    const standingKey: ScopeKey = { agentPreset: 'standard' }
    const standing = createScope(root, standingKey)
    // The preset's real provider files into the standing layer.
    standing.ctx.skills.registerProvider(() => realProvider)

    // The plugin side: learn the runtime's scope-tag symbol, mint a
    // standing-tagged ctx on a row ctx, and register the policy provider.
    const tag = findScopeTag(standing.ctx)
    expect(tag).toBeDefined()
    function row(): void {}
    const rowCtx = root.plugin(row).ctx
    const tagged = scopeTaggedContext(rowCtx, tag as symbol, standingKey)
    expect(scopeOf(tagged)).toBe(standingKey)

    const invalidators = new Set<() => void>()
    const user: Record<string, { description: string; source: string }> = {}
    const policy = { user, workspace: {} as Record<string, Record<string, { description: string; source: string }>> }
    const dispose = registerPolicyProvider(tagged.get('skills') as never, invalidators, root, () => policy)

    // Cold view before disable: the real skill is listed.
    expect(await userVisible(registry, { scope: standingKey })).toEqual(['demo-skill'])

    user['demo-skill'] = { description: 'a real skill', source: 'user-agents' }
    for (const invalidate of [...invalidators]) invalidate()

    // Cold view after disable: stub wins in the standing layer.
    expect(await userVisible(registry, { scope: standingKey })).toEqual([])

    // Live view: the agent key chains through the standing layer, so the
    // standing stub covers it too.
    const agentKey: ScopeKey = { agentPreset: 'standard', agent: 's1' }
    createScope(root, agentKey, { parent: standingKey })
    expect(await userVisible(registry, { scope: agentKey })).toEqual([])

    dispose()
  })
})

describe('findScopeTag / scopeTaggedContext', () => {
  it('returns undefined for an untagged context and tags a fresh context readably', () => {
    const root = new Context()
    function row(): void {}
    const rowCtx = root.plugin(row).ctx
    expect(findScopeTag(rowCtx)).toBeUndefined()

    const key: ScopeKey = { agentPreset: 'standard' }
    const standing = createScope(root, key)
    const tag = findScopeTag(standing.ctx)
    expect(tag).toBeDefined()
    const tagged = scopeTaggedContext(rowCtx, tag as symbol, key)
    expect(scopeOf(tagged)).toBe(key)
  })
})
