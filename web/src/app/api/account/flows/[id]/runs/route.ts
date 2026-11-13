/**
 * GET /api/account/flows/[id]/runs — last N runs of this flow, newest first.
 *
 * Used by the Flows view to show the "Last runs" history pane. `?include=<runId>`
 * guarantees that one run is in the response even when it has aged out of the
 * page — a notification deep link lands on a specific run, which may be older
 * than the newest N. The included run is appended (it is older than the page).
 *
 * A loop on its owner's mail, chat or documents: only its owner reads its runs
 * (migration 640's policy, restated here in code). Anyone else gets no runs
 * and `owner_only: true`, which the history pane says in words.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { OWNER_ONLY_RUNS_NOTE, canReadFlowRuns } from '@/lib/flows/types'

const RUN_SELECT = `
  id, flow_id, triggered_by_action_id, status,
  action_results,
  request_summary, response_status_code, response_body_preview,
  error_message, fired_at, duration_ms,
  action:actions!triggered_by_action_id(identifier, title)
`

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  // Verify the flow belongs to this workspace before exposing run history.
  const { data: flow } = await supabase
    .from('flow')
    .select('id, trigger_type, created_by')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!flow) return notFound('Flow not found')
  if (!canReadFlowRuns(flow as { trigger_type?: string; created_by?: string | null }, user.id)) {
    return NextResponse.json({ runs: [], owner_only: true, note: OWNER_ONLY_RUNS_NOTE })
  }

  const url = new URL(request.url)
  const limitRaw = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 20
  const include = url.searchParams.get('include')

  const { data, error } = await supabase
    .from('flow_run')
    .select(RUN_SELECT)
    .eq('flow_id', id)
    .order('fired_at', { ascending: false })
    .limit(limit)

  if (error) return serverError(error.message)

  let runs = (data ?? []) as Array<{ id: string }>
  if (include && !runs.some((r) => r.id === include)) {
    // Same select, same flow fence — the run must belong to THIS flow.
    const { data: extra } = await supabase
      .from('flow_run')
      .select(RUN_SELECT)
      .eq('id', include)
      .eq('flow_id', id)
      .maybeSingle()
    if (extra) runs = [...runs, extra as { id: string }]
  }

  return NextResponse.json({ runs })
}
