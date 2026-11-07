/**
 * GET /api/account/projects/[id]/move/preflight
 *
 * What a cross-workspace move of this project would drag along, so the move
 * dialog can disclose it before the user commits:
 *
 *   - `actions` / `documents` / `milestones` — travel with the project
 *     (documents only when the caller keeps `move_documents` on).
 *   - `captures_to_unlink` — captures filed under the project. They STAY and
 *     lose the project link; a capture has its own move flow.
 *   - `views_to_delete` — project-scoped saved views. Their filters reference
 *     workspace-scoped ids that don't translate, so the move deletes them.
 *   - `labels` — project labels, remapped by name in the destination where a
 *     same-named label exists and dropped otherwise.
 *   - `external_tasks` — Jira/Linear/Asana links on the project's actions.
 *     The move severs every one of them; naming them lets the user re-link
 *     deliberately rather than discover the silence later.
 *
 * No destination_workspace_id is needed: the counts don't depend on where the
 * project lands (the destination only matters for permission checks and label
 * name matching, both enforced at move time).
 *
 * Scoped to the caller's CURRENT workspace. A user with access to several
 * workspaces can only preflight projects in the one they're actively viewing
 * — without that pin they could probe any project RLS lets them read and
 * learn cross-workspace counts.
 */
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { NextResponse } from 'next/server'

/** PostgREST results don't throw; every query carries its own .error field.
 * Silently under-counting would defeat the purpose of the disclosure, so any
 * errored query fails the whole preflight loudly. */
function firstError(
  results: { error: { message: string } | null }[],
): string | null {
  const failed = results.find((r) => r.error)
  return failed?.error?.message ?? null
}

/** `.in()` serializes into the query string, so a project with thousands of
 * actions would blow the URL length limit in one request. */
const IN_CHUNK = 100

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

interface ExternalTaskRow {
  action_id: string
  provider: string
  external_title: string | null
  external_url: string | null
}

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id: projectId } = await params

  // Belt-and-suspenders: RLS already filters projects by workspace
  // membership, but we additionally pin to the caller's current workspace.
  const { data: project, error: projectErr } = await supabase
    .from('projects')
    .select('id, workspace_id')
    .eq('id', projectId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (projectErr) {
    console.error('[project_move_preflight] project lookup failed:', projectErr.message)
    return serverError('Preflight failed')
  }
  if (!project) return notFound('Project not found')

  // Actions come back as rows (not a count) because round 2 needs their ids
  // for the external-task lookup — paged, because PostgREST silently caps a
  // single response (default 1000 rows) and a truncated id list would both
  // under-count the disclosure and hide external-task links.
  const PAGE = 1000
  const actionIds: string[] = []
  for (let from = 0; ; from += PAGE) {
    const page = await supabase
      .from('actions')
      .select('id')
      .eq('project_id', projectId)
      .eq('workspace_id', workspaceId)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (page.error) {
      console.error('[project_move_preflight] action page failed:', page.error.message)
      return serverError('Preflight failed')
    }
    const rows = (page.data ?? []) as { id: string }[]
    actionIds.push(...rows.map((a) => a.id))
    if (rows.length < PAGE) break
  }

  // Round 1 — the rest of the project's closure.
  const round1 = await Promise.all([
    supabase
      .from('document')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('workspace_id', workspaceId),
    supabase
      .from('milestone')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId),
    supabase
      .from('captures')
      .select('id', { count: 'exact', head: true })
      .eq('project_id', projectId)
      .eq('workspace_id', workspaceId),
    supabase
      .from('view')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('scope_type', 'project')
      .eq('scope_id', projectId),
    supabase
      .from('project_label')
      .select('label_id', { count: 'exact', head: true })
      .eq('project_id', projectId),
  ])

  const round1Error = firstError(round1)
  if (round1Error) {
    console.error('[project_move_preflight] count query failed:', round1Error)
    return serverError('Preflight failed')
  }

  const [documentsRes, milestonesRes, capturesRes, viewsRes, labelsRes] = round1

  // Round 2 — external tracker links on those actions, chunked so the `IN`
  // list can't overflow the URL. Skipped entirely for a project with no
  // actions rather than sent as `IN ()`.
  const externalTasks: ExternalTaskRow[] = []
  if (actionIds.length > 0) {
    const batches = await Promise.all(
      chunk(actionIds, IN_CHUNK).map((ids) =>
        supabase
          .from('action_external_task')
          .select('action_id, provider, external_title, external_url')
          .eq('workspace_id', workspaceId)
          .in('action_id', ids),
      ),
    )
    const batchError = firstError(batches)
    if (batchError) {
      console.error('[project_move_preflight] external task query failed:', batchError)
      return serverError('Preflight failed')
    }
    for (const batch of batches) {
      externalTasks.push(...((batch.data ?? []) as ExternalTaskRow[]))
    }
  }

  return NextResponse.json({
    project_id: projectId,
    actions: actionIds.length,
    documents: documentsRes.count ?? 0,
    milestones: milestonesRes.count ?? 0,
    captures_to_unlink: capturesRes.count ?? 0,
    views_to_delete: viewsRes.count ?? 0,
    labels: labelsRes.count ?? 0,
    external_tasks: externalTasks,
  })
}
