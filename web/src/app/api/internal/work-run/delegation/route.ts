import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import {
  extractAgentRunToken,
  extractInternalSecret,
  verifyAgentRunToken,
  verifyInternalSecret,
} from '@/lib/agent-run/agent-run-token'
import { buildDelegationResult } from '@/lib/agent-run/delegation'

/**
 * POST /api/internal/work-run/delegation — what one `delegate_work` call
 * handed back (Part 3). Called by the work-agent tool's execute, which eve runs
 * only after the parent's handoff approval was answered: at the release (every
 * child settled) or at once (the handoff was refused). The result becomes the
 * tool's own result, so it is durable in the parent's session.
 *
 * Auth is the tool route's: the internal secret plus the PARENT's run token.
 * The lookup is keyed on the token's run and the tool call's id, so a run can
 * only ever read its own handoffs.
 *
 * Body `{ call_id }`. 200 with the DelegationResult (status completed | failed
 * | canceled | refused | running | unknown).
 */
export async function POST(request: Request) {
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  const claims = verifyAgentRunToken(extractAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }
  let body: { call_id?: unknown }
  try {
    body = (await request.json()) as { call_id?: unknown }
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const callId = typeof body.call_id === 'string' ? body.call_id.trim() : ''
  if (!callId) return NextResponse.json({ error: 'missing call_id' }, { status: 400 })

  const result = await buildDelegationResult(getServiceClient(), {
    parentRunId: claims.agentRunId,
    workspaceId: claims.workspaceId,
    callId,
  })
  return NextResponse.json(result)
}
