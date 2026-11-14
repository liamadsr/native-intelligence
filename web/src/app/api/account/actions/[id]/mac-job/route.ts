/**
 * GET /api/account/actions/[id]/mac-job
 *
 * The signed-in person's own job for this action on their Mac (an action's
 * Start with "Run my work here"): the live one when there is one, else the
 * latest, or null. `worker` names the coding agent doing the work (migration
 * 658), null for Native Intelligence's own agent. The action panel opens the
 * job's LocalAgentPanel with `sessionId`.
 *
 * { job: { sessionId, status, worker, deviceName, folderLabel, live } | null }
 */
import { NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { isUuid } from '@/lib/local-agent/store'
import { personActionMacJob } from '@/lib/local-agent/unattended'

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Action not found')
  try {
    // The action must be this workspace's and visible to the person (their own client, under RLS).
    const { data: action, error } = await auth.supabase.from('actions').select('id').eq('id', id).eq('workspace_id', auth.workspaceId).maybeSingle()
    if (error) throw new Error(error.message)
    if (!action) return notFound('Action not found')
    const job = await personActionMacJob(getServiceClient(), { userId: auth.user.id, workspaceId: auth.workspaceId, actionId: id })
    return NextResponse.json({ job }, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    console.error('[actions/mac-job] read failed:', err instanceof Error ? err.message : err)
    return serverError()
  }
}
