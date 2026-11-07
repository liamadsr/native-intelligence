import { requireUser } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { NextResponse } from 'next/server'
import { parseRespondBody, respondToWorkRun } from '@/lib/agent-run/respond-to-run'

/**
 * POST /api/account/agent-runs/[id]/respond — answer a work run parked in
 * `needs_input` (Loops v3 interactive work runs —
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md §Account API routes).
 *
 * When the work agent asks a mid-run clarifying question via `request_user_input`,
 * the dispatcher (run-work-eve.ts, W1) parks the run: status `needs_input`,
 * `pending_input` populated (the eve requestId + approve/deny option ids + the
 * QuestionPicker-shaped questions). The drill-in renders the picker; the user
 * submits answers (or skips) here, and the run resumes.
 *
 * Body: `{ answers: [{ question, answer } | { question, selected, other? }] }`
 * or `{ skipped: true }` (parseRespondBody).
 *
 * The user comes from the cookie session (requireUser); everything after the
 * body is respondToWorkRun (src/lib/agent-run/respond-to-run.ts), the one path
 * the main agent's send_work_answer takes too (bots-v4 Phase A2): the run is
 * loaded by id alone (a work run may live in a workspace that isn't the
 * caller's ACTIVE one), the caller must be a member of the RUN's workspace AND
 * its starter (`triggered_by`), the guards (kind / status / pending_input /
 * not a delegation park), then the needs_input→queued CAS and action mirror on
 * the service client, the `work/run.resumed` emit, and the compensation that
 * reverts the CAS when the emit throws.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  // Parse the body: { answers } | { skipped: true }.
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = parseRespondBody(body)
  if ('error' in parsed) return badRequest(parsed.error)

  const result = await respondToWorkRun(supabase, { userId: user.id, runId: id, response: parsed.response })
  if (result.ok) return NextResponse.json({ ok: true, status: result.status })
  // The two membership refusals answer as a plain 403, as they always have.
  const code = result.code === 'NOT_MEMBER' || result.code === 'NOT_STARTER' ? 'FORBIDDEN' : result.code
  return apiError(result.error, { status: result.status, code })
}
