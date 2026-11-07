/**
 * /api/account/evals/runs — the run history of a suite, and queueing a run.
 *
 * POST is the only route in this feature that can spend money, and everything
 * about its ordering is deliberate:
 *
 *   1. `requireWorkspace` — who is asking, and in which workspace.
 *   2. `checkUsageLimits(user.id)` ONCE (spec §5.1). The route hands the
 *      thrown 429/503 Response straight back; it must stay outside any
 *      try/catch that would rewrap it as a 500. Once, not per trial: a run
 *      that crossed the wall mid-flight is a run-level `failed` with an
 *      `error_code`, never a per-trial retry storm or a scored zero, and a
 *      per-trial check is exactly how you get the latter.
 *   3. `startEvalRun`, which snapshots the target prompt and its hash, checks
 *      the monthly eval budget, writes the row and emits the Inngest event.
 *
 * Two mappings the client branches on:
 *   - `adopted: true` — the unique index `idx_eval_run_one_live` refused a
 *     second live run of this suite+mode and the existing run's row came back
 *     instead. That is a 202 like any other, not a 409: a double-click and a
 *     chat tool racing the UI should converge on one run, which is what the
 *     poll contract then follows.
 *   - `EVAL_BUDGET_EXCEEDED` — a 409 `budget_exceeded`, so the UI can say what
 *     the ceiling is rather than showing a generic failure.
 *
 * 202, not 201: nothing has executed when this returns. The row exists and the
 * work is queued.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { checkUsageLimits } from '@/lib/ai/auth'
import { getServiceClient } from '@/lib/admin'
import { getSuite, listRuns } from '@/lib/evals/queries'
import { EvalRunError, startEvalRun } from '@/lib/evals/start-run'
import { notFound } from '@/lib/api-errors'
import { StartRunSchema } from '../schemas'
import { parseBody } from '../parse-body'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth

  const suiteId = request.nextUrl.searchParams.get('suite_id')
  if (!suiteId) return badRequest('suite_id is required')

  const suite = await getSuite(supabase, workspaceId, suiteId)
  if (!suite) return notFound('Suite not found')

  // A positive whole number or nothing. `Number.isFinite` alone accepted '',
  // '0' and '-5' — the first two hand `listRuns` an explicit `.limit(0)`,
  // which defeats its own default and answers 200 with an empty history the
  // suite really has; the third makes PostgREST error into the same silent
  // empty list. Matched as a whole string rather than parsed, so '1.5' falls
  // back to the default instead of silently becoming 1. The cap is the other
  // half: RUN_FIELDS carries `target_system_prompt` and `target_agent_config`,
  // so an unbounded limit is a megabyte response.
  const rawLimit = request.nextUrl.searchParams.get('limit')
  const wholeNumber = /^\d+$/.test(rawLimit ?? '') ? Number(rawLimit) : 0
  const limit = wholeNumber > 0 ? Math.min(wholeNumber, 100) : undefined

  const runs = await listRuns(supabase, suiteId, limit)
  return NextResponse.json({ runs })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, user, workspaceId } = auth

  const parsed = await parseBody(request, StartRunSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  // Membership in the suite's workspace before the usage check: an id from
  // another workspace is a 404 and must not cost the caller a billing probe.
  const suite = await getSuite(supabase, workspaceId, body.suite_id)
  if (!suite) return notFound('Suite not found')

  // checkUsageLimits throws a raw 429/503 Response — return it directly, and
  // keep this OUTSIDE the try/catch below, which would rewrap it as a 500.
  // Opted in to the ChatGPT free tier: a person on their own plan runs evals
  // on it (startEvalRun prices their run at $0; the lane grades on the plan).
  try {
    await checkUsageLimits(user.id, undefined, { chatgptPlan: true })
  } catch (limitResponse) {
    if (limitResponse instanceof Response) return limitResponse
    throw limitResponse
  }

  try {
    const result = await startEvalRun(getServiceClient(), {
      workspaceId,
      userId: user.id,
      suiteId: body.suite_id,
      mode: body.mode,
      speed: body.speed,
      trialsPerCase: body.trials_per_case,
      caseIds: body.case_ids,
    })

    return NextResponse.json(
      {
        run: result.run,
        adopted: result.adopted,
        estimated_cost_usd: result.estimated_cost_usd,
      },
      { status: 202 },
    )
  } catch (err) {
    if (err instanceof EvalRunError) {
      // The monthly eval ceiling is a fixable state the user can see and act
      // on, never a 500.
      if (err.code === 'EVAL_BUDGET_EXCEEDED') {
        return apiError(err.message, { status: 409, code: 'budget_exceeded' })
      }
      // A suite that vanished between the membership read and the insert, or a
      // `case_ids` narrowing that selected nothing — both are the caller's
      // request being wrong about the world, not the server failing.
      if (err.code === 'EVAL_SUITE_NOT_FOUND') return notFound('Suite not found')
      if (err.code === 'EVAL_NO_CASES') return badRequest(err.message)
      // The suite names a target this workspace cannot see. Snapshotting an
      // empty prompt instead would grade every case against nothing.
      if (err.code === 'EVAL_TARGET_NOT_FOUND') return badRequest(err.message)
      // A watched replay speed with no driver behind it yet. The message names
      // the speed that does work, so this is a 400 the caller can retry from.
      if (err.code === 'EVAL_SPEED_UNAVAILABLE') return badRequest(err.message)
      if (err.code === 'EVAL_USAGE_UNAVAILABLE') return apiError(err.message, { status: 503, code: 'BILLING_UNAVAILABLE' })
    }
    console.error('[evals] start run failed:', err)
    return serverError()
  }
}
