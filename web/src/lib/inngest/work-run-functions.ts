/**
 * Inngest function for executing an approved WORK run (Loops v3 work proposals —
 * docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * Emitted by the attention-items Start action as `work/run.requested` with an
 * agent_run.id (kind='workspace'). This function loads the run + its origin card
 * + tracked action, builds the JSON brief, and dispatches a durable eve
 * work-agent session (run-work-eve.ts), which streams progress into
 * agent_run.log_tail and lets the agent's finish_work settle the terminal state.
 *
 * Why Inngest: the run is long (a substantive draft/doc takes minutes) and must
 * be durable, observable, and not block the Start API response. Concurrency is
 * capped per-workspace so one busy workspace can't starve others.
 *
 * Cancel: shares the existing `agent/run.cancel` event + the agentRunCancel
 * function (agent-run-functions.ts). A work run's sandbox_id carries the `eve:`
 * prefix (an eve-owned session — nothing to tear down), so agentRunCancel just
 * settles the row canceled — the SAME rule the coding path follows. This function's cancelOn stops the
 * dispatch the moment a cancel for THIS run arrives.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { packageVisibleTo } from '@/lib/knowledge/package-acl'
import {
  releaseDelegationPark,
  startWorkEveSession,
  watchWorkEveSession,
  resumeWorkEveSession,
  type WorkRunBrief,
  type WorkWatchOutcome,
} from '@/lib/agent-run/run-work-eve'
import {
  AGENT_RUN_TERMINAL_STATUSES,
  type WorkResourceRef,
  type AskUserAnswer,
  type PendingInput,
} from '@/lib/agent-run/types'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'
import { CHILD_SETTLED_EVENT, emitChildSettled, type DelegationRequest } from '@/lib/agent-run/delegation'
import { loadBriefSource } from '@/lib/work/provenance'
import { loadTeammateMemory } from '@/lib/work/agent-memory'

const TERMINAL = AGENT_RUN_TERMINAL_STATUSES as readonly string[]

/**
 * How long one `watch-eve-session-<n>` step watches before handing off to the
 * next: inside /api/inngest's maxDuration (300s) with room for the log flush
 * and the step's own overhead. Each step runs in its own request
 * (checkpointing is off for both functions below). Same figure as the coding
 * path (agent-run-functions.ts WATCH_STEP_BUDGET_MS).
 *
 * `WORK_WATCH_STEP_BUDGET_MS` (env) overrides it, between 5 s and 290 s — a
 * dev-server gate run shortens it to force a long turn across many watch-step
 * boundaries (scripts/work-run-gate-smoke.ts). Anything else keeps the default.
 */
export const WORK_WATCH_STEP_BUDGET_MS = readWatchBudgetMs(process.env.WORK_WATCH_STEP_BUDGET_MS, 240_000)

function readWatchBudgetMs(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 5_000 || n > 290_000) return fallback
  return Math.floor(n)
}

/**
 * Watch steps per dispatch or resume: 15 × 240s = 60 min of one turn. Each watch
 * mints its own run token, so the token TTL is not the limit — this is a cap on
 * how long ONE turn may run before the row is left to the reaper.
 */
export const MAX_WORK_WATCH_STEPS = 15

/** Statuses a fresh guard read treats as "nothing to dispatch". */
const NOT_DISPATCHABLE = new Set<string>([...TERMINAL, 'canceling', 'needs_input'])

/** The slice of Inngest's step tools the watch loop needs (a memoized `run`). */
type StepRunner = { run: (id: string, fn: () => Promise<unknown>) => Promise<unknown> }

/**
 * Watch one eve work session across budgeted steps until its turn settles,
 * parks, or is canceled — or `MAX_WORK_WATCH_STEPS` elapse. Shared by the
 * dispatch and the resume: both end in exactly this loop.
 */
async function watchAcrossSteps(
  step: StepRunner,
  args: {
    agentRunId: string
    workspaceId: string
    userId: string
    sessionId: string
    fromIndex: number
    supabase: SupabaseClient
  },
): Promise<{ ok: boolean; settled: string | null; sessionId: string; watchExhausted?: true }> {
  let fromIndex = args.fromIndex
  let carried: PendingInput | null = null
  let carriedDelegations: DelegationRequest[] = []
  for (let n = 0; n < MAX_WORK_WATCH_STEPS; n++) {
    const watched = (await step.run(`watch-eve-session-${n}`, () =>
      watchWorkEveSession({
        agentRunId: args.agentRunId,
        workspaceId: args.workspaceId,
        userId: args.userId,
        sessionId: args.sessionId,
        fromIndex,
        budgetMs: WORK_WATCH_STEP_BUDGET_MS,
        carriedPendingInput: carried,
        carriedDelegations,
        supabase: args.supabase,
      }),
    )) as WorkWatchOutcome
    if (!watched.pending) {
      return { ok: watched.settled !== 'failed', settled: watched.settled, sessionId: args.sessionId }
    }
    fromIndex = watched.pending.nextIndex
    carried = watched.pending.pendingInput
    carriedDelegations = watched.pending.delegations ?? []
  }
  // Still running after the watch cap: the session keeps going on eve and its
  // finish_work can still settle the row through the outcome route; the ledger
  // reaper fails a row nobody beats. Nothing more to watch here.
  return { ok: false, settled: null, sessionId: args.sessionId, watchExhausted: true }
}

/** At most this many declared packages are pre-loaded into the brief. */
const MAX_PACKAGE_CONTEXT = 3
/** Fuse on a compiled brief's size (briefs are ≤900 words; this is a clamp, not a feature). */
const PACKAGE_BRIEF_MAX_CHARS = 6000

/** One pre-loaded package brief, embedded in the work-run brief. */
type PackageContextEntry = { id: string; name: string; brief: string | null }

/**
 * Pre-load the compiled briefs for a work run's declared package resources so the
 * executing agent starts with the curated context already in hand (Loops v3 Phase 4
 * — docs/loop-engine/PACKAGE-AWARE-PROPOSALS-DESIGN.md, W-B).
 *
 * The Start snapshot already validated these package ids once under the
 * declarer's RLS, but visibility can drift between Start and execution (a
 * package narrowed to personal/team, the declarer removed) — so each id is
 * re-checked against the triggering user via the mig-238 predicate
 * (packageVisibleTo; service-role client, hence the explicit user id). A
 * package that no longer verifies is skipped silently, same as moved/deleted.
 * We re-fence `workspace_id` too, and batch both content reads with `.in()`:
 * one knowledge_package select (existence + name) and one knowledge_brief
 * select (the compiled markdown).
 * A package with no compiled brief yet → `brief: null` (the agent falls back to
 * get_package). Only the first {@link MAX_PACKAGE_CONTEXT} package refs are loaded.
 *
 * Entirely fail-soft: any error → `undefined` (the field is omitted and the run
 * proceeds exactly as today). Package content is untrusted workspace data — it is
 * embedded as context, not instructions (see instructions.md's Declared resources).
 */
async function loadPackageContext(
  supabase: SupabaseClient,
  workspaceId: string,
  resources: WorkResourceRef[],
  triggeredBy: string | null,
): Promise<PackageContextEntry[] | undefined> {
  try {
    // No attributable user → no package context (fail closed, still soft).
    if (!triggeredBy) return undefined
    // First 3 package refs with a string id, de-duplicated (a card could list the
    // same package twice), preserving declaration order.
    const seen = new Set<string>()
    const candidates: string[] = []
    for (const r of resources) {
      if (r?.type !== 'package' || typeof r.id !== 'string' || !r.id) continue
      if (seen.has(r.id)) continue
      seen.add(r.id)
      candidates.push(r.id)
      if (candidates.length >= MAX_PACKAGE_CONTEXT) break
    }
    if (candidates.length === 0) return undefined

    // Visibility re-check per id (drift window between Start and execution).
    const visible = await Promise.all(
      candidates.map((id) => packageVisibleTo(supabase, triggeredBy, id)),
    )
    const ids = candidates.filter((_, i) => visible[i])
    if (ids.length === 0) return undefined

    // Re-fence: the package must still live in THIS workspace (name doubles as the
    // existence check — a missing row means moved/deleted → skipped).
    const { data: pkgRows } = await supabase
      .from('knowledge_package')
      .select('id, name')
      .eq('workspace_id', workspaceId)
      .in('id', ids)
    const names = new Map<string, string>()
    for (const p of (pkgRows ?? []) as Array<{ id: string; name: string | null }>) {
      names.set(p.id as string, (p.name as string | null) ?? '')
    }

    // Batch the compiled briefs (scope_type='package'), same workspace.
    const { data: briefRows } = await supabase
      .from('knowledge_brief')
      .select('scope_id, content')
      .eq('workspace_id', workspaceId)
      .eq('scope_type', 'package')
      .in('scope_id', ids)
    const briefs = new Map<string, string>()
    for (const b of (briefRows ?? []) as Array<{ scope_id: string; content: string | null }>) {
      const content = b.content as string | null
      if (typeof content === 'string') briefs.set(b.scope_id as string, content)
    }

    // Assemble in declaration order, skipping any package that no longer verifies.
    const out: PackageContextEntry[] = []
    for (const id of ids) {
      if (!names.has(id)) continue
      const raw = briefs.get(id)
      const brief = typeof raw === 'string' ? raw.slice(0, PACKAGE_BRIEF_MAX_CHARS) : null
      out.push({ id, name: names.get(id) ?? '', brief })
    }
    return out.length ? out : undefined
  } catch {
    // Fail-soft by contract: a thrown lookup never blocks the run — the field is
    // simply omitted and the agent works without pre-loaded package context.
    return undefined
  }
}

export const workRunExecute = inngest.createFunction(
  {
    id: 'work-run-execute',
    // One retry — network/transport flakes happen; a second attempt re-enters
    // through the fresh idempotency guard + the memoized create step below, and
    // re-attaches to the first attempt's session instead of starting another.
    retries: 1,
    // Cap concurrent work sessions per workspace.
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    // Each step in its own request: the watch steps are each budgeted to fit one
    // request's maxDuration, which only holds if steps are not chained inside a
    // single request (Inngest v4 checkpointing, on by default, would do that).
    checkpointing: false,
    // Stop this run (and any pending retry) the moment a cancel for THIS run
    // arrives. Inngest stops awaiting the eve watcher; agentRunCancel settles
    // the row canceled (no sandbox to tear down — eve: prefix).
    cancelOn: [{ event: 'agent/run.cancel', match: 'data.agent_run_id' }],
    triggers: [{ event: 'work/run.requested' }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id } = event.data as {
      agent_run_id: string
      workspace_id: string
    }
    const supabase = getServiceClient()

    // 1. Load the run + everything the brief needs (workspace-scoped). Memoized —
    //    the brief must be the same on a retry. NOTE: `status` here is the status
    //    at FIRST attempt; never use it as the idempotency guard (step 2).
    const ctx = await step.run('load-work-context', async () => {
      const { data: run } = await supabase
        .from('agent_run')
        .select('id, status, kind, task_prompt, resources, triggered_by, attention_item_id, action_id, ai_team_member_id')
        .eq('id', agent_run_id)
        .eq('workspace_id', workspace_id)
        .single()
      if (!run) throw new Error('agent_run not found')
      if (run.kind !== 'workspace') throw new Error('agent_run is not a workspace run')

      // The tracked action's identifier (e.g. GEN-42) for the brief — best-effort.
      let trackedActionIdentifier: string | null = null
      if (run.action_id) {
        const { data: action } = await supabase
          .from('actions')
          .select('identifier')
          .eq('id', run.action_id)
          .eq('workspace_id', workspace_id)
          .maybeSingle()
        trackedActionIdentifier = (action?.identifier as string | null) ?? null
      }

      // The origin card's deliverable_hint — best-effort (the card may have been
      // swept on its TTL; the run row is the source of truth for everything else).
      let deliverableHint: string | null = null
      if (run.attention_item_id) {
        const { data: card } = await supabase
          .from('attention_item')
          .select('payload')
          .eq('id', run.attention_item_id)
          .maybeSingle()
        const payload = card?.payload as Record<string, unknown> | null
        const hint = payload?.deliverable_hint
        deliverableHint = typeof hint === 'string' ? hint : null
      }

      // The triggering user's display name for the brief.
      let userName: string | null = null
      if (run.triggered_by) {
        const { data: member } = await supabase
          .from('member')
          .select('display_name')
          .eq('user_id', run.triggered_by)
          .eq('workspace_id', workspace_id)
          .maybeSingle()
        userName = (member?.display_name as string | null) ?? null
      }

      // The workspace name.
      const { data: ws } = await supabase
        .from('workspace')
        .select('name')
        .eq('id', workspace_id)
        .maybeSingle()
      const workspaceName = (ws?.name as string | null) ?? null

      // Resources snapshot lives on the run row (captured at Start).
      const rawResources = run.resources
      const resources: WorkResourceRef[] = Array.isArray(rawResources)
        ? (rawResources as WorkResourceRef[])
        : []

      // Pre-load declared packages' compiled briefs (fail-soft; field omitted on
      // any error). Package content is context/data, not instructions.
      const packageContext = await loadPackageContext(
        supabase,
        workspace_id,
        resources,
        (run.triggered_by as string | null) ?? null,
      )

      // The teammate doing the work, and where the work came from (B PR 4) —
      // both fail-soft: a missing teammate or provenance just leaves the field out.
      let teammate: { name: string; role: string | null } | undefined
      if (run.ai_team_member_id) {
        const { data: mate } = await supabase
          .from('ai_team_member')
          .select('name, role')
          .eq('id', run.ai_team_member_id)
          .eq('workspace_id', workspace_id)
          .maybeSingle()
        if (mate?.name) teammate = { name: mate.name as string, role: (mate.role as string | null) ?? null }
      }
      const source = await loadBriefSource(supabase, {
        workspaceId: workspace_id,
        agentRunId: agent_run_id,
        triggeredBy: (run.triggered_by as string | null) ?? null,
      })
      // What the teammate remembers from its earlier runs (row 15), fail-soft.
      const memory = teammate
        ? await loadTeammateMemory(supabase, {
            workspaceId: workspace_id,
            teammateId: run.ai_team_member_id as string,
            userId: (run.triggered_by as string | null) ?? null,
          })
        : undefined

      return {
        status: run.status as string,
        task: (run.task_prompt as string | null) ?? '',
        triggeredBy: (run.triggered_by as string | null) ?? '',
        resources,
        packageContext,
        deliverableHint,
        trackedActionIdentifier,
        userName,
        workspaceName,
        teammate,
        source,
        memory,
      }
    })

    // 2. Idempotency guard, read FRESH on every replay (not the memoized step,
    //    whose replay would hand back the first attempt's status): a terminal row
    //    already finished (finish_work / cancel landed before the retry), a
    //    canceling row is agentRunCancel's, and a needs_input row is parked — the
    //    resume function owns it. None of them gets a session started or watched.
    const { data: guardRow } = await supabase
      .from('agent_run')
      .select('status')
      .eq('id', agent_run_id)
      .eq('workspace_id', workspace_id)
      .maybeSingle()
    const guardStatus = (guardRow?.status as string | null) ?? ctx.status
    if (TERMINAL.includes(guardStatus)) {
      return { ok: guardStatus !== 'failed', alreadySettled: true }
    }
    if (NOT_DISPATCHABLE.has(guardStatus)) {
      return { ok: true, status: guardStatus, skipped: true }
    }

    // 3. Guard: a run with no task can't proceed. Settle it failed rather than
    //    dispatching an empty session.
    if (!ctx.task.trim()) {
      await step.run('mark-failed-precondition', async () => {
        const { data: run } = await supabase
          .from('agent_run')
          .select('action_id')
          .eq('id', agent_run_id)
          .maybeSingle()
        await supabase
          .from('agent_run')
          .update({ status: 'failed', error_message: 'No task text for this work run.', finished_at: new Date().toISOString() })
          .eq('id', agent_run_id)
        const actionId = (run?.action_id as string | null) ?? null
        if (actionId) {
          await supabase.from('actions').update({ agent_run_status: 'failed' }).eq('id', actionId)
        }
        await mirrorAgentRunStatus(
          supabase,
          { agentRunId: agent_run_id, workspaceId: workspace_id },
          { status: 'failed', error: 'No task text for this work run.' },
        )
        await emitChildSettled(supabase, { childRunId: agent_run_id, workspaceId: workspace_id })
      })
      return { ok: false, reason: 'no task' }
    }

    // 4. Create the durable eve work session in its OWN memoized step, so a retry
    //    (a killed request, retries:1) replays the same session id instead of
    //    starting a second agent on the same task; the `eve:` stamp on the row
    //    covers a retry that lands before this step's result was recorded
    //    (startWorkEveSession reuses a stamped live session). Then watch it in
    //    budgeted steps, each re-attaching from where the last stopped, so a turn
    //    longer than one request is watched to its boundary rather than killed
    //    and restarted. finish_work (via the outcome route), the watcher's
    //    classifier (park / bare-park / cancel), or the reaper settles the row.
    const brief: WorkRunBrief = {
      task: ctx.task,
      userName: ctx.userName,
      workspaceName: ctx.workspaceName,
      resources: ctx.resources,
      deliverableHint: ctx.deliverableHint,
      trackedActionIdentifier: ctx.trackedActionIdentifier,
      // Only present when at least one declared package verified + loaded.
      ...(ctx.packageContext ? { packageContext: ctx.packageContext } : {}),
      ...(ctx.teammate ? { teammate: ctx.teammate } : {}),
      ...(ctx.source ? { source: ctx.source } : {}),
      ...(ctx.memory ? { memory: ctx.memory } : {}),
    }
    const session = await step.run('create-eve-session', () =>
      startWorkEveSession({
        agentRunId: agent_run_id,
        workspaceId: workspace_id,
        userId: ctx.triggeredBy,
        brief,
        supabase,
      }),
    )

    // A parked run holds NO concurrency slot: a needs_input classification ends
    // this invocation and work-run-resume picks the session back up.
    return watchAcrossSteps(step, {
      agentRunId: agent_run_id,
      workspaceId: workspace_id,
      userId: ctx.triggeredBy,
      sessionId: session.sessionId,
      fromIndex: session.fromIndex,
      supabase,
    })
  },
)

/**
 * Resume a parked (needs_input) WORK run with the user's answer (Loops v3 Phase 3
 * — docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * Emitted by the respond route (`/api/account/agent-runs/[id]/respond`) as
 * `work/run.resumed` with `{ agent_run_id, workspace_id, response }`, after that
 * route CAS'd the run needs_input→queued. This function answers the approval in
 * its own memoized step (resumeWorkEveSession: fresh token, the approval
 * choreography, clears pending_input, CAS queued→running) and then watches the
 * resumed turn in the SAME budgeted steps a dispatch uses — so it can settle,
 * park AGAIN on a follow-up question, or fail exactly like the initial dispatch,
 * and a turn longer than one request is not cut off.
 *
 * Same per-workspace concurrency cap as work-run-execute (a resume runs a real eve
 * turn — it competes for the same budget), and the same `cancelOn: agent/run.cancel`
 * so Stop on a resuming run halts it.
 */
export const workRunResume = inngest.createFunction(
  {
    id: 'work-run-resume',
    // One retry — a resume send is a network op; a second attempt re-enters
    // through the memoized resume step (and its queued→running CAS, which no-ops
    // if the row is no longer queued).
    retries: 1,
    // Share work-run-execute's per-workspace concurrency: a resume drives a real
    // eve turn and must not let a busy workspace starve others.
    concurrency: [{ limit: 2, key: 'event.data.workspace_id' }],
    // Each step in its own request (see work-run-execute).
    checkpointing: false,
    // Stop a resuming run the moment a cancel for THIS run arrives — same as execute.
    cancelOn: [{ event: 'agent/run.cancel', match: 'data.agent_run_id' }],
    triggers: [{ event: 'work/run.resumed' }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id, response, request_id } = event.data as {
      agent_run_id: string
      workspace_id: string
      response: { answers?: AskUserAnswer[]; skipped?: boolean }
      /** The eve requestId this answer set was submitted against (respond route). */
      request_id?: string | null
    }
    const supabase = getServiceClient()

    // Load the run's routing facts (triggered_by is the token subject the resume
    // runs under) + a terminal-guard read. A terminal/canceling run means the user
    // answered a run that finished (or was canceled) in the meantime — no-op.
    const { data: run } = await supabase
      .from('agent_run')
      .select('status, kind, triggered_by')
      .eq('id', agent_run_id)
      .eq('workspace_id', workspace_id)
      .maybeSingle()
    if (!run) return { ok: false, reason: 'run not found' }
    if (run.kind !== 'workspace') return { ok: false, reason: 'not a workspace run' }
    // The respond route CAS'd needs_input→queued; a run that isn't queued here was
    // canceled/settled/already-resumed in the gap — nothing to drive. (On a retry
    // the row is `running` from our own memoized resume step; the step's replay
    // hands back the session to keep watching, so only a NEVER-resumed row is
    // refused here.)
    const userId = (run.triggered_by as string | null) ?? ''
    if (run.status !== 'queued' && run.status !== 'running') {
      return { ok: run.status !== 'failed', reason: 'run not queued for resume', status: run.status }
    }

    const opened = await step.run('resume-eve-session', () =>
      resumeWorkEveSession({
        agentRunId: agent_run_id,
        workspaceId: workspace_id,
        userId,
        response: response ?? {},
        expectedRequestId: request_id ?? null,
        supabase,
      }),
    )
    if (opened.kind !== 'resumed') {
      return { ok: opened.settled !== 'failed', settled: opened.settled, sessionId: opened.sessionId }
    }

    return watchAcrossSteps(step, {
      agentRunId: agent_run_id,
      workspaceId: workspace_id,
      userId,
      sessionId: opened.sessionId,
      fromIndex: opened.fromIndex,
      supabase,
    })
  },
)

/**
 * Release a run parked on the teammates it handed work to (delegate_work,
 * Part 3). Every delegated child's settle emits `work/run.child_settled`
 * `{ agent_run_id: <the parent>, child_run_id, workspace_id }`. Once every child
 * of the park is terminal, releaseDelegationPark un-parks the parent and answers
 * its `delegate_work` approvals; each tool then fetches its own child's result
 * as its tool result, and the resumed turn is watched exactly like a dispatch.
 *
 * One release at a time per parent: two children settling together deliver two
 * events, and the second finds the parent already running (a no-op). Stop on the
 * parent cancels a release in flight (`cancelOn` matches the parent's id).
 */
export const workRunChildSettled = inngest.createFunction(
  {
    id: 'work-run-child-settled',
    retries: 1,
    concurrency: [{ limit: 1, key: 'event.data.agent_run_id' }],
    checkpointing: false,
    cancelOn: [{ event: 'agent/run.cancel', match: 'data.agent_run_id' }],
    triggers: [{ event: CHILD_SETTLED_EVENT }],
  },
  async ({ event, step }) => {
    const { agent_run_id, workspace_id } = event.data as {
      agent_run_id: string
      child_run_id: string
      workspace_id: string
    }
    const supabase = getServiceClient()
    const { data: run } = await supabase
      .from('agent_run')
      .select('kind, triggered_by')
      .eq('id', agent_run_id)
      .eq('workspace_id', workspace_id)
      .maybeSingle()
    if (!run || run.kind !== 'workspace') return { ok: false, reason: 'parent not found' }
    const userId = (run.triggered_by as string | null) ?? ''

    const released = await step.run('release-parent', () =>
      releaseDelegationPark({ agentRunId: agent_run_id, workspaceId: workspace_id, supabase }),
    )
    if (released.kind !== 'resumed') {
      return { ok: released.settled !== 'failed', released: released.kind, settled: released.settled }
    }
    return watchAcrossSteps(step, {
      agentRunId: agent_run_id,
      workspaceId: workspace_id,
      userId,
      sessionId: released.sessionId,
      fromIndex: released.fromIndex,
      supabase,
    })
  },
)
