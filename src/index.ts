/**
 * ui-settings-skills host half: serves the skill-management catalog over the
 * plugin's own HTTP route (`ctx.webServer`). The catalog exposes one
 * dimension per registered workspace; every workspace folds in the global
 * layer, the current user's user-level rows (every live agent's scoped view
 * contributes its `user-agents` / `user-dsh` rows), the workspace's per-cwd
 * global view, and the scoped views of its live sessions (the workspace
 * record owns the session mapping). Per-session granularity is never shown.
 *
 * M2 toggles: a settings-namespace policy records disabled skills (user level
 * and per workspace); rank-0 shadowing providers replace them with stubs so
 * every `ctx.skills` consumer (model catalog, `/name` injection, the ui-skill
 * menu RPC) stops seeing them, and the catalog marks them disabled so the
 * page renders the toggle off. The stub is mounted on the global registry
 * and, through each live agent, on the agent's own preset registry when the
 * preset composes one — both host-provider compositions (TUI/headless) and
 * web compositions (providers behind agent presets) are covered. The browser
 * never submits a raw path.
 *
 * @module ui-settings-skills
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.skills Context merge.
import type {} from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
// Type-only: pulls the ctx.workspaceRegistry Context merge.
import type {} from '@deepseek-ai/dsh-workspace'
// Type-only: pulls the ctx.webServer Context merge.
import type {} from '@deepseek-ai/dsh-host-webserver'
// Type-only: pulls the ctx.agents Context merge.
import type {} from '@deepseek-ai/dsh-agent'
// Type-only: pulls the ctx.settings Context merge.
import type {} from '@deepseek-ai/dsh-settings'
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import {
  createPolicyProvider, POLICY_NS, POLICY_PROVIDER, policySchema, readPolicy, updatePolicy,
} from './policy.ts'
import type { SkillPolicy } from './policy.ts'
import z from '@deepseek-ai/schemastery'
import type { CatalogResponse, DimensionView, ErrorResponse, PutPolicyRequest, SkillRow } from './wire.ts'

export const name = 'ui-settings-skills'

/** Services required by the catalog route. */
export const inject = ['skills', 'workspaceRegistry', 'webServer', 'agents']

/** Plugin role: host (routes + namespace + provider) or policy (provider only). */
export const Config = z.object({
  role: z.string().default('host'),
})

/** Route prefix under which the plugin serves its API. */
export const API_PREFIX = '/plugin/settings-skills'

/** Skill sources the page manages: the user's own skills and project skills. Preset-loaded skills (`custom`) and built-ins are not managed and never shown. */
const VISIBLE_SOURCES = new Set(['user-agents', 'user-dsh', 'project-dsh', 'project-agents'])

/** User-level skill sources (the current user's own skills). */
const USER_LEVEL_SOURCES = new Set(['user-agents', 'user-dsh'])

/** The subset of `ctx.skills` the aggregation reads. */
export interface SkillsReader {
  snapshot(options?: { readonly cwd?: string; readonly scope?: ScopeKey }): Promise<{ readonly skills: readonly SkillSummary[] }>
}

/** One workspace row the aggregation resolves. */
export interface WorkspaceRow {
  readonly workspaceId: string
  readonly path: string
  readonly title: string
  /** Sessions accounted under this workspace; live ones contribute their scope views. */
  readonly sessionIds: readonly string[]
}

/** One live agent's scoped view. */
export interface LiveAgentRow {
  /** The live agent is its own scope key. */
  readonly scope: ScopeKey
}

/** Map one registry summary onto the wire row. */
export function toSkillRow(skill: SkillSummary): SkillRow {
  return {
    name: skill.name,
    description: skill.description,
    ...(skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {}),
    source: skill.source,
    provider: skill.provider,
    modelInvocable: skill.invocation.modelInvocable,
    userInvocable: skill.invocation.userInvocable,
    ...(skill.resourceBase !== undefined ? { resourceBaseKind: skill.resourceBase.kind } : {}),
  }
}

/**
 * Merge skill rows by name, first row winning, sorted by name.
 * @param batches - row batches in precedence order.
 * @returns the merged rows.
 */
function mergeRows(...batches: readonly SkillRow[][]): SkillRow[] {
  const merged = new Map<string, SkillRow>()
  for (const batch of batches) {
    for (const row of batch) {
      if (!merged.has(row.name)) merged.set(row.name, row)
    }
  }
  return [...merged.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
}

/** Filter to the managed sources, dropping policy stub rows and preset/built-in skills. */
function visibleRows(rows: readonly SkillRow[]): SkillRow[] {
  return rows.filter(row => row.provider !== POLICY_PROVIDER && VISIBLE_SOURCES.has(row.source))
}

/** The disabled rows for one workspace: user-level entries plus the workspace's own. */
function disabledRowsFor(policy: SkillPolicy, workspaceId: string): Map<string, SkillRow> {
  const rows = new Map<string, SkillRow>()
  for (const [name, entry] of Object.entries(policy.user)) {
    rows.set(name, {
      name,
      description: entry.description,
      source: entry.source,
      provider: POLICY_PROVIDER,
      modelInvocable: false,
      userInvocable: false,
      disabled: true,
      disabledScope: 'user',
    })
  }
  const workspaceEntries = policy.workspace[workspaceId]
  if (workspaceEntries !== undefined) {
    for (const [name, entry] of Object.entries(workspaceEntries)) {
      rows.set(name, {
        name,
        description: entry.description,
        source: entry.source,
        provider: POLICY_PROVIDER,
        modelInvocable: false,
        userInvocable: false,
        disabled: true,
        disabledScope: 'workspace',
      })
    }
  }
  return rows
}

/**
 * Aggregate the catalog. One dimension per workspace in registry order, each
 * folding the global layer, the user-level rows of every live agent, the
 * workspace's per-cwd global view, and the scoped views of its live sessions.
 * Policy-disabled skills are replaced by their policy rows (rendered with the
 * toggle off); a workspace whose collection fails yields an error-bearing
 * view instead of failing the whole response; a failing session is contained
 * inside its workspace.
 * @param skills - the skill registry reader.
 * @param agentsBySession - live agents keyed by session id (read at request time).
 * @param workspaces - workspace rows.
 * @param policy - the current disable policy.
 * @returns the workspace dimension views.
 */
export async function buildCatalog(
  skills: SkillsReader,
  agentsBySession: ReadonlyMap<string, LiveAgentRow>,
  workspaces: readonly WorkspaceRow[],
  policy: SkillPolicy = { user: {}, workspace: {} },
): Promise<DimensionView[]> {
  const globalRows = visibleRows((await skills.snapshot()).skills.map(toSkillRow))
  const userLevelRows: SkillRow[] = []
  for (const row of globalRows) {
    if (USER_LEVEL_SOURCES.has(row.source)) userLevelRows.push(row)
  }
  const agents = [...agentsBySession.values()]
  for (const agent of agents) {
    try {
      for (const row of visibleRows((await skills.snapshot({ scope: agent.scope })).skills.map(toSkillRow))) {
        if (USER_LEVEL_SOURCES.has(row.source)) userLevelRows.push(row)
      }
    } catch {
      // One agent's scope failure must not fail the whole catalog.
    }
  }
  const userRows = mergeRows(userLevelRows)
  const dimensions: DimensionView[] = []
  for (const workspace of workspaces) {
    try {
      const scopedRows: SkillRow[][] = [
        globalRows,
        userRows,
        // The global layer's per-cwd view (host-plane providers; the web-app
        // bundle disables them, so this batch is empty there).
        visibleRows((await skills.snapshot({ cwd: workspace.path })).skills.map(toSkillRow)),
      ]
      for (const sessionId of workspace.sessionIds) {
        const agent = agentsBySession.get(sessionId)
        if (agent === undefined) continue
        try {
          scopedRows.push(visibleRows((await skills.snapshot({ scope: agent.scope, cwd: workspace.path })).skills.map(toSkillRow)))
        } catch {
          // One session's scope failure must not fail the whole workspace.
        }
      }
      const merged = new Map(mergeRows(...scopedRows).map(row => [row.name, row]))
      // Policy rows win: a disabled skill renders off even where a live view
      // still carries it.
      for (const [name, row] of disabledRowsFor(policy, workspace.workspaceId)) merged.set(name, row)
      dimensions.push({
        kind: 'workspace',
        id: workspace.workspaceId,
        title: workspace.title,
        skills: [...merged.values()].sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0),
      })
    } catch (error) {
      dimensions.push({
        kind: 'workspace',
        id: workspace.workspaceId,
        title: workspace.title,
        skills: [],
        error: { code: 'workspace-catalog-failed', message: String(error) },
      })
    }
  }
  return dimensions
}

/** Write one JSON response with no-store caching. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** Uniform error body. */
function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } }
}

/** Narrow an unknown JSON value to a policy toggle write, throwing on malformed fields. */
function parsePolicyUpdate(body: unknown): PutPolicyRequest {
  const value = body as Partial<PutPolicyRequest> | null
  if (typeof value !== 'object' || value === null) throw new Error('policy update must be an object')
  const { kind, workspaceId, name, description, source, enabled } = value
  if (kind !== 'user' && kind !== 'workspace') throw new Error('policy update kind must be "user" or "workspace"')
  if (typeof name !== 'string' || name.length === 0) throw new Error('policy update requires a skill name')
  if (typeof description !== 'string') throw new Error('policy update requires a description')
  if (typeof source !== 'string') throw new Error('policy update requires a source')
  if (typeof enabled !== 'boolean') throw new Error('policy update requires a boolean enabled')
  if (kind === 'workspace' && (typeof workspaceId !== 'string' || workspaceId.length === 0)) {
    throw new Error('workspace policy update requires a workspaceId')
  }
  return {
    kind,
    ...(workspaceId !== undefined ? { workspaceId } : {}),
    name,
    description,
    source,
    enabled,
  }
}

/**
 * Route handler for the plugin API.
 * @param ctx - the plugin context, for logging and services.
 * @param skills - the skill registry reader.
 * @param agentsBySession - live agent supplier keyed by session id (read at request time).
 * @param workspaces - workspace row supplier (read at request time).
 * @param invalidatePolicy - invalidate the shadowing provider's catalog caches.
 * @returns the node:http handler.
 */
function makeHandler(
  ctx: Context,
  skills: SkillsReader,
  agentsBySession: () => ReadonlyMap<string, LiveAgentRow>,
  workspaces: () => readonly WorkspaceRow[],
  invalidatePolicy: () => void,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://ui-settings-skills').pathname
      if (pathname === `${API_PREFIX}/catalog`) {
        if (req.method !== 'GET') {
          sendJson(res, 405, errorBody('method-not-allowed', `method ${req.method} is not allowed`))
          return
        }
        const dimensions = await buildCatalog(skills, agentsBySession(), workspaces(), readPolicy(ctx))
        sendJson(res, 200, { dimensions } satisfies CatalogResponse)
        return
      }
      if (pathname === `${API_PREFIX}/policy`) {
        if (req.method !== 'PUT') {
          sendJson(res, 405, errorBody('method-not-allowed', `method ${req.method} is not allowed`))
          return
        }
        const body = await readJsonBody(req)
        const update = parsePolicyUpdate(body)
        await updatePolicy(ctx, update)
        invalidatePolicy()
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, errorBody('not-found', `unknown route ${pathname}`))
    } catch (error) {
      ctx.logger.warn(`ui-settings-skills: ${String(error)}`)
      sendJson(res, 400, errorBody('bad-request', String(error)))
    }
  }
}

/** Read a bounded JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

/**
 * Register the shadowing provider, and — in the host role — the settings
 * namespace and the HTTP routes. A policy role (`config.role === 'policy'`)
 * registers only the provider, without the namespace or routes.
 */
export function apply(ctx: Context, config: { role?: string } = {}): void {
  const skills = ctx.skills
  const role = config.role ?? 'host'

  if (role === 'host') {
    const settings = ctx.get('settings') as { register?: (ns: string, schema: unknown) => { dispose?: () => void } } | undefined
    if (settings?.register !== undefined) {
      ctx.effect(() => {
        // The closure re-checks because property narrowing does not survive
        // into a deferred callback.
        if (settings?.register === undefined) return () => {}
        const scope = settings.register(POLICY_NS, policySchema)
        return () => { scope.dispose?.() }
      }, 'ui-settings-skills: policy namespace')
    }
  }

  let invalidatePolicy = (): void => {}
  // Every registration's invalidation control (global instance plus one per
  // live agent's preset registry); WeakRefs let a disposed agent's closure be
  // collected. A stale control is a no-op, but dropping it keeps the set from
  // growing across agent lifecycles.
  const invalidators = new Set<WeakRef<() => void>>()
  const fireInvalidators = (): void => {
    for (const ref of invalidators) {
      const invalidate = ref.deref()
      if (invalidate === undefined) invalidators.delete(ref)
      else invalidate()
    }
  }
  ctx.effect(() => skills.registerProvider((control) => {
    invalidators.add(new WeakRef(control.invalidate))
    invalidatePolicy = fireInvalidators
    return createPolicyProvider(ctx, () => readPolicy(ctx))
  }), 'ui-settings-skills: policy provider')

  // A global-layer provider alone cannot shadow web compositions: the ui-skill
  // `/` menu and the model catalog read the agent preset's OWN SkillRegistry
  // (isolated behind the preset's realm), where a global registry cannot win.
  // Mount the provider both on the global registry's agent layer
  // (TUI/headless) and — when the agent's preset composes its own registry —
  // directly on that registry, whose context carries the agent's scope tag so
  // the stub files into the same layer as the preset's real providers. A
  // failing mount must not veto agent publication, so it is contained here.
  type PolicyControl = { invalidate: () => void }
  type PolicyRegisterable = { registerProvider?: (create: (control: PolicyControl) => unknown) => () => void }
  const presets = ctx.get('agentPresets') as { serviceFor?: (agent: unknown, name: string) => PolicyRegisterable | undefined } | undefined
  const mountScopeProvider = (agent: { readonly ctx: Context }): void => {
    agent.ctx.effect(() => {
      const disposers: Array<() => void> = [
        agent.ctx.skills.registerProvider((control) => {
          invalidators.add(new WeakRef(control.invalidate))
          return createPolicyProvider(agent.ctx, () => readPolicy(ctx))
        }),
      ]
      const presetRegistry = presets?.serviceFor?.(agent, 'skills')
      if (presetRegistry?.registerProvider !== undefined) {
        disposers.push(presetRegistry.registerProvider((control) => {
          invalidators.add(new WeakRef(control.invalidate))
          return createPolicyProvider(agent.ctx, () => readPolicy(ctx))
        }))
      }
      return () => {
        for (const dispose of disposers) dispose()
      }
    }, 'ui-settings-skills: scoped policy provider')
  }
  const mountAllScoped = (): void => {
    for (const agent of ctx.agents.list()) {
      try {
        mountScopeProvider(agent)
      } catch (error) {
        ctx.logger.warn(`ui-settings-skills: scoped policy provider for agent "${agent.id}" failed: ${String(error)}`)
      }
    }
  }
  mountAllScoped()
  ctx.on('agent/created', ({ agent }) => {
    try {
      mountScopeProvider(agent)
    } catch (error) {
      ctx.logger.warn(`ui-settings-skills: scoped policy provider for agent "${agent.id}" failed: ${String(error)}`)
    }
  })

  if (role !== 'host') return

  const agentsBySession = () => new Map(
    ctx.agents.list().map(agent => [String(agent.id), { scope: agent } satisfies LiveAgentRow]),
  )
  const workspaces = () => ctx.workspaceRegistry.list().map(workspace => ({
    workspaceId: workspace.id,
    path: workspace.path,
    title: workspace.title,
    sessionIds: workspace.sessionIds.map(String),
  }))
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'prefix',
      path: API_PREFIX,
      handler: makeHandler(ctx, skills, agentsBySession, workspaces, () => invalidatePolicy()),
    }),
    'ui-settings-skills: catalog route',
  )
}
