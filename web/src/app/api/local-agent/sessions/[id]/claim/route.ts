/**
 * POST /api/local-agent/sessions/[id]/claim — the Mac takes a queued session.
 *
 * Body: {deviceId, runId, localModel?, workers?} (workers: true from a relay that
 * hands `worker` to the Mac; without it a job with a worker is failed, migration 658). Answers `localModel` as recorded, so
 * the Mac launches on the model C1 narrows the tools by. CAS queued → starting on this device's
 * folder, then the lease. `localModel` (a boolean, when the Mac says which
 * model it runs this launch on) is kept on the session (migration 418): C1's
 * routes narrow the tools for a Mac on its own model. Returns {grantId, mode, request, modelToken, modelTokenExpiresAt, resume, localModel, baseBranch, worker}
 * (baseBranch: an edit job's base, E3, a local branch name the Mac resolves itself; null: HEAD;
 * worker: the coding agent the person chose for that Mac when the job started, migration 658,
 * which the Mac runs or refuses with its own sentence; null: Native Intelligence's own agent);
 * 409 when the CAS lost. `modelToken` is null when tokens are not configured
 * (dev: the local agent then uses its dev env file). The token carries the
 * ChatGPT free tier's plan flag (`cp`) for a person on their own plan. A
 * loop's job the kill switch or the workspace's pause reached is refused (403)
 * and cancelled before anything runs (loop-gate.ts).
 */
import { NextResponse } from 'next/server'
import { conflict } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { claimSession } from '@/lib/local-agent/device'
import { errorResponse, readJsonBody, requireLocalAgentUser } from '@/lib/local-agent/http'
import { crossSiteRefusal } from '@/lib/security/same-origin'
import { loopJobRefusal } from '@/lib/local-agent/loop-gate'
import { modelTokenSecret, signModelToken } from '@/lib/local-agent/tokens'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const crossSite = crossSiteRefusal(request)
  if (crossSite) return crossSite
  const auth = await requireLocalAgentUser(request)
  if (auth instanceof Response) return auth
  const { id } = await ctx.params
  const body = await readJsonBody(request)
  if (body instanceof Response) return body
  try {
    const refusal = await loopJobRefusal(getServiceClient(), auth.user.id, id)
    if (refusal) return refusal
    const claimed = await claimSession(getServiceClient(), auth.user.id, id, {
      deviceId: body.deviceId as string,
      runId: body.runId as string,
      ...(typeof body.localModel === 'boolean' ? { localModel: body.localModel } : {}),
      // The page's relay understands `worker` (migration 658); a job with one fails for a page that doesn't say so.
      workers: body.workers === true,
    })
    if (!claimed) return conflict('This local agent is not waiting to be claimed by this device')
    // The token says whether the person runs on their own ChatGPT plan (the
    // free tier): the local agent then runs its model on the plan, through
    // the relay's plan path (src/lib/local-agent/tokens.ts `cp`).
    const minted = modelTokenSecret()
      ? signModelToken({
          sid: claimed.session.id,
          uid: auth.user.id,
          wid: claimed.session.workspace_id,
          plan: await chatgptPlanFor(auth.user.id, { attempts: 2 }),
        })
      : null
    return NextResponse.json({
      grantId: claimed.grantId,
      mode: claimed.mode,
      request: claimed.request,
      modelToken: minted?.token ?? null,
      modelTokenExpiresAt: minted?.expiresAt ?? null,
      resume: claimed.resume,
      // As recorded: the relay hands it to the Mac's start, which launches on it (or refuses).
      localModel: claimed.localModel,
      // An edit job's base branch (E3): a local branch name the Mac resolves itself; null: HEAD.
      baseBranch: claimed.baseBranch,
      // Who does the work (migration 658): the person's own coding agent, or null for ours. The Mac never falls back.
      worker: claimed.worker,
    })
  } catch (err) {
    return errorResponse(err, 'claim')
  }
}
