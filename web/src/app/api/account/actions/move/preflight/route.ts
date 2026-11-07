/**
 * POST /api/account/actions/move/preflight
 *
 * Returns what a move of the given actions would cost, so the move dialog can
 * render an honest disclosure before the user commits:
 *
 *   - `actions` — the selected actions that actually live in the caller's
 *     current workspace (identifier + title, for the "these will move" list).
 *   - `external_tasks` — Jira/Linear/Asana links that the move severs; the
 *     external task keeps existing but stops syncing.
 *   - `attachments` / `agent_runs` — files that travel along vs agent runs
 *     that are dropped (their sandboxes/PR history are workspace-scoped).
 *   - `crossing_relations` — blocks/related links with exactly ONE endpoint in
 *     the selection. Those get severed; links wholly inside the selection
 *     survive the move.
 *
 * POST rather than GET on purpose: a bulk selection can carry 500 ids, which
 * blows past URL length limits as a query string.
 *
 * No destination_workspace_id is needed — the numbers are the same wherever
 * the actions land (the destination only matters for permission and
 * identifier-collision checks, both enforced at move time).
 *
 * Scoped to the caller's CURRENT workspace: ids outside it are silently
 * omitted rather than 404'd, so a stale selection degrades gracefully and a
 * multi-workspace user can't probe actions outside the workspace they're
 * viewing.
 */
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, serverError } from '@/lib/api-errors'
import { NextResponse } from 'next/server'

/** Matches the move route / engine ceiling. */
const MAX_ACTION_IDS = 500

/**
 * PostgREST sends `IN` lists as a query string, so an unbounded `.in()` on 500
 * uuids exceeds the URL limit. Every id-list read below is issued in chunks of
 * this size and the results concatenated.
 */
const IN_CHUNK_SIZE = 100

function chunkIds(ids: string[], size = IN_CHUNK_SIZE): string[][] {
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size))
  return chunks
}

/** PostgREST results don't throw; every query carries its own .error field.
 * Silently under-counting would defeat the purpose of the disclosure, so any
 * errored query fails the whole preflight loudly. */
function firstError(
  results: { error: { message: string } | null }[],
): string | null {
  const failed = results.find((r) => r.error)
  return failed?.error?.message ?? null
}

function sumCounts(results: { count?: number | null }[]): number {
  return results.reduce((total, r) => total + (r.count ?? 0), 0)
}

interface ActionRow {
  id: string
  identifier: string | null
  title: string
}

interface ExternalTaskRow {
  action_id: string
  provider: string
  external_title: string | null
  external_url: string | null
}

interface RelationRow {
  id: string
  action_id: string
  related_action_id: string
}

export async function POST(req: Request) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  let body: { action_ids?: unknown } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const rawActionIds = body?.action_ids
  if (
    !Array.isArray(rawActionIds) ||
    rawActionIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return badRequest('action_ids must be an array of action ids')
  }
  const requestedIds = [...new Set(rawActionIds as string[])]
  if (requestedIds.length === 0) {
    return badRequest('action_ids is required')
  }
  if (requestedIds.length > MAX_ACTION_IDS) {
    return badRequest('action_ids is too large')
  }

  // Round 1 — resolve the selection against the current workspace. Everything
  // downstream keys off the ids that survive this filter, so an id from
  // another workspace can't drag its artifacts into the disclosure.
  const actionResults = await Promise.all(
    chunkIds(requestedIds).map((ids) =>
      supabase
        .from('actions')
        .select('id, identifier, title')
        .eq('workspace_id', workspaceId)
        .in('id', ids),
    ),
  )
  const actionsError = firstError(actionResults)
  if (actionsError) {
    console.error('[actions_move_preflight] action lookup failed:', actionsError)
    return serverError('Preflight failed')
  }

  const actions = actionResults.flatMap((r) => (r.data ?? []) as ActionRow[])
  const actionIds = actions.map((a) => a.id)

  if (actionIds.length === 0) {
    return NextResponse.json({
      actions: [],
      external_tasks: [],
      attachments: 0,
      agent_runs: 0,
      crossing_relations: 0,
    })
  }

  // Round 2 — the artifacts hanging off the resolved ids. Relations are read
  // from both ends because a crossing link may be stored in either direction.
  const idChunks = chunkIds(actionIds)
  const [externalRes, attachmentRes, agentRunRes, relationOutRes, relationInRes] =
    await Promise.all([
      Promise.all(
        idChunks.map((ids) =>
          supabase
            .from('action_external_task')
            .select('action_id, provider, external_title, external_url')
            .eq('workspace_id', workspaceId)
            .in('action_id', ids),
        ),
      ),
      Promise.all(
        idChunks.map((ids) =>
          supabase
            .from('attachments')
            .select('id', { count: 'exact', head: true })
            .in('action_id', ids),
        ),
      ),
      Promise.all(
        idChunks.map((ids) =>
          supabase
            .from('agent_run')
            .select('id', { count: 'exact', head: true })
            .in('action_id', ids),
        ),
      ),
      Promise.all(
        idChunks.map((ids) =>
          supabase
            .from('action_relation')
            .select('id, action_id, related_action_id')
            .in('action_id', ids),
        ),
      ),
      Promise.all(
        idChunks.map((ids) =>
          supabase
            .from('action_relation')
            .select('id, action_id, related_action_id')
            .in('related_action_id', ids),
        ),
      ),
    ])

  const artifactError = firstError([
    ...externalRes,
    ...attachmentRes,
    ...agentRunRes,
    ...relationOutRes,
    ...relationInRes,
  ])
  if (artifactError) {
    console.error('[actions_move_preflight] artifact query failed:', artifactError)
    return serverError('Preflight failed')
  }

  const externalTasks = externalRes.flatMap(
    (r) => (r.data ?? []) as ExternalTaskRow[],
  )

  // A relation with both endpoints inside the selection comes back from both
  // directions, so dedupe by row id before deciding which ones cross.
  const movingIds = new Set(actionIds)
  const relations = new Map<string, RelationRow>()
  for (const res of [...relationOutRes, ...relationInRes]) {
    for (const row of (res.data ?? []) as RelationRow[]) {
      relations.set(row.id, row)
    }
  }
  let crossingRelations = 0
  for (const row of relations.values()) {
    if (movingIds.has(row.action_id) !== movingIds.has(row.related_action_id)) {
      crossingRelations += 1
    }
  }

  return NextResponse.json({
    actions: actions.map((a) => ({
      id: a.id,
      identifier: a.identifier,
      title: a.title,
    })),
    external_tasks: externalTasks.map((t) => ({
      action_id: t.action_id,
      provider: t.provider,
      external_title: t.external_title,
      external_url: t.external_url,
    })),
    attachments: sumCounts(attachmentRes),
    agent_runs: sumCounts(agentRunRes),
    crossing_relations: crossingRelations,
  })
}
