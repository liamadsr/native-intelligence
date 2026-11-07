/**
 * POST /api/internal/agent-run/event  (token via header)
 *
 * INTERNAL-ONLY log pump for the eve `coding-agent` runtime (Phase 3). The eve
 * agent posts `{ kind: 'log'|'progress', text }` beats as it works; this appends
 * them to `agent_run.log_tail` (the same 4000-char tail the retired sandbox runner
 * keeps), and on the FIRST event flips a still-`queued` run to `running` +
 * stamps `started_at` — the log pump doubles as the run's "it started" signal.
 *
 * ── The cancel signal ───────────────────────────────────────────────────────
 * The response includes `{ canceling }` = whether the row is `canceling` OR
 * already `canceled` (agentRunCancel settles the former into the latter within
 * seconds, and the signal must survive that). agentRunCancel also asks eve to
 * cancel the session's turn, but that is cooperative, so this response stays the
 * model's own stop channel: post_progress surfaces `canceling: true` back as a
 * hard STOP instruction (see the design doc §Cancel).
 *
 * ── The plan (`kind: 'plan'`, A4) ────────────────────────────────────────────
 * `{ kind: 'plan', steps: [{ text, status }] }` writes the run's job plan: the
 * work item is resolved from the run (resolveWorkItemIdForAgentRun) and the
 * one writer, setWorkPlan (src/lib/work/plan.ts), validates and stores it in
 * `tracked_job.plan`. It touches neither `log_tail` nor the ledger's step log
 * (a plan is not a step) and never flips a queued run to running. The answer
 * is `{ ok, plan | error, canceling }`; an invalid plan is a 400 with the words
 * to fix it.
 *
 * Auth: same two gates as the spec route — shared secret + signed run token.
 * Tenancy is the token's. Never 500 on a benign race (a terminal/canceling row is
 * a normal outcome, not an error): a lost beat is only observability.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import {
  extractInternalSecret,
  verifyInternalSecret,
  extractAgentRunToken,
  verifyAgentRunToken,
} from '@/lib/agent-run/agent-run-token'
import { beatAgentRunWork } from '@/lib/work/agent-run-mirror'
import { setWorkPlan } from '@/lib/work/plan'
import { resolveWorkItemIdForAgentRun } from '@/lib/work/touch'

export const dynamic = 'force-dynamic'

/** Keep only the last N chars — same tail discipline as the legacy runner. */
function tail(s: string, n = 4000): string {
  return s.length <= n ? s : s.slice(s.length - n)
}

interface EventBody {
  kind?: 'log' | 'progress' | 'plan'
  text?: unknown
  /** `kind: 'plan'`: the whole plan, replacing the last one. */
  steps?: unknown
}

export async function POST(request: Request) {
  // Gate 1: our-infrastructure caller.
  if (!verifyInternalSecret(extractInternalSecret(request))) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  // Gate 2: a valid run token — the authoritative source of tenancy.
  const claims = verifyAgentRunToken(extractAgentRunToken(request))
  if (!claims) {
    return NextResponse.json({ error: 'invalid or expired run token' }, { status: 401 })
  }

  let body: EventBody
  try {
    body = (await request.json()) as EventBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }
  const text = typeof body.text === 'string' ? body.text : ''

  const supabase = getServiceClient()

  // Read the current row (workspace-scoped by the token). A missing row is a
  // benign race with a cascade/delete — respond ok:false without a 500.
  const { data: row } = await supabase
    .from('agent_run')
    .select('status, log_tail, kind, triggered_by, task_prompt, action_id')
    .eq('id', claims.agentRunId)
    .eq('workspace_id', claims.workspaceId)
    .maybeSingle()
  if (!row) {
    return NextResponse.json({ ok: false, canceling: false }, { status: 200 })
  }

  // A CANCELED row is still "stop": agentRunCancel settles canceling → canceled
  // within seconds of Stop, and the model must keep hearing STOP after that.
  const canceling = row.status === 'canceling' || row.status === 'canceled'

  // The plan: its own column on the run's job, through the one writer. No log
  // line, no ledger beat, no queued → running flip.
  if (body.kind === 'plan') {
    const workItemId = await resolveWorkItemIdForAgentRun(supabase, claims.agentRunId)
    if (!workItemId) {
      return NextResponse.json({ ok: false, error: 'This run has no job to keep a plan on.', canceling }, { status: 200 })
    }
    const written = await setWorkPlan(supabase, { workspaceId: claims.workspaceId, workItemId, steps: body.steps })
    if (!written.ok) {
      return NextResponse.json(
        { ok: false, error: written.error, code: written.code, canceling },
        { status: written.code === 'INPUT_INVALID' ? 400 : 200 },
      )
    }
    return NextResponse.json({ ok: true, plan: written.plan, canceling })
  }

  // Append this beat and re-tail. Read-append-write is best-effort: a lost beat
  // under concurrent writes is only a UI observability gap, never a correctness
  // issue (log_tail is a projection, not authoritative state).
  const nextLog = tail((typeof row.log_tail === 'string' ? row.log_tail : '') + text)

  // On the FIRST event of a still-queued run, mark it running + stamp started_at.
  // Only from 'queued' — never resurrect a terminal/canceling row into 'running'.
  const patch: Record<string, unknown> = { log_tail: nextLog }
  if (row.status === 'queued') {
    patch.status = 'running'
    patch.started_at = new Date().toISOString()
  }

  // Best-effort persist. A benign write race (terminal transition landing between
  // our read and write) must not 500 — swallow and still report the cancel signal.
  try {
    const write = supabase.from('agent_run').update(patch).eq('id', claims.agentRunId)
    // The queued → running flip is a compare-and-set on 'queued': a Stop or
    // settle that lands between our read and this write must win, not be
    // overwritten back to 'running'. (Losing it drops this one log line.)
    await (patch.status ? write.eq('status', 'queued') : write)
  } catch {
    /* best-effort — log_tail is observability, never fail a beat */
  }

  // The same beat feeds the work ledger (a `[tool] …` line is the live step).
  await beatAgentRunWork(
    supabase,
    {
      id: claims.agentRunId,
      workspace_id: claims.workspaceId,
      status: row.status as string,
      kind: row.kind as string | null,
      triggered_by: row.triggered_by as string | null,
      task_prompt: row.task_prompt as string | null,
      action_id: row.action_id as string | null,
    },
    text,
  )

  return NextResponse.json({ ok: true, canceling })
}
