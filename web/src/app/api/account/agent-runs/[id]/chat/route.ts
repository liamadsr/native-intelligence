import type { HandleMessageStreamEvent, MessageResponse } from 'eve/client'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requireUser } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError, apiError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/supabase/service'
import { mintAgentRunToken, internalSecret } from '@/lib/agent-run/agent-run-token'
import {
  GONE_SESSION_RESET_MS,
  dispatchChatTurn,
  extractSessionId,
  isBusyError,
  isRunSessionGoneError,
  makeWorkAgentClient,
  parseSessionState,
  persistAdvancedCursor,
  reopenedChatSessionOf,
  type RunChatPreviousSession,
  type RunSessionState,
} from '@/lib/agent-run/run-chat-dispatch'
import { reopenRunChatSession, type ReopenedRunChat } from '@/lib/agent-run/run-chat-reopen'
import {
  reduceStreamEvent,
  encodeRunChatEvent,
  type RunChatEvent,
} from '@/lib/agent-run/run-chat-events'
import { logWorkRunUsage } from '@/lib/agent-run/work-run-usage'
import { buildRunChatTurn, type BuiltRunChatTurn } from '@/lib/agent-run/run-chat-turn'
import { hasRunChatTurnExtras, parseRunChatTurnExtras, type RunChatTurnExtras } from '@/lib/agent-run/run-chat-turn-extras'

/**
 * POST + GET /api/account/agent-runs/[id]/chat — follow-up chat with a settled
 * work run's parked eve session (Loops v3 interactive work runs —
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md §Account API routes).
 *
 * A work run's eve session never completes: `finish_work` settles the
 * agent_run row via the internal outcome route, the turn ends, and the session
 * PARKS at `waiting` (every eve 0.67+ session does) until the agent's session
 * timeout, 30 days by default. That parked
 * session, with the run's full working context + tool ceiling, IS the follow-up
 * chat handle. This route is the browser's only door to it, and a strict trust
 * boundary: the browser NEVER holds a run token, the internal secret, or a raw
 * eve event.
 *
 * ── POST: send one follow-up turn (server-side proxy) ────────────────────────
 *  1. Auth: cookie user, member of the RUN's workspace, equal to `triggered_by`.
 *  2. Guards: terminal run (completed/failed), `session_state` present.
 *  3. Mint a FRESH run token (the original's 60-min TTL is irrelevant — mint per
 *     proxy call from the run row's ids) + the internal-secret headers, build an
 *     eve Client at the work-agent mount (ABSOLUTE origin — server-side fetch has
 *     no ambient origin), and re-attach the parked session
 *     (`client.sessions.attach(sessionId, { streamIndex })` — no I/O).
 *  4. Dispatch ONE turn: `send(message, opts)` for a plain follow-up, or
 *     `respond(inputResponses, opts)` when answering a park. The two are EXCLUSIVE
 *     in eve 0.31.0 and a respond carries no `message`, so accompanying text rides on
 *     each response's `text` plus `clientContext` (see `dispatchChatTurn`). A send
 *     uses `turnPolicy: 'queue'` (see `dispatchChatTurn` for why not eve's
 *     default `steer`).
 *  5. Stream the turn back as REDUCED NDJSON (text-delta / user-message / tool
 *     NAMES / question / done / error) — never raw eve events, never tool INPUTS.
 *  6. After the turn parks, best-effort persist the ADVANCED `streamIndex` (the
 *     read cursor the NEXT POST resumes streaming from) while preserving the
 *     frozen `settleStreamIndex` transcript boundary the GET replay uses. This is
 *     the only session_state write on this path — there is no send capability to
 *     stamp any more.
 *  7. A session eve says is GONE (isRunSessionGoneError: the 30-day session
 *     timeout's 409 `session_not_active`, a stranded session, or a stream whose
 *     history expired before any event) → the chat continues in a NEW session,
 *     registered on the run and led by a history primer (run-chat-reopen.ts),
 *     and this turn streams from it. Another send that reopened first, or a
 *     locked session (423), → `{type:'error', code:'BUSY'}`; every other
 *     failure (auth/mount/transport) → `{type:'error', code:'FAILED'}` with
 *     GENERIC copy (the raw eve body is logged server-side, never forwarded — the
 *     reduced vocabulary is a privacy fence). Since eve 0.57 a send into a
 *     RUNNING turn is accepted (steered or queued), never rejected, so BUSY no
 *     longer means "still finishing a turn".
 *  8. Stop (the browser aborts the request): the turn eve accepted is cancelled
 *     by id through the response's own `cancel()`, and the stream keeps being
 *     drained (nothing forwarded) so eve can name the turn and the read cursor
 *     still advances past it. Without this, eve 0.57+ would keep generating the
 *     stopped turn unobserved. The abort is NOT wired into the POST: an aborted
 *     POST eve had already accepted would leave no handle to cancel by.
 *
 * ── session_state contract (migration 200, shared across F1/W1) ──────────────
 *   { sessionId, streamIndex, settleStreamIndex?, previous? }
 *   - sessionId           — the durable eve session address (mirrors `sandbox_id`'s
 *                           `eve:` value). eve 0.31.0 removed continuation tokens;
 *                           the id plus the Client's auth headers IS the authority.
 *   - streamIndex         — the ADVANCING read cursor a follow-up POST resumes
 *                           streaming from (must move, else each turn replays the
 *                           previous one).
 *   - settleStreamIndex   — the FROZEN transcript boundary, stamped once at settle
 *                           (by W1's dispatcher). GET replay starts here so a
 *                           reloaded page reconstructs ALL follow-up turns; all
 *                           later persists PRESERVE it.
 *   - previous            — the chat's earlier sessions, once it reopened after
 *                           one expired (step 7): each one's id and replay start.
 *                           The GET replays them first; all later persists
 *                           PRESERVE it.
 *   LEGACY: a row still carrying `continuationToken` predates the eve upgrade and
 *   is NOT resumable — `parseSessionState` rejects it and the route answers 409
 *   NO_SESSION, the same response a run with no session at all gets.
 *
 * ── GET: transcript replay proxy ─────────────────────────────────────────────
 * Replay the session stream from `settleStreamIndex ?? streamIndex` (the boundary
 * captured at settle: only follow-up turns lie past it) through the SAME reducer,
 * so a reloaded page reconstructs all follow-up turns (including the user's own
 * messages, via the `user-message` reduced event). A parked session's durable
 * stream never closes on its own, so the replay aborts on an idle gap. A chat
 * that reopened replays its earlier sessions first (bounded reads), and a
 * session whose history eve no longer holds shows nothing rather than an error:
 * Open still works, and the next send reopens the chat.
 */

/** Max follow-up message length; beyond this the POST is a 400 (input cap). */
const MAX_MESSAGE_LENGTH = 4000
/** Max inputResponses entries on a single follow-up send (input cap). */
const MAX_INPUT_RESPONSES = 8

/** Terminal statuses a run must be in before follow-up chat is allowed. */
const CHATTABLE_STATUSES = ['completed', 'failed'] as const

/** GET replay: a parked session's durable stream never closes on its own, so the
 *  replay ends after this long with no new event (history arrives in a burst). */
const REPLAY_IDLE_CLOSE_MS = 1500
/** GET replay: one of a reopened chat's earlier sessions, read for at most this long. */
const REPLAY_EARLIER_SESSION_MS = 5000

/** The run context both handlers load (auth + resume facts). */
interface RunChatContext {
  workspaceId: string
  triggeredBy: string
  status: string
  kind: string
  sessionId: string
  sessionState: RunSessionState
}

// ── Shared auth + load ────────────────────────────────────────────────────────

type LoadResult =
  | { ok: true; ctx: RunChatContext; supabase: SupabaseClient; userId: string }
  | { ok: false; response: Response }

/**
 * Resolve the cookie user, load the run, enforce tenancy (member of the run's
 * workspace + equal to triggered_by), and the chat guards (terminal run,
 * session_state present, an eve session id on sandbox_id). Shared by POST + GET.
 */
async function loadRunChatContext(id: string): Promise<LoadResult> {
  const auth = await requireUser()
  if (auth instanceof Response) return { ok: false, response: auth }
  const { supabase, user } = auth

  const { data: run, error } = await supabase
    .from('agent_run')
    .select('id, kind, status, workspace_id, triggered_by, sandbox_id, session_state')
    .eq('id', id)
    .maybeSingle()
  if (error) return { ok: false, response: serverError(error.message) }
  if (!run) return { ok: false, response: notFound('Agent run not found') }

  const workspaceId = run.workspace_id as string

  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!member) {
    return { ok: false, response: forbidden('Not a member of this run’s workspace') }
  }
  if (run.triggered_by !== user.id) {
    return {
      ok: false,
      response: forbidden('Only the person who started this run can chat with it'),
    }
  }

  if (run.kind !== 'workspace') {
    return {
      ok: false,
      response: apiError('Only workspace runs support follow-up chat', {
        status: 400,
        code: 'INVALID_KIND',
      }),
    }
  }
  if (!CHATTABLE_STATUSES.includes(run.status as (typeof CHATTABLE_STATUSES)[number])) {
    return {
      ok: false,
      response: apiError('This run is not settled yet', {
        status: 409,
        code: 'NOT_TERMINAL',
      }),
    }
  }

  const sessionId = extractSessionId(run.sandbox_id as string | null)
  if (!sessionId) {
    return {
      ok: false,
      response: apiError('This run has no eve session handle', {
        status: 409,
        code: 'NO_SESSION',
      }),
    }
  }

  // A pre-eve-0.31 row (one carrying a continuationToken) parses to null: that
  // capability no longer exists and the session cannot be re-addressed, so the run
  // degrades into the SAME 409 NO_SESSION the UI already handles as "this run has
  // no chat to continue". No data migration is performed.
  const sessionState = parseSessionState(run.session_state, sessionId)
  if (!sessionState) {
    return {
      ok: false,
      response: apiError('This run has no chat session to continue', {
        status: 409,
        code: 'NO_SESSION',
      }),
    }
  }

  return {
    ok: true,
    supabase,
    userId: user.id,
    ctx: {
      workspaceId,
      triggeredBy: run.triggered_by as string,
      status: run.status as string,
      kind: run.kind as string,
      sessionId,
      sessionState,
    },
  }
}

// ── POST: one follow-up turn ──────────────────────────────────────────────────

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const secret = internalSecret()
  if (!secret) {
    return serverError('Follow-up chat is not configured (missing internal secret)')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const parsed = parseChatBody(body)
  if ('error' in parsed) return badRequest(parsed.error)

  const loaded = await loadRunChatContext(id)
  if (!loaded.ok) return loaded.response
  const { ctx } = loaded

  // What the full composer added (bots v4: a skill, files, mentions),
  // checked and built here: a skill the caller can't use, a file that isn't
  // their own upload, or a photo (no file part ever reaches the work-agent:
  // run-chat-turn.ts) is a 400 before anything is sent. Not on an answer to a
  // park (the picker's answers carry none).
  let turn: BuiltRunChatTurn | null = null
  if (!parsed.inputResponses?.length && hasRunChatTurnExtras(parsed.extras)) {
    const built = await buildRunChatTurn({
      supabase: loaded.supabase,
      service: getServiceClient(),
      userId: loaded.userId,
      workspaceId: ctx.workspaceId,
      message: parsed.message ?? '',
      extras: parsed.extras,
      // A work run's tools never read the person's private captures, so the
      // mentions don't hand their content over either.
      privateCaptures: false,
    })
    if ('error' in built) return apiError(built.error, { status: built.status, code: built.code })
    turn = built
  }

  // Mint a FRESH run token per proxy call (never persist / reuse a token) and
  // build the eve Client at the work-agent mount, authenticated exactly like the
  // dispatcher (bearer = internal secret + the x-agent-run-* headers).
  // `chat: true` (bots v3 Phase 5): the work-agent re-resolves its workspace
  // tools on this turn from THIS token, so they work however long after the run
  // the follow-up comes (the run's own token, which its session-start tools
  // captured, expires 60 minutes after it was minted). A picked skill (bots v4)
  // rides it too: this turn's tools add the skill's, within the bot's attended
  // chat ceiling (ceilingForWorkRunTurn), on the spec and the tool route alike.
  const runToken = mintAgentRunToken({
    agentRunId: id,
    workspaceId: ctx.workspaceId,
    userId: ctx.triggeredBy,
    chat: true,
    ...(turn?.skill ? { skillId: turn.skill.id } : {}),
  })
  const client = makeWorkAgentClient({
    secret,
    runToken,
    workspaceId: ctx.workspaceId,
    userId: ctx.triggeredBy,
  })

  // `attach()` performs NO I/O — it pins the handle to the durable session id and
  // seeds the read cursor so this turn's stream starts past the last park. Both
  // change when eve says that session is gone and the chat reopens (step 7).
  let session = client.sessions.attach(ctx.sessionId, {
    streamIndex: ctx.sessionState.streamIndex,
  })
  let sessionState = ctx.sessionState

  const encoder = new TextEncoder()
  const abortSignal = request.signal
  // Stopped before anything was sent: send nothing (there is nothing to cancel).
  if (abortSignal.aborted) return new Response(null, { status: 499 })

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: RunChatEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeRunChatEvent(event)))
        } catch {
          /* stream already closed */
        }
      }

      let sent = false
      let terminalEmitted = false
      const enqueueTracked = (event: RunChatEvent) => {
        if (event.type === 'done' || event.type === 'error') terminalEmitted = true
        enqueue(event)
      }
      // Stop → cancel exactly the turn this POST started (see step 8 above).
      let stopped = false
      let response: MessageResponse | null = null
      // The turn's raw events, for its usage rows only (never forwarded).
      const turnEvents: HandleMessageStreamEvent[] = []
      const onStop = () => {
        stopped = true
        if (response) requestTurnCancel(id, response)
      }
      abortSignal.addEventListener('abort', onStop, { once: true })
      // Step 7: the chat continues in a new session led by its history
      // (run-chat-reopen.ts), at most once per turn. Null when it can't: the
      // caller rethrows the original failure, reported by `reopenRefused` (BUSY
      // when another send's new session won, else FAILED).
      let reopened = false
      const reopenRefused: { reason: Extract<ReopenedRunChat, { ok: false }>['reason'] | null } = { reason: null }
      const reopen = async (): Promise<MessageResponse | null> => {
        reopened = true
        const result = await reopenRunChatSession({
          client,
          service: getServiceClient(),
          agentRunId: id,
          workspaceId: ctx.workspaceId,
          gone: sessionState,
          input: parsed,
          turn,
          signal: abortSignal,
        })
        if (!result.ok) {
          console.warn(`[agent-run/chat] run ${id}: the session is gone and the chat could not reopen (${result.reason})`)
          reopenRefused.reason = result.reason
          return null
        }
        session = result.session
        sessionState = result.state
        return result.response
      }
      try {
        // eve 0.31.0 made the two turn shapes EXCLUSIVE and positional: a turn
        // carrying inputResponses goes through respond(), which carries no
        // `message` field at all. So the answer text (when both are
        // supplied) travels on the InputResponse's own `text` — durable, echoed
        // back on `input.resolved` — plus `clientContext`, one-turn user-role
        // model context that guarantees the model reads it on THIS turn. A second
        // send() would cost a second turn.
        try {
          response = await dispatchChatTurn(session, parsed, turn)
        } catch (err) {
          // The 30-day session timeout (eve 0.79's 409 session_not_active), a
          // stranded session: this session never takes a turn again. Not after
          // Stop: no new session just to cancel its first turn.
          if (stopped || !isRunSessionGoneError(err)) throw err
          logSessionGone(id, err)
          const next = await reopen()
          if (!next) throw err
          response = next
        }
        sent = true
        if (stopped) requestTurnCancel(id, response)

        // Nothing to persist up front any more: eve 0.31.0 removed continuation
        // tokens, so the only mutable part of the cursor is `streamIndex`, which
        // is only meaningful once the stream has drained to its boundary (handled
        // by persistAdvancedCursor below). A mid-turn abort can no longer lose a
        // send capability, because there is none.

        for (;;) {
          let sawEvent = false
          try {
            for await (const ev of response) {
              sawEvent = true
              turnEvents.push(ev)
              // After Stop keep draining to the boundary (eve's cancel identifies
              // the turn from this stream; the cursor advances past it) but forward
              // nothing — the browser has gone.
              if (stopped) continue
              for (const reduced of reduceStreamEvent(ev)) {
                enqueueTracked(reduced)
              }
            }
            break
          } catch (err) {
            // eve 0.79: a session whose stream history passed the World's
            // retention may take the POST, then answer its stream with 410
            // session_expired. Before any event, the turn goes to a new session
            // instead (eve-chat-transport.ts re-primes a chat the same way), and
            // whatever the POST started there is stopped first (its output is
            // unreadable), so the words never run in both.
            if (sawEvent || reopened || stopped || !isRunSessionGoneError(err)) throw err
            logSessionGone(id, err)
            try {
              await session.reset({ reason: 'stream history expired; the chat reopened in a new session', signal: AbortSignal.timeout(GONE_SESSION_RESET_MS) })
            } catch {
              /* best-effort: eve answers a reset of an inactive session no_active_session */
            }
            const next = await reopen()
            if (!next) throw err
            response = next
            // Stop while the chat reopened: cancel the turn it just started.
            if (stopped) requestTurnCancel(id, response)
          }
        }
      } catch (err) {
        // A turn against a locked session (423), or one another send reopened
        // first, surfaces BUSY. A send into a RUNNING turn is not one of these
        // since eve 0.57: it is accepted (queued, see dispatchChatTurn).
        // EVERYTHING else (auth/mount/transport failure, the relative-URL
        // TypeError, a JSON parse error) is a hard FAILED. Never forward the raw
        // eve body: it can embed internal paths / stack frames / deployment ids
        // — log it server-side, hand the browser generic copy (privacy fence).
        logChatError(id, sent, err)
        enqueueTracked(
          reopenRefused.reason === 'lost_race' ? BUSY_EVENT : reopenRefused.reason ? FAILED_EVENT : reduceChatError(err, sent),
        )
      } finally {
        abortSignal.removeEventListener('abort', onStop)
      }

      // BELT: eve can end a turn WITHOUT any event our reducer maps to a
      // terminal — e.g. a model-call failure makes the harness "park the
      // session for retry by the user" with no turn.completed/failed on the
      // stream. The send stream ending IS the turn boundary, so guarantee the
      // browser a terminal event or the UI would show "Thinking…" forever.
      if (!terminalEmitted) enqueue({ type: 'done' })

      // What the follow-up turn spent, one usage row per model step, billed to
      // the run's user like the dispatch (work-run-usage.ts). Never throws.
      await logWorkRunUsage(getServiceClient(), {
        agentRunId: id,
        workspaceId: ctx.workspaceId,
        events: turnEvents,
        source: 'chat',
        // A reopened chat's session numbers its turns from turn_0 again.
        sessionId: reopenedChatSessionOf(sessionState),
      })

      // The turn has parked (or errored). Best-effort persist the ADVANCED read
      // cursor (streamIndex) so the NEXT POST resumes streaming PAST this turn's
      // boundary instead of replaying it. The token was already persisted the
      // instant send() resolved; here we only advance streamIndex, preserving the
      // frozen settleStreamIndex transcript boundary the GET replay uses. Pass the
      // prior cursor so a send that never advanced (BUSY / immediate error) writes
      // nothing redundant.
      try {
        await persistAdvancedCursor(id, ctx.workspaceId, session, sessionState)
      } catch {
        /* best-effort: a failed persist doesn't break the visible turn */
      }

      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

// ── GET: transcript replay ────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params

  const secret = internalSecret()
  if (!secret) {
    return serverError('Follow-up chat is not configured (missing internal secret)')
  }

  const loaded = await loadRunChatContext(id)
  if (!loaded.ok) return loaded.response
  const { ctx } = loaded

  const runToken = mintAgentRunToken({
    agentRunId: id,
    workspaceId: ctx.workspaceId,
    userId: ctx.triggeredBy,
  })
  const client = makeWorkAgentClient({
    secret,
    runToken,
    workspaceId: ctx.workspaceId,
    userId: ctx.triggeredBy,
  })

  const session = client.sessions.attach(ctx.sessionId, {
    streamIndex: ctx.sessionState.streamIndex,
  })

  // Replay from the FROZEN settle boundary (all follow-up turns lie past it), not
  // the advancing POST cursor — otherwise a reload after a follow-up turn would
  // miss the earlier turns.
  const replayStartIndex = ctx.sessionState.settleStreamIndex ?? ctx.sessionState.streamIndex

  const encoder = new TextEncoder()

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (event: RunChatEvent) => {
        try {
          controller.enqueue(encoder.encode(encodeRunChatEvent(event)))
        } catch {
          /* stream already closed */
        }
      }
      // A chat that reopened after its session expired: its earlier sessions'
      // turns first, oldest session first.
      for (const earlier of ctx.sessionState.previous ?? []) {
        await replayEarlierSession(id, client, earlier, enqueue)
      }
      // A parked session's durable stream never closes on its own — it holds open
      // at `waiting` for future events. History arrives in a burst, so we close on
      // an idle gap. The idle break must ABORT the underlying fetch (eve's
      // stream() accepts a signal): a bare `events.return()` while a `next()` is
      // blocked on a never-resolving read deadlocks (return queues behind the
      // pending next()), so the response would never terminate.
      const ac = new AbortController()
      try {
        const events = session
          .stream({ startIndex: replayStartIndex, signal: ac.signal })
          [Symbol.asyncIterator]()
        for (;;) {
          let idleTimer: ReturnType<typeof setTimeout> | undefined
          const next = await Promise.race([
            events.next(),
            new Promise<'idle'>((resolve) => {
              idleTimer = setTimeout(() => resolve('idle'), REPLAY_IDLE_CLOSE_MS)
            }),
          ])
          clearTimeout(idleTimer)
          if (next === 'idle') {
            // Abort the underlying read so the generator unwinds (its finally
            // runs) instead of hanging; return() now resolves because next()
            // settles via the abort.
            ac.abort()
            void events.return?.(undefined)?.catch(() => {})
            break
          }
          if (next.done) break
          for (const reduced of reduceStreamEvent(next.value)) {
            enqueue(reduced)
          }
        }
      } catch (err) {
        // AbortError from our own idle-abort is expected — don't surface it. Nor
        // a session whose history eve no longer holds: the chat opens without
        // it, and the next send reopens it in a new session (POST step 7).
        if (!ac.signal.aborted && !isRunSessionGoneError(err)) {
          logChatError(id, true, err)
          enqueue(reduceChatError(err, true))
        }
      }

      try {
        controller.close()
      } catch {
        /* already closed */
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Stop → cooperative cancel of the turn THIS POST's response carries, by id
 * (eve's MessageResponse.cancel() waits for the response stream to name its
 * turn, and resolves `no_active_turn` if the turn ended first). Idempotent and
 * fire-and-forget: a failed cancel is logged, never surfaced.
 */
function requestTurnCancel(agentRunId: string, response: MessageResponse): void {
  void response.cancel().catch((err: unknown) => {
    console.warn(
      `[agent-run/chat] Stop: turn cancel failed for run ${agentRunId}:`,
      err instanceof Error ? err.message : String(err),
    )
  })
}

/**
 * Classify a send/stream failure into a reduced `error` event WITHOUT leaking the
 * raw eve body. Only a genuine busy/conflict `ClientError` (HTTP 409/423 — a send
 * against a non-waiting session, or a gone one the chat couldn't reopen because
 * another send reopened it first) is BUSY, which the UI softens to a retry notice;
 * every other failure (auth 401/403, missing mount 404, 5xx, the relative-URL
 * TypeError, a JSON parse error) is a hard FAILED. The message is fixed GENERIC
 * copy — the raw body (internal paths, stack frames, deployment ids) is logged
 * server-side, never forwarded (the reduced vocabulary is a privacy fence).
 */
function reduceChatError(err: unknown, sent: boolean): RunChatEvent {
  return !sent && isBusyError(err) ? BUSY_EVENT : FAILED_EVENT
}

const BUSY_EVENT: RunChatEvent = { type: 'error', message: 'The agent could not be reached', code: 'BUSY' }
const FAILED_EVENT: RunChatEvent = { type: 'error', message: 'The turn failed', code: 'FAILED' }

/**
 * Replay one of a reopened chat's earlier sessions: a bounded catch-up read
 * (`follow: false`, it ends at the session's tail) from where its follow-up
 * turns start, through the same reducer, within REPLAY_EARLIER_SESSION_MS. A
 * session whose history eve no longer holds shows nothing; any other failure
 * is logged and skipped, never the whole replay's error.
 */
async function replayEarlierSession(
  agentRunId: string,
  client: ReturnType<typeof makeWorkAgentClient>,
  earlier: RunChatPreviousSession,
  enqueue: (event: RunChatEvent) => void,
): Promise<void> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), REPLAY_EARLIER_SESSION_MS)
  try {
    const session = client.sessions.attach(earlier.sessionId, { streamIndex: earlier.startIndex })
    for await (const ev of session.stream({
      startIndex: earlier.startIndex,
      follow: false,
      signal: ac.signal,
      streamReconnectPolicy: { reconnect: false },
    })) {
      for (const reduced of reduceStreamEvent(ev)) enqueue(reduced)
    }
  } catch (err) {
    if (!ac.signal.aborted && !isRunSessionGoneError(err)) logChatError(agentRunId, true, err)
  } finally {
    clearTimeout(timer)
  }
}

/** Log, with the run id, that eve said the run's session is gone (status and code only, never the body). */
function logSessionGone(agentRunId: string, err: unknown): void {
  const { status, code } = err as { status?: unknown; code?: unknown }
  console.warn(`[agent-run/chat] run ${agentRunId}: the session is gone (${String(status)}${typeof code === 'string' ? ` ${code}` : ''}); reopening the chat`)
}

/** Log the raw failure server-side (with the run id) so a genuine mount/auth/eve
 *  error is diagnosable even though the browser only sees generic copy. */
function logChatError(agentRunId: string, sent: boolean, err: unknown): void {
  console.error(
    `[agent-run/chat] ${sent ? 'stream' : 'send'} failed for run ${agentRunId}:`,
    err instanceof Error ? `${err.name}: ${err.message}` : String(err),
  )
}

/**
 * Parse the POST body: { message } (+ optional { inputResponses }), and what
 * the full composer added (bots v4: skillId, files, mentions;
 * parseRunChatTurnExtras).
 */
function parseChatBody(
  body: unknown,
):
  | { message?: string; inputResponses?: { requestId: string; optionId?: string; text?: string }[]; extras: RunChatTurnExtras }
  | { error: string } {
  if (!body || typeof body !== 'object') return { error: 'Body must be an object' }
  const b = body as Record<string, unknown>
  const extras = parseRunChatTurnExtras(b)
  if ('error' in extras) return extras

  const message = typeof b.message === 'string' ? b.message.trim() : ''
  if (message.length > MAX_MESSAGE_LENGTH) {
    return { error: `Message must be ${MAX_MESSAGE_LENGTH} characters or fewer` }
  }
  const rawResponses = Array.isArray(b.inputResponses) ? b.inputResponses : null
  if (rawResponses && rawResponses.length > MAX_INPUT_RESPONSES) {
    return { error: `inputResponses may have at most ${MAX_INPUT_RESPONSES} entries` }
  }

  const inputResponses: { requestId: string; optionId?: string; text?: string }[] = []
  if (rawResponses) {
    for (const raw of rawResponses) {
      if (!raw || typeof raw !== 'object') continue
      const r = raw as Record<string, unknown>
      if (typeof r.requestId !== 'string' || !r.requestId) continue
      inputResponses.push({
        requestId: r.requestId,
        ...(typeof r.optionId === 'string' ? { optionId: r.optionId } : {}),
        ...(typeof r.text === 'string' ? { text: r.text } : {}),
      })
    }
  }

  // Require at least a message OR an input response — an empty send is a no-op.
  if (!message && inputResponses.length === 0) {
    return { error: 'Body must include a non-empty message or inputResponses' }
  }
  return {
    ...(message ? { message } : {}),
    ...(inputResponses.length ? { inputResponses } : {}),
    extras,
  }
}
