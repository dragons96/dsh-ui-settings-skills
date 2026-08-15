import { describe, expect, it, vi } from 'vitest'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import { POLICY_PROVIDER } from '../src/policy.ts'
import { buildCatalog, toSkillRow, type LiveAgentRow, type SkillsReader, type WorkspaceRow } from '../src/index.ts'

function mkSkill(name: string, overrides: Partial<Omit<SkillSummary, 'name'>> = {}): SkillSummary {
  return {
    name,
    description: `description of ${name}`,
    invocation: { modelInvocable: true, userInvocable: true },
    source: 'project-dsh',
    provider: 'fixture',
    ...overrides,
  }
}

interface Lookup {
  readonly cwd?: string
  readonly scope?: object
}

/** Reader whose rows depend on the lookup options, recording every call. */
function reader(rowsFor: (options: Lookup | undefined) => SkillSummary[]): SkillsReader & { snapshot: ReturnType<typeof vi.fn> } {
  const snapshot = vi.fn(async (options?: Lookup) => ({ skills: rowsFor(options) }))
  return { snapshot }
}

const workspaces: readonly WorkspaceRow[] = [
  { workspaceId: 'w1', path: 'C:\\proj\\one', title: 'One', sessionIds: ['s1', 's2'] },
  { workspaceId: 'w2', path: 'C:\\proj\\two', title: 'Two', sessionIds: [] },
]

const scopeA = { marker: 'scope-a' }
const scopeB = { marker: 'scope-b' }

describe('toSkillRow', () => {
  it('maps summary fields onto the wire row', () => {
    const row = toSkillRow(mkSkill('demo-skill', {
      whenToUse: 'when needed',
      source: 'user-agents',
      provider: 'skill-filesystem',
      invocation: { modelInvocable: false, userInvocable: true },
      resourceBase: { kind: 'directory', path: 'C:\\skills' },
    }))
    expect(row).toEqual({
      name: 'demo-skill',
      description: 'description of demo-skill',
      whenToUse: 'when needed',
      source: 'user-agents',
      provider: 'skill-filesystem',
      modelInvocable: false,
      userInvocable: true,
      resourceBaseKind: 'directory',
    })
  })

  it('omits optional fields that are absent', () => {
    const row = toSkillRow(mkSkill('bare-skill'))
    expect(row.whenToUse).toBeUndefined()
    expect(row.resourceBaseKind).toBeUndefined()
  })
})

describe('buildCatalog', () => {
  it('returns one dimension per workspace, folding global, user-level, per-cwd, and live-session rows', async () => {
    const skills = reader(options => {
      if (options === undefined) return [mkSkill('global-a'), mkSkill('user-skill', { source: 'user-agents' })]
      if (options.scope === scopeA) return [mkSkill('scope-skill', { source: 'project-agents' }), mkSkill('user-skill', { source: 'user-agents' }), mkSkill('shared')]
      if (options.scope === scopeB) return [mkSkill('user-skill-2', { source: 'user-agents' })]
      if (options.cwd === 'C:\\proj\\one') return [mkSkill('global-one-skill')]
      return [mkSkill('global-two-skill')]
    })
    const agentsBySession = new Map<string, LiveAgentRow>([
      ['s1', { scope: scopeA }],
      ['s3', { scope: scopeB }],
    ])
    const dimensions = await buildCatalog(skills, agentsBySession, workspaces)

    expect(dimensions.map(d => d.kind)).toEqual(['workspace', 'workspace'])
    expect(dimensions[0]).toMatchObject({ id: 'w1', title: 'One' })
    // w1: global + user-level (global and scopeB) + per-cwd + session scopeA, deduped and sorted.
    expect(dimensions[0]?.skills.map(s => s.name)).toEqual([
      'global-a', 'global-one-skill', 'scope-skill', 'shared', 'user-skill', 'user-skill-2',
    ])
    // w2: global + user-level + its per-cwd view (no live sessions).
    expect(dimensions[1]?.skills.map(s => s.name)).toEqual(['global-a', 'global-two-skill', 'user-skill', 'user-skill-2'])

    const snapshot = skills.snapshot
    expect(snapshot).toHaveBeenCalledTimes(6)
    expect(snapshot.mock.calls[0]).toEqual([])
    expect(snapshot.mock.calls[1]).toEqual([{ scope: scopeA }])
    expect(snapshot.mock.calls[2]).toEqual([{ scope: scopeB }])
    expect(snapshot.mock.calls[3]).toEqual([{ cwd: 'C:\\proj\\one' }])
    expect(snapshot.mock.calls[4]).toEqual([{ scope: scopeA, cwd: 'C:\\proj\\one' }])
    expect(snapshot.mock.calls[5]).toEqual([{ cwd: 'C:\\proj\\two' }])
  })

  it('drops preset-loaded (custom) and built-in (bundled) skills from every view', async () => {
    const skills = reader(options => {
      if (options === undefined) return [mkSkill('custom-skill', { source: 'custom' }), mkSkill('bundled-skill', { source: 'bundled' }), mkSkill('user-skill', { source: 'user-agents' })]
      if (options?.cwd === 'C:\\proj\\one') return [mkSkill('project-skill'), mkSkill('runtime-skill', { source: 'runtime' })]
      return []
    })
    const dimensions = await buildCatalog(skills, new Map(), workspaces)

    for (const dimension of dimensions) {
      const names = dimension.skills.map(s => s.name)
      expect(names).not.toContain('custom-skill')
      expect(names).not.toContain('bundled-skill')
      expect(names).not.toContain('runtime-skill')
      expect(names).toContain('user-skill')
    }
    expect(dimensions[0]?.skills.map(s => s.name)).toEqual(['project-skill', 'user-skill'])
  })

  it('unions every live session of a workspace, deduped by name', async () => {
    const skills = reader(options => {
      if (options?.scope === scopeA) return [mkSkill('skill-a'), mkSkill('shared')]
      if (options?.scope === scopeB) return [mkSkill('skill-b'), mkSkill('shared')]
      return []
    })
    const agentsBySession = new Map<string, LiveAgentRow>([
      ['s1', { scope: scopeA }],
      ['s2', { scope: scopeB }],
    ])
    const dimensions = await buildCatalog(skills, agentsBySession, workspaces)

    expect(dimensions[0]?.skills.map(s => s.name)).toEqual(['shared', 'skill-a', 'skill-b'])
  })

  it('contains a failing session inside its workspace and marks a workspace whose per-cwd view fails', async () => {
    const agentsBySession = new Map<string, LiveAgentRow>([
      ['s1', { scope: scopeA }],
      ['s2', { scope: scopeB }],
    ])
    const skills = reader(options => {
      if (options?.scope === scopeA) throw new Error('agent scope exploded')
      if (options?.cwd === 'C:\\proj\\two') throw new Error('provider exploded')
      return [mkSkill('ok-skill', { source: 'user-agents' })]
    })
    const dimensions = await buildCatalog(skills, agentsBySession, workspaces)

    // w1: the failing session (s1) is skipped, the healthy one (s2) contributes.
    expect(dimensions[0]?.skills.map(s => s.name)).toEqual(['ok-skill'])
    // w2's per-cwd view failed, so the workspace carries the error.
    expect(dimensions[1]).toMatchObject({
      kind: 'workspace',
      id: 'w2',
      title: 'Two',
      skills: [],
      error: { code: 'workspace-catalog-failed', message: 'Error: provider exploded' },
    })
  })

  it('drops policy stub rows and renders policy-disabled skills with the toggle off', async () => {
    const stub = { ...mkSkill('disabled-a'), provider: POLICY_PROVIDER }
    const skills = reader(options => {
      if (options === undefined) return [stub, mkSkill('user-skill', { source: 'user-agents' })]
      if (options?.cwd === 'C:\\proj\\one') return [stub, mkSkill('project-skill')]
      return []
    })
    const policy = {
      user: { 'disabled-a': { description: 'the disabled user skill', source: 'user-agents' } },
      workspace: { w1: { 'project-skill': { description: 'the disabled project skill', source: 'project-agents' } } },
    }
    const dimensions = await buildCatalog(skills, new Map(), workspaces, policy)

    const w1 = dimensions[0]!
    expect(w1.skills.map(s => s.name)).toEqual(['disabled-a', 'project-skill', 'user-skill'])
    expect(w1.skills.find(s => s.name === 'disabled-a')).toMatchObject({
      description: 'the disabled user skill',
      source: 'user-agents',
      disabled: true,
      disabledScope: 'user',
    })
    expect(w1.skills.find(s => s.name === 'project-skill')).toMatchObject({
      description: 'the disabled project skill',
      source: 'project-agents',
      disabled: true,
      disabledScope: 'workspace',
    })
    // w2 (no workspace disables) still carries the user-level disabled row.
    const w2 = dimensions[1]!
    expect(w2.skills.map(s => s.name)).toEqual(['disabled-a', 'user-skill'])
    expect(w2.skills.find(s => s.name === 'disabled-a')?.disabledScope).toBe('user')
  })
})
