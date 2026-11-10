/**
 * The eve-runtime dispatcher for an approved WORK run (Loops v3 work proposals —
 * docs/loop-engine/WORK-PROPOSALS-DESIGN.md, extended for interactive runs by
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * A work run is an `agent_run` row (kind='workspace') executed as a durable eve
 * session on the `work-agent` mount. Unlike the coding path (a fire-and-forget
 * one-shot, task-session.ts), an interactive work run can PARK on a question
 * mid-run and, after `finish_work` settles it, keep its session parked (until
 * the agent's session timeout) as the follow-up-chat handle. This module owns:
 *
 *   - CREATE: an interactive session (conversation-session.ts) with the FIRST
 *     MESSAGE = the JSON brief. Every eve session parks after its turn (eve
 *     0.67+ has no run modes); this caller keeps the parked session, which is
 *     what lets the run ask a question and (later) chat. (The one-shot callers,
 *     skill/coding/onboarding, treat a park as the end — see task-session.ts.)
 *   - The TURN-BOUNDARY CLASSIFIER (runTurnLoop): drains one turn's stream, then
 *     dispositions it into one of five cases (see classifyAndSettle):
 *       1. request_user_input park → persist pending_input + session_state, CAS
 *          running→needs_input, mirror action needs_input, file notification.
 *       2. turn done AND run already terminal (finish_work settled it) → persist
 *          session_state (the follow-up handle) and stop; session stays parked.
 *       3. turn done, run NOT terminal, no pending input (bare park) →
 *          settleFailed('agent ended without reporting an outcome') — but STILL
 *          persist session_state so a failed run is interrogable.
 *       4. stream error / silent death → settleFailed.
 *       5. `canceling` observed → settleCanceled. The session itself is cancelled
 *          server-side by agentRunCancel (cancelEveWorkSession), so the turn stops
 *          rather than running on to its own finish.
 *   - The RESUME DRIVER (resumeWorkRun): a fresh-process answer to a parked run.
 *     Mints a fresh token, re-attaches the session and answers the approval
 *     (approveOptionId, or denyOptionId + a "skipped" note), clears pending_input,
 *     CAS queued→running, and drives the SAME classifier.
 *
 * `session_state` (the resume + replay snapshot) is persisted at EVERY park.
 * The eve session id is stored in `agent_run.sandbox_id` as `eve:<sessionId>`
 * (the `eve:` prefix marks an eve-owned session for agentRunCancel).
 *
 * ── eve 0.31.0 (shipped in 0.47.7): no continuation tokens, exclusive turns ────
 * `client.session(...)` is gone; sessions are created with `client.sessions.create()`
 * and resumed with `client.sessions.attach(id, { streamIndex })`. The persisted
 * snapshot is now `{ sessionId, streamIndex }` — there is no send capability left to
 * store. `send(message, opts)` and `respond(inputResponses, opts)` are exclusive:
 * a respond carries no `message` (eve rejects the pair with a 400), so answer text now rides on the
 * InputResponse's `text` plus `clientContext` (see conversation-session.ts).
 * Rows still carrying a pre-upgrade `continuationToken` are NOT resumable and settle
 * failed with an explicit "predates the eve upgrade" reason.
 */
import { Client } from 'eve/client'
import type { ClientSession, HandleMessageStreamEvent, MessageResponse } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  createConversationSession,
  resumeConversationSession,
  readSessionSnapshot,
  parseConversationSnapshot,
  isLegacySessionState,
} from '@/lib/eve/conversation-session'
import {
  mintAgentRunToken,
  internalSecret,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
  AGENT_RUN_WORKSPACE_HEADER,
  AGENT_RUN_USER_HEADER,
} from './agent-run-token'
import { appendAgentRunLog, readAgentRunCanceling } from './log-tail'
import { logWorkRunUsage } from './work-run-usage'
import { noteOutsideRead, outsideToolsIn, toolReadOf, type ToolRead } from '@/lib/safety/outside-text'
import {
  EVE_SANDBOX_PREFIX,
  cancelSessionVia,
  stampEveSession,
  type EveSessionCancelResult,
} from './run-agent-eve'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'
import { markSteersApplied, settleSteersAtBoundary } from './steer-ledger'
import { findWork } from '@/lib/work/recorder'
import { WORK_ROLE_LABELS, isWorkRole } from '@/lib/work/roles'
import { eveDispatchOrigin, protectionBypassHeaders } from '@/lib/eve/dispatch-origin'
import { createTurnBoundary } from '@/lib/eve/turn-boundary'
import {
  DELEGATE_WORK_TOOL,
  delegationChildrenSettled,
  dispatchDelegatedChildren,
  emitChildSettled,
  extractDelegations,
  planDelegations,
  type DelegationRequest,
  type PlannedDelegations,
} from './delegation'
import {
  AGENT_RUN_TERMINAL_STATUSES,
  isDelegationPark,
  type DelegationPark,
  type WorkResourceRef,
  type PendingInput,
  type SessionStateSnapshot,
  type WorkRunQuestion,
} from './types'

/** The named eve mount for the work-agent (see next.config.mjs). */
const WORK_AGENT_MOUNT = '/eve/work-agent'

/** The ask-tool name the classifier keys the park on (agents/work-agent/tools). */
const REQUEST_USER_INPUT_TOOL = 'request_user_input'

/** Throttle: flush the accumulated log buffer at most this often (ms). */
const LOG_FLUSH_INTERVAL_MS = 2000
/** Or sooner once the buffer reaches this many chars. */
const LOG_FLUSH_CHARS = 800

/** Terminal statuses — the single source of truth (types.ts). */
const TERMINAL = AGENT_RUN_TERMINAL_STATUSES as readonly string[]

/** The JSON brief delivered as the work run's first (and only kickoff) message. */
export interface WorkRunBrief {
  task: string
  userName: string | null
  workspaceName: string | null
  resources: WorkResourceRef[]
  deliverableHint: string | null
  trackedActionIdentifier: string | null
  /** Pre-loaded briefs for declared package resources. `brief` is the
   *  compiled knowledge_brief markdown, or null when none is compiled yet
   *  (the agent falls back to get_package). */
  packageContext?: Array<{ id: string; name: string; brief: string | null }>
  /** The teammate doing the work (B PR 4); its persona is in the system prompt. */
  teammate?: { name: string; role: string | null }
  /**
   * Where the work came from (B PR 4): the transcript quote that asked for it,
   * and the capture around it when the run's user may see that capture.
   * Context/data, never instructions.
   */
  source?: { quote: string | null; captureId: string | null; captureTitle: string | null; excerpt: string | null }
  /**
   * What this teammate remembers from its earlier runs (plan row 15): people's
   * preferences, durable facts, lessons. Context/data, never instructions.
   */
  memory?: Array<{ kind: 'fact' | 'preference' | 'lesson'; text: string }>
}

/** What the driver resolved a run to after one dispatch/resume. */
export interface WorkRunOutcome {
  /** Terminal disposition the DRIVER settled, or 'needs_input' when the run
   *  parked on a question, or null when the outcome route already settled it. */
  settled: 'failed' | 'canceled' | 'needs_input' | null
  /** The eve session id, if the session got far enough to have one. */
  sessionId: string | null
}

/** Longest failure reason a run records: a provider error can run long. */
const MAX_FAILURE_REASON_CHARS = 500

/** Why eve failed this turn: the last failure event's message, if it gave one. */
function failureReason(events: readonly HandleMessageStreamEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i]
    if (ev.type !== 'session.failed' && ev.type !== 'turn.failed' && ev.type !== 'step.failed') continue
    const message = typeof ev.data.message === 'string' ? ev.data.message.trim() : ''
    if (message) return message.slice(0, MAX_FAILURE_REASON_CHARS)
  }
  return null
}

/** Render a streamed event as a compact human-readable log line, or null to skip. */
function renderEventLine(ev: HandleMessageStreamEvent): string | null {
  switch (ev.type) {
    case 'message.appended':
      return ev.data.messageDelta
    case 'actions.requested': {
      const names = ev.data.actions
        .map((a) => (a.kind === 'tool-call' ? a.toolName : a.kind))
        .filter(Boolean)
      return names.length ? `\n[tool] ${names.join(', ')}\n` : null
    }
    case 'action.result':
      return ev.data.status === 'failed' ? `\n[tool failed]\n` : null
    case 'input.requested': {
      // A request_user_input pause → the ❓ line (the design's park marker).
      const asked = ev.data.requests.some(
        (r) => r.action?.toolName === REQUEST_USER_INPUT_TOOL,
      )
      if (asked) return `\n❓ [asked the user a question — waiting for input]\n`
      // A delegate_work pause → the 🤝 line, one per handoff.
      const handoffs = ev.data.requests
        .filter((r) => r.action?.toolName === DELEGATE_WORK_TOOL)
        .map((r) => {
          const role = (r.action?.input as { role?: unknown } | undefined)?.role
          return typeof role === 'string' && isWorkRole(role) ? WORK_ROLE_LABELS[role] : 'a teammate'
        })
      return handoffs.length > 0 ? `\n🤝 [handing work to ${handoffs.join(', ')}]\n` : null
    }
    case 'step.failed':
      return `\n[step failed] ${ev.data.message}\n`
    case 'session.failed':
      return `\n[session failed] ${ev.data.message}\n`
    case 'turn.cancelled':
      // Protocol 19: the turn was cancelled (not a failure — eve follows this
      // with session.waiting and accepts the next message). Render a marker so
      // the transcript isn't silent about it. extractPendingInput reacts only to
      // input.requested events, so a cancellation never confuses the resume.
      return `\n[turn cancelled]\n`
    default:
      return null
  }
}

/**
 * The disposition a drained turn's stream reduced to. The classifier turns this
 * into one of the five settle cases. `pendingInput` present ⇒ case 1 (a park on
 * request_user_input). `streamError` ⇒ case 4. `canceled` (from the cancel-signal
 * poll) ⇒ case 5. Otherwise the post-drain status read decides cases 2/3.
 */
interface DrainDisposition {
  /** The request_user_input pause captured from an input.requested event, if any. */
  pendingInput: PendingInput | null
  /** The delegate_work pauses in the turn (Part 3), if any. */
  delegations?: DelegationRequest[]
  /** What driveTurns decided for them: the park to take (set only when at
   *  least one child was created). */
  delegationPlan?: PlannedDelegations | null
  /** True when the cancel-signal poll observed a `canceling` row and aborted. */
  canceled: boolean
  /** A stream-level error message (case 4), if the drain threw un-aborted. */
  streamError: string | null
  /** Why eve failed the turn or session (its last failure event's message), if
   *  it did. A bare park (case 3) reports it: the work-agent's refusal to run
   *  without its spec ends there, with no outcome reported. */
  failure?: string | null
  /** Events read by this drain — the next watch resumes at fromIndex + consumed. */
  consumed: number
  /**
   * The drain read the current turn's boundary event (session.waiting with no
   * pending authorization, session.completed, session.failed). A watch whose
   * budget expires AFTER this is true still has the whole turn in hand and
   * must classify it, never return `pending` past the boundary.
   */
  reachedBoundary: boolean
  /**
   * The text of each `message.received` the drain read: the kickoff brief, and
   * any steer folded into the turn (steer-ledger.ts marks those applied).
   */
  receivedMessages?: string[]
}

/**
 * Build the eve Client for a work run with a FRESHLY MINTED token. The original
 * dispatch's token has a 60-min TTL that is irrelevant to a resume; every
 * dispatch/resume mints its own from the run row's routing facts (Trap #5).
 */
function makeWorkAgentClient(args: {
  secret: string
  runToken: string
  workspaceId: string
  userId: string
}): Client {
  // eveDispatchOrigin: THIS deployment on Vercel (never the production domain
  // from a preview), through Deployment Protection when a bypass secret is set.
  return new Client({
    host: `${eveDispatchOrigin()}${WORK_AGENT_MOUNT}`,
    auth: { bearer: args.secret },
    headers: {
      ...protectionBypassHeaders(),
      [AGENT_RUN_SECRET_HEADER]: args.secret,
      [AGENT_RUN_TOKEN_HEADER]: args.runToken,
      [AGENT_RUN_WORKSPACE_HEADER]: args.workspaceId,
      [AGENT_RUN_USER_HEADER]: args.userId,
    },
    redirect: 'error',
  })
}

/**
 * Extract a request_user_input pause from a drained turn's events, or null. eve
 * gates request_user_input with `approval: always()`, so its pause arrives as an
 * `input.requested` whose `action.toolName` is `request_user_input`. The request's
 * own two options ([{id:'approve'},{id:'cancel'}]) carry the ids the resume must
 * echo back to resolve the approval; the `action.input.questions` is the picker
 * payload. Reading the ids off the request (never a hardcoded literal) means a
 * schema tweak can't desync the resume (the chat transport's dead-Submit bug
 * class — Trap #2).
 */
function extractPendingInput(events: HandleMessageStreamEvent[]): PendingInput | null {
  for (const ev of events) {
    if (ev.type !== 'input.requested') continue
    for (const req of ev.data.requests) {
      if (req.action?.toolName !== REQUEST_USER_INPUT_TOOL) continue
      const opts = req.options
      const approveOptionId =
        opts?.find((o) => o?.id === 'approve')?.id ?? opts?.[0]?.id ?? 'approve'
      // eve 0.32.0 renamed the negative approval verb 'deny' → 'cancel'; 0.47.7
      // emits [{id:'approve'},{id:'cancel'}]. Accept either id (and fall back to
      // 'cancel') so the resume echoes a verb resolveApprovalOutcome recognizes.
      const denyOptionId =
        opts?.find((o) => o?.id === 'cancel' || o?.id === 'deny')?.id ?? opts?.[1]?.id ?? 'cancel'
      const questions = normalizeQuestions(req.action?.input)
      return {
        requestId: req.requestId,
        approveOptionId,
        denyOptionId,
        questions,
        askedAt: new Date().toISOString(),
      }
    }
  }
  return null
}

/** Coerce the ask-tool's input into the QuestionPicker-shaped questions array. */
function normalizeQuestions(input: unknown): WorkRunQuestion[] {
  const raw =
    input && typeof input === 'object' && 'questions' in input
      ? (input as { questions?: unknown }).questions
      : undefined
  if (!Array.isArray(raw)) return []
  const out: WorkRunQuestion[] = []
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue
    const rec = q as Record<string, unknown>
    const question = typeof rec.question === 'string' ? rec.question : ''
    if (!question) continue
    const header = typeof rec.header === 'string' ? rec.header : ''
    const multiSelect = rec.multiSelect === true
    const options: Array<{ label: string; description?: string }> = []
    if (Array.isArray(rec.options)) {
      for (const o of rec.options) {
        if (!o || typeof o !== 'object') continue
        const orec = o as Record<string, unknown>
        const label = typeof orec.label === 'string' ? orec.label : ''
        if (!label) continue
        const option: { label: string; description?: string } = { label }
        if (typeof orec.description === 'string' && orec.description) {
          option.description = orec.description
        }
        options.push(option)
      }
    }
    out.push({ question, header, options, multiSelect })
  }
  return out
}

/**
 * Persist a run's advanced session snapshot (the resume + replay handle). Written
 * at EVERY park. Best-effort — a lost write only costs the follow-up-chat handle
 * (or a resume must re-derive it via replay), never a stuck run.
 *
 * `settleStreamIndex` (the FROZEN follow-up-transcript boundary GET replay reads
 * from) is handled here, not by callers:
 *   - `stampSettleBoundary: true` (the terminal parks — classifier cases 2/3/4)
 *     stamps `settleStreamIndex = snapshot.streamIndex` exactly ONCE. If the row
 *     already carries one (a prior settle persist), it is PRESERVED, never moved.
 *   - Otherwise (question parks) any existing `settleStreamIndex` is PRESERVED so a
 *     non-terminal re-persist can never erase the frozen boundary.
 * The advancing `streamIndex` in the snapshot is always written through.
 */
async function persistSessionState(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    snapshot: SessionStateSnapshot | null
    stampSettleBoundary?: boolean
  },
): Promise<void> {
  if (!args.snapshot) return
  try {
    // Read the row's current session_state so we PRESERVE a settleStreamIndex that
    // was already stamped (the boundary is frozen forever once the run settles).
    const { data: existing } = await supabase
      .from('agent_run')
      .select('session_state')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    const prior = (existing?.session_state as SessionStateSnapshot | null) ?? null
    const priorSettle =
      typeof prior?.settleStreamIndex === 'number' ? prior.settleStreamIndex : undefined

    const next: SessionStateSnapshot = {
      sessionId: args.snapshot.sessionId,
      streamIndex: args.snapshot.streamIndex,
    }
    // A frozen boundary, once stamped, is preserved on every persist. It is stamped
    // exactly once — at the first terminal park that carries a snapshot.
    if (priorSettle !== undefined) {
      next.settleStreamIndex = priorSettle
    } else if (args.stampSettleBoundary) {
      next.settleStreamIndex = args.snapshot.streamIndex
    }

    await supabase
      .from('agent_run')
      .update({ session_state: next })
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
  } catch {
    /* observability projection — never throw out of the driver */
  }
}

/**
 * Merge an advancing snapshot with the run's already-persisted `settleStreamIndex`
 * (the FROZEN follow-up-transcript boundary). Callers that write `session_state`
 * inline (parkNeedsInput, settleFailed) use this so the frozen boundary survives:
 *   - a boundary already stamped on `priorState` is PRESERVED, never re-derived;
 *   - `stampSettleBoundary` stamps it (from the advancing streamIndex) at a terminal
 *     park when none exists yet.
 * Returns null when there is no snapshot to write.
 */
function mergeSessionState(
  snapshot: SessionStateSnapshot | null,
  priorState: SessionStateSnapshot | null,
  stampSettleBoundary: boolean,
): SessionStateSnapshot | null {
  if (!snapshot) return null
  const priorSettle =
    typeof priorState?.settleStreamIndex === 'number' ? priorState.settleStreamIndex : undefined
  const next: SessionStateSnapshot = {
    sessionId: snapshot.sessionId,
    streamIndex: snapshot.streamIndex,
  }
  if (priorSettle !== undefined) next.settleStreamIndex = priorSettle
  else if (stampSettleBoundary) next.settleStreamIndex = snapshot.streamIndex
  return next
}

/**
 * Mirror the tracked action's `agent_run_status` — best-effort (a lost mirror is
 * a board-chip gap, not a stuck run). A no-op when there's no tracked action.
 */
async function mirrorActionStatus(
  supabase: SupabaseClient,
  actionId: string | null,
  status: string,
): Promise<void> {
  if (!actionId) return
  try {
    await supabase.from('actions').update({ agent_run_status: status }).eq('id', actionId)
  } catch {
    /* board-chip projection — never throw out of the driver */
  }
}

/**
 * Park the run on a question (case 1). CAS-guarded on the observed status so a
 * terminal write in the gap since our drain (finish_work / cancel) is never
 * clobbered: only a row STILL in `running` (or `queued`, the resume window) is
 * moved to `needs_input`. Persists pending_input + session_state, mirrors the
 * tracked action to `needs_input`, and parks the ledger row — which sends the
 * `work_needs_you` notification (the recorder is the only notifier for work).
 * Returns true when the park took (the row was ours to park).
 */
async function parkNeedsInput(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    pendingInput: PendingInput
    snapshot: SessionStateSnapshot | null
  },
): Promise<boolean> {
  const { agentRunId, workspaceId, pendingInput, snapshot } = args

  const { data: row } = await supabase
    .from('agent_run')
    .select('status, action_id, attention_item_id, triggered_by, session_state')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!row) return false
  const observed = row.status as string
  // A terminal or canceling row is not parked — the settle/cancel owns it.
  if (TERMINAL.includes(observed) || observed === 'canceling') return false

  const patch: Record<string, unknown> = {
    status: 'needs_input',
    pending_input: pendingInput,
  }
  // A question park is NON-terminal: preserve any frozen settleStreamIndex (there
  // is normally none yet pre-settle), never stamp a new one.
  const merged = mergeSessionState(
    snapshot,
    (row.session_state as SessionStateSnapshot | null) ?? null,
    false,
  )
  if (merged) patch.session_state = merged

  const { data: updated } = await supabase
    .from('agent_run')
    .update(patch)
    .eq('id', agentRunId)
    .eq('status', observed) // CAS on the exact status we drained under
    .select('id')
  if (!updated || updated.length === 0) return false

  // Mirror the tracked action → needs_input (board chip "waiting on you").
  const actionId = row.action_id as string | null
  await mirrorActionStatus(supabase, actionId, 'needs_input')
  // The ledger row parks with the questions (Activity's "Needs you") and sends
  // the work_needs_you push — the one notification for a parked run.
  await mirrorAgentRunStatus(supabase, { agentRunId, workspaceId }, {
    status: 'needs_input',
    questions: pendingInput.questions,
  })

  return true
}

/**
 * Park the run on the teammates it handed work to (delegate_work, Part 3). The
 * same CAS as a question park — only a row still in the status we drained under
 * parks — with `pending_input` = the DelegationPark. The tracked action keeps
 * its chip (the work is still going; nobody is being asked anything), and the
 * ledger row goes `waiting_on_child`, which notifies no one. Returns true when
 * the park took; the caller dispatches the children only then.
 */
async function parkOnDelegations(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    park: DelegationPark
    snapshot: SessionStateSnapshot | null
  },
): Promise<boolean> {
  const { agentRunId, workspaceId, park, snapshot } = args

  const { data: row } = await supabase
    .from('agent_run')
    .select('status, session_state')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!row) return false
  const observed = row.status as string
  if (TERMINAL.includes(observed) || observed === 'canceling') return false

  const patch: Record<string, unknown> = { status: 'needs_input', pending_input: park }
  const merged = mergeSessionState(snapshot, (row.session_state as SessionStateSnapshot | null) ?? null, false)
  if (merged) patch.session_state = merged

  const { data: updated } = await supabase
    .from('agent_run')
    .update(patch)
    .eq('id', agentRunId)
    .eq('status', observed)
    .select('id')
  if (!updated || updated.length === 0) return false

  const live = park.children.filter((c) => c.childRunId)
  const first = live[0]
  const firstWork = first?.childRunId ? await findWork(supabase, { agentRunId: first.childRunId }) : null
  await mirrorAgentRunStatus(supabase, { agentRunId, workspaceId }, {
    status: 'waiting_on_child',
    childWorkItemId: firstWork?.id ?? null,
    role: first?.role ?? '',
    label: first && isWorkRole(first.role) ? WORK_ROLE_LABELS[first.role] : 'a teammate',
    count: live.length,
  })
  return true
}

/** Children created for a park that did not take: nobody will run them. */
async function abandonUndispatchedChildren(
  supabase: SupabaseClient,
  args: { workspaceId: string; childRunIds: string[] },
): Promise<void> {
  if (args.childRunIds.length === 0) return
  const { data } = await supabase
    .from('agent_run')
    .update({ status: 'canceled', error_message: 'The run that handed this over stopped first', finished_at: new Date().toISOString() })
    .in('id', args.childRunIds)
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'queued')
    .select('id')
  for (const r of (data ?? []) as Array<{ id: string }>) {
    await mirrorAgentRunStatus(supabase, { agentRunId: r.id, workspaceId: args.workspaceId }, {
      status: 'canceled',
      reason: 'The run that handed this over stopped first',
    })
  }
}

/**
 * Settle a non-terminal run as failed (case 3/4: agent died / bare-park). Mirrors
 * the coding watcher: agent_run failed + finished_at, tracked action → 'failed'.
 * ALSO persists session_state so a failed run's session stays interrogable via
 * follow-up chat ("what happened?"). CAS-guarded on the observed status so a
 * concurrent terminal write is never clobbered.
 */
async function settleFailed(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    error: string
    snapshot: SessionStateSnapshot | null
  },
): Promise<boolean> {
  const { data: row } = await supabase
    .from('agent_run')
    .select('status, action_id, session_state')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (!row) return false
  if (TERMINAL.includes(row.status as string)) return false

  const patch: Record<string, unknown> = {
    status: 'failed',
    error_message: args.error,
    finished_at: new Date().toISOString(),
  }
  // A failed run's session is still interrogable — persist the snapshot so the
  // run-detail follow-up chat can ask what happened. A failed run is TERMINAL, so
  // this is where the frozen follow-up-transcript boundary (settleStreamIndex) gets
  // stamped (once). pending_input is cleared: a failed run has no open question.
  const merged = mergeSessionState(
    args.snapshot,
    (row.session_state as SessionStateSnapshot | null) ?? null,
    true,
  )
  if (merged) patch.session_state = merged
  patch.pending_input = null

  const { data: updated } = await supabase
    .from('agent_run')
    .update(patch)
    .eq('id', args.agentRunId)
    .eq('status', row.status as string)
    .select('id')
  if (!updated || updated.length === 0) return false
  if (row.action_id) {
    await supabase
      .from('actions')
      .update({ agent_run_status: 'failed' })
      .eq('id', row.action_id as string)
  }
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: args.agentRunId, workspaceId: args.workspaceId },
    { status: 'failed', error: args.error },
  )
  // A delegated child tells its parent (a no-op for a run with no parent).
  await emitChildSettled(supabase, { childRunId: args.agentRunId, workspaceId: args.workspaceId })
  return true
}

/**
 * Settle a canceling run as canceled (case 5). The cancel route already flipped
 * the row to 'canceling'; this writes the terminal 'canceled', clears
 * pending_input, and resets the tracked action to 'idle'. Idempotent + CAS-guarded.
 */
async function settleCanceled(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<boolean> {
  const { data: row } = await supabase
    .from('agent_run')
    .select('status, action_id')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (!row) return false
  if (TERMINAL.includes(row.status as string)) return false

  const { data: updated } = await supabase
    .from('agent_run')
    .update({
      status: 'canceled',
      error_message: 'Canceled by user',
      finished_at: new Date().toISOString(),
      pending_input: null,
    })
    .eq('id', args.agentRunId)
    .eq('status', row.status as string)
    .select('id')
  if (!updated || updated.length === 0) return false
  if (row.action_id) {
    await supabase
      .from('actions')
      .update({ agent_run_status: 'idle' })
      .eq('id', row.action_id as string)
  }
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: args.agentRunId, workspaceId: args.workspaceId },
    { status: 'canceled' },
  )
  await emitChildSettled(supabase, { childRunId: args.agentRunId, workspaceId: args.workspaceId })
  return true
}

/**
 * Drain ONE turn's stream into the log tail + a disposition, watching the cancel
 * signal between flushes. Shared by the initial dispatch and every resume. The
 * `response` is the turn's event stream; `session` is read for the advanced
 * snapshot AFTER this returns (its streamIndex is only advanced once the stream
 * drains to the turn boundary). Returns the disposition; the caller reads
 * session.state and classifies.
 */
async function drainTurn(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    /** A MessageResponse (breaks at the turn boundary by itself) or an ATTACHED
     *  `session.stream()` (does not — pass `stopAtBoundary`). */
    events: AsyncIterable<HandleMessageStreamEvent>
    controller: AbortController
    markedSandboxId: string | undefined
    /**
     * Stop at the current turn's boundary. Required for an attached durable
     * stream, which stays open across a park (`session.waiting`) and would
     * otherwise hang the drain. Mirrors eve's own MessageResponse rule: a
     * session.completed / session.failed, or a session.waiting with no pending
     * webhook authorization, ends the turn.
     */
    stopAtBoundary?: boolean
  },
): Promise<DrainDisposition> {
  const { agentRunId, workspaceId, events: source, controller, markedSandboxId, stopAtBoundary } = args

  let buffer = ''
  let lastFlush = 0
  let stampedSandbox = false
  let canceled = false
  let consumed = 0
  let reachedBoundary = false
  let streamError: string | null = null
  const events: HandleMessageStreamEvent[] = []
  const receivedMessages: string[] = []
  const endsTurn = createTurnBoundary()

  const flushNow = async (force: boolean): Promise<void> => {
    const now = Date.now()
    const due = force || buffer.length >= LOG_FLUSH_CHARS || now - lastFlush >= LOG_FLUSH_INTERVAL_MS
    if (!due) return
    if (buffer.length === 0) {
      const canceling = await readAgentRunCanceling(supabase, { agentRunId, workspaceId })
      if (canceling) {
        canceled = true
        controller.abort()
      }
      lastFlush = now
      return
    }
    const chunk = buffer
    buffer = ''
    lastFlush = now
    const { canceling } = await appendAgentRunLog(supabase, {
      agentRunId,
      workspaceId,
      text: chunk,
      ...(!stampedSandbox && markedSandboxId ? { sandboxId: markedSandboxId } : {}),
    })
    if (!stampedSandbox && markedSandboxId) stampedSandbox = true
    if (canceling) {
      canceled = true
      controller.abort()
    }
  }
  // Flushes run one at a time, in order: the loop's and the timer's share this
  // chain, so two appends never interleave and the tail keeps its order.
  let flushChain: Promise<void> = Promise.resolve()
  const flush = (force: boolean): Promise<void> => {
    const next = flushChain.then(() => flushNow(force))
    flushChain = next.catch(() => {})
    return next
  }
  // The timer flush (Part 0, observation 1): the loop flushes only when the NEXT
  // event arrives, so during a long tool call the `[tool] …` line — and with it
  // the ledger's current_step ("Running now") — sat in the buffer until the tool
  // returned. Ticking on the flush interval writes it within one interval, and
  // the empty-buffer branch's canceling read keeps Stop responsive in the same
  // silence. At most one write or read per interval, like a busy stream.
  const timer = setInterval(() => {
    if (!canceled) void flush(false).catch(() => {})
  }, LOG_FLUSH_INTERVAL_MS)

  try {
    for await (const ev of source) {
      consumed += 1
      events.push(ev)
      if (ev.type === 'message.received') {
        const text = (ev.data as { message?: unknown } | undefined)?.message
        if (typeof text === 'string') receivedMessages.push(text)
      }
      const line = renderEventLine(ev)
      if (line) buffer += line
      await flush(false)
      if (canceled) break
      if (endsTurn(ev)) {
        reachedBoundary = true
        if (stopAtBoundary) break
      }
    }
    clearInterval(timer)
    if (!canceled) await flush(true)
  } catch (err) {
    const aborted = controller.signal.aborted
    if (!aborted) {
      streamError = err instanceof Error ? err.message : String(err)
      await appendAgentRunLog(supabase, {
        agentRunId,
        workspaceId,
        text: `\n[stream error] ${streamError}\n`,
        ...(!stampedSandbox && markedSandboxId ? { sandboxId: markedSandboxId } : {}),
      }).catch(() => {})
    }
  } finally {
    clearInterval(timer)
    // A timer flush may still be in flight; let it land before the caller
    // reads the run and classifies.
    await flushChain
  }

  // What this read of the stream spent, one usage row per model step (keyed
  // per step, so a re-read never bills twice). Canceled or not: the tokens
  // were spent. Never throws.
  await logWorkRunUsage(supabase, { agentRunId, workspaceId, events, source: 'dispatch' })
  // What every call of this read brought in (F3 review R1), judged by the one
  // outside-text definition from each action.result: eve's own web tools, a
  // delegated teammate's findings (delegate_work, a subagent), any tool not
  // known to be workspace text. A memory entry the run teaches is then
  // labelled with them. Mail reads are sender-checked by the tool route, which
  // ran them. Never throws.
  for (const toolName of outsideToolsIn(events.map(toolReadOf).filter((r): r is ToolRead => r !== null))) {
    await noteOutsideRead(supabase, { agentRunId, workspaceId, toolName })
  }

  return {
    pendingInput: canceled ? null : extractPendingInput(events),
    delegations: canceled ? [] : extractDelegations(events),
    canceled,
    streamError,
    failure: canceled ? null : failureReason(events),
    consumed,
    reachedBoundary,
    receivedMessages,
  }
}

/**
 * Classify a drained turn into one of the five settle cases and act on it. Shared
 * by the initial dispatch and every resume. Returns the WorkRunOutcome the caller
 * reports back to Inngest.
 *
 *   5. canceled (cancel-signal poll aborted the stream) → settleCanceled.
 *   4. streamError (un-aborted throw) → settleFailed (still persist snapshot).
 *   1. pendingInput (request_user_input park) → parkNeedsInput (persist +
 *      pending_input + notification), status → needs_input.
 *   2. turn done AND run already terminal (finish_work settled it) → persist
 *      snapshot only; session stays parked forever (the follow-up handle).
 *   3. turn done, run NOT terminal, no pending input (bare park) → settleFailed.
 */
async function classifyAndSettle(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    disposition: DrainDisposition
    snapshot: SessionStateSnapshot | null
    sessionId: string | null
  },
): Promise<WorkRunOutcome> {
  const { agentRunId, workspaceId, disposition, snapshot, sessionId } = args

  // Case 5 — cancel.
  if (disposition.canceled) {
    const settled = await settleCanceled(supabase, { agentRunId, workspaceId })
    return { settled: settled ? 'canceled' : null, sessionId }
  }

  // Case 4 — stream error / silent death. Persist the snapshot first so the failed
  // run's session (if it got one) is still interrogable, then settle failed.
  if (disposition.streamError) {
    const settled = await settleFailed(supabase, {
      agentRunId,
      workspaceId,
      error: `agent stream error: ${disposition.streamError}`,
      snapshot,
    })
    return { settled: settled ? 'failed' : null, sessionId }
  }

  // Case 1b — a delegate_work park (driveTurns created at least one child).
  // The children are dispatched only once the park took, so none can settle
  // before its parent is waiting on it.
  if (disposition.delegationPlan) {
    const plan = disposition.delegationPlan
    const parked = await parkOnDelegations(supabase, { agentRunId, workspaceId, park: plan.park, snapshot })
    if (parked) {
      await dispatchDelegatedChildren(supabase, { workspaceId, childRunIds: plan.childRunIds })
      return { settled: 'needs_input', sessionId }
    }
    // The park lost to a concurrent settle/cancel: its children never run.
    await abandonUndispatchedChildren(supabase, { workspaceId, childRunIds: plan.childRunIds })
  }

  // Case 1 — a request_user_input park.
  if (disposition.pendingInput) {
    const parked = await parkNeedsInput(supabase, {
      agentRunId,
      workspaceId,
      pendingInput: disposition.pendingInput,
      snapshot,
    })
    if (parked) return { settled: 'needs_input', sessionId }
    // The park CAS lost to a concurrent settle/cancel (rare) — fall through to the
    // status read below, which reports the winner's disposition.
  }

  // Re-read the row's status: a canceling row settles canceled; a terminal row was
  // settled by finish_work (case 2) — persist the follow-up snapshot and stop.
  const { data: finalRow } = await supabase
    .from('agent_run')
    .select('status')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const finalStatus = (finalRow?.status as string | null) ?? null

  if (finalStatus === 'canceling') {
    const settled = await settleCanceled(supabase, { agentRunId, workspaceId })
    return { settled: settled ? 'canceled' : null, sessionId }
  }

  // Case 2 — finish_work already settled it (or a prior settle owns it). Persist
  // the session_state (the follow-up-chat handle + transcript boundary) and stop.
  // The run is TERMINAL now, so stamp the FROZEN settleStreamIndex here (once) — GET
  // replay reads from it. The session stays parked at session.waiting forever.
  if (finalStatus && TERMINAL.includes(finalStatus)) {
    await persistSessionState(supabase, {
      agentRunId,
      workspaceId,
      snapshot,
      stampSettleBoundary: true,
    })
    return { settled: null, sessionId }
  }

  // Case 3 — bare park: the turn ended, the run is still non-terminal, and there
  // is no open question. The agent stopped without reporting an outcome. Settle
  // failed, but STILL persist the snapshot so the run is interrogable.
  const settled = await settleFailed(supabase, {
    agentRunId,
    workspaceId,
    error: disposition.failure
      ? `agent session failed: ${disposition.failure}`
      : 'agent ended without reporting an outcome',
    snapshot,
  })
  return { settled: settled ? 'failed' : null, sessionId }
}

/** Refused handoffs answered in place per dispatch before the run is failed: a
 *  model that keeps handing off work the policy refuses is not making progress. */
const MAX_REFUSED_HANDOFF_ROUNDS = 2

/** Guidance replayed into the session when the agent asks an EMPTY question. */
const EMPTY_ASK_GUIDANCE =
  'Your question was empty or unreadable — it had no question text (or no answerable ' +
  'options). Re-ask with request_user_input using at least one complete question with ' +
  'real options, or proceed with your best judgment and note the assumption in your summary.'

/**
 * Guidance replayed into the session when a run that may not ask (a helper the
 * server started on its own, `agent_run.server_helper`, migration 337: a
 * meeting prep) calls request_user_input anyway: nobody is there to answer,
 * so it never parks on a question; it finishes with what it has.
 */
const NO_ASK_GUIDANCE =
  'Nobody can answer questions on this run: Native Intelligence started it on its own, ahead of time. ' +
  'Do not ask again. Finish with what you have, and note any assumption you made in your summary.'

/**
 * Whether this run may not park on a question (a server-started helper,
 * migration 337). Fails open to false: a failed read (or a database without
 * the column) keeps the ordinary park.
 */
async function runMayNotAsk(supabase: SupabaseClient, agentRunId: string, workspaceId: string): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .select('server_helper')
      .eq('id', agentRunId)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    if (error || !data) return false
    const kind = (data as { server_helper?: unknown }).server_helper
    return typeof kind === 'string' && kind.length > 0
  } catch {
    return false
  }
}

/**
 * A drained turn's disposition + the advanced snapshot to classify. The output of
 * {@link driveTurns} after any empty-ask self-heal has run.
 */
interface DrivenTurn {
  disposition: DrainDisposition
  snapshot: SessionStateSnapshot | null
}

/**
 * Drive one turn's stream to its disposition, self-healing a DEGENERATE empty ask.
 *
 * A `request_user_input` call whose questions all normalize away (blank question
 * text / no options) would otherwise park the run at `needs_input` with an EMPTY
 * `questions` array — a dead picker the user can neither answer nor skip (only
 * cancel). The schema now rejects blank text up front, but this is the runtime
 * belt-and-suspenders: when the drained turn parks on an empty ask, we DENY the
 * approval in-place (deny optionId + guidance message), re-drive the SAME session,
 * and continue. Allowed exactly ONCE per dispatch — a second empty ask → a
 * disposition carrying a streamError so the caller settles the run failed cleanly,
 * rather than looping or parking a dead question.
 *
 * `session` is the live eve session handle; `initial` is the drained disposition of
 * the FIRST turn (already drained by the caller). Returns the disposition to
 * classify plus the snapshot read after the final turn drained.
 */
async function driveTurns(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    session: ClientSession
    initial: DrainDisposition
    controller: AbortController
    markedSandboxId: string | undefined
  },
): Promise<DrivenTurn> {
  const { agentRunId, workspaceId, session, controller, markedSandboxId } = args
  let disposition = args.initial
  let healed = false
  let refusedRounds = 0
  let mayNotAsk: boolean | null = null

  for (;;) {
    // A park with a request_user_input pending is only actionable when it carries at
    // least one renderable question. An empty questions array = a degenerate ask.
    const pending = disposition.pendingInput
    let isEmptyAsk = pending !== null && pending.questions.length === 0
    let guidance = EMPTY_ASK_GUIDANCE
    // A run that may not ask (a server-started helper) never parks on a question:
    // its ask is answered in place like an empty one, once; a second fails it.
    if (pending !== null && !isEmptyAsk && (disposition.delegations ?? []).length === 0) {
      mayNotAsk ??= await runMayNotAsk(supabase, agentRunId, workspaceId)
      if (mayNotAsk) {
        isEmptyAsk = true
        guidance = NO_ASK_GUIDANCE
      }
    }
    if (!isEmptyAsk) {
      // delegate_work pauses (Part 3). Plan them: a batch with at least one child
      // created parks on its children (classifyAndSettle); a batch alongside a
      // question parks on the question, whose resume also answers the refused
      // handoffs; a batch where every handoff was refused is answered here and
      // now — each tool's execute returns its refusal — and the turn goes on.
      const delegations = disposition.delegations ?? []
      if (delegations.length === 0 || disposition.canceled || disposition.streamError) break
      const plan = await planDelegations(supabase, {
        parentRunId: agentRunId,
        workspaceId,
        requests: delegations,
        alongsideQuestion: pending !== null,
      })
      const responses = plan.park.children.map((c) => ({ requestId: c.requestId, optionId: c.approveOptionId }))
      if (pending) {
        disposition = { ...disposition, pendingInput: { ...pending, companionResponses: responses }, delegations: [] }
        break
      }
      if (plan.childRunIds.length > 0) {
        disposition = { ...disposition, delegationPlan: plan }
        break
      }
      if (refusedRounds >= MAX_REFUSED_HANDOFF_ROUNDS) {
        return {
          disposition: {
            pendingInput: null,
            canceled: false,
            streamError: 'agent kept handing off work that was refused',
            consumed: disposition.consumed,
            reachedBoundary: false,
          },
          snapshot: readSessionSnapshot(session),
        }
      }
      refusedRounds += 1
      await appendAgentRunLog(supabase, {
        agentRunId,
        workspaceId,
        text: `\n🚫 [handoff refused — ${plan.park.children.map((c) => c.refused?.code ?? 'refused').join(', ')}]\n`,
      }).catch(() => {})
      let refusedResponse: MessageResponse
      try {
        refusedResponse = await session.respond(responses, { signal: controller.signal })
      } catch (err) {
        return {
          disposition: {
            pendingInput: null,
            canceled: false,
            streamError: `answering a refused handoff failed: ${err instanceof Error ? err.message : String(err)}`,
            consumed: disposition.consumed,
            reachedBoundary: false,
          },
          snapshot: readSessionSnapshot(session),
        }
      }
      disposition = await drainTurn(supabase, {
        agentRunId,
        workspaceId,
        events: refusedResponse,
        controller,
        markedSandboxId,
      })
      continue
    }

    // Only an ask reaches here (isEmptyAsk implies one is pending).
    if (pending === null) break
    if (healed) {
      // Second empty ask in one dispatch — stop self-healing and settle failed. A
      // streamError disposition routes the caller to settleFailed (case 4).
      return {
        disposition: {
          pendingInput: null,
          canceled: false,
          streamError:
            guidance === NO_ASK_GUIDANCE
              ? 'agent kept asking questions on a run nobody can answer'
              : 'agent repeatedly asked an empty question with no answerable content',
          consumed: disposition.consumed,
          // An error is not a turn boundary.
          reachedBoundary: false,
        },
        snapshot: readSessionSnapshot(session),
      }
    }
    healed = true

    // Deny the empty approval in-place and hand the model guidance, then re-drive
    // the same session. eve 0.31.0 made respond() and send() exclusive — a turn
    // carrying inputResponses uses respond(), which carries no `message` at all
    // (eve rejects the pair with a 400), so the guidance travels on the
    // response's own `text` (durable; echoed on input.resolved) plus clientContext
    // (one-turn model context for exactly this turn). Same information, one turn.
    await appendAgentRunLog(supabase, {
      agentRunId,
      workspaceId,
      text:
        guidance === NO_ASK_GUIDANCE
          ? `\n⚠️ [question on a run nobody can answer — asked the agent to finish with what it has]\n`
          : `\n⚠️ [empty question — asked the agent to re-ask or proceed]\n`,
    }).catch(() => {})

    let healResponse: MessageResponse
    try {
      healResponse = await session.respond(
        [
          {
            requestId: pending.requestId,
            optionId: pending.denyOptionId,
            text: guidance,
          },
        ],
        {
          clientContext: guidance,
          ...(controller.signal ? { signal: controller.signal } : {}),
        },
      )
    } catch (err) {
      // The self-heal send itself failed — settle failed with the reason.
      return {
        disposition: {
          pendingInput: null,
          canceled: false,
          streamError: `empty-ask self-heal send failed: ${err instanceof Error ? err.message : String(err)}`,
          consumed: disposition.consumed,
          // An error is not a turn boundary.
          reachedBoundary: false,
        },
        snapshot: readSessionSnapshot(session),
      }
    }

    disposition = await drainTurn(supabase, {
      agentRunId,
      workspaceId,
      events: healResponse,
      controller,
      markedSandboxId,
    })
  }

  return { disposition, snapshot: readSessionSnapshot(session) }
}

// ── One run = one eve session: step-split dispatch for Inngest ─────────────────
//
// /api/inngest has maxDuration = 300 and a work turn can run longer than one
// request. The dispatch therefore MUST NOT hold the whole turn inside one
// invocation: the session is created in its own memoized step
// (startWorkEveSession) and then watched in budgeted steps that re-attach from
// where the last one stopped (watchWorkEveSession) — the same shape the coding
// path uses (agent-run-functions.ts). Two things make a retry safe:
//   • the eve session id stamped on the row (`sandbox_id = 'eve:<id>'`) is the
//     idempotency key: a retry whose earlier attempt created the session but died
//     before the step result was recorded finds the stamp and re-attaches;
//   • an Inngest step's result is memoized, so a retry after the step completed
//     replays the same session id instead of running the create again.
// runWorkViaEve / resumeWorkRun below are the IN-PROCESS drivers (create/resume
// and drain in one process, used by tests and any synchronous caller). Never
// call them from an Inngest function — use the start/watch pair there.

/** JSON-safe result of {@link startWorkEveSession} (it is an Inngest step's output). */
export interface WorkSessionStart {
  sessionId: string
  /** Whether `eve:<sessionId>` is on the row (agentRunCancel's handle). */
  stamped: boolean
  /** True when an earlier attempt's session was found on the row and reused. */
  reused: boolean
  /** The absolute stream index the first watch reads from (0 for a new session;
   *  the persisted cursor for a reused one, so the log is not replayed). */
  fromIndex: number
}

/** Where a budget-expired watch stopped, for the next watch to resume from. */
export interface WorkWatchPending {
  /** Absolute stream index of the first event the next watch reads. */
  nextIndex: number
  /** A request_user_input park seen before the budget expired, carried so the
   *  next watch still classifies it when the turn boundary lands there. */
  pendingInput: PendingInput | null
  /** delegate_work pauses seen before the budget expired, carried the same way. */
  delegations?: DelegationRequest[]
}

/** {@link watchWorkEveSession}'s result: an outcome, or `pending` when the watch
 *  budget expired before the turn reached its boundary. */
export interface WorkWatchOutcome extends WorkRunOutcome {
  pending?: WorkWatchPending
}

/** {@link resumeWorkEveSession}'s result. */
export type WorkResumeStart =
  | { kind: 'resumed'; sessionId: string; fromIndex: number }
  | { kind: 'skipped'; sessionId: string | null; settled: 'failed' | null }

/** Statuses under which a session already on the row is the one to keep watching. */
const REUSABLE_STATUSES: ReadonlySet<string> = new Set(['queued', 'running', 'needs_input'])

function sessionIdFromSandbox(sandboxId: unknown): string | null {
  if (typeof sandboxId !== 'string' || !sandboxId.startsWith(EVE_SANDBOX_PREFIX)) return null
  const id = sandboxId.slice(EVE_SANDBOX_PREFIX.length)
  return id.length > 0 ? id : null
}

function buildWorkClient(args: {
  secret: string
  agentRunId: string
  workspaceId: string
  userId: string
  /** A resume of a parked run: the turn re-resolves its tools from this token (AgentRunTokenClaims.resume). */
  resume?: boolean
}): Client {
  const runToken = mintAgentRunToken({
    agentRunId: args.agentRunId,
    workspaceId: args.workspaceId,
    userId: args.userId,
    ...(args.resume ? { resume: true as const } : {}),
  })
  return makeWorkAgentClient({
    secret: args.secret,
    runToken,
    workspaceId: args.workspaceId,
    userId: args.userId,
  })
}

/**
 * Ask eve to cancel a WORK session (the work-agent mount) — the stale-run
 * reaper's teardown for a `kind = 'workspace'` row, the counterpart of
 * cancelEveCodingSession. Never throws: 'not_configured' without the internal
 * secret, 'error' on a transport failure — a reaper pass is never stopped by one
 * dead session. Stop-by-user does NOT come through here: agentRunCancel settles
 * the row and the watcher's cancel-signal poll aborts the drain (the session is
 * left to finish its turn on its own — see agentRunCancel).
 */
export async function cancelEveWorkSession(args: {
  sessionId: string
  agentRunId: string
  workspaceId: string
  userId: string
}): Promise<EveSessionCancelResult> {
  const secret = internalSecret()
  if (!secret) return 'not_configured'
  let client: Client
  try {
    client = buildWorkClient({
      secret,
      agentRunId: args.agentRunId,
      workspaceId: args.workspaceId,
      userId: args.userId,
    })
  } catch (err) {
    console.warn('[agent-run-cancel] eve work session cancel failed', {
      agentRunId: args.agentRunId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'error'
  }
  return cancelSessionVia(client, args.sessionId, args.agentRunId)
}

interface OpenedWorkSession extends WorkSessionStart {
  client: Client
  /** The live handle + first-turn response when THIS call created the session. */
  created: { session: ClientSession; response: MessageResponse } | null
}

/**
 * The create-once key for a work run's eve session: one session per run, ever.
 * A run is never legitimately re-dispatched with a fresh session (the dispatch
 * guard refuses terminal rows, and a resume attaches), so the run id alone is
 * the operation.
 */
export function workRunOperationId(agentRunId: string): string {
  return `work-run:${agentRunId}`
}

/**
 * Create the run's eve session exactly once. Reads the row first: a live row that
 * already carries `eve:<id>` belongs to an earlier attempt of this same dispatch
 * (a killed request, an Inngest retry), and that session — still running on eve —
 * is reused rather than duplicated. Otherwise flips queued→running, creates the
 * conversation-mode session with the JSON brief as its first message, and stamps
 * the id on the row (stampEveSession: fills an empty slot, or supersedes and
 * cancels a stale `eve:` stamp so two agents never work one run).
 *
 * The create→stamp window (Sequence step 3). A process that dies after eve
 * accepted the create but before the stamp leaves the row unstamped; the retry
 * then creates again. eve mints session ids server-side, so the id cannot be
 * persisted BEFORE the create; instead the create carries
 * `operationId = work-run:<runId>` (eve's create-once key), and the retry's
 * create is answered with the FIRST session's id without dispatching the brief
 * again. The stamp then records that session and the watch reads its first turn
 * from index 0 — one agent per run across the window.
 *
 * The first turn's response stream is returned but NOT opened here.
 */
async function openWorkSession(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  brief: WorkRunBrief
  supabase: SupabaseClient
  signal?: AbortSignal
}): Promise<OpenedWorkSession> {
  const { agentRunId, workspaceId, userId, brief, supabase, signal } = args

  const secret = internalSecret()
  if (!secret) throw new Error('work run requested but AGENT_RUN_INTERNAL_SECRET is not set')
  const client = buildWorkClient({ secret, agentRunId, workspaceId, userId })

  // Idempotency: the session already on the row wins.
  const { data: row } = await supabase
    .from('agent_run')
    .select('status, sandbox_id, session_state')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const existing = sessionIdFromSandbox(row?.sandbox_id)
  const status = (row?.status as string | null) ?? null
  if (existing && status && REUSABLE_STATUSES.has(status)) {
    const cursor = parseConversationSnapshot(row?.session_state, existing)
    return {
      sessionId: existing,
      stamped: true,
      reused: true,
      fromIndex: cursor?.streamIndex ?? 0,
      client,
      created: null,
    }
  }

  // Flip queued→running + stamp the tracked action 'working' up front, so the
  // board reflects the live run even before the first streamed event lands.
  await flipToRunning(supabase, { agentRunId, workspaceId })

  // An interactive session: a work run must be able to park (on a question,
  // and after finish_work) and be resumed. CREATE-ONCE on
  // the run id: a retry across the create→stamp window adopts this session.
  const created = await createConversationSession(client, {
    message: JSON.stringify(brief),
    operationId: workRunOperationId(agentRunId),
    ...(signal ? { signal } : {}),
  })
  const stamped = await stampEveSession(supabase, client, {
    agentRunId,
    workspaceId,
    sandboxId: `${EVE_SANDBOX_PREFIX}${created.sessionId}`,
  })
  return {
    sessionId: created.sessionId,
    stamped,
    reused: false,
    fromIndex: 0,
    client,
    created: { session: created.session, response: created.response },
  }
}

/**
 * Inngest step 1 of a work dispatch: create (or find) the run's eve session and
 * return its JSON-safe handle. Memoize this in its own `step.run` so a retry
 * replays the same session id; the row stamp covers the gap before memoization.
 *
 * @throws only on a hard transport/mint error (Inngest retries; the row stamp
 *         makes the retry re-attach instead of creating twice).
 */
export async function startWorkEveSession(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  brief: WorkRunBrief
  supabase: SupabaseClient
}): Promise<WorkSessionStart> {
  const opened = await openWorkSession(args)
  return {
    sessionId: opened.sessionId,
    stamped: opened.stamped,
    reused: opened.reused,
    fromIndex: opened.fromIndex,
  }
}

/** How long a continuation waits for the steer's turn to show its first event. */
export const STEER_CONTINUATION_WAIT_MS = 20_000
/** At most this many steer continuations in one watch (each is a whole turn). */
const MAX_STEER_CONTINUATIONS = 3

/** One steer continuation: the next turn's disposition, where it was read from, and whether the budget cut it. */
interface SteerContinuation {
  disposition: DrainDisposition
  startIndex: number
  cutByBudget: boolean
}

/**
 * At ONE turn boundary, settle the run's steers (steer-ledger.ts): the ones
 * the turn received are marked applied; for any it didn't, the steer starts
 * (or started) the NEXT turn on this session, so read that turn too, from
 * `startIndex` (just past the boundary). Each orphan is CLAIMED (applied_at,
 * compare-and-set) before the read, and only a claim that took reads: the
 * relay's after-settle drain claims the same way, so exactly one reader
 * drains a steer's turn, and a turn that never comes (the send failed after
 * all, or eve folded it in a form the match missed) costs one bounded wait,
 * never a loop. Null when nothing continues.
 *
 * Only for a turn that ended cleanly with nothing parked: a cancel, a stream
 * error, a question or a handoff classifies as it is (the relay refuses a
 * steer to a parked run). `cutByBudget`: the watch budget ran out inside the
 * continuation turn (the caller answers `pending` past what it read).
 */
async function drainSteerContinuation(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    session: ClientSession
    startIndex: number
    drained: DrainDisposition
    markedSandboxId: string | undefined
    /** Epoch ms when the watch budget runs out (null = no budget). */
    deadline: number | null
    /** How long to wait for the continuation turn's first event. */
    waitMs: number
  },
): Promise<SteerContinuation | null> {
  const { agentRunId, workspaceId, session, markedSandboxId, drained } = args
  const parked = drained.pendingInput !== null || (drained.delegations ?? []).length > 0 || !!drained.delegationPlan
  if (drained.canceled || drained.streamError || !drained.reachedBoundary || parked) return null
  const orphans = await settleSteersAtBoundary(supabase, {
    agentRunId,
    workspaceId,
    receivedMessages: drained.receivedMessages ?? [],
  })
  if (orphans.length === 0) return null
  // No budget left to read another turn: leave the steers unapplied (the
  // relay's after-settle drain can still claim them) and classify what is in hand.
  const remaining = args.deadline === null ? null : args.deadline - Date.now()
  if (remaining !== null && remaining <= 0) return null
  const claimed = await markSteersApplied(supabase, { agentRunId, workspaceId, ids: orphans.map((o) => o.id) })
  if (claimed.length === 0) return null
  await appendAgentRunLog(supabase, {
    agentRunId,
    workspaceId,
    text: `\n↪️ [a message arrived as the turn ended; continuing with it]\n`,
  }).catch(() => {})

  const controller = new AbortController()
  let sawEvent = false
  let cutByBudget = false
  const firstEventTimer = setTimeout(() => {
    if (!sawEvent) controller.abort()
  }, args.waitMs)
  const budgetTimer =
    remaining !== null
      ? setTimeout(() => {
          cutByBudget = true
          controller.abort()
        }, remaining)
      : null
  const source = session.stream({ signal: controller.signal, startIndex: args.startIndex })
  const watched = (async function* () {
    for await (const ev of source) {
      sawEvent = true
      yield ev
    }
  })()
  let next: DrainDisposition
  try {
    next = await drainTurn(supabase, {
      agentRunId,
      workspaceId,
      events: watched,
      controller,
      markedSandboxId,
      stopAtBoundary: true,
    })
  } finally {
    clearTimeout(firstEventTimer)
    if (budgetTimer) clearTimeout(budgetTimer)
  }
  // No turn came: the original disposition stands.
  if (!sawEvent && next.consumed === 0) return null
  return { disposition: next, startIndex: args.startIndex, cutByBudget: cutByBudget && !next.reachedBoundary && !next.canceled }
}

/**
 * driveTurns, then settle the run's steers at the boundary it reached; a
 * steer's continuation turn is driven again (its question, handoff or empty
 * ask handled as any turn's), at most MAX_STEER_CONTINUATIONS times. The ONE
 * boundary path shared by the watch, the in-process dispatch (runWorkViaEve)
 * and the in-process resume (resumeWorkRun), so a steer that lands anywhere
 * is applied or drained. `readEnd` is the stream index just past what the
 * caller read (null when only the session's own snapshot knows it); a
 * continuation reads from the session's snapshot, else from `readEnd`.
 * `pending`: the watch budget cut a continuation short (nextIndex past what
 * was read).
 */
async function driveTurnsWithSteers(
  supabase: SupabaseClient,
  args: {
    agentRunId: string
    workspaceId: string
    session: ClientSession
    initial: DrainDisposition
    controller: AbortController
    markedSandboxId: string | undefined
    readEnd: number | null
    deadline?: number | null
    waitMs?: number
  },
): Promise<DrivenTurn & { readEnd: number | null; pending?: { nextIndex: number; disposition: DrainDisposition } }> {
  let disposition = args.initial
  let readEnd = args.readEnd
  for (let round = 0; ; round++) {
    const driven = await driveTurns(supabase, {
      agentRunId: args.agentRunId,
      workspaceId: args.workspaceId,
      session: args.session,
      initial: disposition,
      controller: args.controller,
      markedSandboxId: args.markedSandboxId,
    })
    if (round >= MAX_STEER_CONTINUATIONS) return { ...driven, readEnd }
    const startIndex = driven.snapshot?.streamIndex ?? readEnd
    if (startIndex === null || startIndex === undefined) return { ...driven, readEnd }
    const cont = await drainSteerContinuation(supabase, {
      agentRunId: args.agentRunId,
      workspaceId: args.workspaceId,
      session: args.session,
      startIndex,
      drained: driven.disposition,
      markedSandboxId: args.markedSandboxId,
      deadline: args.deadline ?? null,
      waitMs: args.waitMs ?? STEER_CONTINUATION_WAIT_MS,
    })
    if (!cont) return { ...driven, readEnd }
    readEnd = cont.startIndex + cont.disposition.consumed
    if (cont.cutByBudget) {
      return { disposition: cont.disposition, snapshot: null, readEnd, pending: { nextIndex: readEnd, disposition: cont.disposition } }
    }
    disposition = cont.disposition
  }
}

/**
 * Inngest step 2..n of a work dispatch: re-attach to the run's session at
 * `fromIndex` and read it until EITHER the turn reaches its boundary (then run
 * the classifier: park / settle / no-op, exactly like the in-process driver) OR
 * `budgetMs` elapses first (then return `pending` with where the next watch
 * resumes, settling nothing). Each watch mints its own token, so the 60-min TTL
 * never limits a run — the caller's step count does.
 *
 * A park seen in an earlier watch (`carriedPendingInput`) is honoured when the
 * boundary lands in this one, so a budget expiring between the input.requested
 * event and the session.waiting that follows it cannot turn a question into a
 * bare-park failure.
 */
export async function watchWorkEveSession(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  sessionId: string
  fromIndex: number
  budgetMs?: number
  carriedPendingInput?: PendingInput | null
  carriedDelegations?: DelegationRequest[] | null
  /** How long a steer continuation waits for its turn's first event (default STEER_CONTINUATION_WAIT_MS). */
  steerWaitMs?: number
  supabase: SupabaseClient
}): Promise<WorkWatchOutcome> {
  const { agentRunId, workspaceId, userId, sessionId, fromIndex, supabase } = args

  const secret = internalSecret()
  if (!secret) throw new Error('work run watch requested but AGENT_RUN_INTERNAL_SECRET is not set')
  const client = buildWorkClient({ secret, agentRunId, workspaceId, userId })

  // attach() performs no I/O: it pins the id and seeds the read cursor.
  const session = client.sessions.attach(sessionId, { streamIndex: fromIndex })
  const controller = new AbortController()
  const watchStartedAt = Date.now()
  let budgetExpired = false
  const budgetTimer =
    args.budgetMs !== undefined
      ? setTimeout(() => {
          budgetExpired = true
          controller.abort()
        }, args.budgetMs)
      : null
  const markedSandboxId = `${EVE_SANDBOX_PREFIX}${sessionId}`

  let drained: DrainDisposition
  try {
    drained = await drainTurn(supabase, {
      agentRunId,
      workspaceId,
      // The raw durable stream stays open across a park — stop at the boundary.
      events: session.stream({ signal: controller.signal }),
      controller,
      markedSandboxId,
      stopAtBoundary: true,
    })
  } finally {
    if (budgetTimer) clearTimeout(budgetTimer)
  }

  const carried = args.carriedPendingInput ?? null
  const carriedDelegations = args.carriedDelegations ?? []
  const seenRequests = new Set(carriedDelegations.map((d) => d.requestId))
  const delegations = [
    ...carriedDelegations,
    ...(drained.delegations ?? []).filter((d) => !seenRequests.has(d.requestId)),
  ]
  // `pending` only when the budget cut the drain SHORT of the boundary. If the
  // timer fired after the boundary event was read (during the trailing log
  // flush), the turn's disposition is already in hand: classify it. Returning
  // pending here would hand the next watch an index PAST the boundary, where
  // nothing further arrives, so it would hang to its own budget and re-carry
  // the park until the step cap turned a question into a failure.
  if (budgetExpired && !drained.canceled && !drained.reachedBoundary) {
    return {
      settled: null,
      sessionId,
      pending: {
        nextIndex: fromIndex + drained.consumed,
        pendingInput: drained.pendingInput ?? carried,
        ...(delegations.length > 0 ? { delegations } : {}),
      },
    }
  }

  const initial: DrainDisposition = {
    ...drained,
    pendingInput: drained.canceled ? null : (drained.pendingInput ?? carried),
    delegations: drained.canceled ? [] : delegations,
  }
  // The orphan-steer race (steer-ledger.ts): a steer that reached eve just
  // after a turn settled starts the next turn; driveTurnsWithSteers drains it
  // as a continuation, so it is read, billed and classified, never left unread.
  const driven = await driveTurnsWithSteers(supabase, {
    agentRunId,
    workspaceId,
    session,
    initial,
    // The budget timer aborts `controller`; a boundary reached in the same
    // instant must not hand the follow-up turns an already-aborted signal.
    controller: budgetExpired ? new AbortController() : controller,
    markedSandboxId,
    readEnd: fromIndex + drained.consumed,
    deadline: budgetExpired ? Date.now() : args.budgetMs !== undefined ? watchStartedAt + args.budgetMs : null,
    waitMs: args.steerWaitMs ?? STEER_CONTINUATION_WAIT_MS,
  })
  if (driven.pending) {
    const cut = driven.pending.disposition
    return {
      settled: null,
      sessionId,
      pending: {
        nextIndex: driven.pending.nextIndex,
        pendingInput: cut.pendingInput,
        ...((cut.delegations ?? []).length > 0 ? { delegations: cut.delegations } : {}),
      },
    }
  }
  return classifyAndSettle(supabase, {
    agentRunId,
    workspaceId,
    disposition: driven.disposition,
    snapshot: driven.snapshot ?? { sessionId, streamIndex: driven.readEnd ?? fromIndex + drained.consumed },
    sessionId,
  })
}

/**
 * IN-PROCESS driver: run one workspace agent_run as a durable eve CONVERSATION
 * session and mirror its progress in ONE process — create (or reuse) the session
 * with the brief, drain the first turn, classify. Not for Inngest (see the
 * section header): a request killed mid-turn would leave the session unwatched.
 *
 * @param agentRunId  the run to execute
 * @param workspaceId the run's workspace (tenancy — from the loaded run context)
 * @param userId      the triggering user (token subject; attribution)
 * @param brief       the JSON brief delivered as the session's first message
 * @param supabase    the service client (progress + terminal settle writes)
 *
 * Throws only on a hard transport/mint error. A normal run — settle, needs_input
 * park, or cancel — resolves.
 */
export async function runWorkViaEve(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  brief: WorkRunBrief
  supabase: SupabaseClient
}): Promise<WorkRunOutcome> {
  const { agentRunId, workspaceId, userId, brief, supabase } = args

  const controller = new AbortController()
  const opened = await openWorkSession({
    agentRunId,
    workspaceId,
    userId,
    brief,
    supabase,
    signal: controller.signal,
  })

  // An earlier attempt's session is on the row: watch it to its boundary instead
  // of creating another agent for the same task.
  if (!opened.created) {
    return watchWorkEveSession({
      agentRunId,
      workspaceId,
      userId,
      sessionId: opened.sessionId,
      fromIndex: opened.fromIndex,
      supabase,
    })
  }

  const sessionId = opened.sessionId
  const markedSandboxId = `${EVE_SANDBOX_PREFIX}${sessionId}`

  const firstTurn = await drainTurn(supabase, {
    agentRunId,
    workspaceId,
    events: opened.created.response,
    controller,
    markedSandboxId,
  })

  // Drive the turn to its final disposition, self-healing a degenerate empty ask.
  // The stream has drained to the turn boundary → the session's streamIndex is
  // advanced; driveTurns captures the snapshot after the final turn drained.
  // A steer landing here is applied or drained, as in the watch.
  const { disposition, snapshot } = await driveTurnsWithSteers(supabase, {
    agentRunId,
    workspaceId,
    session: opened.created.session,
    initial: firstTurn,
    controller,
    markedSandboxId,
    readEnd: null,
  })

  return classifyAndSettle(supabase, {
    agentRunId,
    workspaceId,
    disposition,
    snapshot,
    sessionId,
  })
}

type OpenedResumedTurn =
  | {
      kind: 'resumed'
      sessionId: string
      session: ClientSession
      response: MessageResponse
      snapshot: SessionStateSnapshot
      controller: AbortController
    }
  | { kind: 'skipped'; sessionId: string | null; settled: 'failed' | null }

/**
 * Open the resumed turn of a parked (needs_input) work run from a FRESH process:
 * load the resume handles, guard, CAS queued→running, and send ONE turn that
 * answers the approval. The turn's response stream is returned but not opened.
 *
 * The response shape mirrors the drill-in's POST: either structured answers or a
 * skip. eve DISCARDS text on an approval response, so the answers ride on the
 * response's `text` + clientContext (conversation-session.ts); the `optionId`
 * resolves the approval.
 */
async function openResumedTurn(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  response: { answers?: Array<{ question: string; answer: string }>; skipped?: boolean }
  expectedRequestId?: string | null
  supabase: SupabaseClient
}): Promise<OpenedResumedTurn> {
  const { agentRunId, workspaceId, userId, response, expectedRequestId, supabase } = args

  const secret = internalSecret()
  if (!secret) throw new Error('work run resume requested but AGENT_RUN_INTERNAL_SECRET is not set')

  // Load the run's resume handles: the eve session id (sandbox_id's eve: prefix),
  // the persisted snapshot (session_state), and the open question (pending_input).
  const { data: run } = await supabase
    .from('agent_run')
    .select('status, sandbox_id, session_state, pending_input, action_id')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!run) return { kind: 'skipped', sessionId: null, settled: null }

  const sessionId = sessionIdFromSandbox(run.sandbox_id) ?? ''
  // Validate the persisted blob into a live resume cursor. A PRE-0.31 row (one
  // carrying a continuationToken) parses to null: continuation tokens no longer
  // exist, so such a session cannot be re-addressed and the run degrades into the
  // settleFailed path below, exactly as a run with no session at all would.
  const rawSessionState = run.session_state
  const snapshot = parseConversationSnapshot(rawSessionState, sessionId || null)
  const legacySessionState = snapshot === null && isLegacySessionState(rawSessionState)
  // A run parked on its delegated children is released by work/run.child_settled
  // (releaseDelegationPark), never by a person's answer.
  if (isDelegationPark(run.pending_input)) {
    return { kind: 'skipped', sessionId: sessionId || null, settled: null }
  }
  const pending = run.pending_input as PendingInput | null

  // Request-identity guard: a DUPLICATE of an OLDER resume event (Inngest is
  // at-least-once) delivered while this run is queued for a LATER question would pair
  // a stale answer set with the newer pending question and drop the real answers. The
  // respond route stamps the answered question's requestId on the event; if it no
  // longer matches the run's CURRENT pending_input.requestId, this delivery is stale
  // — no-op cleanly (do NOT CAS/settle; the correct, matching event still needs to
  // win the queued→running CAS). A null expectedRequestId (legacy event) skips the
  // check. This runs BEFORE the queued→running CAS so a stale duplicate never
  // consumes the resume slot.
  if (
    expectedRequestId != null &&
    pending?.requestId != null &&
    expectedRequestId !== pending.requestId
  ) {
    return { kind: 'skipped', sessionId: sessionId || null, settled: null }
  }

  // Without a session + snapshot + open question there is nothing to resume. Settle
  // the run failed so it doesn't sit `queued` forever (the respond route CAS'd it).
  // A legacy (pre-eve-0.31) session_state lands here too — it is reported distinctly
  // so the log says "expired by the upgrade", not "never had a session".
  if (!sessionId || !snapshot || !pending?.requestId) {
    const settled = await settleFailed(supabase, {
      agentRunId,
      workspaceId,
      error: legacySessionState
        ? 'cannot resume — this run’s session predates the eve upgrade and can no longer be continued'
        : 'cannot resume — the run has no live session to answer',
      snapshot,
    })
    return { kind: 'skipped', sessionId: sessionId || null, settled: settled ? 'failed' : null }
  }

  // CAS queued→running (+ action mirror → working), clear pending_input. The
  // respond route flipped needs_input→queued; move it into running for this
  // dispatch. If the row isn't queued (a race — canceled meanwhile), bail.
  // started_at is re-stamped as this TURN's start (the respond route did the
  // same at the un-park): the stale-run reaper measures from it, and a run
  // parked longer than the reaper's cutoff must not be reaped the moment its
  // answer arrives. Any future un-park path (a child settling, a delegated
  // handoff) inherits the rule through this CAS.
  const { data: flipped } = await supabase
    .from('agent_run')
    .update({ status: 'running', pending_input: null, started_at: new Date().toISOString() })
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'queued')
    .select('id')
  if (!flipped || flipped.length === 0) {
    // Not queued anymore (canceled / already resumed) — nothing to do here.
    return { kind: 'skipped', sessionId, settled: null }
  }
  const actionId = run.action_id as string | null
  await mirrorActionStatus(supabase, actionId, 'working')
  // The ledger row un-parks (needs_input → running).
  await mirrorAgentRunStatus(supabase, { agentRunId, workspaceId }, { status: 'running' })

  // Build the resume payload — the approval choreography. Answer = approve optionId
  // + the answers as the follow-up message. Skip = deny optionId + a "skipped" note.
  const skipped = response.skipped === true
  const optionId = skipped
    ? pending.denyOptionId || 'cancel'
    : pending.approveOptionId || 'approve'
  const message = skipped
    ? 'I skipped the question without answering. Proceed with your best judgment and note the assumption in your summary.'
    : formatAnswers(response.answers ?? [])

  const client = buildWorkClient({ secret, agentRunId, workspaceId, userId, resume: true })
  const controller = new AbortController()

  // Log the answer (💬) — the design's resume marker, mirroring the ❓ at the park.
  await appendAgentRunLog(supabase, {
    agentRunId,
    workspaceId,
    text: `\n💬 [user ${skipped ? 'skipped the question' : 'answered'}]\n`,
  }).catch(() => {})

  try {
    const resumed = await resumeConversationSession(client, {
      sessionId,
      snapshot: { sessionId: snapshot.sessionId, streamIndex: snapshot.streamIndex },
      payload: {
        // The question's approval, plus any handoff made in the same step and
        // refused ASK_FIRST: eve resolves the batch only when all are answered.
        inputResponses: [{ requestId: pending.requestId, optionId }, ...(pending.companionResponses ?? [])],
        message,
      },
      signal: controller.signal,
    })
    return {
      kind: 'resumed',
      sessionId,
      session: resumed.session,
      response: resumed.response,
      snapshot,
      controller,
    }
  } catch (err) {
    // The resume send failed (session no longer waiting, network, eve error).
    // Settle failed with the current snapshot so the run doesn't hang running.
    const msg = err instanceof Error ? err.message : String(err)
    const settled = await settleFailed(supabase, {
      agentRunId,
      workspaceId,
      error: `resume send failed: ${msg}`,
      snapshot,
    })
    return { kind: 'skipped', sessionId, settled: settled ? 'failed' : null }
  }
}

/**
 * Release a run parked on its delegated children (work/run.child_settled), once
 * every child is terminal: CAS needs_input → running, un-park the ledger row,
 * and answer every `delegate_work` approval in the park (approve). eve then
 * runs each tool's execute, which fetches its own child's result (or refusal)
 * by call id and returns it as the tool result, and the turn goes on. Returns
 * where the resumed turn starts, for watchWorkEveSession; `waiting` while a
 * child is still running; `skipped` when there is nothing of ours to release
 * (not parked on children any more: canceled, already released).
 */
export async function releaseDelegationPark(args: {
  agentRunId: string
  workspaceId: string
  supabase: SupabaseClient
}): Promise<WorkResumeStart | { kind: 'waiting'; sessionId: string | null; settled: null }> {
  const { agentRunId, workspaceId, supabase } = args
  const { data: run } = await supabase
    .from('agent_run')
    .select('status, sandbox_id, session_state, pending_input, triggered_by')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!run) return { kind: 'skipped', sessionId: null, settled: null }
  const sessionId = sessionIdFromSandbox(run.sandbox_id) ?? ''
  const park = run.pending_input
  if (run.status !== 'needs_input' || !isDelegationPark(park)) {
    return { kind: 'skipped', sessionId: sessionId || null, settled: null }
  }
  const settledAll = await delegationChildrenSettled(supabase, park, workspaceId)
  if (!settledAll) return { kind: 'waiting', sessionId: sessionId || null, settled: null }

  const snapshot = parseConversationSnapshot(run.session_state, sessionId || null)
  const userId = (run.triggered_by as string | null) ?? ''
  const secret = internalSecret()
  if (!secret) throw new Error('work run release requested but AGENT_RUN_INTERNAL_SECRET is not set')
  if (!sessionId || !snapshot) {
    const settled = await settleFailed(supabase, {
      agentRunId,
      workspaceId,
      error: 'cannot resume — the run has no live session to hand its teammates’ results to',
      snapshot,
    })
    return { kind: 'skipped', sessionId: sessionId || null, settled: settled ? 'failed' : null }
  }

  // The same un-park the question resume does (re-stamping started_at: the
  // stale-run reaper measures from it), in one CAS from needs_input.
  const { data: flipped } = await supabase
    .from('agent_run')
    .update({ status: 'running', pending_input: null, started_at: new Date().toISOString() })
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .eq('status', 'needs_input')
    .select('id')
  if (!flipped || flipped.length === 0) return { kind: 'skipped', sessionId, settled: null }
  await mirrorAgentRunStatus(supabase, { agentRunId, workspaceId }, { status: 'running' })
  const done = park.children.filter((c) => c.childRunId).length
  await appendAgentRunLog(supabase, {
    agentRunId,
    workspaceId,
    text: `\n🤝 [${done === 1 ? 'the teammate' : `${done} teammates`} finished — picking the work back up]\n`,
  }).catch(() => {})

  const client = buildWorkClient({ secret, agentRunId, workspaceId, userId, resume: true })
  try {
    await resumeConversationSession(client, {
      sessionId,
      snapshot: { sessionId: snapshot.sessionId, streamIndex: snapshot.streamIndex },
      payload: { inputResponses: park.children.map((c) => ({ requestId: c.requestId, optionId: c.approveOptionId })) },
      signal: new AbortController().signal,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const settled = await settleFailed(supabase, { agentRunId, workspaceId, error: `release send failed: ${msg}`, snapshot })
    return { kind: 'skipped', sessionId, settled: settled ? 'failed' : null }
  }
  return { kind: 'resumed', sessionId, fromIndex: snapshot.streamIndex }
}

/**
 * Inngest step 1 of a work resume: answer the parked question and return where
 * the resumed turn starts on the durable stream. Memoize it in its own
 * `step.run` (the queued→running CAS inside makes a re-run a no-op anyway), then
 * watch from `fromIndex` with {@link watchWorkEveSession} exactly as a dispatch
 * does.
 */
export async function resumeWorkEveSession(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  response: { answers?: Array<{ question: string; answer: string }>; skipped?: boolean }
  expectedRequestId?: string | null
  supabase: SupabaseClient
}): Promise<WorkResumeStart> {
  const opened = await openResumedTurn(args)
  if (opened.kind === 'skipped') return opened
  return { kind: 'resumed', sessionId: opened.sessionId, fromIndex: opened.snapshot.streamIndex }
}

/**
 * IN-PROCESS resume driver: answer a parked (needs_input) work run and drive the
 * resumed turn through the SAME classifier in ONE process. Not for Inngest (see
 * the section header) — use resumeWorkEveSession + watchWorkEveSession there.
 *
 * @param response  { answers } to answer, or { skipped: true } to skip.
 */
export async function resumeWorkRun(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  response: { answers?: Array<{ question: string; answer: string }>; skipped?: boolean }
  /**
   * The eve requestId this answer set was submitted against (the respond route reads
   * it off pending_input at submit time). The driver rejects a resume whose expected
   * requestId doesn't match the run's CURRENT pending_input.requestId — an Inngest
   * at-least-once DUPLICATE of an OLDER resume event, delivered while the run is
   * queued for a LATER question, would otherwise pair a stale answer set with the
   * newer pending question and drop the real answers. null = no check (legacy events).
   */
  expectedRequestId?: string | null
  supabase: SupabaseClient
}): Promise<WorkRunOutcome> {
  const { agentRunId, workspaceId, supabase } = args
  const opened = await openResumedTurn(args)
  if (opened.kind === 'skipped') return { settled: opened.settled, sessionId: opened.sessionId }

  const markedSandboxId = `${EVE_SANDBOX_PREFIX}${opened.sessionId}`
  const firstTurn = await drainTurn(supabase, {
    agentRunId,
    workspaceId,
    events: opened.response,
    controller: opened.controller,
    markedSandboxId,
  })

  const { disposition, snapshot: nextSnapshot } = await driveTurnsWithSteers(supabase, {
    agentRunId,
    workspaceId,
    session: opened.session,
    initial: firstTurn,
    controller: opened.controller,
    markedSandboxId,
    readEnd: null,
  })

  return classifyAndSettle(supabase, {
    agentRunId,
    workspaceId,
    disposition,
    snapshot: nextSnapshot,
    sessionId: opened.sessionId,
  })
}

/**
 * Render the user's answers as the follow-up `message` eve replays to the model
 * after the approval resolves. eve discards `text` on an approval response, so the
 * answers MUST ride here. Plain and readable so the model reads it as the user's
 * own reply.
 */
function formatAnswers(answers: Array<{ question: string; answer: string }>): string {
  const lines = answers
    .filter((a) => a && typeof a.answer === 'string' && a.answer.trim().length > 0)
    .map((a) => `- ${a.question}: ${a.answer}`)
  if (lines.length === 0) {
    return 'I acknowledged the question without selecting a specific option. Proceed with your best judgment.'
  }
  return `Here are my answers:\n${lines.join('\n')}`
}

/**
 * Flip a still-queued run to running + started_at, and stamp its tracked action's
 * agent_run_status to 'working'. CAS-guarded on 'queued'. Best-effort.
 */
async function flipToRunning(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string },
): Promise<void> {
  const { data: updated } = await supabase
    .from('agent_run')
    .update({ status: 'running', started_at: new Date().toISOString() })
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'queued')
    .select('action_id')
    .maybeSingle()
  const actionId = (updated?.action_id as string | null) ?? null
  if (actionId) {
    await supabase.from('actions').update({ agent_run_status: 'working' }).eq('id', actionId)
  }
}
