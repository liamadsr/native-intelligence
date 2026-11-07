/**
 * Inngest function for executing a server-side agent coding run.
 *
 * Emitted as `agent/run.requested` with an agent_run.id — by the start-agent
 * route (action-origin) or the run_agent flow executor (flow-origin, or
 * action-origin under use_triggering_action_context). This function checks the
 * run is runnable, then executes it as a durable eve `coding-agent` session
 * (run-agent-eve.ts) — the ONLY cloud coding-run runtime. The eve agent's
 * finish_run tool settles the terminal state + PR link through the internal
 * outcome route; the watcher settles the failure/cancel modes eve can't.
 *
 * Why Inngest: the run is long (minutes) and must be durable, observable, and
 * not block the API response. Concurrency is capped per-workspace so one busy
 * workspace can't starve others or blow the sandbox budget.
 */
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { internalSecret } from '@/lib/agent-run/agent-run-token'
import { buildAgentRunSpec, AGENT_RUN_NOT_FOUND, NOT_LIVE_STATUSES } from '@/lib/agent-run/spec-rebuild'
import {
  runAgentViaEve,
  startAgentEveSession,
  cancelEveCodingSession,
  EVE_SANDBOX_PREFIX,
} from '@/lib/agent-run/run-agent-eve'
import { cancelEveWorkSession } from '@/lib/agent-run/run-work-eve'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'
import { recoverQueuedChatHelpers } from '@/lib/chat/start-helper'
import { emitChildSettled, sweepSettledDelegationParks } from '@/lib/agent-run/delegation'
import { WORK_RUN_IN_FLIGHT_STATUSES } from '@/lib/agent-run/cancel-workspace-runs'
import { precheckBeforeSandbox } from '@/lib/coding/precheck'
import { chatgptPlanFor } from '@/lib/chatgpt/plan-route'
import { CHATGPT_PLAN_NO_CODING_REASON } from '@/lib/chatgpt/plan-models'

/** agent_run statuses no later write may move a run out of. */
const TERMINAL = ['pr_open', 'completed', 'failed', 'canceled']

/**
 * How long one `watch-eve-session-<n>` step watches before handing off to the
 * next: inside /api/inngest's maxDuration (300s) with room for the log flush
 * and the step's own overhead. Each step runs in its own request
 * (checkpointing is off for this function, below).
 */
export const WATCH_STEP_BUDGET_MS = 240_000

/**
 * Watch steps per run: 15 × 240s = 60 min, the run token's TTL
 * (agent-run-token.ts). Past that the session can no longer reach its spec or
 * outcome routes; the stale-run reaper settles a row nobody finished.
 */
export const MAX_WATCH_STEPS = 15

/**
 * A queued/running coding row older than this (from started_at, else
 * created_at) is failed by agentRunReaper: past the 60-min run token plus a
 * margin, nothing can settle it any more.
 */
export const STALE_RUN_AFTER_MS = 90 * 60 * 1000

/** The reason a run fails with when this deployment can't sign run tokens. */
export const NO_INTERNAL_SECRET_REASON =
  'Cloud coding runs are not configured on this deployment (AGENT_RUN_INTERNAL_SECRET is unset).'

export const agentRunExecute = inngest.createFunction(
  {
    id: 'agent-run-execute',
    // One retry — sandbox/network flakes happen; a second attempt is cheap
    // relative to the run, but we don't want infinite loops on a real failure.
    retries: 1,
    // Cap concurrent sandboxes per workspace.
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    // Each step in its own request: the watch steps are each budgeted to fit one
    // request's maxDuration, which only holds if steps are not chained inside a
    // single request (Inngest v4 checkpointing, on by default, would do that).
    checkpointing: false,
    // Stop this run (and any pending retry) the moment a cancel for THIS
    // agent_run arrives. Inngest stops awaiting the eve watcher; the separate
    // agentRunCancel function settles the status, since this function's code
    // after the await never runs once cancelled.
    cancelOn: [{ event: 'agent/run.cancel', match: 'data.agent_run_id' }],
    triggers: [{ event: 'agent/run.requested' }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id } = event.data as {
      agent_run_id: string
      workspace_id: string
    }
    const supabase = getServiceClient()

    // 1. Is the run runnable? The SAME spec build the eve agent's spec route
    //    serves (spec-rebuild.ts), for both origins, so the two agree on what a
    //    buildable run is. The spec route additionally refuses a row that is no
    //    longer live (NOT_LIVE_STATUSES: canceling or settled); the idempotency
    //    guard below refuses the same set at dispatch, so no session is started
    //    for a row the spec route would already 404 (a Stop landing after that
    //    read is caught by the watcher's cancel path). The step returns ONLY
    //    non-secret routing facts: the spec carries the user's GitHub token and
    //    step output is persisted in Inngest's run history.
    const ctx = await step.run('load-run-context', async () => {
      const built = await buildAgentRunSpec(supabase, { agentRunId: agent_run_id, workspaceId: workspace_id })
      if (!built.run) throw new Error(AGENT_RUN_NOT_FOUND)
      // Without the internal secret no run token can be signed, so the eve
      // session could never fetch its spec — fail the run with a clear cause
      // instead of throwing into a retry that leaves the row queued forever.
      const failure = built.ok ? (internalSecret() ? null : NO_INTERNAL_SECRET_REASON) : built.reason
      // The ChatGPT free tier: a coding run is Sonnet in a cloud sandbox, all
      // Dial8-paid, so a person on their own ChatGPT plan never gets one,
      // whichever way it was started (Start, an answered pre-check, a flow).
      // Refused before the pre-check, which is a model call too.
      const freeTier = !failure && (await chatgptPlanFor(built.run.triggeredBy))
      return {
        actionId: built.run.actionId,
        triggeredBy: built.run.triggeredBy,
        origin: built.origin,
        // The repo the sandbox will clone (non-secret). Stamped onto the row below
        // so the outcome route opens the PR against the SAME repo.
        repoFullName: built.ok ? built.spec.repoFullName : null,
        failure: failure ?? (freeTier ? CHATGPT_PLAN_NO_CODING_REASON : null),
      }
    })

    // 2. Precondition failure → settle failed. CAS-guarded: a replay against a
    //    run that already reached a terminal state never overwrites it.
    if (ctx.failure) {
      const reason = ctx.failure
      await step.run('mark-failed-precondition', async () => {
        const { data: took } = await supabase
          .from('agent_run')
          .update({ status: 'failed', error_message: reason, finished_at: new Date().toISOString() })
          .eq('id', agent_run_id)
          .eq('workspace_id', workspace_id)
          .not('status', 'in', `(${TERMINAL.join(',')})`)
          .select('id')
        if (!took || took.length === 0) return
        // Flow-origin runs have no action to stamp agent_run_status on.
        if (ctx.actionId) {
          await supabase.from('actions').update({ agent_run_status: 'failed' }).eq('id', ctx.actionId)
        }
        await mirrorAgentRunStatus(
          supabase,
          { agentRunId: agent_run_id, workspaceId: workspace_id },
          { status: 'failed', error: reason },
        )
      })
      return { ok: false, reason }
    }

    // Idempotency guard, read FRESH on every replay (not a memoized step, whose
    // replay would hand back the first attempt's status): if the run already
    // settled (e.g. finish_run landed before a function-level retry), start and
    // watch nothing. A still-running row is the legitimate retry: it re-attaches
    // to the memoized session below instead of starting a second one.
    const { data: guardRow } = await supabase
      .from('agent_run')
      .select('status, pr_url')
      .eq('id', agent_run_id)
      .eq('workspace_id', workspace_id)
      .maybeSingle()
    const guard = {
      status: (guardRow?.status as string | null) ?? null,
      prUrl: (guardRow?.pr_url as string | null) ?? null,
    }
    if (guard.status && TERMINAL.includes(guard.status)) {
      return { ok: guard.status !== 'failed', prUrl: guard.prUrl, alreadySettled: true }
    }
    // A Stop that landed before dispatch (row 'canceling', agentRunCancel not yet
    // settled it, or this function's cancelOn missed). The spec route already
    // refuses a non-live row, so a session started now would run spec-less —
    // default model, no persona, deny-all sandbox — until something stopped it.
    // Start nothing; agentRunCancel owns the canceling → canceled settle.
    if (guard.status && NOT_LIVE_STATUSES.has(guard.status)) {
      return { ok: false, canceled: true }
    }
    // Parked on its pre-check's questions (below): the person's answer
    // re-dispatches it. A retry of the dispatch that parked it starts nothing.
    if (guard.status === 'needs_input') {
      return { ok: false, parked: true }
    }

    // 2b. The pre-check (P10 F5, src/lib/coding/precheck.ts): is the action
    //     clear enough to build? Once per run, before any sandbox. An unclear
    //     action parks the run on its questions (the action's run panel and
    //     For you ask them) and nothing more runs until the person answers.
    //     It also writes the acceptance criteria the reviewer checks. A model
    //     failure goes ahead (fail open for a person's Start).
    const pre = await step.run('precheck', () =>
      precheckBeforeSandbox(supabase, { agentRunId: agent_run_id, workspaceId: workspace_id, userId: ctx.triggeredBy }),
    )
    if (pre.parked) {
      return { ok: false, parked: true, needsClarification: true }
    }

    // The row's repo_full_name must equal the repo the spec clones: the outcome
    // route opens the PR on the ROW's repo (never the request body's). They can
    // differ — a run_agent flow action with use_triggering_action_context inserts
    // its config repo, while an action-origin spec clones the action's project
    // repo — so stamp the spec's repo here, before the session starts.
    // CAS-guarded: never touch a row that already settled.
    if (ctx.repoFullName) {
      const repoFullName = ctx.repoFullName
      await step.run('stamp-repo', async () => {
        await supabase
          .from('agent_run')
          .update({ repo_full_name: repoFullName })
          .eq('id', agent_run_id)
          .eq('workspace_id', workspace_id)
          .not('status', 'in', `(${TERMINAL.join(',')})`)
          .select('id')
      })
    }

    // 3. Execute on the eve `coding-agent` — both origins. The session is created
    //    in its OWN memoized step, so a retry (a killed request, retries:1)
    //    replays the same session id instead of starting a second agent on the
    //    same branch. It is then watched in budgeted steps, each re-attaching
    //    from where the last stopped, so a run longer than one request is
    //    watched to the end rather than killed and restarted. The agent's
    //    finish_run (via the outcome route) OR the watcher settles the terminal
    //    state; nothing more to write here.
    const userId = ctx.triggeredBy || ''
    const session = await step.run('create-eve-session', () =>
      startAgentEveSession({
        agentRunId: agent_run_id,
        workspaceId: workspace_id,
        userId,
        supabase,
      }),
    )
    let fromIndex = 0
    for (let n = 0; n < MAX_WATCH_STEPS; n++) {
      const watched = await step.run(`watch-eve-session-${n}`, () =>
        runAgentViaEve({
          agentRunId: agent_run_id,
          workspaceId: workspace_id,
          userId,
          supabase,
          sessionId: session.sessionId,
          fromIndex,
          budgetMs: WATCH_STEP_BUDGET_MS,
          stamped: session.stamped,
        }),
      )
      if (!watched.pending) {
        return { ok: watched.settled !== 'failed', settled: watched.settled, sessionId: session.sessionId }
      }
      fromIndex = watched.pending.nextIndex
    }
    // Still running after the token's lifetime: the session can no longer reach
    // its routes. The reaper (agentRunReaper) settles the row if nothing does.
    return { ok: false, settled: null, sessionId: session.sessionId, watchExhausted: true }
  },
)

/**
 * Cancels a server-side agent run (coding or work run).
 *
 * Emitted as `agent/run.cancel` (with the agent_run.id) when the user hits Stop.
 * The SAME event cancels `agentRunExecute` / the work-run dispatch via their
 * `cancelOn` — but that only stops Inngest from awaiting the eve watcher. This
 * function settles the run as `canceled`.
 *
 * There is no sandbox for us to stop: every run's `sandbox_id` is the eve session
 * id under the `eve:` prefix (EVE_SANDBOX_PREFIX), and eve owns that session's
 * sandbox lifecycle (retention-based teardown). For a CODING run we ask eve to
 * cancel the session (its running turn + background tasks) so Stop preempts the
 * agent; that cancel is cooperative, so the model is ALSO told to stop through
 * post_progress's `canceling` signal (true for canceling AND canceled rows), and
 * the watcher aborts its stream on seeing either. Work runs (kind='workspace')
 * live on a different eve mount and keep the signal-only path.
 *
 * Idempotent and terminal-safe: if the run already finished (raced the cancel),
 * we leave its outcome alone.
 */
export const agentRunCancel = inngest.createFunction(
  {
    id: 'agent-run-cancel',
    retries: 2,
    triggers: [{ event: 'agent/run.cancel' }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id, reason } = event.data as {
      agent_run_id: string
      workspace_id: string
      /** Why — 'Canceled by user' when absent; the workspace kill switch names itself. */
      reason?: string | null
    }
    const cancelReason = typeof reason === 'string' && reason.trim() ? reason.trim() : 'Canceled by user'
    const supabase = getServiceClient()

    const run = await step.run('load-run', async () => {
      const { data } = await supabase
        .from('agent_run')
        .select('id, status, sandbox_id, action_id, kind, triggered_by')
        .eq('id', agent_run_id)
        .eq('workspace_id', workspace_id)
        .single()
      return data
    })

    if (!run) return { ok: false, reason: 'run not found' }

    // The `eve:` prefix marks a run whose sandbox eve owns. A bare (un-prefixed)
    // id could only be a row from the retired Vercel-Sandbox runner — nothing in
    // this app can stop that sandbox any more (it expires on its own wall-clock
    // timeout), so say so rather than pretend.
    const sandboxId = run.sandbox_id as string | null
    const eveSession = !!sandboxId && sandboxId.startsWith(EVE_SANDBOX_PREFIX)
    if (sandboxId && !eveSession) {
      console.warn(`[agent-run-cancel] run ${agent_run_id} carries a non-eve sandbox id; nothing to stop`)
    }

    await step.run('settle-canceled', async () => {
      // Only move NON-terminal runs to canceled — don't clobber a run that
      // already reached pr_open/completed/failed in a race with the cancel. The
      // terminal guard lives IN the UPDATE's WHERE (a CAS), NOT read off the
      // memoized load-run status: a run can settle completed in the gap between
      // load-run and this step (or on an Inngest retry that replays the memoized
      // load-run), and an unguarded write would resurrect a completed run as
      // canceled — clobbering its summary/deliverables and the "ready for review"
      // notification. `.not('status', 'in', ...)` makes the DB reject the write
      // unless the row is still non-terminal at write time.
      const { data: settled } = await supabase
        .from('agent_run')
        .update({
          status: 'canceled',
          error_message: cancelReason,
          finished_at: new Date().toISOString(),
          // A run canceled while parked at needs_input must not keep its
          // stale question around (the respond route guards on status, but
          // a terminal row should not carry a pending ask).
          pending_input: null,
        })
        .eq('id', agent_run_id)
        .eq('workspace_id', workspace_id)
        .not('status', 'in', `(${TERMINAL.join(',')})`)
        .select('id')
      // Only reset the action when the cancel write actually took (the run was
      // ours to cancel) — a lost CAS means a terminal winner owns the action state.
      if (settled && settled.length > 0) {
        if (run.action_id) {
          await supabase
            .from('actions')
            .update({ agent_run_status: 'idle' })
            .eq('id', run.action_id)
        }
        await mirrorAgentRunStatus(
          supabase,
          { agentRunId: agent_run_id, workspaceId: workspace_id },
          { status: 'canceled', reason: cancelReason },
        )
        // A delegated child tells its parent it was stopped.
        await emitChildSettled(supabase, { childRunId: agent_run_id, workspaceId: workspace_id })
      }
    })

    // Stopping a run stops the work it handed over (delegate_work, Part 3): the
    // same CAS + cancel event the kill switch sends, for each in-flight child.
    // Each child's own cancel fans out to ITS children, so the subtree stops.
    await step.run('cancel-children', async () => {
      const { data: children } = await supabase
        .from('agent_run')
        .select('id')
        .eq('parent_run_id', agent_run_id)
        .eq('workspace_id', workspace_id)
        .in('status', [...WORK_RUN_IN_FLIGHT_STATUSES])
      const flipped: string[] = []
      for (const child of (children ?? []) as Array<{ id: string }>) {
        const { data: took } = await supabase
          .from('agent_run')
          .update({ status: 'canceling' })
          .eq('id', child.id)
          .eq('workspace_id', workspace_id)
          .in('status', [...WORK_RUN_IN_FLIGHT_STATUSES])
          .select('id')
        if (took && took.length > 0) flipped.push(child.id)
      }
      if (flipped.length > 0) {
        await inngest.send(
          flipped.map((id) => ({
            name: 'agent/run.cancel' as const,
            data: { agent_run_id: id, workspace_id, reason: 'The run that handed this over was stopped' },
          })),
        )
      }
      return { children: flipped.length }
    })

    // Preempt the agent: eve's server-side session cancel, on the mount that
    // owns the session (the work-agent for a workspace run, the coding-agent
    // otherwise). Runs whether or not the settle above took (a watcher may have
    // settled first; the session can still be running). Best-effort — the row
    // is already settled, and for a work run the watcher's cancel-signal poll
    // aborts its drain on the next flush; this is what stops the TURN, so a
    // canceled run stops consuming instead of finishing on its own.
    let sessionCancel: string | null = null
    if (eveSession) {
      const sessionId = sandboxId!.slice(EVE_SANDBOX_PREFIX.length)
      const cancelArgs = {
        sessionId,
        agentRunId: agent_run_id,
        workspaceId: workspace_id,
        userId: (run.triggered_by as string | null) ?? '',
      }
      sessionCancel = await step.run('cancel-eve-session', () =>
        (run.kind as string | null) === 'workspace'
          ? cancelEveWorkSession(cancelArgs)
          : cancelEveCodingSession(cancelArgs),
      )
    }

    return { ok: true, eveSession, sessionCancel }
  },
)

/**
 * Reaps stale agent runs of BOTH kinds: a row still 'queued' or 'running'
 * STALE_RUN_AFTER_MS after it started (else was created) is past its 60-min run
 * token AND past the longest turn the step-split watchers drive (15 × 240 s), so
 * no finish_run / finish_work, watcher or spec fetch can settle it any more, and
 * it would sit "running" forever (a killed dispatch, a watch that ran out, a
 * session that died quietly). Fail it, CAS-guarded so a late real outcome is
 * never overwritten, and ask eve to cancel its session (the coding-agent or the
 * work-agent mount, by kind) in case it is still going. A parked work run
 * (needs_input) is not stale — it is waiting on a person or on the teammates it
 * handed work to — and is left alone; a run parked on teammates who have all
 * finished gets its child-settled event again (sweepSettledDelegationParks).
 */
export const agentRunReaper = inngest.createFunction(
  {
    id: 'agent-run-reaper',
    retries: 1,
    triggers: [{ cron: '*/15 * * * *' }],
  },
  async ({ step }) => {
    const supabase = getServiceClient()
    const reaped = await step.run('reap-stale-agent-runs', () => reapStaleAgentRuns(supabase))
    // Recover a chat launch that committed before its request could mirror or send.
    const chatRecovered = await step.run('recover-queued-chat-delegations', () => recoverQueuedChatHelpers(supabase))
    // A parent parked on children that all finished, whose child-settled event
    // was lost, is nudged again (delegation.ts).
    const nudged = await step.run('nudge-settled-delegation-parks', () => sweepSettledDelegationParks(supabase))
    return { reaped, nudged, chatRecovered }
  },
)

/** The reason a stale run is failed with. */
export const STALE_RUN_REASON = 'The run stopped reporting and was ended: no outcome within 90 minutes.'

/** The run kinds the reaper covers: cloud coding runs and workspace work runs. */
export const REAPED_RUN_KINDS = ['coding', 'workspace'] as const

/** One reaper pass (exported for tests). Returns how many rows it failed. */
export async function reapStaleAgentRuns(
  supabase: ReturnType<typeof getServiceClient>,
  now = Date.now(),
): Promise<number> {
  const cutoff = new Date(now - STALE_RUN_AFTER_MS).toISOString()
  // started_at is the start of the run's CURRENT turn: a parked work run gets
  // it re-stamped when it un-parks (respond route, openResumedTurn), so a run
  // that waited hours for an answer is measured from the answer, not from its
  // first dispatch. A `needs_input` row is never selected here at all.
  const { data: rows, error } = await supabase
    .from('agent_run')
    .select('id, workspace_id, kind, status, sandbox_id, action_id, triggered_by, started_at, created_at')
    .in('kind', [...REAPED_RUN_KINDS])
    .in('status', ['queued', 'running'])
    // coalesce(started_at, created_at) < cutoff
    .or(`started_at.lt.${cutoff},and(started_at.is.null,created_at.lt.${cutoff})`)
    .limit(50)
  if (error || !rows) return 0

  let reaped = 0
  for (const row of rows) {
    const { data: took } = await supabase
      .from('agent_run')
      .update({ status: 'failed', error_message: STALE_RUN_REASON, finished_at: new Date(now).toISOString() })
      .eq('id', row.id)
      .eq('workspace_id', row.workspace_id)
      .in('status', ['queued', 'running'])
      .select('id')
    if (!took || took.length === 0) continue
    reaped += 1
    if (row.action_id) {
      await supabase.from('actions').update({ agent_run_status: 'failed' }).eq('id', row.action_id)
    }
    await mirrorAgentRunStatus(
      supabase,
      { agentRunId: row.id as string, workspaceId: row.workspace_id as string },
      { status: 'failed', error: STALE_RUN_REASON },
    )
    await emitChildSettled(supabase, { childRunId: row.id as string, workspaceId: row.workspace_id as string })
    const sandboxId = row.sandbox_id as string | null
    if (sandboxId?.startsWith(EVE_SANDBOX_PREFIX)) {
      const cancelArgs = {
        sessionId: sandboxId.slice(EVE_SANDBOX_PREFIX.length),
        agentRunId: row.id as string,
        workspaceId: row.workspace_id as string,
        userId: (row.triggered_by as string | null) ?? '',
      }
      // The session lives on the mount that created it: the work-agent for a
      // workspace run, the coding-agent for everything else.
      if ((row.kind as string | null) === 'workspace') await cancelEveWorkSession(cancelArgs)
      else await cancelEveCodingSession(cancelArgs)
    }
  }
  return reaped
}
