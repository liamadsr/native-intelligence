/**
 * The agent coding-run executor (Phase 3) — the ONLY cloud coding-run runtime,
 * for both action-origin and flow-origin runs.
 *
 * Mirrors src/lib/flows/run-skill-eve.ts's structure, adapted for a LONG,
 * PROGRESS-STREAMED coding run (vs. the skill path's await-the-result shape):
 *
 *   - Mint an HMAC-signed run token (agent-run-token.ts) carrying only the routing
 *     facts { agentRunId, workspaceId, userId }. The eve agent's dynamic resolvers
 *     fetch the full spec (persona prompt, task, repo, GitHub token, env) from the
 *     internal spec route keyed by this token — nothing large crosses the boundary.
 *   - Create a DURABLE eve session server-to-server against the `coding-agent`
 *     mount (base URL + channel-auth pattern from run-skill-eve.ts).
 *   - STREAM the session's NDJSON events, mirroring assistant text + tool activity
 *     into `agent_run.log_tail` via throttled direct DB appends (log-tail.ts). We
 *     deliberately do NOT POST the internal event route in-process — see log-tail.ts
 *     for why (route-handler import = layering inversion + next/server in the
 *     Inngest bundle). Same 4000-char tail discipline; same queued→running flip.
 *   - The eve session id is stored in `agent_run.sandbox_id` as `eve:<sessionId>`
 *     (documented dual use, zero migration — the `eve:` prefix marks a sandbox eve
 *     owns, so agentRunCancel never tries to tear it down itself). It is stamped
 *     the moment the session exists, so agentRunCancel can cancel the session
 *     however quiet the run is.
 *   - The run's TERMINAL state + PR link are written by the eve agent's `finish_run`
 *     tool → the internal OUTCOME route (the single writer). This watcher does NOT
 *     settle a successful run — it only settles the two failure modes eve can't:
 *       · agent died without reporting an outcome (stream ended, row non-terminal)
 *         → settle 'failed'.
 *       · the run is being canceled (row went 'canceling', or agentRunCancel
 *         already settled it 'canceled', mid-stream) → cancel the eve session,
 *         abort the client stream + settle 'canceled' idempotently (a late
 *         finish_run 409s against a canceling/canceled row per the outcome route
 *         contract). agentRunCancel ALSO cancels the session (by the stamped
 *         sandbox_id); the watcher's own cancel covers a Stop whose load-run read
 *         the row before the stamp landed. eve's cancel is idempotent
 *         (`no_active_turn` on the second call).
 *
 * Two halves, so an Inngest retry never starts a second agent on the same run:
 *   - startAgentEveSession (the caller's `create-eve-session` step, memoized):
 *     creates the session and stamps it. A retry replays the memoized session id.
 *   - runAgentViaEve with `sessionId` (the caller's `watch-eve-session-<n>`
 *     steps): RE-ATTACHES to that session from `fromIndex` and watches it for at
 *     most `budgetMs`, returning `{ pending: { nextIndex } }` when the budget ends
 *     first, so a long run is watched across several requests (each inside
 *     /api/inngest's maxDuration) instead of being killed and restarted.
 * Called without `sessionId` it creates and watches in one go (no budget).
 */
import { Client } from 'eve/client'
import type { HandleMessageStreamEvent } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTaskSession, retireTaskSession } from '@/lib/eve/task-session'
import { eveDispatchOrigin } from '@/lib/eve/dispatch-origin'
import { createTurnBoundary } from '@/lib/eve/turn-boundary'
import {
  mintAgentRunToken,
  internalSecret,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
  AGENT_RUN_WORKSPACE_HEADER,
  AGENT_RUN_USER_HEADER,
} from './agent-run-token'
import { appendAgentRunLog, readAgentRunCanceling } from './log-tail'
import { mirrorAgentRunStatus } from '@/lib/work/agent-run-mirror'

/** The named eve mount for the coding-agent (see next.config.mjs). */
const CODING_AGENT_MOUNT = '/eve/coding-agent'

/**
 * Prefix stamped on `agent_run.sandbox_id` for eve runs (coding + work). Marks the
 * value as an eve session id whose sandbox eve owns (retention-based teardown), so
 * agentRunCancel settles the row without any sandbox-teardown call of its own.
 */
export const EVE_SANDBOX_PREFIX = 'eve:'

/** The single kickoff message. The task itself is delivered via the spec route. */
const KICKOFF_MESSAGE =
  'Begin the coding run. Fetch your task from the run spec, complete the work in the sandbox, and finish by calling the terminal tool exactly once.'

/** Throttle: flush the accumulated log buffer at most this often (ms). */
const LOG_FLUSH_INTERVAL_MS = 2000
/** Or sooner once the buffer reaches this many chars. */
const LOG_FLUSH_CHARS = 800

/** What the watcher resolved a run to. */
export interface EveAgentRunOutcome {
  /**
   * Set when the watch budget ran out before the run reached a terminal
   * boundary: nothing was settled; watch again from `nextIndex`.
   */
  pending?: { nextIndex: number }
  /** Terminal disposition the WATCHER settled, or null when the outcome route
   *  already settled it (successful finish_run). */
  settled: 'failed' | 'canceled' | null
  /** The eve session id, if the session got far enough to have one. */
  sessionId: string | null
  /** What the watcher's own eve session cancel returned (cancel paths only). */
  sessionCancel?: EveSessionCancelResult | null
}

/** Render a streamed event as a compact human-readable log line, or null to skip. */
function renderEventLine(ev: HandleMessageStreamEvent): string | null {
  switch (ev.type) {
    case 'message.appended':
      // Assistant prose delta — the model narrating its work.
      return ev.data.messageDelta
    case 'actions.requested': {
      // Tool activity — one line per requested tool call.
      const names = ev.data.actions
        .map((a) => (a.kind === 'tool-call' ? a.toolName : a.kind))
        .filter(Boolean)
      return names.length ? `\n[tool] ${names.join(', ')}\n` : null
    }
    case 'action.result':
      return ev.data.status === 'failed' ? `\n[tool failed]\n` : null
    case 'step.failed':
      return `\n[step failed] ${ev.data.message}\n`
    case 'session.failed':
      return `\n[session failed] ${ev.data.message}\n`
    case 'turn.failed':
      // eve 0.67+: a recoverable failure fails only the turn and the session
      // parks (no session.failed follows). A terminal one is logged above.
      return ev.data.terminal ? null : `\n[turn failed] ${ev.data.message}\n`
    case 'turn.cancelled':
      // Protocol 19: the turn was cancelled (not a failure — eve follows this
      // with session.waiting). Render a marker so the transcript isn't silent.
      return `\n[turn cancelled]\n`
    default:
      return null
  }
}

/**
 * Settle a non-terminal run as failed (agent died without finish_run). Mirrors the
 * legacy record-outcome failure write: agent_run failed + finished_at, and (action
 * -origin only) actions.agent_run_status='failed'. Idempotent: only writes when the
 * row is still non-terminal.
 */
async function settleFailed(
  supabase: SupabaseClient,
  args: { agentRunId: string; workspaceId: string; error: string },
): Promise<boolean> {
  const { data: row } = await supabase
    .from('agent_run')
    .select('status, action_id')
    .eq('id', args.agentRunId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (!row) return false
  const terminal = ['pr_open', 'completed', 'failed', 'canceled']
  if (terminal.includes(row.status as string)) return false

  // Guard the write against a concurrent terminal write (outcome route landing
  // finish_run, or agentRunCancel settling) in the gap since the SELECT: only
  // transition a row that is STILL in the status we observed. If zero rows come
  // back, someone else settled it first — leave their outcome intact.
  const { data: updated } = await supabase
    .from('agent_run')
    .update({ status: 'failed', error_message: args.error, finished_at: new Date().toISOString() })
    .eq('id', args.agentRunId)
    .eq('status', row.status as string)
    .select('id')
  if (!updated || updated.length === 0) return false
  if (row.action_id) {
    await supabase.from('actions').update({ agent_run_status: 'failed' }).eq('id', row.action_id as string)
  }
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: args.agentRunId, workspaceId: args.workspaceId },
    { status: 'failed', error: args.error },
  )
  return true
}

/**
 * Settle a canceling run as canceled. The cancel route already flipped the row to
 * 'canceling' (optimistic UI); this writes the terminal 'canceled'. Idempotent: a
 * row already 'canceled' (raced) is left alone; a row that reached a REAL terminal
 * (finish_run landed before we noticed the cancel) is left alone too. Mirrors the
 * legacy agentRunCancel settle (actions.agent_run_status back to 'idle').
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
  const terminal = ['pr_open', 'completed', 'failed', 'canceled']
  if (terminal.includes(row.status as string)) return false

  // Same CAS guard as settleFailed: don't overwrite a REAL terminal (finish_run
  // that landed before we noticed the cancel) that raced in after our SELECT.
  const { data: updated } = await supabase
    .from('agent_run')
    .update({ status: 'canceled', error_message: 'Canceled by user', finished_at: new Date().toISOString() })
    .eq('id', args.agentRunId)
    .eq('status', row.status as string)
    .select('id')
  if (!updated || updated.length === 0) return false
  if (row.action_id) {
    await supabase.from('actions').update({ agent_run_status: 'idle' }).eq('id', row.action_id as string)
  }
  await mirrorAgentRunStatus(
    supabase,
    { agentRunId: args.agentRunId, workspaceId: args.workspaceId },
    { status: 'canceled' },
  )
  return true
}

/**
 * The same-origin server-to-server client for the coding-agent mount. The shared
 * secret authenticates us as the trusted internal caller; the signed run token
 * (routing facts ONLY — the spec is rebuilt server-side from it) scopes the
 * session; redirect:'error' stops the credentialed headers following a
 * cross-origin redirect.
 */
function codingAgentClient(args: {
  secret: string
  agentRunId: string
  workspaceId: string
  userId: string
}): Client {
  const { secret, agentRunId, workspaceId, userId } = args
  const runToken = mintAgentRunToken({ agentRunId, workspaceId, userId })
  // eveDispatchOrigin: the app's own address, where the agents are mounted.
  return new Client({
    host: `${eveDispatchOrigin()}${CODING_AGENT_MOUNT}`,
    auth: { bearer: secret },
    headers: {
      [AGENT_RUN_SECRET_HEADER]: secret,
      [AGENT_RUN_TOKEN_HEADER]: runToken,
      [AGENT_RUN_WORKSPACE_HEADER]: workspaceId,
      [AGENT_RUN_USER_HEADER]: userId,
    },
    redirect: 'error',
  })
}

/** What asking eve to cancel a coding session came back with. */
export type EveSessionCancelResult = 'accepted' | 'no_active_turn' | 'not_configured' | 'error'

/**
 * Cancel one eve session's running turn AND its background tasks through an
 * already-built coding-agent client. Never throws — every caller is on a Stop
 * path that must still settle the row when eve is unreachable. Since eve 0.69
 * a plain `cancel()` also stops working tasks (`{ tasks: true }` is gone).
 */
export async function cancelSessionVia(
  client: Client,
  sessionId: string,
  agentRunId: string,
): Promise<EveSessionCancelResult> {
  try {
    const res = await client.sessions.attach(sessionId).cancel()
    return res.status
  } catch (err) {
    console.warn('[agent-run-cancel] eve session cancel failed', {
      agentRunId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'error'
  }
}

/**
 * Stamp `eve:<sessionId>` onto the row as soon as the session exists — before any
 * event streams — so agentRunCancel sees an eve-owned session and cancels it even
 * when the model is silent (a log flush only happens on a rendered event).
 *
 * Fills an EMPTY sandbox_id. When the row already carries a DIFFERENT `eve:`
 * session (an Inngest retry of this dispatch: the first attempt's session is
 * stamped and, with its watcher gone, still running), it swaps the stamp to this
 * session with a CAS on the observed old value — so agentRunCancel targets the
 * session that is actually being watched — and cancels the superseded session so
 * two agents never work the same run. Any other value is left alone.
 *
 * Returns whether THIS session's id is now on the row. A write that errors, or
 * that matched zero rows, is NOT a stamp (false → the first log flush retries the
 * empty-slot stamp).
 *
 * Shared with the work-run dispatcher (run-work-eve.ts `startWorkEveSession`):
 * the stamp is the idempotency key that makes "one run = one eve session" hold
 * across Inngest retries on both mounts. The `client` only has to reach the
 * session's own mount for the supersede cancel.
 */
export async function stampEveSession(
  supabase: SupabaseClient,
  client: Client,
  args: { agentRunId: string; workspaceId: string; sandboxId: string },
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from('agent_run')
      .update({ sandbox_id: args.sandboxId })
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .is('sandbox_id', null)
      .select('id')
    if (error) return false
    if ((data?.length ?? 0) > 0) return true

    // Zero rows: the slot is taken (or the row is gone). Only a prior eve session
    // of this same run is ours to supersede.
    const { data: row, error: readError } = await supabase
      .from('agent_run')
      .select('sandbox_id')
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (readError || !row) return false
    const prior = typeof row.sandbox_id === 'string' ? row.sandbox_id : null
    if (prior === args.sandboxId) return true
    if (!prior || !prior.startsWith(EVE_SANDBOX_PREFIX)) return false

    const { data: swapped, error: swapError } = await supabase
      .from('agent_run')
      .update({ sandbox_id: args.sandboxId })
      .eq('id', args.agentRunId)
      .eq('workspace_id', args.workspaceId)
      .eq('sandbox_id', prior)
      .select('id')
    if (swapError || (swapped?.length ?? 0) === 0) return false

    const priorSessionId = prior.slice(EVE_SANDBOX_PREFIX.length)
    if (priorSessionId) {
      const priorCancel = await cancelSessionVia(client, priorSessionId, args.agentRunId)
      console.warn('[agent-run-eve] superseded a prior eve session on this run', {
        agentRunId: args.agentRunId,
        priorSessionId,
        priorCancel,
      })
    }
    return true
  } catch {
    return false
  }
}

/**
 * Ask eve to cancel a coding run's durable session (POST
 * /eve/v1/session/<id>/cancel on the coding-agent mount, same auth as the
 * dispatch). Cancels the running turn AND any background tasks it owns, so Stop
 * preempts the agent instead of waiting for it to read the cancel signal off
 * post_progress. eve's cancel is cooperative and asynchronous; `accepted` and
 * `no_active_turn` are both success (the latter: the session already finished).
 *
 * Never throws — Stop must still settle the row when eve is unreachable.
 */
export async function cancelEveCodingSession(args: {
  sessionId: string
  agentRunId: string
  workspaceId: string
  userId: string
}): Promise<EveSessionCancelResult> {
  const secret = internalSecret()
  if (!secret) return 'not_configured'
  let client: Client
  try {
    client = codingAgentClient({ secret, ...args })
  } catch (err) {
    console.warn('[agent-run-cancel] eve session cancel failed', {
      agentRunId: args.agentRunId,
      error: err instanceof Error ? err.message : String(err),
    })
    return 'error'
  }
  return cancelSessionVia(client, args.sessionId, args.agentRunId)
}

/**
 * Create the run's durable eve coding-agent session and stamp it onto the row
 * (the dispatcher's memoized `create-eve-session` step). Does not read the
 * stream: runAgentViaEve re-attaches to watch it. Throws on a create/mint error.
 */
export async function startAgentEveSession(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  supabase: SupabaseClient
}): Promise<{ sessionId: string; stamped: boolean }> {
  const { agentRunId, workspaceId, userId, supabase } = args
  const secret = internalSecret()
  if (!secret) throw new Error('eve agent runtime requested but AGENT_RUN_INTERNAL_SECRET is not set')
  const client = codingAgentClient({ secret, agentRunId, workspaceId, userId })
  // A one-shot session (createTaskSession) — see runAgentViaEve. The response's
  // stream is never opened here.
  const response = await createTaskSession(client, { message: KICKOFF_MESSAGE })
  const sessionId = response.sessionId
  const stamped = await stampEveSession(supabase, client, {
    agentRunId,
    workspaceId,
    sandboxId: `${EVE_SANDBOX_PREFIX}${sessionId}`,
  })
  return { sessionId, stamped }
}

/**
 * Run one agent_run as a durable eve coding-agent session and mirror its progress.
 *
 * @param agentRunId  the run to execute
 * @param workspaceId the run's workspace (tenancy — from the loaded run context)
 * @param userId      the triggering user (token subject; GitHub/attribution)
 * @param supabase    the service client (progress + terminal settle writes)
 * @param sessionId   re-attach to this already-created session (startAgentEveSession)
 *                    instead of creating one
 * @param fromIndex   with sessionId: the absolute stream index to resume from
 * @param budgetMs    with sessionId: stop watching after this long and return
 *                    `pending` (nothing settled) so the caller watches again
 * @param stamped     with sessionId: whether the session is already on the row
 *
 * Throws only on a hard transport/mint error (Inngest's retry re-enters through the
 * idempotency guard). A normal run — success, agent-died, or cancel — resolves.
 */
export async function runAgentViaEve(args: {
  agentRunId: string
  workspaceId: string
  userId: string
  supabase: SupabaseClient
  sessionId?: string
  fromIndex?: number
  budgetMs?: number
  stamped?: boolean
}): Promise<EveAgentRunOutcome> {
  const { agentRunId, workspaceId, userId, supabase } = args
  const fromIndex = args.fromIndex ?? 0

  const secret = internalSecret()
  if (!secret) throw new Error('eve agent runtime requested but AGENT_RUN_INTERNAL_SECRET is not set')

  const client = codingAgentClient({ secret, agentRunId, workspaceId, userId })

  // AbortController fires on cancel — aborting the client stream stops THIS
  // watcher. The session itself is stopped with eve's server-side cancel, by
  // agentRunCancel AND by this watcher's cancel branches below.
  const controller = new AbortController()
  // The watch budget (re-attach mode): abort the local stream, settle nothing.
  let budgetExpired = false
  const budgetTimer =
    args.sessionId && args.budgetMs !== undefined
      ? setTimeout(() => {
          budgetExpired = true
          controller.abort()
        }, args.budgetMs)
      : null

  // Create a one-shot session (createTaskSession): a headless coding run is one
  // turn, read to its boundary. eve 0.67 removed run modes (every session parks
  // after its turn) and eve holds a turn open at `turn.waiting` on a question
  // (0.69+) or a token-limit prompt (0.78+) nobody here will answer; the read stops at
  // that boundary (createTurnBoundary), the post-stream reconcile below settles
  // a row the agent never finished as failed, and the session is retired. The
  // terminal state is still written by the agent's finish_run tool via the
  // outcome route.
  // Re-attach mode reads the already-created session's durable stream from
  // `fromIndex` (no I/O until iterated); nothing new is created.
  let events: AsyncIterable<HandleMessageStreamEvent>
  let sessionId: string | null
  let stampedSandbox: boolean
  let markedSandboxId: string | undefined
  if (args.sessionId) {
    sessionId = args.sessionId
    markedSandboxId = `${EVE_SANDBOX_PREFIX}${sessionId}`
    stampedSandbox = args.stamped ?? true
    events = client.sessions
      .attach(sessionId, { streamIndex: fromIndex })
      .stream({ signal: controller.signal }) as AsyncIterable<HandleMessageStreamEvent>
  } else {
    const response = await createTaskSession(client, {
      message: KICKOFF_MESSAGE,
      signal: controller.signal,
    })
    events = response
    // The session id is available synchronously once the POST resolves. Stamp it
    // (prefixed) right away so agentRunCancel can identify — and cancel — the
    // eve-owned session from the first moment it exists.
    sessionId = response.sessionId || null
    markedSandboxId = sessionId ? `${EVE_SANDBOX_PREFIX}${sessionId}` : undefined
    stampedSandbox = markedSandboxId
      ? await stampEveSession(supabase, client, { agentRunId, workspaceId, sandboxId: markedSandboxId })
      : false
  }
  // Events consumed this watch, for the next watch's resume index.
  let consumed = 0
  // Re-attach mode only: the durable session stream does not close at a turn
  // boundary the way the first attach's MessageResponse does, so without this a
  // finished session would hold the watcher open until the step budget expired.
  // Mirrors eve's MessageResponse rule (@/lib/eve/turn-boundary): stop AFTER a
  // session.completed / session.failed, a session.waiting with no pending
  // webhook authorization, or a turn.waiting on a person.
  const endsReattachedWatch = createTurnBoundary()

  // Throttled log buffer. We accumulate rendered lines and flush on interval/size,
  // reading the row's cancel signal off the same append (or a standalone read when
  // the buffer is empty), so a `canceling` transition aborts the stream promptly.
  let buffer = ''
  let lastFlush = 0
  let canceled = false

  const flush = async (force: boolean): Promise<void> => {
    const now = Date.now()
    const due = force || buffer.length >= LOG_FLUSH_CHARS || now - lastFlush >= LOG_FLUSH_INTERVAL_MS
    if (!due) return
    if (buffer.length === 0) {
      // Nothing to write, but still poll the cancel signal so a quiet run notices.
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
      // Fallback stamp, only if the direct stamp after session create failed.
      ...(!stampedSandbox && markedSandboxId ? { sandboxId: markedSandboxId } : {}),
    })
    if (!stampedSandbox && markedSandboxId) stampedSandbox = true
    if (canceling) {
      canceled = true
      controller.abort()
    }
  }

  try {
    for await (const ev of events) {
      consumed += 1
      const line = renderEventLine(ev)
      if (line) buffer += line
      await flush(false)
      if (canceled) break
      // A terminal session event ends this watch; the post-stream reconcile below
      // settles the row exactly as it does after the first attach's stream ends.
      if (args.sessionId && endsReattachedWatch(ev)) break
    }
    // Final flush of any tail buffer (unless we already aborted for cancel).
    if (!canceled) await flush(true)
  } catch (err) {
    // A cancel-driven abort surfaces here as an AbortError — that's expected, not a
    // failure. Any OTHER stream error means the session broke mid-flight; fall
    // through to the post-stream reconcile, which settles a non-terminal row failed.
    const aborted = controller.signal.aborted
    if (!aborted && !budgetExpired) {
      // Best-effort: record the transport error into the log tail for the UI.
      await appendAgentRunLog(supabase, {
        agentRunId,
        workspaceId,
        text: `\n[stream error] ${err instanceof Error ? err.message : String(err)}\n`,
        ...(!stampedSandbox && markedSandboxId ? { sandboxId: markedSandboxId } : {}),
      }).catch(() => {})
    }
  }

  if (budgetTimer) clearTimeout(budgetTimer)

  // Watch budget spent with the run still going: flush the tail, settle nothing,
  // and hand back where to resume. (A cancel that landed in the same window wins.)
  if (budgetExpired && !canceled) {
    await flush(true).catch(() => {})
    if (!canceled) return { settled: null, sessionId, pending: { nextIndex: fromIndex + consumed } }
  }

  // ── Post-stream reconcile ───────────────────────────────────────────────────
  // Every path below ends the run. eve 0.67+ parks every session after its
  // turn, for the coding agent's 30-day session timeout, and a coding run has
  // no follow-up chat (those are work and loop runs, on other agents): retire
  // the session once the row is settled, so nothing is left parked.
  const retire = async (): Promise<void> => {
    if (sessionId) await retireTaskSession(client, sessionId, { reason: 'coding run over' })
  }
  // Cancel path: the row is 'canceling'/'canceled' → stop the eve session (the
  // agent must not keep running bash / git push after Stop), then settle
  // 'canceled' (idempotent; a late finish_run 409s against a canceling/canceled
  // row per the outcome route).
  if (canceled) {
    const sessionCancel = sessionId ? await cancelSessionVia(client, sessionId, agentRunId) : null
    const settled = await settleCanceled(supabase, { agentRunId, workspaceId })
    await retire()
    return { settled: settled ? 'canceled' : null, sessionId, sessionCancel }
  }

  // Normal completion: the eve agent's finish_run already wrote the terminal state
  // via the outcome route. Re-read the row; if it's STILL non-terminal, the agent
  // ended without reporting an outcome → settle 'failed' (mirrors the legacy
  // stuck-row protection). If it IS terminal, the outcome route owns it — no-op.
  const { data: finalRow } = await supabase
    .from('agent_run')
    .select('status')
    .eq('id', agentRunId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const finalStatus = (finalRow?.status as string | null) ?? null

  // A row that went 'canceling' after our loop ended but before this read — settle
  // canceled, not failed (respect the user's cancel).
  if (finalStatus === 'canceling') {
    const sessionCancel = sessionId ? await cancelSessionVia(client, sessionId, agentRunId) : null
    const settled = await settleCanceled(supabase, { agentRunId, workspaceId })
    await retire()
    return { settled: settled ? 'canceled' : null, sessionId, sessionCancel }
  }

  const terminal = ['pr_open', 'completed', 'failed', 'canceled']
  if (finalStatus && terminal.includes(finalStatus)) {
    // Outcome route (or a prior settle) already owns the terminal state.
    await retire()
    return { settled: null, sessionId }
  }

  const settled = await settleFailed(supabase, {
    agentRunId,
    workspaceId,
    error: 'agent ended without reporting an outcome',
  })
  await retire()
  return { settled: settled ? 'failed' : null, sessionId }
}
