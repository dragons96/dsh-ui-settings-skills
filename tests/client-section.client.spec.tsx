// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { SkillManagementSection, type SkillManagementSectionProps } from '../src/client/SkillManagementSection.tsx'
import { en, sourceLabelKey, zh } from '../src/client/locales.ts'
import type { CatalogResponse } from '../src/wire.ts'

// React 18 act() requires the environment flag when driving a real root.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const fixture: CatalogResponse = {
  dimensions: [
    {
      kind: 'workspace',
      id: 'w1',
      title: 'One',
      skills: [
        { name: 'global-skill', description: 'a global skill', source: 'bundled', provider: 'skill-filesystem', modelInvocable: true, userInvocable: true },
        { name: 'project-skill', description: 'a project skill with a long description that would wrap over several lines', source: 'project-agents', provider: 'skill-filesystem', modelInvocable: false, userInvocable: true },
      ],
    },
    {
      kind: 'workspace',
      id: 'w2',
      title: 'Two',
      skills: [
        { name: 'find-docs', description: 'find documentation', source: 'user-agents', provider: 'skill-filesystem', modelInvocable: true, userInvocable: true },
        { name: 'find-skills', description: 'find skills', source: 'user-agents', provider: 'skill-filesystem', modelInvocable: true, userInvocable: true },
      ],
    },
  ],
}

function mount(props: Partial<SkillManagementSectionProps>): { root: Root; container: HTMLElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  root.render(<SkillManagementSection {...({
    t: (key: string) => key,
    close: () => {},
    load: async () => fixture,
    ...props,
  } as unknown as SkillManagementSectionProps)} />)
  return { root, container }
}

afterEach(() => {
  document.body.innerHTML = ''
})

describe('SkillManagementSection', () => {
  it('renders one tab per workspace with the first workspace active, badges but no provider label', async () => {
    const { root, container } = mount({})
    await act(async () => {})
    // Tabs for every workspace.
    expect(container.textContent).toContain('One')
    expect(container.textContent).toContain('Two')
    // The active workspace's rows; the source badge renders the localized key
    // (the test translator is the identity) instead of the raw source value.
    expect(container.textContent).toContain('global-skill')
    expect(container.textContent).toContain('sourceBundled')
    expect(container.textContent).toContain('project-skill')
    expect(container.textContent).toContain('sourceProjectAgents')
    expect(container.textContent).not.toContain('project-agents')
    // The invocation face and provider labels are never rendered.
    expect(container.textContent).not.toContain('skill-filesystem')
    expect(container.textContent).not.toContain('userOnly')
    // The inactive workspace is not mounted yet.
    expect(container.textContent).not.toContain('find-docs')
    root.unmount()
  })

  it('switches to another workspace tab on click', async () => {
    const { root, container } = mount({})
    await act(async () => {})
    const tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    const second = tabs.find(tab => tab.textContent === 'Two')!
    await act(async () => { second.click() })
    expect(container.textContent).toContain('find-docs')
    expect(container.textContent).toContain('find-skills')
    root.unmount()
  })

  it('filters the active workspace by the search query and reports no matches', async () => {
    const { root, container } = mount({})
    await act(async () => {})
    const input = container.querySelector<HTMLInputElement>('input[type="search"]')!
    // React tracks controlled inputs through the native value setter; bypassing
    // it would leave the tracker stale and the onChange ignored.
    const setValue = (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!
      setter.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    await act(async () => { setValue('project') })
    expect(container.textContent).toContain('project-skill')
    expect(container.textContent).not.toContain('global-skill')
    await act(async () => { setValue('zzz-nothing') })
    expect(container.textContent).toContain('noMatches')
    root.unmount()
  })

  it('renders the error state with a retry affordance when load rejects', async () => {
    const { root, container } = mount({ load: async () => { throw new Error('boom') } })
    await act(async () => {})
    expect(container.textContent).toContain('loadError')
    expect(container.textContent).toContain('boom')
    expect(container.querySelector('button')).not.toBeNull()
    root.unmount()
  })

  it('recovers after a failed load when retry is pressed', async () => {
    let calls = 0
    const load = async (): Promise<CatalogResponse> => {
      calls += 1
      if (calls === 1) throw new Error('boom')
      return fixture
    }
    const { root, container } = mount({ load })
    await act(async () => {})
    expect(container.textContent).toContain('loadError')
    const button = container.querySelector('button')!
    await act(async () => { button.click() })
    await act(async () => {})
    expect(container.textContent).toContain('global-skill')
    root.unmount()
  })
})

describe('sourceLabelKey', () => {
  it('maps every known source to a localized label', () => {
    expect(sourceLabelKey('project-dsh')).toBe('sourceProjectDsh')
    expect(sourceLabelKey('project-agents')).toBe('sourceProjectAgents')
    expect(sourceLabelKey('runtime')).toBe('sourceRuntime')
    expect(sourceLabelKey('user-dsh')).toBe('sourceUserDsh')
    expect(sourceLabelKey('user-agents')).toBe('sourceUserAgents')
    expect(sourceLabelKey('custom')).toBe('sourceCustom')
    expect(sourceLabelKey('bundled')).toBe('sourceBundled')
    expect(sourceLabelKey('unknown-source')).toBeUndefined()
  })

  it('localizes the workspace and user labels in both languages', () => {
    expect(zh.sourceProjectAgents).toBe('工作区')
    expect(en.sourceProjectAgents).toBe('Workspace')
    expect(zh.sourceProjectDsh).toBe('工作区')
    expect(en.sourceProjectDsh).toBe('Workspace')
    expect(zh.sourceUserAgents).toBe('用户')
    expect(en.sourceUserAgents).toBe('User')
    expect(zh.sourceUserDsh).toBe('用户')
    expect(en.sourceUserDsh).toBe('User')
  })
})
