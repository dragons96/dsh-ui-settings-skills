/**
 * Skill management settings page: one tab per workspace (global and user-level
 * skills are already folded in by the host), a name search over the active
 * workspace's rows, and per-skill localized scope badges. Descriptions clamp
 * to two lines and answer a hover with the full text when actually cut off.
 */

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  IconChevronLeftOutline14, IconChevronRightOutline14, IconSearchOutline16, Tooltip,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { CatalogResponse, DimensionView, PutPolicyRequest, SkillRow } from '../wire.ts'
import { sourceLabelKey, type SkillManagementKey } from './locales.ts'
import css from './SkillManagementSection.module.css'

/** Registration-side business face for the management page. */
export interface SkillManagementSectionInjected {
  /** Read the full catalog; called when the section first renders. */
  load: () => Promise<CatalogResponse>
  /** Write one policy toggle (disable or re-enable a skill). */
  setSkillDisabled: (request: PutPolicyRequest) => Promise<void>
}

/** Full component props. */
export type SkillManagementSectionProps =
  PropsRuntime<'settings.section'>
  & PropsLocale<'settings.skillManagement'>
  & InjectFace<SkillManagementSectionInjected>

type PageState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly catalog: CatalogResponse }
  | { readonly phase: 'error'; readonly message: string }

/**
 * The description, clamped by CSS to two lines and offered in full on hover.
 * The tooltip is attached only while the text is actually cut off, so a short
 * description does not answer a hover with a bubble repeating the row.
 * @param description - the skill description.
 * @returns the description element, tooltip-anchored while it overflows.
 */
function ClampedDescription({ description }: { description: string }): ReactNode {
  const ref = useRef<HTMLSpanElement | null>(null)
  const [truncated, setTruncated] = useState(false)
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const measure = () => { setTruncated(el.scrollHeight > el.clientHeight) }
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [description])
  return (
    <Tooltip label={description} side="bottom" delayMs={400} disabled={!truncated} maxWidth={360}>
      {/* The empty title stops the native tooltip from climbing to this span. */}
      <span ref={ref} className={css.rowDesc} title="">{description}</span>
    </Tooltip>
  )
}

/**
 * The localized scope label for one skill source; unknown sources show
 * verbatim.
 * @param source - the wire source value.
 * @param t - the bound locale translator.
 * @returns the display label.
 */
function sourceLabel(source: string, t: (key: SkillManagementKey) => string): string {
  const key = sourceLabelKey(source)
  return key === undefined ? source : t(key)
}

/** The policy scope a row toggles: its disabled scope when disabled, else its source. */
function policyKindOf(row: SkillRow): 'user' | 'workspace' {
  if (row.disabledScope !== undefined) return row.disabledScope
  return row.source === 'user-agents' || row.source === 'user-dsh' ? 'user' : 'workspace'
}

/**
 * Render one skill row: name, right-aligned scope badge, and the enable
 * switch (house track/thumb style).
 * @param row - the skill row.
 * @param t - the bound locale translator.
 * @param workspaceId - the owning workspace (for workspace-kind toggles).
 * @param setSkillDisabled - the policy write face.
 * @param onToggled - called after a successful write with the target state so
 *   the page updates the row locally instead of reloading the catalog.
 * @returns the row.
 */
function SkillRowView({
  row, t, workspaceId, setSkillDisabled, onToggled,
}: {
  row: SkillRow
  t: (key: SkillManagementKey) => string
  workspaceId: string
  setSkillDisabled: (request: PutPolicyRequest) => Promise<void>
  onToggled: (name: string, kind: 'user' | 'workspace', enabled: boolean) => void
}): ReactNode {
  const [saving, setSaving] = useState(false)
  const enabled = row.disabled !== true
  const toggle = async (): Promise<void> => {
    if (saving) return
    setSaving(true)
    try {
      const kind = policyKindOf(row)
      // The write carries the TARGET state: clicking an enabled switch
      // disables the skill, clicking a disabled one re-enables it.
      const target = !enabled
      await setSkillDisabled({
        kind,
        ...(kind === 'workspace' ? { workspaceId } : {}),
        name: row.name,
        description: row.description,
        source: row.source,
        enabled: target,
      })
      onToggled(row.name, kind, target)
    } finally {
      setSaving(false)
    }
  }
  return (
    <li className={css.row}>
      <div className={css.rowHead}>
        <span className={css.rowName}>{row.name}</span>
        <span className={css.badge}>{sourceLabel(row.source, t)}</span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${row.name}: ${enabled ? t('enabled') : t('disabled')}`}
          className={css.switch}
          disabled={saving}
          onClick={() => { void toggle() }}
        >
          <span className={css.track} data-on={enabled ? 'true' : undefined} aria-hidden="true">
            <span className={css.thumb} />
          </span>
        </button>
      </div>
      <ClampedDescription description={row.description} />
    </li>
  )
}

/** Filter one workspace's rows by the current search query (name or description). */
function filterRows(dimension: DimensionView, query: string): readonly SkillRow[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return dimension.skills
  return dimension.skills.filter(row =>
    row.name.toLowerCase().includes(needle) || row.description.toLowerCase().includes(needle),
  )
}

/**
 * Render the Skill management section content column: workspace tabs, a name
 * search, and the active workspace's skill rows.
 * @param props - composed slot props.
 * @returns the section with loading/error/ready states.
 */
export function SkillManagementSection(props: SkillManagementSectionProps): ReactNode {
  const { t, load, setSkillDisabled } = props
  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [activeId, setActiveId] = useState<string>()
  const [visitedIds, setVisitedIds] = useState<ReadonlySet<string>>(() => new Set())
  const [query, setQuery] = useState('')
  const tabsId = useId()
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const tabScrollRef = useRef<HTMLDivElement | null>(null)
  const tabsRef = useRef<HTMLDivElement | null>(null)
  const [scrollState, setScrollState] = useState({ left: 0, max: 0 })

  useEffect(() => {
    let cancelled = false
    setState({ phase: 'loading' })
    void load().then(
      (catalog) => { if (!cancelled) setState({ phase: 'ready', catalog }) },
      (error: unknown) => {
        if (!cancelled) setState({ phase: 'error', message: error instanceof Error ? error.message : String(error) })
      },
    )
    return () => { cancelled = true }
  }, [load, attempt])

  // Measure the tab strip's overflow after layout and whenever the tab set
  // or the strip's size changes, so the arrows enable exactly when content
  // is cut off and disable again once everything is visible.
  useLayoutEffect(() => {
    const el = tabScrollRef.current
    if (el === null) return
    const max = Math.max(0, el.scrollWidth - el.clientWidth)
    setScrollState(prev => {
      const left = Math.min(prev.left, max)
      return left === prev.left && max === prev.max ? prev : { left, max }
    })
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      const current = tabScrollRef.current
      if (current === null) return
      const fresh = Math.max(0, current.scrollWidth - current.clientWidth)
      setScrollState(prev => {
        const left = Math.min(prev.left, fresh)
        return left === prev.left && fresh === prev.max ? prev : { left, max: fresh }
      })
    })
    observer.observe(el)
    if (tabsRef.current !== null) observer.observe(tabsRef.current)
    return () => { observer.disconnect() }
  }, [state])

  const scrollBy = (delta: number): void => {
    tabScrollRef.current?.scrollBy({ left: delta, behavior: 'smooth' })
  }

  /**
   * Apply one successful toggle locally: a user-level toggle flips the skill
   * in every workspace, a workspace toggle only in the active one. The page
   * keeps its loaded catalog; the next reload reconciles with the server.
   * @param name - the toggled skill name.
   * @param kind - the policy scope the write used.
   * @param enabled - the target state just written.
   */
  const applyToggle = (name: string, kind: 'user' | 'workspace', enabled: boolean): void => {
    setState(prev => {
      if (prev.phase !== 'ready') return prev
      return {
        ...prev,
        catalog: {
          ...prev.catalog,
          dimensions: prev.catalog.dimensions.map(dimension => ({
            ...dimension,
            skills: dimension.skills.map(row => {
              if (row.name !== name) return row
              if (kind === 'workspace' && dimension.id !== active) return row
              if (enabled) {
                const { disabled: _disabled, disabledScope: _scope, ...rest } = row
                return rest
              }
              return { ...row, disabled: true, disabledScope: kind }
            }),
          })),
        },
      }
    })
  }

  if (state.phase === 'loading') return <p className={css.status}>{t('loading')}</p>
  if (state.phase === 'error') {
    return (
      <div className={css.section} role="alert">
        <h2 className={css.heading}>{t('title')}</h2>
        <p className={css.error}>{t('loadError')}</p>
        <p className={css.errorDetail}>{state.message}</p>
        <button type="button" className={css.secondaryButton} onClick={() => { setAttempt(value => value + 1) }}>{t('retry')}</button>
      </div>
    )
  }

  const dimensions = state.catalog.dimensions
  const active = dimensions.find(dimension => dimension.id === activeId)?.id ?? dimensions[0]?.id
  const visible = dimensions.filter(dimension => dimension.id === active || visitedIds.has(dimension.id))

  return (
    <div className={css.section}>
      <h2 className={css.heading}>{t('title')}</h2>
      <p className={css.intro}>{t('intro')}</p>
      {dimensions.length === 0 ? <p className={css.empty}>{t('noWorkspaces')}</p> : (
        <>
          <label className={css.search}>
            <IconSearchOutline16 aria-hidden="true" />
            <span className={css.visuallyHidden}>{t('searchPlaceholder')}</span>
            <input
              type="search"
              value={query}
              placeholder={t('searchPlaceholder')}
              aria-label={t('searchPlaceholder')}
              spellCheck={false}
              onChange={(event) => { setQuery(event.currentTarget.value) }}
            />
          </label>
          <div className={css.tabArea}>
            <div className={css.tabRow}>
              <button
                type="button"
                className={css.scrollArrow}
                aria-label={t('scrollLeft')}
                disabled={scrollState.left <= 0}
                onClick={() => { scrollBy(-220) }}
              >
                <IconChevronLeftOutline14 aria-hidden="true" />
              </button>
              <div
                ref={tabScrollRef}
                className={css.tabScroll}
                onScroll={() => {
                  const el = tabScrollRef.current
                  if (el !== null) setScrollState(prev => ({ ...prev, left: Math.min(el.scrollLeft, prev.max) }))
                }}
              >
                <div ref={tabsRef} className={css.tabs} role="tablist" aria-label={t('tabs')}>
                  {dimensions.map((dimension, index) => {
                    const selected = dimension.id === active
                    return (
                      <button
                        key={dimension.id}
                        ref={(element) => { tabRefs.current[index] = element }}
                        id={`${tabsId}-tab-${dimension.id}`}
                        type="button"
                        role="tab"
                        className={css.tab}
                        aria-selected={selected}
                        aria-controls={`${tabsId}-panel-${dimension.id}`}
                        data-active={selected ? 'true' : undefined}
                        tabIndex={selected ? 0 : -1}
                        onClick={() => { setActiveId(dimension.id) }}
                        onKeyDown={(event) => {
                          let nextIndex: number
                          switch (event.key) {
                            case 'ArrowRight': nextIndex = (index + 1) % dimensions.length; break
                            case 'ArrowLeft': nextIndex = (index - 1 + dimensions.length) % dimensions.length; break
                            case 'Home': nextIndex = 0; break
                            case 'End': nextIndex = dimensions.length - 1; break
                            default: return
                          }
                          event.preventDefault()
                          const next = dimensions[nextIndex] as DimensionView
                          const nextTab = tabRefs.current[nextIndex] as HTMLButtonElement
                          setActiveId(next.id)
                          nextTab.focus()
                        }}
                      >
                        {dimension.title}
                      </button>
                    )
                  })}
                </div>
              </div>
              <button
                type="button"
                className={css.scrollArrow}
                aria-label={t('scrollRight')}
                disabled={scrollState.left >= scrollState.max}
                onClick={() => { scrollBy(220) }}
              >
                <IconChevronRightOutline14 aria-hidden="true" />
              </button>
            </div>
          </div>
          {visible.map((dimension) => {
            const selected = dimension.id === active
            return (
              <div
                key={dimension.id}
                id={`${tabsId}-panel-${dimension.id}`}
                className={css.panel}
                role="tabpanel"
                aria-labelledby={`${tabsId}-tab-${dimension.id}`}
                hidden={!selected}
              >
                {dimension.error !== undefined
                  ? <p className={css.error} role="alert">{t('dimensionError')}</p>
                  : (() => {
                    const rows = filterRows(dimension, query)
                    if (rows.length === 0) {
                      return <p className={css.empty}>{query.trim() === '' ? t('empty') : t('noMatches')}</p>
                    }
                    return (
                      <ul className={css.list}>
                        {rows.map(row => (
                          <SkillRowView
                            key={row.name}
                            row={row}
                            t={t}
                            workspaceId={dimension.id}
                            setSkillDisabled={setSkillDisabled}
                            onToggled={applyToggle}
                          />
                        ))}
                      </ul>
                    )
                  })()}
              </div>
            )
          })}
        </>
      )}
    </div>
  )
}
