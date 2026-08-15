/** Locale namespace for the Skill management settings page. */
export const NS = 'settings.skillManagement'

const keys = [
  'nav', 'title', 'intro', 'tabs', 'searchPlaceholder', 'loading', 'loadError', 'retry',
  'empty', 'noWorkspaces', 'noMatches', 'dimensionError',
  'sourceProjectDsh', 'sourceProjectAgents', 'sourceRuntime', 'sourceUserDsh', 'sourceUserAgents', 'sourceCustom', 'sourceBundled',
] as const

export type SkillManagementKey = typeof keys[number]

export const en: Record<SkillManagementKey, string> = {
  nav: 'Skills',
  title: 'Skill management',
  intro: 'Skills grouped by workspace, with global and user-level skills folded in.',
  tabs: 'Workspaces',
  searchPlaceholder: 'Search skills',
  loading: 'Loading skills…',
  loadError: 'Failed to load the skill catalog.',
  retry: 'Retry',
  empty: 'No skills in this workspace.',
  noWorkspaces: 'No workspaces yet.',
  noMatches: 'No skills match the search.',
  dimensionError: 'This workspace catalog could not be loaded.',
  sourceProjectDsh: 'Workspace',
  sourceProjectAgents: 'Workspace',
  sourceRuntime: 'Runtime',
  sourceUserDsh: 'User',
  sourceUserAgents: 'User',
  sourceCustom: 'Custom',
  sourceBundled: 'Bundled',
}

export const zh: Record<SkillManagementKey, string> = {
  nav: '技能',
  title: '技能管理',
  intro: '技能按工作区组织，全局与用户级技能已叠加到每个工作区。',
  tabs: '工作区',
  searchPlaceholder: '搜索技能…',
  loading: '正在加载技能…',
  loadError: '技能目录加载失败。',
  retry: '重试',
  empty: '该工作区没有技能。',
  noWorkspaces: '还没有工作区。',
  noMatches: '没有匹配搜索的技能。',
  dimensionError: '该工作区的技能目录加载失败。',
  sourceProjectDsh: '工作区',
  sourceProjectAgents: '工作区',
  sourceRuntime: '运行时',
  sourceUserDsh: '用户',
  sourceUserAgents: '用户',
  sourceCustom: '自定义',
  sourceBundled: '内置',
}

/** The localized key for one skill source; undefined for unknown sources (shown verbatim). */
export function sourceLabelKey(source: string): SkillManagementKey | undefined {
  switch (source) {
    case 'project-dsh': return 'sourceProjectDsh'
    case 'project-agents': return 'sourceProjectAgents'
    case 'runtime': return 'sourceRuntime'
    case 'user-dsh': return 'sourceUserDsh'
    case 'user-agents': return 'sourceUserAgents'
    case 'custom': return 'sourceCustom'
    case 'bundled': return 'sourceBundled'
    default: return undefined
  }
}
