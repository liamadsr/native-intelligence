import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/supabase/service'
import { inngest } from '@/lib/inngest/client'
import { isDelegationPark, type AskUserAnswer } from '@/lib/agent-run/types'
import { isPrecheckPark, readPrecheckRecord, type PrecheckRecord } from '@/lib/coding/precheck'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'

/**
 * Answering a work run parked in `needs_input` (Loops v3 interactive work runs,
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md §Account API routes): the
 * logic behind POST /api/account/agent-runs/[id]/respond, moved here unchanged
 * so the main agent's `send_work_answer` (bots-v4 Phase A2,
 * src/lib/bots/bot-work-acts.ts) answers through EXACTLY the path the run
 * view's question form and a bot's bubble take.
 *
 * When the work agent asks a mid-run clarifying question via `request_user_input`,
 * the dispatcher (run-work-eve.ts, W1) parks the run: status `needs_input`,
 * `pending_input` populated (the eve requestId + approve/deny option ids + the
 * QuestionPicker-shaped questions). The answers (or a skip) come here, and the
 * run resumes.
 *
 * ── Auth (tenancy = the RUN's workspace, not the active one) ─────────────────
 * The run's tools execute under the STARTER's identity (the run token was minted
 * for `triggered_by`), so only the starter may steer it (v1). The caller must be
 *   (a) a member of the RUN's workspace_id, AND
 *   (b) equal to `triggered_by`.
 * The run is loaded by id alone on `reader` (a work run may live in a workspace
 * that isn't the caller's ACTIVE one), then membership of the run's own
 * workspace and the triggered_by identity are checked explicitly, so the
 * checks hold on the route's session client and on a tool's service client
 * alike.
 *
 * The interaction-control WRITES (the needs_input→queued CAS + action mirror) go
 * through the SERVICE client: member-wide UPDATE RLS on agent_run is dropped in
 * Phase 3 (mig 200), so all agent_run writes are service-role via callers that
 * authorize themselves (as this does above).
 *
 * ── Guards ───────────────────────────────────────────────────────────────────
 *   - `kind='workspace'`      — respond is meaningless for a coding run.
 *   - `status='needs_input'`  — only a parked run accepts an answer.
 *   - `pending_input` present — the park wrote it; without it there's nothing to
 *                               resume against.
 *   - not a delegation park   — a run waiting on the teammates it handed work
 *                               to is released by their runs, never an answer.
 *
 * ── CAS + resume ─────────────────────────────────────────────────────────────
 * CAS `needs_input→queued` (guarded on the observed status so a concurrent
 * cancel/second-respond can't double-resume), mirror the tracked action
 * `agent_run_status='working'`, then emit `work/run.resumed` with the STRUCTURED
 * response (answers | skipped). The dispatcher (W1) owns building the eve
 * approval-resume send (`{ inputResponses:[{requestId, optionId}], message }`)
 * from `pending_input` + this response — the already-debugged eve quirk lives in
 * ONE place. `pending_input` is cleared on the dispatcher's successful resume (a
 * failed resume settles the run failed); we do not clear it here.
 *
 * Compensation: if the Inngest emit throws, revert the CAS (queued→needs_input +
 * action back to needs_input) so the drill-in still shows the parked question and
 * the user can retry, rather than a run stuck `queued` with no dispatcher pending.
 */

/**
 * The `work/run.resumed` event's `response` payload — the shape the resume driver
 * (resumeWorkRun in run-work-eve.ts, via the work-run-resume Inngest function, W1)
 * consumes to replay the parked session: either the structured answers or a skip.
 * The driver owns building the eve approval-resume send from it (approve/deny
 * optionId off `pending_input` + the answers as the follow-up `message` — eve
 * discards `text` on an approval), so this only forwards a serializable
 * response, never the eve send shape.
 */
export type WorkRunResumeResponse = { answers: AskUserAnswer[] } | { skipped: true }

/** Why an answer was turned down: the route's status and code, and its message. */
export type RespondRefusalCode =
  | 'NOT_FOUND'
  | 'NOT_MEMBER'
  | 'NOT_STARTER'
  | 'INVALID_KIND'
  | 'NOT_NEEDS_INPUT'
  | 'NO_PENDING_INPUT'
  | 'WAITING_ON_TEAMMATE'
  | 'INTERNAL'

export type RespondResult =
  | { ok: true; status: 'queued'; workspaceId: string }
  | { ok: false; status: number; code: RespondRefusalCode; error: string }

function refuse(status: number, code: RespondRefusalCode, error: string): RespondResult {
  return { ok: false, status, code, error }
}

/**
 * Answer (or skip) the question run `runId` waits on, as user `userId`.
 * `reader` loads the run and the caller's member row (the route's session
 * client, or a tool's service client: every check is explicit). Never throws
 * for a refusal; a failed read or emit is `INTERNAL`.
 */
export async function respondToWorkRun(
  reader: SupabaseClient,
  args: { userId: string; runId: string; response: WorkRunResumeResponse },
): Promise<RespondResult> {
  const { userId, runId: id, response } = args

  // Load the run by id alone (tenancy is re-derived from the run row, not the
  // active workspace). needs the columns the guards + resume read.
  const { data: run, error: runErr } = await reader
    .from('agent_run')
    .select('id, kind, status, workspace_id, triggered_by, action_id, pending_input')
    .eq('id', id)
    .maybeSingle()
  if (runErr) return refuse(500, 'INTERNAL', runErr.message)
  if (!run) return refuse(404, 'NOT_FOUND', 'Agent run not found')

  const workspaceId = run.workspace_id as string

  // (a) member of the run's workspace + (b) equal to triggered_by.
  const { data: member } = await reader
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) return refuse(403, 'NOT_MEMBER', 'Not a member of this run’s workspace')
  if (run.triggered_by !== userId) {
    return refuse(403, 'NOT_STARTER', 'Only the person who started this run can respond to it')
  }

  // A coding run parked on its pre-check's questions (P10 F5): the answer is
  // kept on the run and the run starts; there is no session to resume yet.
  if (run.kind === 'coding' && isPrecheckPark(run.pending_input)) {
    if (run.status !== 'needs_input') {
      return refuse(409, 'NOT_NEEDS_INPUT', 'This run is not waiting for input')
    }
    return answerPrecheck({
      agentRunId: id,
      workspaceId,
      actionId: (run.action_id as string | null) ?? null,
      pending: run.pending_input,
      response,
    })
  }

  // Guards.
  if (run.kind !== 'workspace') {
    return refuse(400, 'INVALID_KIND', 'Only workspace runs accept a response')
  }
  if (run.status !== 'needs_input') {
    return refuse(409, 'NOT_NEEDS_INPUT', 'This run is not waiting for input')
  }
  if (!run.pending_input || typeof run.pending_input !== 'object') {
    return refuse(409, 'NO_PENDING_INPUT', 'This run has no pending question to answer')
  }
  // Parked on the teammates it handed work to: their runs release it, never a
  // person's answer (a person answering would resolve the handoff with nothing).
  if (isDelegationPark(run.pending_input)) {
    return refuse(409, 'WAITING_ON_TEAMMATE', 'This run is waiting on a teammate, not on an answer')
  }
  // The eve requestId of the question being answered. Carried on the resume event so
  // the driver can reject a DUPLICATE/stale delivery (Inngest is at-least-once) that
  // would otherwise pair this answer set with a newer pending question.
  const pendingRequestId =
    typeof (run.pending_input as Record<string, unknown>).requestId === 'string'
      ? ((run.pending_input as Record<string, unknown>).requestId as string)
      : null

  // CAS needs_input→queued (guarded on the observed status) + mirror action.
  // The interaction-control WRITE goes through the SERVICE client: member-wide
  // UPDATE RLS on agent_run is dropped in Phase 3 (mig 200) so a member can't
  // tamper the control state via direct PostgREST — the checks above did the
  // authorization (membership + triggered_by).
  // `started_at` is re-stamped here: it is the start of the run's CURRENT
  // turn, not of its first one. The stale-run reaper fails any queued/running
  // row whose started_at is older than its cutoff, and an answer routinely
  // arrives hours after the park — with the original start left in place the
  // resumed turn would be reaped (and its eve session canceled) on the next
  // reaper tick. The run's own elapsed time reads from the same column, so the
  // detail views show the active turn's duration, not the time spent parked.
  const service = getServiceClient()
  const { data: casRows } = await service
    .from('agent_run')
    .update({ status: 'queued', started_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'needs_input')
    .eq('workspace_id', workspaceId)
    .select('id')
  if (!casRows || casRows.length === 0) {
    // Lost the race (a concurrent cancel / second respond flipped it first).
    return refuse(409, 'NOT_NEEDS_INPUT', 'This run is no longer waiting for input')
  }
  const actionId = (run.action_id as string | null) ?? null
  if (actionId) {
    await service
      .from('actions')
      .update({ agent_run_status: 'working' })
      .eq('id', actionId)
      .eq('workspace_id', workspaceId)
  }

  // Emit the resume event with the structured response. On emit failure, revert
  // the CAS so the run isn't stranded queued-with-no-dispatcher.
  try {
    await inngest.send({
      name: 'work/run.resumed',
      data: { agent_run_id: id, workspace_id: workspaceId, response, request_id: pendingRequestId },
    })
  } catch (err) {
    await revertResumeCas(service, { agentRunId: id, workspaceId, actionId })
    return refuse(500, 'INTERNAL', `Failed to resume run: ${err instanceof Error ? err.message : String(err)}`)
  }

  return { ok: true, status: 'queued', workspaceId }
}

/**
 * Answer a coding run's pre-check (P10 F5, src/lib/coding/precheck.ts). The
 * caller already checked membership and that this is the starter. CAS
 * needs_input → queued with the answers (or the skip) kept on the run's
 * precheck, the action back to working, the ledger row back to running, then
 * `agent/run.requested` again: agentRunExecute finds the precheck done and
 * starts the session, the answers in the coder's task (precheckTaskBlock).
 * A run asks once: its answer, or a skip, is final.
 */
async function answerPrecheck(args: {
  agentRunId: string
  workspaceId: string
  actionId: string | null
  pending: unknown
  response: WorkRunResumeResponse
}): Promise<RespondResult> {
  const service = getServiceClient()
  const { data: row } = await service
    .from('agent_run')
    .select('precheck')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  const prior: PrecheckRecord = readPrecheckRecord((row as { precheck?: unknown } | null)?.precheck) ?? {
    verdict: 'needs_clarification',
    questions: [],
    kind: null,
    size: null,
    reason: '',
    model: null,
    at: new Date().toISOString(),
  }
  const now = new Date().toISOString()
  const answered: PrecheckRecord =
    'skipped' in args.response
      ? { ...prior, skipped: true, answered_at: now }
      : { ...prior, answers: args.response.answers, answered_at: now }
  const { data: casRows } = await service
    .from('agent_run')
    .update({ status: 'queued', pending_input: null, precheck: answered, started_at: now })
    .eq('id', args.agentRunId)
    .eq('status', 'needs_input')
    .eq('workspace_id', args.workspaceId)
    .select('id')
  if (!casRows || casRows.length === 0) {
    return refuse(409, 'NOT_NEEDS_INPUT', 'This run is no longer waiting for input')
  }
  if (args.actionId) {
    await service.from('actions').update({ agent_run_status: 'working' }).eq('id', args.actionId).eq('workspace_id', args.workspaceId)
  }
  await mirrorAgentRunStatus(service, { agentRunId: args.agentRunId, workspaceId: args.workspaceId }, { status: 'running' })
  try {
    await inngest.send({ name: 'agent/run.requested', data: { agent_run_id: args.agentRunId, workspace_id: args.workspaceId } })
  } catch (err) {
    await service
      .from('agent_run')
      .update({ status: 'needs_input', pending_input: args.pending })
      .eq('id', args.agentRunId)
      .eq('status', 'queued')
      .eq('workspace_id', args.workspaceId)
    if (args.actionId) {
      await service.from('actions').update({ agent_run_status: 'needs_input' }).eq('id', args.actionId).eq('workspace_id', args.workspaceId)
    }
    const questions = (args.pending as { questions?: unknown[] } | null)?.questions ?? []
    await mirrorAgentRunStatus(service, { agentRunId: args.agentRunId, workspaceId: args.workspaceId }, { status: 'needs_input', questions })
    return refuse(500, 'INTERNAL', `Failed to start the run: ${err instanceof Error ? err.message : String(err)}`)
  }
  return { ok: true, status: 'queued', workspaceId: args.workspaceId }
}

/**
 * Revert the resume CAS after a failed Inngest emit: queued→needs_input and the
 * tracked action back to needs_input, so the drill-in still shows the parked
 * question and the user can retry. Guarded on `queued` so it can't clobber a run
 * that already advanced (a race with a retried emit that DID land).
 */
async function revertResumeCas(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; actionId: string | null },
): Promise<void> {
  await supabase
    .from('agent_run')
    .update({ status: 'needs_input' })
    .eq('id', args.agentRunId)
    .eq('status', 'queued')
    .eq('workspace_id', args.workspaceId)
  if (args.actionId) {
    await supabase
      .from('actions')
      .update({ agent_run_status: 'needs_input' })
      .eq('id', args.actionId)
      .eq('workspace_id', args.workspaceId)
  }
}

/**
 * Size caps on the interaction body. request_user_input asks 1–4 questions, so a
 * legitimate answer set is small; these bound the payload (which also rides into the
 * `work/run.resumed` Inngest event) so a starter can't spend the run's eve budget on
 * multi-megabyte answers or overflow Inngest's event-size ceiling. Beyond the cap →
 * a clean 400, not a post-CAS serverError.
 */
export const MAX_ANSWERS = 8
export const MAX_ANSWER_CHARS = 2000

/** Parse + validate a respond body into a structured resume response. */
export function parseRespondBody(
  body: unknown,
): { response: WorkRunResumeResponse } | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Body must be an object' }
  const b = body as Record<string, unknown>

  if (b.skipped === true) return { response: { skipped: true } }

  if (!Array.isArray(b.answers)) {
    return { error: 'Body must be { answers: [...] } or { skipped: true }' }
  }
  if (b.answers.length > MAX_ANSWERS) {
    return { error: `answers may contain at most ${MAX_ANSWERS} entries` }
  }
  // Normalize to the canonical AskUserAnswer (types.ts): { question, answer }.
  // The resume driver (W1) formats these into the follow-up message the model
  // reads. We accept the picker's richer form too — a client that submits
  // { question, selected: string[], other?: string } has its selection(s)
  // collapsed here into the single `answer` string (this is the seam between
  // the picker and the resume driver), so either shape works.
  const answers: AskUserAnswer[] = []
  for (const raw of b.answers) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const question = typeof r.question === 'string' ? r.question : ''
    if (!question) continue
    const answer = coerceAnswer(r)
    if (answer.length > MAX_ANSWER_CHARS) {
      return { error: `each answer may be at most ${MAX_ANSWER_CHARS} characters` }
    }
    answers.push({ question, answer })
  }
  if (answers.length === 0) {
    return { error: 'answers must contain at least one { question, answer } entry' }
  }
  return { response: { answers } }
}

/**
 * Collapse one answer entry into a single `answer` string. Prefers an explicit
 * `answer` (the canonical AskUserAnswer shape); otherwise folds the picker's
 * `selected: string[]` + optional `other` free-text into a comma-joined string.
 * Returns '' when nothing was chosen (the resume driver still surfaces the
 * question was reached, unanswered).
 */
function coerceAnswer(r: Record<string, unknown>): string {
  if (typeof r.answer === 'string') return r.answer
  const picked: string[] = []
  if (Array.isArray(r.selected)) {
    for (const s of r.selected) if (typeof s === 'string' && s.trim()) picked.push(s)
  }
  if (typeof r.other === 'string' && r.other.trim()) picked.push(r.other.trim())
  return picked.join(', ')
}

/**
 * The questions a run's `pending_input` asks, as text (none for a handoff to
 * teammates, which no person answers). The answer to them all goes back as
 * one entry, as a bot's bubble sends a typed reply (item-run-chat.ts
 * answerRunQuestion): the questions joined, one free-text answer.
 */
export function pendingQuestionTexts(pending: unknown): string[] {
  if (!pending || typeof pending !== 'object') return []
  const p = pending as { kind?: unknown; questions?: unknown }
  if (p.kind === 'delegation') return []
  const questions = p.questions
  if (!Array.isArray(questions)) return []
  return questions
    .map((q) => (q && typeof q === 'object' && typeof (q as { question?: unknown }).question === 'string' ? (q as { question: string }).question.trim() : ''))
    .filter(Boolean)
}
