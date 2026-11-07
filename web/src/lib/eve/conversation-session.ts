/**
 * createConversationSession / resumeConversationSession — start and resume an eve
 * session for a work run's interactive lifecycle (Loops v3 Phase 3;
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md).
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS (and why it is NOT task-session.ts)
 *
 * eve 0.67 removed run modes: every session parks after each turn at
 * `session.waiting`, durably, until the agent's session timeout (30 days by
 * default), and eve holds a turn open at `turn.waiting` on a question (0.69+)
 * or an approval (0.70+).
 * Two callers read that differently:
 *
 *   • task-session.ts — an UNATTENDED one-shot (skill-runner, coding-agent,
 *     onboarding, utility): one turn read to its boundary, a held turn is a
 *     failure, and the session is retired afterwards.
 *
 *   • this file — an INTERACTIVE work run: the run can ask the user a question
 *     mid-run and park until they answer, and after `finish_work` settles the
 *     run the session stays parked as the follow-up-chat handle (§three
 *     framework facts). The typed `client.sessions.create()` is enough here.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * eve 0.31.0 API (as shipped in 0.47.7): CONTINUATION TOKENS ARE GONE
 *
 * `client.session(...)` no longer exists. The surface is now:
 *   • `client.sessions.create(input)` → `{ session, response }` — one POST to
 *     `/eve/v1/session`, returning the fixed handle AND the first turn's response.
 *   • `client.sessions.attach(sessionId, { streamIndex })` → a handle pinned to a
 *     known session id, performing NO I/O. This is the resume path.
 *
 * The durable resume snapshot is therefore just `ClientSessionState`:
 *     { sessionId, streamIndex }
 * There is no send capability to persist any more — the session ID *is* the
 * address, and auth is carried entirely by the Client's header cascade. The
 * create route now actively REJECTS a `continuationToken` in its body.
 *
 * SEND vs RESPOND are now EXCLUSIVE (0.31.0):
 *   `send(message, options)` and `respond(inputResponses, options)` are separate
 *   positional calls, and a `respond()` carries NO `message` — the client never
 *   emits that key, and eve's channel route rejects the pair outright with HTTP 400
 *   ("'message' and 'inputResponses' are mutually exclusive"). The old "answers ride
 *   as `message` alongside `inputResponses` in one send" choreography can no longer
 *   work.
 *
 *   The replacement, applied by {@link resumeConversationSession}: the answer text
 *   rides on the InputResponse's own `text` field (durable, part of the wire
 *   schema, echoed back on `input.resolved`) AND as `clientContext` on the respond
 *   (one-turn user-role model context, guaranteed to reach the next model call).
 *   Together those give the model the same information the old follow-up message
 *   carried, in a single turn — a second `send()` would dispatch a SECOND turn.
 *
 * CRITICAL — why the response stream and NOT `session.stream()`:
 * The response returned by send/respond/create BREAKS at the turn boundary
 * (session.waiting/completed/failed, or a `turn.waiting` on a person) and advances
 * `session.state.streamIndex` in its finally. The raw `session.stream()` (a
 * read-only replay) does NOT break at a boundary — it keeps the durable NDJSON
 * stream open across a park, so a `for await` over it would HANG at
 * `session.waiting` instead of returning. Every session parks after its turn
 * (eve 0.67+), so we MUST use the boundary-aware response stream (task-session.ts
 * cuts its stream at the same boundary itself). `session.state` after the drain carries
 * the advanced `{ sessionId, streamIndex }` — the resume snapshot.
 * ───────────────────────────────────────────────────────────────────────────
 */
import { MessageResponse } from 'eve/client'
import type { Client, ClientSession, ClientSessionState, MessageStreamEvent } from 'eve/client'
import { createTurnBoundary } from './turn-boundary'

/** The eve create-session route (POST), relative to the client's mount. */
const EVE_CREATE_SESSION_PATH = '/eve/v1/session'
/** Response header eve stamps with the session id (belt-and-braces vs. the JSON body). */
const EVE_SESSION_ID_HEADER = 'x-eve-session-id'

/**
 * The durable resume snapshot for a conversation session. Identical in shape to
 * eve's own {@link ClientSessionState} — `{ sessionId, streamIndex }` — because
 * that is now the whole of a resumable cursor.
 */
export type ConversationSnapshot = ClientSessionState

/**
 * One answer to one pending input request. Mirrors eve's `InputResponse` wire
 * schema (`{ requestId, optionId?, text? }`), restated locally so callers don't
 * need the eve type import.
 */
export interface ConversationInputResponse {
  requestId: string
  optionId?: string
  text?: string
}

/**
 * What a conversation-mode create yields: the durable session id, the live
 * {@link ClientSession} handle (its `.state` is the resume snapshot after the
 * turn drains), and the {@link MessageResponse} over the FIRST turn's stream.
 * Iterate `response` to drive the turn; read `session.state` after it drains.
 */
export interface ConversationSessionHandle {
  sessionId: string
  session: ClientSession
  response: MessageResponse
}

/**
 * Create a durable eve session against the client's mount
 * and return a handle over its first turn's stream.
 *
 * @param client   an eve `Client` already pointed at the work-agent mount, with
 *                  the run's internal-secret + run-token headers baked in (the
 *                  create reuses the client's auth/header cascade).
 * @param opts.message  the first user message (the JSON work brief).
 * @param opts.signal   optional abort signal covering the create POST + the whole
 *                        first-turn stream (arm before calling).
 * @param opts.operationId  CREATE-ONCE key (see {@link createConversationSessionOnce}).
 *                        When set, a retried create for the same operation returns
 *                        the session the first create started instead of a second one.
 *
 * @throws if the create POST fails or returns no session id.
 */
export async function createConversationSession(
  client: Client,
  opts: { message: string; signal?: AbortSignal; operationId?: string },
): Promise<ConversationSessionHandle> {
  const { message, signal, operationId } = opts
  if (operationId !== undefined) {
    return createConversationSessionOnce(client, { message, operationId, ...(signal ? { signal } : {}) })
  }

  // `sessions.create()` performs the create POST and hands back BOTH the fixed
  // handle and the first turn's boundary-aware response in one call. It cannot
  // carry `mode`, so the session is conversation-mode (the server default) —
  // which parks at session.waiting instead of failing closed.
  const { session, response } = await client.sessions.create({
    message,
    ...(signal ? { signal } : {}),
  })

  const sessionId = response.sessionId
  if (!sessionId) throw new Error('eve conversation-session create returned no sessionId')

  return { sessionId, session, response }
}

/**
 * CREATE-ONCE: create a conversation-mode session keyed on a caller-owned
 * `operationId`, so a retried create adopts the session the first one started.
 *
 * WHY. eve mints the session id on the SERVER: both the typed create and the
 * message-less prewarm read `sessionId` off the create POST's response
 * (eve/client session.js `readAcceptedMessage`). There is no id to persist
 * before the create. So a process that dies between the create and the row
 * stamp leaves a running session nobody knows about, and a retry that creates
 * again starts a SECOND agent on the same task. eve's own answer (0.66.3,
 * docs/channels/eve.mdx "create-once"; CHANGELOG d8cef1a) is `operationId` on
 * the create body: "Once the operation owner is active, the same operation
 * under the same authenticated principal returns that session instead of
 * dispatching the input again." The key is derived from (authenticator,
 * principal, operationId), so the caller must present the same principal on
 * the retry — the work-agent's principal is the run's user, which is stable.
 *
 * Two limits eve documents, stated here so no caller assumes more:
 *   - SIMULTANEOUS creates can receive different accepted candidate ids; only
 *     the one that claims the operation runs its first turn. This covers a
 *     SEQUENTIAL retry (a crash, then Inngest's backoff), not two concurrent
 *     dispatches of one run — those are prevented upstream (the dispatch event
 *     carries a per-run id, start-work-item.ts).
 *   - Ownership expires when the session is no longer resumable. A work run's
 *     session parks until the agent's session timeout (30 days by default), so
 *     it outlives every retry.
 *
 * The typed `sessions.create()` cannot carry `operationId` (its body builder
 * forwards message / inputResponses / turnPolicy / clientContext /
 * outputSchema only), so this POSTs over the client's authenticated raw fetch —
 * the pattern task-session.ts uses for its create — then attaches at index 0
 * and presents the first turn through a {@link MessageResponse} whose stream
 * stops at the turn boundary exactly as the typed create's does. Index 0 is right
 * for an adopted session too: it is the same first turn, from its first event.
 */
export async function createConversationSessionOnce(
  client: Client,
  opts: { message: string; operationId: string; signal?: AbortSignal },
): Promise<ConversationSessionHandle> {
  const { message, operationId, signal } = opts
  if (!operationId) throw new Error('createConversationSessionOnce requires a non-empty operationId')

  const res = await client.fetch(EVE_CREATE_SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message, operationId }),
    ...(signal ? { signal } : {}),
  })
  if (!res.ok) throw new Error(`eve conversation-session create failed (${res.status})`)
  const body = (await res.json().catch(() => ({}))) as { sessionId?: unknown }
  const sessionId =
    (typeof body.sessionId === 'string' ? body.sessionId.trim() : '') ||
    res.headers.get(EVE_SESSION_ID_HEADER)?.trim() ||
    ''
  if (!sessionId) throw new Error('eve conversation-session create returned no sessionId')

  // attach() performs no I/O; stream() advances session.state as it reads, so
  // after the first turn drains, session.state is the resume snapshot.
  const session = client.sessions.attach(sessionId, { streamIndex: 0 })
  // MessageResponse's constructor is marked @internal but it is the only way to
  // present an attached stream under the surface the typed create returns (the
  // same construction task-session.ts uses).
  const response = new MessageResponse({
    sessionId,
    cancelTurn: (turnId: string) => session.cancel({ turnId }),
    createStream: () => untilTurnBoundary(session.stream(signal ? { signal } : {})),
  })
  return { sessionId, session, response }
}

/**
 * Yield an attached durable stream's events up to and including the current
 * turn's boundary, then stop. The raw `session.stream()` stays open across a
 * park (`session.waiting`), so without this a drain of a conversation session
 * would hang. The rule is eve's own (./turn-boundary.ts): a boundary event
 * ends the turn, including a `turn.waiting` on a person (eve holds the turn
 * open on a question since 0.69, on an approval or sign-in since 0.70), except
 * while a webhook
 * authorization is still pending.
 */
export async function* untilTurnBoundary(
  source: AsyncIterable<MessageStreamEvent>,
): AsyncGenerator<MessageStreamEvent> {
  const endsTurn = createTurnBoundary()
  for await (const ev of source) {
    const boundary = endsTurn(ev)
    yield ev
    if (boundary) return
  }
}

/**
 * Resume a parked conversation session from a FRESH process (a work-run resume or
 * a follow-up-chat turn). Re-attaches the handle from the persisted snapshot and
 * sends ONE turn.
 *
 * Two mutually exclusive turn shapes, matching eve 0.31.0's split:
 *
 *   • `{ inputResponses, message? }` — answering a `request_user_input` park.
 *     Dispatched via `respond(inputResponses, options)`, which carries no `message`
 *     (and eve rejects the pair with a 400), so the `message` text is
 *     instead folded into the responses' `text` field (when a response doesn't
 *     already carry its own) and passed as `clientContext` so the model actually
 *     reads it on this turn. This preserves the pre-0.31 "answers ride along with
 *     the approval" behavior without spending a second turn.
 *
 *   • `{ message }` — a plain follow-up chat turn. Dispatched via
 *     `send(message, options)`.
 *
 * @param client   an eve `Client` at the work-agent mount with FRESH run-token +
 *                  secret headers (mint per dispatch).
 * @param args.snapshot  the persisted `{ sessionId, streamIndex }` cursor. Only
 *                  `streamIndex` is read here; `sessionId` is passed separately so
 *                  the caller's authoritative id (from `sandbox_id`) always wins.
 * @param args.sessionId the durable eve session id (from `sandbox_id`'s `eve:<id>`).
 * @param args.payload  `{ message?, inputResponses? }` for this turn.
 * @param args.signal   optional abort signal for the turn + stream.
 *
 * @returns the live session handle + the MessageResponse over the resumed turn.
 * @throws if neither a message nor any inputResponses were supplied, or if the
 *          turn POST fails (a parked-session mismatch surfaces as a 409
 *          `session_not_active` ClientError — see {@link isSessionNotActiveError}).
 */
export async function resumeConversationSession(
  client: Client,
  args: {
    sessionId: string
    snapshot: ConversationSnapshot
    payload: {
      message?: string
      inputResponses?: ReadonlyArray<ConversationInputResponse>
    }
    signal?: AbortSignal
  },
): Promise<{ session: ClientSession; response: MessageResponse }> {
  const { sessionId, snapshot, payload, signal } = args

  // Re-attach the fixed handle from the persisted cursor. `attach()` performs NO
  // I/O — it just pins the id and seeds the read cursor so the resumed turn's
  // stream picks up where the last park left off.
  const session = client.sessions.attach(sessionId, {
    streamIndex: snapshot.streamIndex,
  })

  const options = signal ? { signal } : {}

  const inputResponses = payload.inputResponses
  if (inputResponses && inputResponses.length > 0) {
    // Answering a park. A respond carries no `message` at all (and eve rejects the
    // pair with a 400 — see below), so the text has to travel by the two channels a
    // respond DOES carry:
    //
    //   • the response's own `text` — durable, but ONLY for a `question`-kind
    //     request (buildQuestionToolResponsePart reads it). For a `tool-approval`
    //     request it is DISCARDED: buildApprovalToolResponseParts
    //     (dist/src/harness/hitl/approval-input-requests.js) emits only
    //     `{approvalId, approved, reason}`, and `reason` comes from
    //     resolveApprovalOutcome's fixed constants, never from the response.
    //   • `clientContext` — one-turn model context for exactly this turn, and
    //     NEVER persisted to durable session history (docs/guides/client/messages).
    //
    // KNOWN GAP: for an approval park that makes clientContext the sole carrier,
    // so the answer text reaches the model on this turn but is absent from history
    // on a later compaction or follow-up turn. Sending it as `message` alongside
    // inputResponses is not an option — eve answers that combination with a 400.
    const text = payload.message
    const responses = inputResponses.map((r) => ({
      requestId: r.requestId,
      ...(r.optionId !== undefined ? { optionId: r.optionId } : {}),
      // Never clobber a response that already carries its own freeform text.
      ...(r.text !== undefined ? { text: r.text } : text ? { text } : {}),
    }))
    const response = await session.respond(responses, {
      ...options,
      ...(text ? { clientContext: text } : {}),
    })
    return { session, response }
  }

  if (payload.message === undefined) {
    throw new Error('eve conversation-session resume requires a message or inputResponses')
  }

  const response = await session.send(payload.message, options)
  return { session, response }
}

/**
 * Read the advanced cursor off a session AFTER its current turn's stream has
 * fully drained to the eve turn boundary (session.waiting / completed / failed).
 * `ClientSession.state` is only advanced once the response generator's finally
 * block runs at the boundary, so this MUST be called after the `for await` loop
 * over the response has ended.
 *
 * Returns null when the session has no id yet (never dispatched) — a caller then
 * has no resume handle to persist, which is the correct "no follow-up chat
 * available" signal. Post-0.31 there is no continuation token to gate on, so a
 * session that reached the server always yields a snapshot.
 */
export function readSessionSnapshot(session: ClientSession): ConversationSnapshot | null {
  const state = session.state
  const sessionId = state?.sessionId
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null
  const streamIndex = typeof state.streamIndex === 'number' ? state.streamIndex : 0
  return { sessionId, streamIndex }
}

/**
 * Parse a persisted `session_state` blob into a live resume snapshot.
 *
 * LEGACY DATA POLICY (eve 0.31.0 upgrade): rows written before the upgrade carry
 * `{ continuationToken, streamIndex }` and NO `sessionId`. Continuation tokens no
 * longer exist — the create route rejects them and there is no way to turn one
 * back into an addressable session — so such a row is NOT resumable. This returns
 * null for it, and callers degrade into their existing "no session to continue"
 * path (a 409 NO_SESSION from the chat route, a `settleFailed` from the work-run
 * resume driver). No data migration is performed.
 *
 * @param raw        the raw `agent_run.session_state` jsonb.
 * @param fallbackSessionId a session id known from elsewhere (the `eve:` prefix on
 *                   `sandbox_id`). Used when the row's own blob predates the
 *                   sessionId field but is otherwise post-upgrade — i.e. it does
 *                   NOT carry a continuationToken.
 */
export function parseConversationSnapshot(
  raw: unknown,
  fallbackSessionId?: string | null,
): ConversationSnapshot | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>

  // LEGACY: a continuation token means this row was written by the pre-0.31 client.
  // It is not resumable under the new API — fail into the caller's expired path.
  if (isLegacySessionState(s)) return null

  const streamIndex = typeof s.streamIndex === 'number' ? s.streamIndex : null
  if (streamIndex === null) return null

  const sessionId =
    typeof s.sessionId === 'string' && s.sessionId.length > 0
      ? s.sessionId
      : typeof fallbackSessionId === 'string' && fallbackSessionId.length > 0
        ? fallbackSessionId
        : null
  if (!sessionId) return null

  return { sessionId, streamIndex }
}

/**
 * True when a persisted `session_state` was written by the PRE-0.31 eve client —
 * it carries a `continuationToken`, a capability that no longer exists. Such a row
 * can never be resumed; callers use this to distinguish "this session expired with
 * the upgrade" from "this run never had a session at all" in their logs/telemetry.
 */
export function isLegacySessionState(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const token = (raw as Record<string, unknown>).continuationToken
  return typeof token === 'string' && token.length > 0
}

/**
 * True when eve rejected a turn because the target session is no longer active —
 * HTTP 409 with `code: "session_not_active"` from the ID-addressed message route
 * (eve 0.31.0 replaced the old busy/conflict shape with this explicit code). A
 * caller should treat it as "this session is gone; start fresh", not as a
 * transient failure to retry.
 *
 * Kept structural (no `instanceof ClientError`) so it also matches an error that
 * crossed a serialization boundary. The status alone is sufficient: 409 and 423
 * have no other meaning on eve's session message route.
 */
export function isSessionNotActiveError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const status = (err as { status?: unknown }).status
  return status === 409 || status === 423
}
