/**
 * GET /api/account/flows/runs/[runId] — which flow a run belongs to.
 *
 * A `flow_run`-targeted notification (a verdict digest: "Triage: 2 need you")
 * carries only the run id, and the flow editor is keyed on the FLOW id. Newer
 * rows stamp the flow as context; the inbox click resolver asks here for the
 * rows that predate that. Fenced through the run's flow: a run whose flow lives
 * in another workspace is simply not found.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'

const RUN_SELECT = 'id, flow_id, status, fired_at, flow!inner(id, name, workspace_id)'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { runId } = await params

  const { data, error } = await supabase
    .from('flow_run')
    .select(RUN_SELECT)
    .eq('id', runId)
    .eq('flow.workspace_id', workspaceId)
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!data) return notFound('Run not found')

  // PostgREST types an `!inner` embed as an array in some client versions and
  // an object in others; read it either way.
  const embedded = (data as { flow?: unknown }).flow
  const flow = (Array.isArray(embedded) ? embedded[0] : embedded) as
    | { id: string; name: string | null }
    | null
    | undefined

  return NextResponse.json({
    run: {
      id: data.id,
      flow_id: data.flow_id,
      flow_name: flow?.name ?? null,
      status: data.status,
      fired_at: data.fired_at,
    },
  })
}
