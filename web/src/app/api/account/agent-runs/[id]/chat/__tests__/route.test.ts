import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * POST + GET /api/account/agent-runs/[id]/chat — follow-up chat proxy into a
 * settled work run's parked eve session. Locks: cross-workspace tenancy + the
 * chat guards (terminal run, session_state present + resumable), the eve-mount
 * turn/stream being translated through the reduced NDJSON vocabulary (never a raw
 * eve event), the advanced session_state persisted via the SERVICE client before
 * the response closes, and the BUSY surface on a non-active-session turn error.
 *
 * eve 0.31.0 shape (as shipped in 0.47.7):
 *   - the session is ATTACHED by id (`client.sessions.attach(id, { streamIndex })`),
 *     not rebuilt from a continuation token — tokens were removed entirely;
 *   - `send(message, options)` and `respond(inputResponses, options)` are EXCLUSIVE
 *     and POSITIONAL; a respond DROPS `message`, so an answer's accompanying text
 *     rides on the InputResponse's `text` plus one-turn `clientContext`;
 *   - a turn against a GONE session (HTTP 409 `session_not_active`: the 30-day
 *     session timeout) reopens the chat in a new session led by a history
 *     primer (run-chat-reopen.ts); a locked one (423) → BUSY;
 *   - a persisted `session_state` still carrying a `continuationToken` is LEGACY
 *     and non-resumable → 409 NO_SESSION.
 */

// ── Fixtures the tests mutate ────────────────────────────────────────────────

let currentUser: { id: string } | null = { id: 'starter-1' }

interface RunRow {
  id: string
  kind: string
  status: string
  workspace_id: string
  triggered_by: string | null
  sandbox_id: string | null
  session_state: unknown
}
let runRow: RunRow | null
let memberRow: { id: string } | null

// The eve session the mocked Client hands back: a scripted event stream + the
// state getter that advances after the stream drains.
let scriptedEvents: unknown[] = []
let sendThrows: Error | null = null
// The session.state getter after the stream drains: the durable id plus the
// ADVANCING streamIndex the next POST resumes from. There is no token any more.
let advancedState: { sessionId: string; streamIndex: number } = {
  sessionId: 'sess-abc',
  streamIndex: 42,
}
// Records the last AbortSignal the mocked stream() received, so the idle-close
// (abort-not-return) behavior is assertable.
let lastStreamSignal: AbortSignal | undefined
// When true, the replay iterable BLOCKS after the history burst (like a real
// parked session's durable stream) until the route aborts on idle — the case the
// idle-close test needs. Default false: the iterable ends after the burst, so the
// route breaks on `next.done` (fast, no 1.5s idle wait) for the other GET tests.
let replayBlocksAfterBurst = false
const sessionSendSpy = vi.fn()
/** Every eve Client the route constructs, with its options (host + headers). */
const clientCtorSpy = vi.fn()
const sessionRespondSpy = vi.fn()
/** MessageResponse.cancel() — Stop's per-turn cancel (every call the route makes). */
const responseCancelSpy = vi.fn(async () => ({ status: 'accepted' }))
/**
 * The durable-turn cancel eve's MessageResponse.cancel() issues once it knows the
 * turn id (its `cancelTurn`) — only reached through an eve-faithful live response.
 */
const cancelTurnSpy = vi.fn(async (turnId: string) => ({ status: 'accepted', turnId }))
/** What each eve-faithful response.cancel() resolved with. */
let cancelResults: Array<Promise<{ status: string; turnId?: string }>> = []
/** When set, the send/respond POST resolves only once this promise does. */
let dispatchGate: Promise<void> | null = null
/**
 * When set, the response iterates THIS through an eve-faithful MessageResponse
 * (cancel semantics + cursor advancement, see makeEveFaithfulResponse) instead of
 * the scripted events.
 */
let liveResponse: AsyncIterable<unknown> | null = null
/**
 * The attached handle's cursor for an eve-faithful response: eve's ClientSession
 * sets `state.streamIndex = start + eventsRead` in the response generator's
 * finally (session.js), so a route that stops reading early leaves the cursor
 * mid-turn. null → the fixed `advancedState` (scripted tests).
 */
let liveCursor: { start: number; read: number } | null = null
const sessionStreamSpy = vi.fn()
/** Records the (sessionId, options) the route passed to client.sessions.attach(). */
const sessionAttachSpy = vi.fn()

const serviceWrites: Array<{ table: string; patch: Record<string, unknown>; eqs: Array<[string, unknown]> }> = []

// ── A session that expired (the 30-day timeout): the chat reopens ────────────
/** Per session id: a send/respond failure, overriding `sendThrows`. */
let sendThrowsById: Record<string, Error> = {}
/** Per session id: a replay script (or failure), overriding `scriptedEvents` / `sendThrows`. */
let streamScriptsById: Record<string, unknown[] | Error> = {}
/** Per session id: the turn response fails on its first read (before any event). */
let responseThrowsById: Record<string, Error> = {}
/** Every (sessionId, options) a stream() was opened with. */
const streamByIdSpy = vi.fn()
/** ClientSession.reset() on an attached session. */
const sessionResetSpy = vi.fn(async (..._a: unknown[]) => ({ status: 'reset' }))
/** The message-free create the reopen makes, and the new session's sends. */
const sessionCreateSpy = vi.fn()
const newSessionSendSpy = vi.fn()
const newSessionResetSpy = vi.fn(async (..._a: unknown[]) => ({ status: 'reset' }))
let newSessionEvents: unknown[] = []
/** The new session's cursor: 0 when created, advanced once its turn drains. */
let newSessionState = { sessionId: 'sess-new', streamIndex: 0 }
/** The run's facts the primer restores (a service read). */
let runFacts: Record<string, unknown> | null = null
/** What the reopen's guarded register matched (one row: it won). */
let registerRows: unknown[] = [{ id: 'run-1' }]

/** Every token the route minted (bots v3 Phase 5: a follow-up turn's carries `chat: true`). */
const mintedClaims: Array<Record<string, unknown>> = []

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('@/lib/api-auth', () => ({
  requireUser: async () =>
    currentUser
      ? { supabase: makeSupabase(), user: currentUser }
      : new Response('no', { status: 401 }),
}))

vi.mock('@/lib/agent-run/agent-run-token', () => ({
  internalSecret: () => 'test-secret',
  mintAgentRunToken: (claims: Record<string, unknown>) => (mintedClaims.push(claims), 'fresh-token'),
  AGENT_RUN_SECRET_HEADER: 'x-agent-run-secret',
  AGENT_RUN_TOKEN_HEADER: 'x-agent-run-token',
  AGENT_RUN_WORKSPACE_HEADER: 'x-agent-run-workspace',
  AGENT_RUN_USER_HEADER: 'x-agent-run-user',
}))

vi.mock('@/lib/agent-run/run-agent-eve', () => ({
  EVE_SANDBOX_PREFIX: 'eve:',
}))

// The follow-up turn's usage (work-run-usage.test.ts covers the rows).
const logWorkRunUsageSpy = vi.hoisted(() => vi.fn(async (_supabase: unknown, _args: unknown) => 0))
vi.mock('@/lib/agent-run/work-run-usage', () => ({ logWorkRunUsage: logWorkRunUsageSpy }))

vi.mock('@/lib/supabase/service', () => ({
  getServiceClient: () => ({
    from: (table: string) => ({
      select: () => {
        const chain = { eq: () => chain, maybeSingle: async () => ({ data: runFacts, error: null }) }
        return chain
      },
      update: (patch: Record<string, unknown>) => {
        const entry = { table, patch, eqs: [] as Array<[string, unknown]> }
        serviceWrites.push(entry)
        const chain = {
          eq: (col: string, v: unknown) => (entry.eqs.push([col, v]), chain),
          select: async () => ({ data: registerRows, error: null }),
          then: (onF?: (v: unknown) => unknown) => Promise.resolve({ data: null }).then(onF),
        }
        return chain
      },
    }),
  }),
}))

// Mock the eve Client on its 0.31.0+ shape: `sessions.attach(id, { streamIndex })`
// returns a handle whose POSITIONAL send(message, options) / respond(inputResponses,
// options) resolve to a MessageResponse-like value (async-iterable over the
// scripted events), whose stream() yields them for replay (honoring an AbortSignal
// by ending iteration), and whose state getter returns the advanced cursor.
vi.mock('eve/client', () => {
  // A minimal stand-in for eve's ClientError (carries an HTTP status) so the BUSY
  // classifier (409/423 → BUSY, else FAILED) is exercised against the real shape.
  // Declared INSIDE the factory (hoisted above module scope) and re-imported below.
  class ClientError extends Error {
    status: number
    body: string
    // Like eve's: the body's JSON `code`, when it has one.
    code: string | undefined
    constructor(status: number, body = '') {
      super(body || `Server returned ${status}.`)
      this.name = 'ClientError'
      this.status = status
      this.body = body
      let code: unknown
      try {
        code = (JSON.parse(body) as { code?: unknown } | null)?.code
      } catch {
        code = undefined
      }
      this.code = typeof code === 'string' ? code : undefined
    }
  }
  const throwing = (err: Error) => ({
    async *[Symbol.asyncIterator]() {
      throw err
    },
  })
  class MockClient {
    readonly sessions = {
      // The reopen's message-free create (run-chat-reopen.ts): a new session
      // whose turn streams `newSessionEvents`.
      create: async (opts?: unknown) => {
        sessionCreateSpy(opts)
        return {
          session: {
            get state() {
              return newSessionState
            },
            reset: newSessionResetSpy,
            async send(message: unknown, sendOpts?: unknown) {
              newSessionSendSpy(message, sendOpts)
              const response = makeMessageResponse(newSessionEvents)
              // The response generator's finally advances the cursor past the turn.
              return {
                cancel: response.cancel,
                async *[Symbol.asyncIterator]() {
                  let read = 0
                  try {
                    for await (const e of response) {
                      read += 1
                      yield e
                    }
                  } finally {
                    newSessionState = { ...newSessionState, streamIndex: newSessionState.streamIndex + read }
                  }
                },
              }
            },
          },
        }
      },
      attach: (sessionId: string, options?: unknown) => {
        sessionAttachSpy(sessionId, options)
        const failure = () => sendThrowsById[sessionId] ?? sendThrows
        const respond = () => (responseThrowsById[sessionId] ? throwing(responseThrowsById[sessionId]) : makeMessageResponse(scriptedEvents))
        return {
          get state() {
            return liveCursor
              ? { sessionId: advancedState.sessionId, streamIndex: liveCursor.start + liveCursor.read }
              : advancedState
          },
          async send(message: unknown, opts?: unknown) {
            sessionSendSpy(message, opts)
            if (dispatchGate) await dispatchGate
            if (failure()) throw failure()
            return respond()
          },
          async respond(inputResponses: unknown, opts?: unknown) {
            sessionRespondSpy(inputResponses, opts)
            if (dispatchGate) await dispatchGate
            if (failure()) throw failure()
            return respond()
          },
          reset: sessionResetSpy,
          stream(opts: { startIndex?: number; signal?: AbortSignal } | undefined) {
            streamByIdSpy(sessionId, opts)
            const own = streamScriptsById[sessionId]
            if (own) return own instanceof Error ? throwing(own) : makeReplayIterable(own, opts?.signal)
            sessionStreamSpy(opts)
            lastStreamSignal = opts?.signal
            if (sendThrows) {
              // A stream error surfaces on iteration.
              return {
                async *[Symbol.asyncIterator]() {
                  throw sendThrows
                },
              }
            }
            return makeReplayIterable(scriptedEvents, opts?.signal)
          },
        }
      },
    }
    constructor(public opts: unknown) {
      clientCtorSpy(opts)
    }
  }
  return { Client: MockClient, ClientError }
})

/** A MessageResponse-like value: async-iterable over `events`. eve 0.31.0 removed
 *  continuationToken from the response, so there is nothing else to carry. */
function makeMessageResponse(events: unknown[]) {
  if (liveResponse) return makeEveFaithfulResponse(liveResponse)
  return {
    cancel: responseCancelSpy,
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
  }
}

const isBoundary = (e: unknown) => {
  const type = (e as { type?: string }).type
  return type === 'session.waiting' || type === 'session.completed' || type === 'session.failed'
}

/**
 * Mirrors eve 0.66.3's MessageResponse (client/message-response.js) and the
 * ClientSession cursor (client/session.js), so a route that stops reading early
 * is caught:
 *   - cancel() only learns the turn id from a `turn.started` the ITERATOR yields.
 *     It resolves `no_active_turn` once a boundary was seen, or if iteration ends
 *     (the generator's finally) before any `turn.started`. Repeat calls share one
 *     promise.
 *   - the handle's streamIndex becomes `start + eventsRead` only in the
 *     generator's finally: stop reading early and the cursor is left mid-turn.
 * (It also stops at the first boundary, like eve's response does.)
 */
function makeEveFaithfulResponse(source: AsyncIterable<unknown>) {
  let resolveTurnId: (id: string | undefined) => void = () => {}
  const turnId = new Promise<string | undefined>((r) => { resolveTurnId = r })
  let boundarySeen = false
  let pending: Promise<{ status: string; turnId?: string }> | undefined
  // The route attaches at the run's persisted cursor (session_state.streamIndex).
  const start = (runRow?.session_state as { streamIndex?: number } | null | undefined)?.streamIndex ?? 0
  const cursor = { start, read: 0 }
  return {
    cancel() {
      responseCancelSpy()
      if (boundarySeen) {
        const r = Promise.resolve({ status: 'no_active_turn' })
        cancelResults.push(r)
        return r
      }
      pending ??= turnId.then((id) => (id === undefined ? { status: 'no_active_turn' } : cancelTurnSpy(id)))
      cancelResults.push(pending)
      return pending
    },
    async *[Symbol.asyncIterator]() {
      let read = 0
      try {
        for await (const e of source) {
          read += 1
          const ev = e as { type?: string; data?: { turnId?: string } }
          if (ev.type === 'turn.started') resolveTurnId(ev.data?.turnId)
          else if (isBoundary(e)) {
            boundarySeen = true
            resolveTurnId(undefined)
          }
          yield e
          if (isBoundary(e)) break
        }
      } finally {
        resolveTurnId(undefined)
        cursor.read = read
        liveCursor = cursor
      }
    },
  }
}

/** A replay iterable that yields the history burst then — like a parked session's
 *  durable stream — never resolves the next read until the signal aborts (at which
 *  point iteration ends cleanly, mirroring eve's disconnect handling). This lets
 *  the route's idle-abort path terminate instead of hanging on events.return(). */
function makeReplayIterable(events: unknown[], signal?: AbortSignal) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
      // History exhausted. A real parked session's stream would hold open here;
      // only the idle-close test opts into that (blocking until the route aborts).
      // Otherwise end the iteration so the route breaks on `next.done` without
      // waiting out the real idle timer.
      if (!replayBlocksAfterBurst) return
      await new Promise<void>((resolve) => {
        if (signal?.aborted) return resolve()
        signal?.addEventListener('abort', () => resolve(), { once: true })
      })
    },
  }
}

// ── Chainable Supabase (cookie client) — only reads here ──────────────────────

function makeSupabase() {
  return {
    from(table: string) {
      if (table === 'agent_run') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: runRow, error: null }),
            }),
          }),
        }
      }
      // member
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: memberRow }),
            }),
          }),
        }),
      }
    },
  }
}

// The composer's turn builder (bots v4; its own tests: run-chat-turn.test.ts):
// a spy here, so the route's wiring is what's pinned.
const composerTurn = vi.hoisted(() => ({
  result: null as unknown,
  calls: [] as Array<Record<string, unknown>>,
}))
vi.mock('@/lib/agent-run/run-chat-turn', async (importOriginal) => ({
  // The real fences (the reopen's primer uses them).
  ...(await importOriginal<typeof import('@/lib/agent-run/run-chat-turn')>()),
  buildRunChatTurn: async (args: Record<string, unknown>) => {
    composerTurn.calls.push(args)
    return composerTurn.result
  },
}))
import { POST, GET } from '../route'
// The ClientError stand-in defined in the eve/client mock factory above.
import { ClientError as MockClientError } from 'eve/client'

const params = Promise.resolve({ id: 'run-1' })

function postReq(body: unknown) {
  return new Request('http://localhost/api/account/agent-runs/run-1/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}
function getReq() {
  return new Request('http://localhost/api/account/agent-runs/run-1/chat', { method: 'GET' })
}

/** Drain an NDJSON Response body into an array of parsed reduced events. */
async function readNdjson(res: Response): Promise<unknown[]> {
  const text = await res.text()
  return text
    .split('\n')
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

beforeEach(() => {
  vi.clearAllMocks()
  serviceWrites.length = 0
  currentUser = { id: 'starter-1' }
  memberRow = { id: 'member-1' }
  sendThrows = null
  dispatchGate = null
  liveResponse = null
  liveCursor = null
  cancelResults = []
  lastStreamSignal = undefined
  replayBlocksAfterBurst = false
  sendThrowsById = {}
  streamScriptsById = {}
  responseThrowsById = {}
  newSessionEvents = []
  newSessionState = { sessionId: 'sess-new', streamIndex: 0 }
  runFacts = null
  registerRows = [{ id: 'run-1' }]
  // The response generator's finally ADVANCES streamIndex past the turn boundary
  // (10 → 42); the session id is fixed for the handle's life.
  advancedState = { sessionId: 'sess-abc', streamIndex: 42 }
  scriptedEvents = [
    { type: 'message.appended', data: { messageDelta: 'Hi' } },
    { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', callId: 'c1', toolName: 'get_document', input: { secret: 'x' } }] } },
    { type: 'turn.completed', data: {} },
    { type: 'session.waiting', data: { wait: 'next-user-message' } },
  ]
  runRow = {
    id: 'run-1',
    kind: 'workspace',
    status: 'completed',
    workspace_id: 'ws-1',
    triggered_by: 'starter-1',
    sandbox_id: 'eve:sess-abc',
    session_state: { sessionId: 'sess-abc', streamIndex: 10 },
  }
})

describe('POST chat — happy path', () => {
  it('mints the turn a FRESH token with the chat claim, so the work-agent re-resolves its tools for it', async () => {
    mintedClaims.length = 0
    await readNdjson(await POST(postReq({ message: 'make it more formal' }), { params }))
    expect(mintedClaims.at(-1)).toMatchObject({ agentRunId: 'run-1', chat: true })
  })

  it('proxies the turn, streams reduced NDJSON, and advances the read cursor before closing', async () => {
    const res = await POST(postReq({ message: 'How did you decide the tone?' }), { params })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('application/x-ndjson')

    const events = await readNdjson(res)
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'tool', name: 'get_document' },
      { type: 'done' },
    ])
    // Privacy fence: the tool input never reached the browser.
    expect(JSON.stringify(events)).not.toContain('secret')

    // The session was ATTACHED by its durable id at the persisted cursor (no I/O,
    // no continuation token), and the message went through send() POSITIONALLY.
    expect(sessionAttachSpy).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ streamIndex: 10 }))
    expect(sessionSendSpy).toHaveBeenCalledWith('How did you decide the tone?', expect.anything())

    // The read cursor (streamIndex) ADVANCES to 42 so the NEXT POST resumes PAST
    // this turn's boundary (a frozen cursor would replay this turn forever). There
    // is no settle boundary in this fixture, so the persisted state is just the id
    // + the cursor — the token that used to live here no longer exists.
    const write = serviceWrites.find((w) => w.table === 'agent_run')
    expect(write?.patch).toEqual({ session_state: { sessionId: 'sess-abc', streamIndex: 42 } })
  })

  it('logs the follow-up turn’s usage (source chat) with every raw event it read, never forwarding them', async () => {
    const res = await POST(postReq({ message: 'Shorter, please.' }), { params })
    await readNdjson(res)
    expect(logWorkRunUsageSpy).toHaveBeenCalledTimes(1)
    const [, args] = logWorkRunUsageSpy.mock.calls[0] as [unknown, Record<string, unknown>]
    expect(args).toEqual({ agentRunId: 'run-1', workspaceId: 'ws-1', events: scriptedEvents, source: 'chat' })
  })

  it('writes session_state EXACTLY ONCE — only after the drain advances the cursor', async () => {
    // The old pre-stream token stamp is gone with continuation tokens: there is no
    // send capability a mid-turn abort could lose, so the only write is the
    // post-drain cursor advance.
    await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
    const writes = serviceWrites.filter((w) => w.table === 'agent_run')
    expect(writes).toHaveLength(1)
    expect(writes[0].patch).toEqual({ session_state: { sessionId: 'sess-abc', streamIndex: 42 } })
  })

  it('preserves the frozen settleStreamIndex across a follow-up turn', async () => {
    runRow!.session_state = { sessionId: 'sess-abc', streamIndex: 20, settleStreamIndex: 10 }
    await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
    // The read cursor advances (20 → 42) but the settle boundary stays 10.
    const write = serviceWrites.find((w) => w.table === 'agent_run')
    expect(write?.patch).toEqual({
      session_state: { sessionId: 'sess-abc', streamIndex: 42, settleStreamIndex: 10 },
    })
  })

  it('RESPONDS (never sends) when the follow-up answers a nested question, folding the text in', async () => {
    // eve 0.31.0: a turn carrying inputResponses goes through respond(), and the
    // route DROPS `message` on such a turn — so the user's text has to ride on the
    // response's own `text` plus one-turn clientContext, or it would be lost.
    await POST(postReq({ inputResponses: [{ requestId: 'r9', optionId: 'approve' }], message: 'yes' }), { params })
    expect(sessionSendSpy).not.toHaveBeenCalled()
    expect(sessionRespondSpy).toHaveBeenCalledWith(
      [{ requestId: 'r9', optionId: 'approve', text: 'yes' }],
      expect.objectContaining({ clientContext: 'yes' }),
    )
  })

  it('responds without a text fold when the answer carries no accompanying message', async () => {
    await POST(postReq({ inputResponses: [{ requestId: 'r9', optionId: 'approve' }] }), { params })
    expect(sessionRespondSpy).toHaveBeenCalledWith(
      [{ requestId: 'r9', optionId: 'approve' }],
      expect.not.objectContaining({ clientContext: expect.anything() }),
    )
  })
})

describe('POST chat — dispatch origin (eveDispatchOrigin): the address in NEXT_PUBLIC_APP_URL', () => {
  afterEach(() => vi.unstubAllEnvs())

  async function clientOptsFor() {
    await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
    return clientCtorSpy.mock.calls.at(-1)![0] as { host: string; headers: Record<string, string> }
  }

  it('is NEXT_PUBLIC_APP_URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://staging.example')
    const opts = await clientOptsFor()
    expect(opts.host).toBe('https://staging.example/eve/work-agent')
  })

  it("is local dev's default without it", async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const opts = await clientOptsFor()
    expect(opts.host).toBe('http://localhost:3000/eve/work-agent')
  })
})

describe('POST chat — turn policy + Stop', () => {
  /** An event source the test feeds one event at a time. */
  function pushable() {
    const queue: unknown[] = []
    let wake: (() => void) | null = null
    let ended = false
    return {
      push(...events: unknown[]) {
        queue.push(...events)
        wake?.()
      },
      end() {
        ended = true
        wake?.()
      },
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length > 0) {
            yield queue.shift()
            continue
          }
          if (ended) return
          await new Promise<void>((r) => { wake = r })
          wake = null
        }
      },
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))
  function abortablePost(body: unknown, signal: AbortSignal) {
    return new Request('http://localhost/api/account/agent-runs/run-1/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal,
    })
  }

  it('sends with turnPolicy "queue" and never wires the request signal into the eve POST', async () => {
    await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
    expect(sessionSendSpy).toHaveBeenCalledWith('hi', { turnPolicy: 'queue' })
  })

  it('a respond carries no signal and no turnPolicy (pure inputResponses never steer)', async () => {
    await readNdjson(await POST(postReq({ inputResponses: [{ requestId: 'r9', optionId: 'approve' }] }), { params }))
    expect(sessionRespondSpy).toHaveBeenCalledWith([{ requestId: 'r9', optionId: 'approve' }], {})
  })

  /** Read the rest of an NDJSON body as text. */
  async function readRest(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    let rest = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      rest += new TextDecoder().decode(value)
    }
    return rest
  }
  /** session_state.streamIndex the route persisted (undefined when none). */
  const persistedIndex = () =>
    (serviceWrites.find((w) => w.table === 'agent_run')?.patch as { session_state?: { streamIndex?: number } } | undefined)
      ?.session_state?.streamIndex

  it('Stop mid-stream cancels the eve turn exactly once (by the id eve learned), forwards nothing more, and drains to the boundary so the cursor lands PAST the turn', async () => {
    const live = pushable()
    liveResponse = live
    const stop = new AbortController()
    const res = await POST(abortablePost({ message: 'go' }, stop.signal), { params })
    const reader = res.body!.getReader()
    live.push(
      { type: 'turn.started', data: { turnId: 'turn_3' } },
      { type: 'message.appended', data: { messageDelta: 'Part' } },
    )
    let first = ''
    while (!first.includes('Part')) first += new TextDecoder().decode((await reader.read()).value)
    expect(responseCancelSpy).not.toHaveBeenCalled()

    stop.abort()
    await flush()
    expect(responseCancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelTurnSpy.mock.calls).toEqual([['turn_3']])
    expect(await cancelResults[0]).toEqual({ status: 'accepted', turnId: 'turn_3' })

    // eve ends the cancelled turn; the route drains it to the boundary.
    live.push(
      { type: 'message.appended', data: { messageDelta: 'never forwarded' } },
      { type: 'turn.cancelled', data: { turnId: 'turn_3' } },
      { type: 'session.waiting', data: { wait: 'next-user-message' } },
    )
    live.end()
    const rest = await readRest(reader)
    expect(rest).not.toContain('never forwarded')
    expect(responseCancelSpy).toHaveBeenCalledTimes(1)
    // 10 (prior cursor) + all 5 events of the turn: the boundary, not the Stop point.
    expect(persistedIndex()).toBe(15)
  })

  it('Stop BEFORE eve names the turn: the route keeps reading, so the cancel resolves with that turn once turn.started arrives, and the cursor still lands past the turn', async () => {
    const live = pushable()
    liveResponse = live
    const stop = new AbortController()
    const res = await POST(abortablePost({ message: 'go' }, stop.signal), { params })
    const reader = res.body!.getReader()
    await flush()
    expect(sessionSendSpy).toHaveBeenCalledTimes(1)

    stop.abort()
    await flush()
    expect(responseCancelSpy).toHaveBeenCalledTimes(1)
    expect(cancelTurnSpy).not.toHaveBeenCalled() // eve has not named the turn yet

    live.push(
      { type: 'turn.started', data: { turnId: 'turn_4' } },
      { type: 'message.appended', data: { messageDelta: 'never forwarded' } },
    )
    await flush()
    expect(cancelTurnSpy.mock.calls).toEqual([['turn_4']])
    expect(await cancelResults[0]).toEqual({ status: 'accepted', turnId: 'turn_4' })

    live.push(
      { type: 'turn.cancelled', data: { turnId: 'turn_4' } },
      { type: 'session.waiting', data: { wait: 'next-user-message' } },
    )
    live.end()
    const rest = await readRest(reader)
    expect(rest).not.toContain('never forwarded')
    expect(persistedIndex()).toBe(14) // 10 + 4 events: the boundary
  })

  it('Stop on a turn that reaches its boundary without ever starting: the cancel resolves no_active_turn and cancels nothing', async () => {
    const live = pushable()
    liveResponse = live
    const stop = new AbortController()
    const res = await POST(abortablePost({ message: 'go' }, stop.signal), { params })
    const reader = res.body!.getReader()
    await flush()
    stop.abort()
    await flush()
    live.push({ type: 'session.waiting', data: { wait: 'next-user-message' } })
    live.end()
    await readRest(reader)
    expect(await cancelResults[0]).toEqual({ status: 'no_active_turn' })
    expect(cancelTurnSpy).not.toHaveBeenCalled()
  })

  it('Stop while the send POST is in flight: the POST completes, then the turn it started is cancelled once', async () => {
    let release: () => void = () => {}
    dispatchGate = new Promise<void>((r) => { release = r })
    const stop = new AbortController()
    const res = await POST(abortablePost({ message: 'go' }, stop.signal), { params })
    const body = res.text()
    await flush()
    expect(sessionSendSpy).toHaveBeenCalledTimes(1)
    stop.abort()
    await flush()
    expect(responseCancelSpy).not.toHaveBeenCalled()
    release()
    await body
    expect(responseCancelSpy).toHaveBeenCalledTimes(1)
  })

  it('a request already aborted before dispatch sends nothing to eve', async () => {
    const stop = new AbortController()
    stop.abort()
    await POST(abortablePost({ message: 'go' }, stop.signal), { params })
    expect(sessionSendSpy).not.toHaveBeenCalled()
    expect(responseCancelSpy).not.toHaveBeenCalled()
  })
})

describe('POST chat — BUSY / errors', () => {
  it('surfaces {type:error, code:BUSY} for a locked session (423) or eve’s retryable 409, and never reopens it', async () => {
    for (const err of [new MockClientError(423, ''), new MockClientError(409, '{"ok":false,"code":"session_not_ready"}')]) {
      sendThrows = err
      serviceWrites.length = 0
      // Real BUSY: the send never advanced the session, so the cursor is unchanged.
      advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
      const events = await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
      expect(events).toEqual([{ type: 'error', message: 'The agent could not be reached', code: 'BUSY' }])
      expect(sessionCreateSpy).not.toHaveBeenCalled()
      expect(serviceWrites.find((w) => w.table === 'agent_run')).toBeUndefined()
    }
  })

  it('BUSY when the session is gone but another send reopened the chat first: nothing goes to the parked new session', async () => {
    sendThrows = new MockClientError(409, '{"ok":false,"code":"session_not_active"}')
    runFacts = { status: 'completed', task_prompt: 'Draft it', result_summary: null, error_message: null, deliverables: [], sandbox_id: 'eve:sess-abc' }
    registerRows = []
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(200) // the stream opened; the error rides IN it
    const events = await readNdjson(res)
    // Generic copy — the raw eve body never reaches the browser.
    expect(events).toEqual([{ type: 'error', message: 'The agent could not be reached', code: 'BUSY' }])
    expect(sessionCreateSpy).toHaveBeenCalledTimes(1)
    expect(newSessionSendSpy).not.toHaveBeenCalled()
    // The one write is the register that lost (guarded on the gone session); no cursor persist.
    expect(serviceWrites.filter((w) => w.table === 'agent_run')).toEqual([
      expect.objectContaining({ eqs: expect.arrayContaining([['sandbox_id', 'eve:sess-abc']]) }),
    ])
  })

  it('classifies a NON-conflict pre-stream failure (e.g. auth/mount 500) as FAILED, not BUSY', async () => {
    sendThrows = new MockClientError(500, 'Internal Server Error: /var/task/eve stack trace…')
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    const res = await POST(postReq({ message: 'hi' }), { params })
    const events = await readNdjson(res)
    // FAILED (a hard error the user must NOT retry as if the agent were busy), and
    // the raw body (internal paths / stack) is clamped to generic copy.
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(JSON.stringify(events)).not.toContain('/var/task')
    expect(JSON.stringify(events)).not.toContain('stack trace')
  })

  it('classifies a plain (non-ClientError) send throw as FAILED with generic copy', async () => {
    // The relative-URL TypeError class of failure — a plain Error, not a conflict.
    sendThrows = new TypeError('Failed to parse URL from /eve/work-agent/…')
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    const res = await POST(postReq({ message: 'hi' }), { params })
    const events = await readNdjson(res)
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(JSON.stringify(events)).not.toContain('parse URL')
  })
})

describe('POST chat — a session that expired (the 30-day timeout) reopens with a history primer', () => {
  const GONE_409 = () => new MockClientError(409, '{"ok":false,"code":"session_not_active","error":"The session is no longer active."}')

  beforeEach(() => {
    runFacts = {
      status: 'completed',
      task_prompt: 'Draft the Q3 board update for Dana',
      result_summary: 'Wrote the update as a document.',
      error_message: null,
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 board update' }],
      // The row still names the gone session (the reopen's early read).
      sandbox_id: 'eve:sess-abc',
    }
    // The gone session's follow-up turns, still readable after the timeout (eve keeps its data).
    streamScriptsById['sess-abc'] = [
      { type: 'message.received', data: { message: 'which numbers did you use?' } },
      { type: 'message.appended', data: { messageDelta: 'The Q3 actuals.' } },
      { type: 'actions.requested', data: { actions: [{ kind: 'tool-call', callId: 'c', toolName: 'get_document', input: { secret: 'old-input' } }] } },
      { type: 'turn.completed', data: {} },
      { type: 'session.completed', data: {} },
    ]
  })

  /** The new session's turn: eve echoes the message (the primer leads it), then the reply. */
  const replyTurn = (message: unknown) => [
    { type: 'message.received', data: { message: 'flattened', parts: message } },
    { type: 'message.appended', data: { messageDelta: 'Shorter now.' } },
    { type: 'turn.completed', data: {} },
    { type: 'session.waiting', data: {} },
  ]

  it('reopens: a new session registered on the run over the gone one, the turn led by the fenced primer, the reply streamed, the cursor kept on the new session', async () => {
    sendThrows = GONE_409()
    newSessionSendSpy.mockImplementationOnce((message: unknown) => {
      newSessionEvents = replyTurn(message)
    })
    mintedClaims.length = 0
    const res = await POST(postReq({ message: 'make it shorter' }), { params })
    const events = await readNdjson(res)

    // The person sees their words and the reply, never the restored history.
    expect(events).toEqual([
      { type: 'user-message', text: 'make it shorter' },
      { type: 'text-delta', delta: 'Shorter now.' },
      { type: 'done' },
    ])
    expect(JSON.stringify(events)).not.toContain('run-history')

    // The same fresh chat token (one client) made the create and the send.
    expect(clientCtorSpy).toHaveBeenCalledTimes(1)
    expect(mintedClaims).toEqual([expect.objectContaining({ agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'starter-1', chat: true })])
    expect(sessionCreateSpy).toHaveBeenCalledWith({})

    // Registered over the gone session only; the gone one's turns stay replayable.
    const previous = [{ sessionId: 'sess-abc', startIndex: 10 }]
    const [register, cursor] = serviceWrites.filter((w) => w.table === 'agent_run')
    expect(register).toEqual({
      table: 'agent_run',
      patch: { sandbox_id: 'eve:sess-new', session_state: { sessionId: 'sess-new', streamIndex: 0, settleStreamIndex: 0, previous } },
      eqs: [['id', 'run-1'], ['workspace_id', 'ws-1'], ['sandbox_id', 'eve:sess-abc']],
    })

    // The turn: the primer first (the run's task, how it ended, what it handed back,
    // the chat's latest messages, each fenced), then the person's words, queued.
    const [message, opts] = newSessionSendSpy.mock.calls[0] as [Array<{ type: string; text: string }>, unknown]
    expect(opts).toEqual({ turnPolicy: 'queue' })
    expect(message.slice(1)).toEqual([{ type: 'text', text: 'make it shorter' }])
    const primer = message[0].text
    expect(primer.startsWith('## Restored history of this chat')).toBe(true)
    expect(primer).toContain('<run-history part="task">\nDraft the Q3 board update for Dana\n</run-history>')
    expect(primer).toContain('<run-history part="report">\nWrote the update as a document.\n</run-history>')
    expect(primer).toContain('- document “Q3 board update” (id doc-1)')
    expect(primer).toContain('Person: which numbers did you use?\nAgent: The Q3 actuals.')
    expect(primer).toContain('do not call finish_work')
    expect(primer).not.toContain('old-input')
    // The gone session's history: a bounded catch-up read from its follow-up boundary.
    expect(streamByIdSpy).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ startIndex: 10, follow: false }))

    // The cursor advances on the NEW session, keeping its boundary and `previous`.
    expect(cursor.patch).toEqual({ session_state: { sessionId: 'sess-new', streamIndex: 4, settleStreamIndex: 0, previous } })
    // The turn's usage is logged under the new session's own keys (eve restarts at turn_0 per session).
    expect(logWorkRunUsageSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ agentRunId: 'run-1', source: 'chat', sessionId: 'sess-new' }))
  })

  it('a live session is untouched: no new session, no register, the turn goes to the run’s own session', async () => {
    const events = await readNdjson(await POST(postReq({ message: 'make it shorter' }), { params }))
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'tool', name: 'get_document' },
      { type: 'done' },
    ])
    expect(sessionCreateSpy).not.toHaveBeenCalled()
    expect(newSessionSendSpy).not.toHaveBeenCalled()
    expect(sessionSendSpy).toHaveBeenCalledWith('make it shorter', expect.anything())
    // Only the cursor advance, on the run's own session (guarded on it), billed under the run's keys.
    expect(serviceWrites.map((w) => w.patch)).toEqual([{ session_state: { sessionId: 'sess-abc', streamIndex: 42 } }])
    expect(serviceWrites[0].eqs).toContainEqual(['sandbox_id', 'eve:sess-abc'])
    expect(logWorkRunUsageSpy).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ sessionId: undefined }))
  })

  it('a session that took the POST but whose history expired (410 before any event): reset, then the turn reopens', async () => {
    responseThrowsById['sess-abc'] = new MockClientError(410, '{"ok":false,"code":"session_expired","error":"Session history is no longer available."}')
    streamScriptsById['sess-abc'] = new MockClientError(410, '{"ok":false,"code":"session_expired"}')
    newSessionSendSpy.mockImplementationOnce((message: unknown) => {
      newSessionEvents = replyTurn(message)
    })
    const events = await readNdjson(await POST(postReq({ message: 'make it shorter' }), { params }))
    expect(events).toEqual([
      { type: 'user-message', text: 'make it shorter' },
      { type: 'text-delta', delta: 'Shorter now.' },
      { type: 'done' },
    ])
    // The old session is reset BEFORE the words go anywhere else, so they never run in both.
    expect(sessionResetSpy).toHaveBeenCalledTimes(1)
    expect(sessionResetSpy.mock.invocationCallOrder[0]).toBeLessThan(newSessionSendSpy.mock.invocationCallOrder[0])
    expect(sessionSendSpy).toHaveBeenCalledTimes(1)
    expect(newSessionSendSpy).toHaveBeenCalledTimes(1)
    // No history to restore: the primer still carries the run's facts.
    const primer = (newSessionSendSpy.mock.calls[0][0] as Array<{ text: string }>)[0].text
    expect(primer).toContain('Draft the Q3 board update for Dana')
    expect(primer).not.toContain('part="messages"')
  })

  it('the 410 path loses the race to another send’s reopen: BUSY (send again), not FAILED', async () => {
    responseThrowsById['sess-abc'] = new MockClientError(410, '{"ok":false,"code":"session_expired"}')
    registerRows = []
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    const events = await readNdjson(await POST(postReq({ message: 'make it shorter' }), { params }))
    expect(events).toEqual([{ type: 'error', message: 'The agent could not be reached', code: 'BUSY' }])
    expect(newSessionSendSpy).not.toHaveBeenCalled()
  })

  it('an answer with no words to carry into a new session is FAILED (a retry can’t succeed), and creates nothing', async () => {
    sendThrows = GONE_409()
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    const events = await readNdjson(await POST(postReq({ inputResponses: [{ requestId: 'r-1', optionId: 'approve' }] }), { params }))
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(sessionCreateSpy).not.toHaveBeenCalled()
  })

  it('a turn the new session refuses is FAILED, and the row goes back to the gone session', async () => {
    sendThrows = GONE_409()
    // The gone session's cursor never moved.
    advancedState = { sessionId: 'sess-abc', streamIndex: 10 }
    newSessionSendSpy.mockImplementationOnce(() => {
      throw new Error('eve refused the send at /var/task')
    })
    const events = await readNdjson(await POST(postReq({ message: 'make it shorter' }), { params }))
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    // The row goes back (only over the new session, its cursor unmoved), then
    // whatever eve may have taken is stopped.
    expect(newSessionResetSpy).toHaveBeenCalledTimes(1)
    const writes = serviceWrites.filter((w) => w.table === 'agent_run')
    expect(writes[1]).toEqual({
      table: 'agent_run',
      patch: { sandbox_id: 'eve:sess-abc', session_state: { sessionId: 'sess-abc', streamIndex: 10 } },
      eqs: [['id', 'run-1'], ['workspace_id', 'ws-1'], ['sandbox_id', 'eve:sess-new'], ['session_state->>streamIndex', '0']],
    })
    expect(writes).toHaveLength(2)
  })

  it('the composer’s turn reopens with its words and one-turn context, and the skill still rides the token', async () => {
    sendThrows = GONE_409()
    composerTurn.result = {
      message: 'use the tone skill',
      clientContext: ['## Skill picked for this message: Tone'],
      skill: { id: 'skill-1', name: 'Tone' },
    }
    newSessionSendSpy.mockImplementationOnce((message: unknown) => {
      newSessionEvents = replyTurn(message)
    })
    mintedClaims.length = 0
    await readNdjson(await POST(postReq({ message: 'use the tone skill', skillId: 'skill-1' }), { params }))
    expect(mintedClaims).toEqual([expect.objectContaining({ chat: true, skillId: 'skill-1' })])
    const [message, opts] = newSessionSendSpy.mock.calls[0] as [Array<{ text: string }>, unknown]
    expect(message.slice(1)).toEqual([{ type: 'text', text: 'use the tone skill' }])
    expect(opts).toEqual({ turnPolicy: 'queue', clientContext: ['## Skill picked for this message: Tone'] })
    composerTurn.result = null
  })
})

describe('POST chat — auth + guards', () => {
  it('401 when unauthenticated', async () => {
    currentUser = null
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(401)
  })

  it('404 when the run does not exist', async () => {
    runRow = null
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(404)
  })

  it('403 cross-workspace: caller is not a member of the run’s workspace', async () => {
    memberRow = null
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(403)
  })

  it('403 when the caller is not triggered_by', async () => {
    runRow!.triggered_by = 'someone-else'
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(403)
  })

  it('400 for a coding run (wrong kind)', async () => {
    runRow!.kind = 'coding'
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_KIND')
  })

  it('409 when the run is not terminal', async () => {
    runRow!.status = 'running'
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NOT_TERMINAL')
  })

  it('409 when session_state is missing', async () => {
    runRow!.session_state = null
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
  })

  it('409 when sandbox_id has no eve session handle', async () => {
    runRow!.sandbox_id = null
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
  })

  it('409 NO_SESSION for a LEGACY session_state (a pre-eve-0.31 continuationToken)', async () => {
    // Continuation tokens were removed with no replacement, so a row written before
    // the upgrade can never be re-addressed. It must degrade into the SAME
    // NO_SESSION the UI already handles, and never reach the eve mount.
    runRow!.session_state = { continuationToken: 'ct-from-before-the-upgrade', streamIndex: 10 }
    const res = await POST(postReq({ message: 'hi' }), { params })
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('NO_SESSION')
    expect(sessionAttachSpy).not.toHaveBeenCalled()
    expect(sessionSendSpy).not.toHaveBeenCalled()
  })

  it('accepts a post-upgrade blob with only a cursor, addressing it via sandbox_id', async () => {
    // Rows written after the upgrade but before sessionId was mirrored into the
    // blob still resume: the `eve:` prefix on sandbox_id supplies the address.
    runRow!.session_state = { streamIndex: 10 }
    await readNdjson(await POST(postReq({ message: 'hi' }), { params }))
    expect(sessionAttachSpy).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ streamIndex: 10 }))
  })

  it('400 on an empty send (no message, no inputResponses)', async () => {
    const res = await POST(postReq({}), { params })
    expect(res.status).toBe(400)
  })

  it('400 when the message exceeds the length cap', async () => {
    const res = await POST(postReq({ message: 'x'.repeat(4001) }), { params })
    expect(res.status).toBe(400)
    // The oversized body never reached the eve mount.
    expect(sessionSendSpy).not.toHaveBeenCalled()
  })

  it('400 when inputResponses exceeds the entry cap', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ requestId: `r${i}`, optionId: 'approve' }))
    const res = await POST(postReq({ message: 'hi', inputResponses: many }), { params })
    expect(res.status).toBe(400)
    expect(sessionSendSpy).not.toHaveBeenCalled()
  })
})

describe('GET chat — replay', () => {
  it('replays from the ADVANCING streamIndex when there is no frozen settle boundary', async () => {
    const res = await GET(getReq(), { params })
    expect(res.status).toBe(200)
    // No settleStreamIndex in this fixture → fall back to streamIndex (10).
    expect(sessionStreamSpy).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 10 }))
    const events = await readNdjson(res)
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'tool', name: 'get_document' },
      { type: 'done' },
    ])
  })

  it('replays from the FROZEN settle boundary when present (so a reload shows ALL follow-up turns)', async () => {
    // After follow-up turns advanced the read cursor to 30, the replay must still
    // start at the settle boundary (10) to reconstruct the whole transcript.
    runRow!.session_state = { sessionId: 'sess-abc', streamIndex: 30, settleStreamIndex: 10 }
    await readNdjson(await GET(getReq(), { params }))
    expect(sessionStreamSpy).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 10 }))
  })

  it('reduces the user’s own follow-up messages so a reloaded transcript is not an agent monologue', async () => {
    scriptedEvents = [
      { type: 'message.received', data: { message: 'How did you decide the tone?' } },
      { type: 'message.appended', data: { messageDelta: 'I matched the brief.' } },
      { type: 'turn.completed', data: {} },
    ]
    const events = await readNdjson(await GET(getReq(), { params }))
    expect(events).toEqual([
      { type: 'user-message', text: 'How did you decide the tone?' },
      { type: 'text-delta', delta: 'I matched the brief.' },
      { type: 'done' },
    ])
  })

  it('idle-closes by ABORTING the stream (not awaiting return) so the response terminates', async () => {
    // The replay iterable yields the burst then blocks forever until abort. If the
    // route awaited events.return() it would deadlock; instead it aborts on idle,
    // the iterable ends, and the response closes. Reaching this assertion at all
    // proves the response terminated.
    replayBlocksAfterBurst = true
    const res = await GET(getReq(), { params })
    const events = await readNdjson(res)
    expect(events).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'tool', name: 'get_document' },
      { type: 'done' },
    ])
    // The route passed an AbortSignal to stream() and fired it on idle.
    expect(lastStreamSignal).toBeInstanceOf(AbortSignal)
    expect(lastStreamSignal?.aborted).toBe(true)
  })

  it('does NOT persist session_state on GET (the dead recovery path is removed)', async () => {
    advancedState = { sessionId: 'sess-abc', streamIndex: 55 }
    await readNdjson(await GET(getReq(), { params }))
    // GET never writes: a stream replay can't advance the token (eve's continue
    // route never rotates it), so the old "recovery persist" was a structural
    // no-op and is gone.
    expect(serviceWrites.find((w) => w.table === 'agent_run')).toBeUndefined()
  })

  it('surfaces a replay error as generic {type:error, FAILED} inside the stream (raw body clamped)', async () => {
    sendThrows = new MockClientError(500, 'replay failed at /var/task/eve internal')
    const res = await GET(getReq(), { params })
    const events = await readNdjson(res)
    expect(events).toEqual([{ type: 'error', message: 'The turn failed', code: 'FAILED' }])
    expect(JSON.stringify(events)).not.toContain('/var/task')
  })

  it('a reopened chat replays its earlier sessions first (bounded reads), then its own, never the restored history', async () => {
    runRow!.sandbox_id = 'eve:sess-new'
    runRow!.session_state = { sessionId: 'sess-new', streamIndex: 4, settleStreamIndex: 0, previous: [{ sessionId: 'sess-abc', startIndex: 10 }] }
    streamScriptsById['sess-abc'] = [
      { type: 'message.received', data: { message: 'which numbers did you use?' } },
      { type: 'message.appended', data: { messageDelta: 'The Q3 actuals.' } },
      { type: 'turn.completed', data: {} },
      { type: 'session.completed', data: {} },
    ]
    scriptedEvents = [
      {
        type: 'message.received',
        data: { message: 'flattened', parts: [{ type: 'text', text: '## Restored history of this chat\n…' }, { type: 'text', text: 'make it shorter' }] },
      },
      { type: 'message.appended', data: { messageDelta: 'Shorter now.' } },
      { type: 'turn.completed', data: {} },
    ]
    const events = await readNdjson(await GET(getReq(), { params }))
    expect(events).toEqual([
      { type: 'user-message', text: 'which numbers did you use?' },
      { type: 'text-delta', delta: 'The Q3 actuals.' },
      { type: 'done' },
      { type: 'done' },
      { type: 'user-message', text: 'make it shorter' },
      { type: 'text-delta', delta: 'Shorter now.' },
      { type: 'done' },
    ])
    expect(streamByIdSpy).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ startIndex: 10, follow: false }))
    expect(sessionStreamSpy).toHaveBeenCalledWith(expect.objectContaining({ startIndex: 0 }))
  })

  it('a session whose history eve no longer holds opens quietly (no error): the next send reopens the chat', async () => {
    sendThrows = new MockClientError(410, '{"ok":false,"code":"session_expired","error":"Session history is no longer available."}')
    expect(await readNdjson(await GET(getReq(), { params }))).toEqual([])
    sendThrows = new MockClientError(404, '{"ok":false,"error":"Session not found."}')
    expect(await readNdjson(await GET(getReq(), { params }))).toEqual([])
  })

  it('an earlier session eve no longer holds is skipped; the chat’s own still replays', async () => {
    runRow!.session_state = { sessionId: 'sess-abc', streamIndex: 10, previous: [{ sessionId: 'sess-old', startIndex: 3 }] }
    streamScriptsById['sess-old'] = new MockClientError(410, '{"ok":false,"code":"session_expired"}')
    expect(await readNdjson(await GET(getReq(), { params }))).toEqual([
      { type: 'text-delta', delta: 'Hi' },
      { type: 'tool', name: 'get_document' },
      { type: 'done' },
    ])
  })

  it('403 cross-workspace on GET too', async () => {
    memberRow = null
    const res = await GET(getReq(), { params })
    expect(res.status).toBe(403)
  })
})

describe('POST chat — the full composer’s turn (bots v4)', () => {
  const built = {
    message: [
      { type: 'text', text: 'Make it formal' },
      { type: 'text', text: '[attached file] "notes.md" (text/markdown) storage_path: starter-1/chat-uploads/f.md' },
    ],
    clientContext: ['## Skill picked for this message: Formal', '## Files attached to this message'],
    skill: { id: 'skill-1', name: 'Formal' },
  }
  const extrasBody = {
    message: 'Make it formal',
    skillId: 'skill-1',
    files: [{ storagePath: 'starter-1/chat-uploads/f.md', fileName: 'notes.md', fileSize: 4, mimeType: 'text/markdown' }],
    mentions: { contactIds: ['11111111-1111-4111-8111-111111111111'] },
    // A stale client's "My captures": read without it.
    searchSettings: { timeWindow: 'all', includeTranscripts: true, includeAttachments: true },
  }

  beforeEach(() => {
    composerTurn.calls = []
    composerTurn.result = built
    mintedClaims.length = 0
  })

  it('builds the turn from the checked extras, sends it to the run’s own session with its one-turn context, and the skill rides the token', async () => {
    const events = await readNdjson(await POST(postReq(extrasBody), { params }))
    expect(events.at(-1)).toEqual({ type: 'done' })
    expect(composerTurn.calls).toHaveLength(1)
    expect(composerTurn.calls[0]).toMatchObject({
      userId: 'starter-1',
      workspaceId: 'ws-1',
      message: 'Make it formal',
      extras: {
        skillId: 'skill-1',
        files: extrasBody.files,
        mentions: { captureIds: [], contactIds: ['11111111-1111-4111-8111-111111111111'], companyIds: [] },
      },
      // A work run's tools never read the person's private captures.
      privateCaptures: false,
    })
    expect(composerTurn.calls[0]).not.toHaveProperty('model')
    expect(composerTurn.calls[0].extras).not.toHaveProperty('searchSettings')
    // The exact parked session, the message with its file notes, the context for this turn only.
    expect(sessionAttachSpy).toHaveBeenCalledWith('sess-abc', expect.objectContaining({ streamIndex: 10 }))
    expect(sessionSendSpy).toHaveBeenCalledWith(built.message, { turnPolicy: 'queue', clientContext: built.clientContext })
    // The skill's tools are the turn's (ceilingForWorkRunTurn reads it off this token).
    expect(mintedClaims.at(-1)).toMatchObject({ agentRunId: 'run-1', chat: true, skillId: 'skill-1' })
  })

  it('a skill or file the person can’t use, or a photo, is a 400 before anything is sent', async () => {
    composerTurn.result = { status: 400, error: 'a file is not one of your chat uploads', code: 'FILE_NOT_ALLOWED' }
    const res = await POST(postReq(extrasBody), { params })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'a file is not one of your chat uploads', code: 'FILE_NOT_ALLOWED' })
    composerTurn.result = { status: 400, error: 'Photos can’t be sent in this chat yet. Describe what the photo shows instead.', code: 'PHOTO_NOT_SUPPORTED' }
    const photo = await POST(postReq(extrasBody), { params })
    expect(photo.status).toBe(400)
    expect(await photo.json()).toMatchObject({ code: 'PHOTO_NOT_SUPPORTED' })
    expect(sessionSendSpy).not.toHaveBeenCalled()
    expect(mintedClaims).toHaveLength(0)
  })

  it('"My captures" alone builds no turn: the message goes as plain text', async () => {
    await readNdjson(
      await POST(postReq({ message: 'hi', searchSettings: { timeWindow: 'all', includeTranscripts: true, includeAttachments: true } }), { params }),
    )
    expect(composerTurn.calls).toHaveLength(0)
    expect(sessionSendSpy).toHaveBeenLastCalledWith('hi', { turnPolicy: 'queue' })
  })

  it('a malformed extra is a 400 (the route’s own parse), and a plain message builds nothing', async () => {
    expect((await POST(postReq({ message: 'hi', files: 'nope' }), { params })).status).toBe(400)
    expect((await POST(postReq({ message: 'hi', mentions: { contactIds: ['not-an-id'] } }), { params })).status).toBe(400)
    await readNdjson(await POST(postReq({ message: 'just words' }), { params }))
    expect(composerTurn.calls).toHaveLength(0)
    expect(sessionSendSpy).toHaveBeenLastCalledWith('just words', { turnPolicy: 'queue' })
    expect(mintedClaims.at(-1)).not.toHaveProperty('skillId')
  })

  it('an answer to a park never builds a composer turn (the picker’s answer is the turn)', async () => {
    await readNdjson(
      await POST(postReq({ message: 'Yes', inputResponses: [{ requestId: 'req-1', optionId: 'approve' }], skillId: 'skill-1' }), { params }),
    )
    expect(composerTurn.calls).toHaveLength(0)
    expect(sessionRespondSpy).toHaveBeenCalledTimes(1)
    expect(sessionSendSpy).not.toHaveBeenCalled()
  })
})

