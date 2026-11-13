/**
 * GET /api/account/flows/[id]/runs — last N runs of this flow, newest first.
 *
 * Used by the Flows view to show the "Last runs" history pane. `?include=<runId>`
 * guarantees that one run is in the response even when it has aged out of the
 * page — a notification deep link lands on a specific run, which may be older
 * than the newest N. The included run is appended (it is older than the page).
 *
 * A run of a loop on someone's own mail, chat or documents is stamped private
 * to them (flow_run.private_to, migration 640's policy, restated here in code
 * per run): anyone else never gets it, whatever the loop's trigger or owner is
 * now. `owner_only: true` (and a note) when the caller's history leaves runs
 * out, or the loop is someone else's event loop: the pane says why.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { OWNER_ONLY_RUNS_NOTE, canReadFlowRun, flowRunsAreSomeoneElses } from '@/lib/flows/types'

const RUN_SELECT = `
  id, flow_id, triggered_by_action_id, status,
  action_results,
  request_summary, response_status_code, response_body_preview,
  error_message, fired_at, duration_ms, private_to,
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

  type RunRow = { id: string; private_to?: string | null }
  const readable = (rows: RunRow[]) => rows.filter((r) => canReadFlowRun(r, user.id)).map(({ private_to: _p, ...run }) => (void _p, run))
  const page = (data ?? []) as RunRow[]
  let runs = readable(page)
  let hidden = page.length - runs.length
  if (include && !runs.some((r) => r.id === include)) {
    // Same select, same flow fence — the run must belong to THIS flow.
    const { data: extra } = await supabase
      .from('flow_run')
      .select(RUN_SELECT)
      .eq('id', include)
      .eq('flow_id', id)
      .maybeSingle()
    if (extra) {
      const kept = readable([extra as RunRow])
      runs = [...runs, ...kept]
      hidden += 1 - kept.length
    }
  }

  const ownerOnly = hidden > 0 || flowRunsAreSomeoneElses(flow as { trigger_type?: string; created_by?: string | null }, user.id)
  return NextResponse.json({ runs, ...(ownerOnly ? { owner_only: true, note: OWNER_ONLY_RUNS_NOTE } : {}) })
}
