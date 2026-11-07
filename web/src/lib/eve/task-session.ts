/**
 * createTaskSession — start an UNATTENDED one-shot eve session and read its one
 * turn to the end.
 *
 * ───────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS
 *
 * Up to eve 0.66 a one-shot ran in `task` mode: the run had to finish within
 * the dispatch, so a finished turn ended with `session.completed` (closing the
 * stream) and a bare park or a HITL / token-limit prompt failed closed with
 * `session.failed`. eve 0.67 REMOVED run modes (the create route now ignores a
 * `mode` field): every session parks after each turn. A one-shot's turn now
 * ends with `turn.completed` / `turn.failed` / `turn.cancelled` and the
 * session parks at `session.waiting`; a question, approval or sign-in holds
 * the turn open at `turn.waiting` (eve 0.70). The durable stream never closes
 * on its own after a park, and nothing fails closed any more.
 *
 * So the one-shot contract is now enforced here, client-side:
 *   • the stream is cut at the turn's boundary (untilTurnBoundary, eve's own
 *     MessageResponse rule plus `turn.waiting`), so `for await` and `result()`
 *     end instead of hanging on the park;
 *   • `result().status` reads `waiting` for a clean end (the session parked),
 *     so callers classify the turn with classifyOneShot
 *     (./turn-boundary.ts): `completed` / `failed` / `waiting`, where `waiting`
 *     means a park on a person nobody will answer, which an unattended caller
 *     treats as a failure and cancels ({@link cancelTaskSession});
 *   • the parked session stays until eve's session timeout (30 days by
 *     default, `limits.sessionTimeoutMs`); a parked run holds no compute.
 *
 * The create still goes over the client's authenticated raw `fetch()` (not the
 * typed `client.sessions.create()`), so the session id is known as soon as the
 * create answers and a caller that times out can still cancel it, and so the
 * stream is read from index 0 through the cut above.
 *
 * INTERACTIVE, multi-turn sessions (e.g. the chat transport) must NOT use this.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { UserContent } from 'ai'
import { Client, MessageResponse } from 'eve/client'
import type { ClientSession, MessageStreamEvent } from 'eve/client'
import { untilTurnBoundary } from './conversation-session'

/** The eve create-session route path (POST). */
const EVE_CREATE_SESSION_PATH = '/eve/v1/session'
/** Response header eve stamps with the new session id (belt-and-suspenders vs. the JSON body). */
const EVE_SESSION_ID_HEADER = 'x-eve-session-id'

/**
 * The subset of the Standard Schema interface we rely on to lower a schema (Zod,
 * Valibot, …) to JSON Schema. Typed structurally so this helper takes no
 * dependency on `@standard-schema/spec` (present only transitively) — any object
 * exposing `~standard.jsonSchema.output` (every Zod v4 schema does) satisfies it.
 */
export interface JsonSchemaCapableSchema<TOutput = unknown> {
  readonly '~standard': {
    readonly jsonSchema?: {
      readonly output?: (opts: { target: string }) => unknown
    }
  }
  /** Phantom — carries the schema's inferred output type onto MessageResult.data. */
  readonly __output?: TOutput
}

/**
 * The create route's JSON response for a successful task-session create.
 *
 * eve 0.31.0 removed continuation tokens entirely: the create route no longer
 * returns one, and (as of 0.47.7) actively REJECTS one in the request body. The
 * session id is the whole handle.
 */
interface CreateSessionResponse {
  ok?: boolean
  sessionId?: string
}

/**
 * Create a durable one-shot eve session and return a {@link MessageResponse}
 * over its event stream, cut at the turn's boundary.
 *
 * @param client        an eve `Client` already pointed at the target agent mount,
 *                       with whatever auth/headers the channel needs (this reuses
 *                       the client's own auth/header cascade for the create POST).
 * @param opts.message  the single task message (the run's first + only user turn):
 *                       a string, or AI SDK `UserContent` (text + file parts) —
 *                       the same `string | UserContent` eve's own SendTurnInput
 *                       takes. File parts must be JSON-serializable (a `data:`
 *                       URL or an https URL, never raw bytes): the create body is
 *                       JSON.
 * @param opts.outputSchema
 *                       optional Standard Schema (e.g. a Zod object) the harness
 *                       must satisfy before the turn terminates. It is normalized
 *                       to draft-07 JSON Schema the SAME way the typed client does
 *                       (`~standard.jsonSchema.output`) so the create body carries
 *                       a plain JSON object — the create route rejects a raw Zod
 *                       schema. `MessageResponse<TOutput>.result().data` is typed
 *                       to the schema's output.
 * @param opts.signal   optional abort signal covering BOTH the create POST and the
 *                       whole event stream (arm it before calling, exactly like the
 *                       typed `send({ signal })`).
 * @param opts.onEvent  optional synchronous tap called with each stream event as
 *                       it arrives, BEFORE the consumer sees it. `result()` only
 *                       hands back the events when the stream ends cleanly — an
 *                       aborted/timed-out stream throws and they are gone — so a
 *                       caller that must inspect a partial run (skill-run verdict
 *                       salvage) or report live progress keeps its own copy here.
 * @param opts.createSignal
 *                       optional abort signal for the create POST ALONE, in place of
 *                       `signal` there (the stream still uses `signal`). A caller
 *                       that times out while the create is in flight can keep the
 *                       POST alive a little longer to learn the session id — and
 *                       cancel the session the server already started.
 *
 * @throws if the create POST fails (non-2xx) or returns no session id.
 *
 * The returned response exposes `sessionId` synchronously (from the create JSON /
 * header) and, when iterated or `.result()`-ed, streams the run to the turn's
 * boundary — identical in shape to what `session().send()` returns. Classify the
 * events with classifyOneShot: a clean end reads `waiting` in `result().status`.
 */
export async function createTaskSession<TOutput = unknown>(
  client: Client,
  opts: {
    message: string | UserContent
    outputSchema?: JsonSchemaCapableSchema<TOutput>
    signal?: AbortSignal
    onEvent?: (event: MessageStreamEvent) => void
    createSignal?: AbortSignal
  },
): Promise<MessageResponse<TOutput>> {
  const { message, outputSchema, signal, onEvent } = opts
  const createSignal = opts.createSignal ?? signal

  // Build the create body. When a schema is requested, lower it to draft-07 JSON
  // Schema through its Standard Schema interface — the EXACT normalization the
  // typed client applies — so the route, which expects a JSON object, accepts
  // it. (The tool contract and the outputSchema contract stay in lockstep
  // because the same Zod schema is the single source.)
  const sessionId = await postCreateSession(client, { message, label: 'task', outputSchema, createSignal })

  // Attach a typed handle to the just-created session and stream it. `attach()`
  // performs NO I/O — the session was already dispatched by the create POST above;
  // `.stream()` opens `/eve/v1/session/<id>/stream` from index 0 and yields the
  // run's events, cut at the turn's boundary (the session parks after it, and
  // the durable stream would stay open). Wrapping it in MessageResponse gives
  // callers the identical `result()` / `for await` surface the typed create
  // returns.
  const resumed = client.sessions.attach(sessionId, { streamIndex: 0 })

  // MessageResponse's constructor is marked @internal but is the only way to
  // present a raw stream under the same surface `sessions.create()` returns.
  // 0.47.7 requires `cancelTurn`: delegate it to the attached handle's own cancel
  // so `response.cancel()` reaches the real session instead of being a no-op.
  return new MessageResponse<TOutput>({
    sessionId,
    cancelTurn: (turnId: string) => resumed.cancel({ turnId }),
    createStream: () => {
      const stream = untilTurnBoundary(resumed.stream({ ...(signal ? { signal } : {}) }))
      return (onEvent ? tapEvents(stream, onEvent) : stream) as never
    },
  })
}

/**
 * The create POST both helpers share: the schema is lowered to JSON Schema, and
 * the new session's id comes back from the JSON body or eve's header. No
 * `mode`: eve 0.67+ ignores it (every session parks after its turn). `label`
 * only names the session in errors.
 */
async function postCreateSession(
  client: Client,
  args: {
    message: string | UserContent
    label: 'task' | 'parking-run'
    outputSchema?: JsonSchemaCapableSchema<unknown>
    createSignal?: AbortSignal
  },
): Promise<string> {
  const body: Record<string, unknown> = { message: args.message }
  if (args.outputSchema !== undefined) {
    body.outputSchema = normalizeOutputSchema(args.outputSchema)
  }

  const res = await client.fetch(EVE_CREATE_SESSION_PATH, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(args.createSignal ? { signal: args.createSignal } : {}),
  })
  if (!res.ok) {
    throw new Error(`eve ${args.label}-session create failed (${res.status})`)
  }
  const created = (await res.json()) as CreateSessionResponse
  const sessionId =
    (typeof created.sessionId === 'string' ? created.sessionId.trim() : '') ||
    res.headers.get(EVE_SESSION_ID_HEADER)?.trim() ||
    ''
  if (!sessionId) throw new Error(`eve ${args.label}-session create returned no sessionId`)
  return sessionId
}

/**
 * createParkingRunSession — an unattended run whose session PARKS when its turn
 * ends, so a person can talk with it afterwards (bots v3 Phase 4: a loop's
 * skill run; docs/plans/bots-v3.md "the exact chat for loop runs").
 *
 * The same raw create as {@link createTaskSession} (the outputSchema rides the
 * create, scoped to this first turn only: eve's client outputSchema is
 * per-turn, so a later follow-up turn carries none). Since eve 0.67 removed run
 * modes the two sessions are the same on eve's side: a finished turn ends at
 * `session.waiting` and the session stays there, durably, as the follow-up
 * chat's handle. This one also hands back the attached session.
 *
 * Two things are the caller's job:
 *   • the stream never closes on its own after the park, so it is cut at the
 *     turn boundary here (`untilTurnBoundary`, eve's own MessageResponse rule);
 *     `result()` then reports a clean end as status `waiting`, not `completed`;
 *   • nothing fails closed: a HITL or session-limit prompt PARKS the turn
 *     (`input.requested`, then `turn.waiting`), and a failed turn parks after
 *     `turn.failed`. An unattended caller must read those as failures and
 *     cancel the session ({@link cancelTaskSession}), or a run would sit
 *     waiting on input nobody sends.
 *
 * Returns the response (same `result()` / `for await` surface) and the attached
 * session, whose `state` is the `{ sessionId, streamIndex }` resume snapshot
 * once the turn has drained (readSessionSnapshot).
 */
export async function createParkingRunSession<TOutput = unknown>(
  client: Client,
  opts: {
    message: string | UserContent
    outputSchema?: JsonSchemaCapableSchema<TOutput>
    signal?: AbortSignal
    onEvent?: (event: MessageStreamEvent) => void
  },
): Promise<{ response: MessageResponse<TOutput>; session: ClientSession }> {
  const { message, outputSchema, signal, onEvent } = opts
  const sessionId = await postCreateSession(client, { message, label: 'parking-run', outputSchema, createSignal: signal })
  const session = client.sessions.attach(sessionId, { streamIndex: 0 })
  const response = new MessageResponse<TOutput>({
    sessionId,
    cancelTurn: (turnId: string) => session.cancel({ turnId }),
    createStream: () => {
      const stream = untilTurnBoundary(session.stream({ ...(signal ? { signal } : {}) }))
      return (onEvent ? tapEvents(stream, onEvent) : stream) as never
    },
  })
  return { response, session }
}

/** Upper bound on the cancel POST, so a hung eve route can't stall the caller. */
const CANCEL_TIMEOUT_MS = 5_000

/**
 * Stop a task session's durable server-side work: its active turn AND every
 * background task it owns. Returns true when eve accepted the request (or
 * reported nothing left to cancel), false when the request itself failed.
 * Never throws. Since eve 0.69 a plain `cancel()` also stops the turn's working
 * tasks (the old `{ tasks: true }` option is gone).
 *
 * Aborting the signal passed to {@link createTaskSession} is only LOCAL
 * transport cancellation. eve's turns are resumable across disconnects, so
 * detaching never stops server-side work (eve docs, guides/client/streaming
 * "Pass an AbortSignal"). A caller that gives up on a run (a wall-clock
 * timeout) must call this, or the session keeps calling tools after the
 * caller has already reported the run as over.
 *
 * Session-level (no turnId), unlike `MessageResponse.cancel()`, which targets
 * only a turn it saw start on the stream. A wall that fires before
 * `turn.started` arrives would make that call a no-op. A task session carries
 * exactly one turn, so there is no later turn this could hit by mistake.
 *
 * `opts.timeoutMs` bounds the cancel POST (default 5s) for a caller with a
 * tighter wall budget.
 */
export async function cancelTaskSession(
  client: Client,
  sessionId: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  try {
    await client.sessions
      .attach(sessionId)
      .cancel({ signal: AbortSignal.timeout(opts.timeoutMs ?? CANCEL_TIMEOUT_MS) })
    return true
  } catch {
    return false
  }
}

/**
 * Retire a one-shot session once its turn has been read. eve 0.67+ parks every
 * session after its turn (there is no task mode), and a parked session lives
 * until the agent's `limits.sessionTimeoutMs` (30 days by default). An agent
 * that also hosts long-lived sessions (the chat agent, the skill runner, the
 * coding agent) can't shorten that for all of them, so its one-shot callers
 * retire their session here: `reset()` terminally ends this exact id (and
 * cancels a run still going), and it is never resumed. Best-effort: never
 * throws; true when eve took it (or the session was already inactive).
 */
export async function retireTaskSession(
  client: Client,
  sessionId: string,
  opts: { timeoutMs?: number; reason?: string } = {},
): Promise<boolean> {
  try {
    await client.sessions
      .attach(sessionId)
      .reset({ reason: opts.reason ?? 'one-shot read to its end', signal: AbortSignal.timeout(opts.timeoutMs ?? CANCEL_TIMEOUT_MS) })
    return true
  } catch {
    return false
  }
}

/** Re-yield every event after handing it to `onEvent` (see opts.onEvent). */
async function* tapEvents(
  source: AsyncIterable<MessageStreamEvent>,
  onEvent: (event: MessageStreamEvent) => void,
): AsyncGenerator<MessageStreamEvent> {
  for await (const event of source) {
    onEvent(event)
    yield event
  }
}

/**
 * Lower a Standard Schema (Zod, Valibot, …) to a plain draft-07 JSON Schema
 * object for the create route — the SAME transform eve's typed client applies
 * (`normalizeJsonSchemaDefinition` → `~standard.jsonSchema.output({ target:
 * 'draft-07' })`). Using the schema's own Standard Schema interface guarantees
 * the create body matches what `send({ outputSchema })` would have produced, so
 * one-shot and parking verdict runs can never drift.
 */
function normalizeOutputSchema(schema: JsonSchemaCapableSchema): unknown {
  const output = schema['~standard']?.jsonSchema?.output
  if (typeof output === 'function') {
    return output({ target: 'draft-07' })
  }
  // Not a JSON-Schema-capable Standard Schema — pass through and let the route
  // validate (it accepts any JSON-serializable object). Should not happen for the
  // Zod schemas we use, but never silently drop the schema.
  return schema
}
