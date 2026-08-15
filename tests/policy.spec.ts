import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  createPolicyProvider, POLICY_PROVIDER, readPolicy, stubCandidate, updatePolicy, workspaceIdForCwd,
} from '../src/policy.ts'
import type { SkillCandidate } from '@deepseek-ai/dsh-skill'

/** A minimal ctx carrying a settable settings service and workspace registry. */
function makeCtx(overrides: {
  settings?: { get?: () => unknown; replace?: (ns: string, section: unknown) => Promise<void> }
  workspaces?: readonly { id: string; path: string }[]
} = {}): Context & {
  get(name: string): unknown
  settings: unknown
} {
  const settings = overrides.settings ?? {
    get: () => ({ user: {}, workspace: {} }),
    replace: vi.fn(async () => {}),
  }
  const workspaces = overrides.workspaces ?? [{ id: 'w1', path: 'C:\\proj\\one' }]
  return {
    get(name: string): unknown {
      if (name === 'settings') return settings
      if (name === 'workspaceRegistry') return { list: () => workspaces }
      return undefined
    },
    settings,
  } as never
}

describe('stubCandidate', () => {
  it('builds a rank-0 candidate that is neither model- nor user-invocable', () => {
    const stub = stubCandidate('demo-skill')
    expect(stub).toMatchObject({
      name: 'demo-skill',
      provider: POLICY_PROVIDER,
      rank: 0,
      invocation: { modelInvocable: false, userInvocable: false },
    })
  })
})

describe('readPolicy', () => {
  it('returns the resolved policy and tolerates an absent settings service', () => {
    const policy = { user: { a: { description: 'd', source: 'user-agents' } }, workspace: {} }
    const withSettings = makeCtx({ settings: { get: () => policy } })
    expect(readPolicy(withSettings)).toEqual(policy)
    expect(readPolicy({ get: () => undefined } as never)).toEqual({ user: {}, workspace: {} })
  })
})

describe('updatePolicy', () => {
  it('writes a disable through replace and removes it when enabled', async () => {
    let current: unknown = { user: {}, workspace: {} }
    const replace = vi.fn(async (_ns: string, section: unknown) => { current = section })
    const ctx = makeCtx({ settings: { get: () => current, replace } })

    await updatePolicy(ctx, { kind: 'user', name: 'user-skill', description: 'd', source: 'user-agents', enabled: false })
    expect(current).toEqual({ user: { 'user-skill': { description: 'd', source: 'user-agents' } }, workspace: {} })

    await updatePolicy(ctx, { kind: 'workspace', workspaceId: 'w1', name: 'proj-skill', description: 'p', source: 'project-agents', enabled: false })
    expect(current).toEqual({
      user: { 'user-skill': { description: 'd', source: 'user-agents' } },
      workspace: { w1: { 'proj-skill': { description: 'p', source: 'project-agents' } } },
    })

    await updatePolicy(ctx, { kind: 'user', name: 'user-skill', description: 'd', source: 'user-agents', enabled: true })
    expect(current).toEqual({ user: {}, workspace: { w1: { 'proj-skill': { description: 'p', source: 'project-agents' } } } })
  })

  it('throws when the settings service is absent or a workspace id is missing', async () => {
    await expect(updatePolicy({ get: () => undefined } as never, {
      kind: 'user', name: 'a', description: 'd', source: 's', enabled: false,
    })).rejects.toThrow('settings service unavailable')
    const ctx = makeCtx()
    await expect(updatePolicy(ctx, {
      kind: 'workspace', name: 'a', description: 'd', source: 's', enabled: false,
    })).rejects.toThrow('workspace-kind policy update requires workspaceId')
  })
})

describe('workspaceIdForCwd', () => {
  it('matches the owning workspace by canonical equal-or-descendant path', () => {
    const ctx = makeCtx({ workspaces: [{ id: 'w1', path: 'C:\\proj\\one' }] })
    expect(workspaceIdForCwd(ctx, 'C:\\proj\\one')).toBe('w1')
    expect(workspaceIdForCwd(ctx, 'C:\\proj\\one\\src')).toBe('w1')
    expect(workspaceIdForCwd(ctx, 'C:\\proj\\two')).toBeUndefined()
    expect(workspaceIdForCwd(ctx, undefined)).toBeUndefined()
  })
})

describe('createPolicyProvider', () => {
  it('lists stubs for user and workspace disables visible at the cwd, and never loads', async () => {
    const policy = {
      user: { 'user-skill': { description: 'd', source: 'user-agents' } },
      workspace: { w1: { 'proj-skill': { description: 'p', source: 'project-agents' } } },
    }
    const provider = createPolicyProvider(makeCtx(), () => policy)

    const inWorkspace = await provider.list({ cwd: 'C:\\proj\\one' }) as SkillCandidate[]
    expect(inWorkspace.map(c => c.name).sort()).toEqual(['proj-skill', 'user-skill'])
    expect(inWorkspace.every(c => c.provider === POLICY_PROVIDER && c.rank === 0)).toBe(true)

    const outside = await provider.list({ cwd: 'C:\\other' }) as SkillCandidate[]
    expect(outside.map(c => c.name)).toEqual(['user-skill'])

    await expect(provider.get({ name: 'proj-skill' } as SkillCandidate)).resolves.toBeUndefined()
  })
})
