/**
 * GET  /api/account/flows/[id]/takeover — is the caller's request to take
 *      over this loop still waiting? ({ pending })
 * POST /api/account/flows/[id]/takeover — "Take over this flow" in the editor
 *      (F1): ask the loop's CURRENT owner to hand it to the caller.
 *
 * POST runs chat's request_flow_takeover tool itself (src/lib/ai/tools/flows.ts),
 * so the editor and chat raise the same verified card: in the owner's queue
 * (or, with the owner gone, its workspace owners' and admins'), and the loop
 * changes hands only on their Accept, re-checked then (the definition hash,
 * the accepter, the asker's membership). Never immediate.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { apiError, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { createFlowTools } from '@/lib/ai/tools/flows'
import { takeoverPending } from '@/lib/flows/flow-approvals'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const { id } = await params
  return NextResponse.json({ pending: await takeoverPending(getServiceClient(), { workspaceId, flowId: id, requesterId: user.id }) })
}

export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { user, workspaceId } = auth
  const { id } = await params

  // Strict to this workspace: the editor only ever names a loop of the active one.
  const tools = createFlowTools(user.id, getServiceClient(), workspaceId, true)
  const out = (await tools.request_flow_takeover.execute!(
    { flow_id: id } as never,
    { toolCallId: `flow-takeover-${id}`, messages: [] } as never,
  )) as { requested?: boolean; message?: string; error?: string; code?: string }

  if (out.requested) return NextResponse.json({ requested: true, message: out.message ?? null })
  if (out.error === 'Flow not found') return notFound('Flow not found')
  return apiError(out.error ?? out.message ?? 'Could not ask for this flow', { status: out.code === 'NOT_ALLOWED' ? 403 : 400, code: out.code ?? 'TAKEOVER_FAILED' })
}
