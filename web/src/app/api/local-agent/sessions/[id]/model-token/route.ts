/**
 * POST /api/local-agent/sessions/[id]/model-token — a fresh model token while
 * the session is live (the relay refreshes at 75% of the token's life).
 *
 * Returns {modelToken, expiresAt, localModel}; 409 when the session is not
 * live; 503 when model tokens are not configured. `localModel` is the model the
 * session is recorded on, which a parked job's resume must launch on. A loop's
 * job the kill switch or the workspace's pause reached gets none (403), and is
 * asked to stop (loop-gate.ts).
 */
import { NextResponse } from 'next/server'
import { apiError, conflict, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { errorResponse, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'
import { loopJobRefusal } from '@/lib/local-agent/loop-gate'
import { MODEL_LIVE_STATUSES, loadSession } from '@/lib/local-agent/store'
import { modelTokenSecret, signModelToken } from '@/lib/local-agent/tokens'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  try {
    const row = await loadSession(getServiceClient(), auth.user.id, id)
    if (!row) return notFound('Local agent not found')
    if (!(MODEL_LIVE_STATUSES as string[]).includes(row.status)) {
      return conflict('This local agent is not running', { status: row.status })
    }
    const refusal = await loopJobRefusal(getServiceClient(), auth.user.id, row.id)
    if (refusal) return refusal
    if (!modelTokenSecret()) return apiError('Model tokens are not configured', { status: 503, code: 'NOT_CONFIGURED' })
    // The plan flag is read again on every refresh (the claim route's note).
    const { token, expiresAt } = signModelToken({ sid: row.id, uid: auth.user.id, wid: row.workspace_id, plan: await chatgptPlanFor(auth.user.id, { attempts: 2 }) })
    // The model the session is recorded on (migration 418): a parked job's resume launches on it, or refuses.
    return NextResponse.json({ modelToken: token, expiresAt, localModel: row.local_model === true })
  } catch (err) {
    return errorResponse(err, 'model token')
  }
}
