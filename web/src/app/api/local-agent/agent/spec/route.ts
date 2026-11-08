/**
 * GET /api/local-agent/agent/spec — the Mac body's spec (docs/plans/teammate-agent.md C1).
 *
 * The Mac body (the main Dial8 agent running on the person's Mac) gets here
 * what the cloud body gets from /api/internal/chat/spec, for its session's
 * conversation, as the MAIN chat: the system prompt, the model policy and the
 * tools, rebuilt from live state by the same rebuildChatSpec. Then narrowed
 * for the Mac (macSpec, src/lib/local-agent/agent-access.ts): the Mac's
 * ceiling (no relay, helper, local-agent or browser tools; web_fetch and
 * web_search served by the tool route), the relay's model, and `host: 'mac'`.
 *
 * Auth: `Authorization: Bearer <session token>` (the job's `la1.…` model
 * token), never the shared internal secret. Every call re-checks the token,
 * the session (live, the token user's own, not idle, not asked to stop), the
 * workspace and its membership, the session's conversation and its
 * local-model flag (authorizeMacBody), and the person's usage limit (inside
 * the rebuild; ?live=1 checks it itself).
 *
 * Query params, as the cloud route's: `skills=1`, `schemas=1`,
 * `turnContext=1`, and `live=1` (a liveness probe: `{ live: true }` once the
 * checks pass, no rebuild). A `ctx` is not read: its systemContext is the
 * app's screen, and a turn with one counts as the person's own in the app
 * (its "While you were away" section would mark those rows delivered); its
 * route signals pick a cloud tier the Mac doesn't run (a Jev call, and a hint
 * to hand work to helpers it doesn't have). With none, the clock is in the
 * person's stored zone, as a server-written turn's is.
 */
import { NextResponse } from 'next/server'
import { apiError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { rebuildChatSpec, type ChatSpec } from '@/lib/chat/chat-run-rebuild'
import { authorizeMacBody, macChatClaims, macSpec, usageRefusal } from '@/lib/local-agent/agent-access'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(request: Request) {
  const body = await authorizeMacBody(request, getServiceClient())
  if (body instanceof Response) return body

  const params = new URL(request.url).searchParams
  if (params.get('live') === '1') {
    const refused = await usageRefusal(body.session.userId)
    return refused ?? NextResponse.json({ live: true })
  }

  const includeSchemas = params.get('schemas') === '1'
  let spec: ChatSpec
  try {
    spec = await rebuildChatSpec(macChatClaims(body), {}, {
      includeSkills: params.get('skills') === '1',
      includeSchemas,
      splitTurnContext: params.get('turnContext') === '1',
      // The Mac runs the relay's model (or its own), never the person's pick.
      callerModel: true,
    })
  } catch (err) {
    // checkUsageLimits throws a Response on 429/503 (usage/billing): as is.
    if (err instanceof Response) return err
    console.error('[local-agent] spec rebuild failed:', err instanceof Error ? err.message : err)
    return apiError('Could not build the agent spec', { status: 500, code: 'CHAT_SPEC_REBUILD_FAILED' })
  }
  return NextResponse.json(macSpec(spec, body, { includeSchemas }))
}
