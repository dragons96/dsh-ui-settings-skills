/**
 * ui-settings-skills host half: serves the skill-management catalog over the
 * plugin's own HTTP route (`ctx.webServer`). The catalog exposes one
 * dimension per registered workspace; every workspace folds in the global
 * layer, the current user's user-level rows (every live agent's scoped view
 * contributes its `user-agents` / `user-dsh` rows), the workspace's per-cwd
 * global view, and the scoped views of its live sessions (the workspace
 * record owns the session mapping). Per-session granularity is never shown.
 * The browser never submits a raw path.
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
import type { ScopeKey } from '@deepseek-ai/dsh-scope'
import type { CatalogResponse, DimensionView, ErrorResponse, SkillRow } from './wire.ts'

export const name = 'ui-settings-skills'

/** Services required by the catalog route. */
export const inject = ['skills', 'workspaceRegistry', 'webServer', 'agents']

/** Route prefix under which the plugin serves its API. */
export const API_PREFIX = '/plugin/settings-skills'

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

/**
 * Aggregate the catalog. One dimension per workspace in registry order, each
 * folding the global layer, the user-level rows of every live agent, the
 * workspace's per-cwd global view, and the scoped views of its live sessions.
 * A workspace whose collection fails yields an error-bearing view instead of
 * failing the whole response; a failing session is contained inside its
 * workspace.
 * @param skills - the skill registry reader.
 * @param agentsBySession - live agents keyed by session id (read at request time).
 * @param workspaces - workspace rows.
 * @returns the workspace dimension views.
 */
export async function buildCatalog(
  skills: SkillsReader,
  agentsBySession: ReadonlyMap<string, LiveAgentRow>,
  workspaces: readonly WorkspaceRow[],
): Promise<DimensionView[]> {
  const globalRows = (await skills.snapshot()).skills.map(toSkillRow)
  const userLevelRows: SkillRow[] = []
  for (const row of globalRows) {
    if (USER_LEVEL_SOURCES.has(row.source)) userLevelRows.push(row)
  }
  const agents = [...agentsBySession.values()]
  for (const agent of agents) {
    try {
      for (const row of (await skills.snapshot({ scope: agent.scope })).skills) {
        if (USER_LEVEL_SOURCES.has(row.source)) userLevelRows.push(toSkillRow(row))
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
        (await skills.snapshot({ cwd: workspace.path })).skills.map(toSkillRow),
      ]
      for (const sessionId of workspace.sessionIds) {
        const agent = agentsBySession.get(sessionId)
        if (agent === undefined) continue
        try {
          scopedRows.push((await skills.snapshot({ scope: agent.scope, cwd: workspace.path })).skills.map(toSkillRow))
        } catch {
          // One session's scope failure must not fail the whole workspace.
        }
      }
      dimensions.push({
        kind: 'workspace',
        id: workspace.workspaceId,
        title: workspace.title,
        skills: mergeRows(...scopedRows),
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

/**
 * Route handler for the plugin API.
 * @param ctx - the plugin context, for logging.
 * @param skills - the skill registry reader.
 * @param agentsBySession - live agent supplier keyed by session id (read at request time).
 * @param workspaces - workspace row supplier (read at request time).
 * @returns the node:http handler.
 */
function makeHandler(
  ctx: Context,
  skills: SkillsReader,
  agentsBySession: () => ReadonlyMap<string, LiveAgentRow>,
  workspaces: () => readonly WorkspaceRow[],
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    try {
      const pathname = new URL(req.url ?? '/', 'http://ui-settings-skills').pathname
      if (req.method !== 'GET') {
        sendJson(res, 405, errorBody('method-not-allowed', `method ${req.method} is not allowed`))
        return
      }
      if (pathname === `${API_PREFIX}/catalog`) {
        const dimensions = await buildCatalog(skills, agentsBySession(), workspaces())
        sendJson(res, 200, { dimensions } satisfies CatalogResponse)
        return
      }
      sendJson(res, 404, errorBody('not-found', `unknown route ${pathname}`))
    } catch (error) {
      ctx.logger.warn(`ui-settings-skills: ${String(error)}`)
      sendJson(res, 500, errorBody('internal', String(error)))
    }
  }
}

/** Register the catalog route; disposal unregisters it. */
export function apply(ctx: Context): void {
  const skills = ctx.skills
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
    () => ctx.webServer.register({ kind: 'prefix', path: API_PREFIX, handler: makeHandler(ctx, skills, agentsBySession, workspaces) }),
    'ui-settings-skills: catalog route',
  )
}
