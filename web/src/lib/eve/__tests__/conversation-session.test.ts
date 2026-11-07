/**
 * Unit tests for the CONVERSATION-mode eve session helpers (Loops v3 Phase 3 —
 * docs/loop-engine/INTERACTIVE-WORK-RUNS-DESIGN.md), on the eve 0.31.0+ API.
 *
 * The load-bearing assertions:
 *   - createConversationSession goes through `client.sessions.create()`, which
 *     cannot carry `mode` → conversation mode (the default), which parks at
 *     session.waiting instead of failing closed. (task-session.ts POSTs
 *     `mode:'task'` over raw fetch for the opposite contract.)
 *   - resumeConversationSession ATTACHES to the persisted `{ sessionId,
 *     streamIndex }` (no continuation token exists any more) and dispatches the
 *     right one of eve's now-EXCLUSIVE turn shapes: `respond(inputResponses, opts)`
 *     when answering a park, `send(message, opts)` for a plain follow-up.
 *   - because a respond DROPS `message`, the accompanying answer text is carried
 *     on the InputResponse's `text` and as `clientContext`.
 *   - readSessionSnapshot reads `{ sessionId, streamIndex }` off session.state.
 *   - parseConversationSnapshot REJECTS a legacy continuationToken blob (the
 *     upgrade's non-resumable path) and accepts a post-upgrade one.
 */
import { describe, it, expect, vi } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import {
  createConversationSession,
  createConversationSessionOnce,
  untilTurnBoundary,
  resumeConversationSession,
  readSessionSnapshot,
  parseConversationSnapshot,
  isLegacySessionState,
  isSessionNotActiveError,
} from '../conversation-session'

function sessionWaiting(): HandleMessageStreamEvent {
  return { type: 'session.waiting', data: { wait: 'next-user-message' } } as HandleMessageStreamEvent
}

/**
 * A fake eve Client mirroring the 0.31.0+ surface: `sessions.create(input)` returns
 * `{ session, response }`, and `sessions.attach(id, { streamIndex })` returns a
 * pinned handle with the positional `send(message, options)` /
 * `respond(inputResponses, options)` pair. The response's stream models the
 * boundary-aware generator (it breaks at the park) — NOT the raw stream() that
 * would hang there.
 */
function makeClient(opts: {
  sessionId?: string
  streamEvents?: HandleMessageStreamEvent[]
  /** create/send/respond throws. */
  turnError?: Error
  /** The state a session reports after a drain (for readSessionSnapshot). */
  sessionState?: { sessionId: string; streamIndex: number }
  /** Force create to return no sessionId. */
  noSessionId?: boolean
}) {
  const createCalls: Array<unknown> = []
  const attachCalls: Array<{ sessionId: string; options: unknown }> = []
  const sendCalls: Array<{ message: unknown; options: unknown }> = []
  const respondCalls: Array<{ inputResponses: unknown; options: unknown }> = []
  const sessionId = opts.sessionId ?? 'wrun_NEW'

  function makeResponse() {
    async function* gen() {
      for (const ev of opts.streamEvents ?? []) yield ev
    }
    return {
      sessionId: opts.noSessionId ? '' : sessionId,
      [Symbol.asyncIterator]: () => gen()[Symbol.asyncIterator](),
    }
  }

  function makeSession() {
    return {
      get state() {
        return opts.sessionState ?? { sessionId, streamIndex: 0 }
      },
      send: vi.fn(async (message: unknown, options?: unknown) => {
        sendCalls.push({ message, options })
        if (opts.turnError) throw opts.turnError
        return makeResponse()
      }),
      respond: vi.fn(async (inputResponses: unknown, options?: unknown) => {
        respondCalls.push({ inputResponses, options })
        if (opts.turnError) throw opts.turnError
        return makeResponse()
      }),
    }
  }

  const client = {
    sessions: {
      create: vi.fn(async (input: unknown) => {
        createCalls.push(input)
        if (opts.turnError) throw opts.turnError
        return { session: makeSession(), response: makeResponse() }
      }),
      attach: vi.fn((id: string, options?: unknown) => {
        attachCalls.push({ sessionId: id, options })
        return makeSession()
      }),
    },
  }
  return { client, createCalls, attachCalls, sendCalls, respondCalls }
}

describe('createConversationSession', () => {
  it('creates via client.sessions.create() (conversation mode — create cannot carry mode)', async () => {
    const { client, createCalls } = makeClient({
      sessionId: 'wrun_ABC',
      streamEvents: [sessionWaiting()],
    })

    const handle = await createConversationSession(client as never, { message: 'do the work' })

    expect(createCalls).toHaveLength(1)
    expect(createCalls[0]).toMatchObject({ message: 'do the work' })
    // No `mode` field is expressible on sessions.create() — so it can never be 'task'.
    expect((createCalls[0] as Record<string, unknown>).mode).toBeUndefined()
    // And no continuation token is sent: 0.47.7's create route REJECTS one.
    expect((createCalls[0] as Record<string, unknown>).continuationToken).toBeUndefined()

    expect(handle.sessionId).toBe('wrun_ABC')
  })

  it('streams the first turn to its parked boundary', async () => {
    const { client } = makeClient({ streamEvents: [sessionWaiting()] })

    const handle = await createConversationSession(client as never, { message: 'go' })
    const seen: string[] = []
    for await (const ev of handle.response) seen.push(ev.type)

    expect(seen).toEqual(['session.waiting'])
  })

  it('propagates a create failure', async () => {
    const { client } = makeClient({ turnError: new Error('eve create failed (503)') })
    await expect(createConversationSession(client as never, { message: 'x' })).rejects.toThrow(/503/)
  })

  it('throws when the create returns no session id', async () => {
    const { client } = makeClient({ noSessionId: true })
    await expect(createConversationSession(client as never, { message: 'x' })).rejects.toThrow(/no sessionId/)
  })
})

/**
 * A fake eve Client for the CREATE-ONCE path: a raw `fetch` against the create
 * route (the typed create cannot carry `operationId`) and `sessions.attach()`
 * returning a handle whose `.stream()` is the RAW durable stream — it does NOT
 * stop at a park, so the wrapper has to.
 */
function makeOnceClient(opts: {
  status?: number
  body?: Record<string, unknown>
  headerId?: string
  events?: HandleMessageStreamEvent[]
}) {
  const fetchCalls: Array<{ path: string; init: RequestInit }> = []
  const attachCalls: Array<{ sessionId: string; options: unknown }> = []
  let tailReads = 0
  const client = {
    fetch: vi.fn(async (path: string, init: RequestInit) => {
      fetchCalls.push({ path, init })
      const headers = new Headers(opts.headerId ? { 'x-eve-session-id': opts.headerId } : {})
      return new Response(JSON.stringify(opts.body ?? {}), { status: opts.status ?? 202, headers })
    }),
    sessions: {
      attach: vi.fn((sessionId: string, options?: unknown) => {
        attachCalls.push({ sessionId, options })
        return {
          state: { sessionId, streamIndex: 0 },
          cancel: vi.fn(async () => ({ status: 'accepted' })),
          stream: vi.fn(() =>
            (async function* () {
              for (const ev of opts.events ?? []) yield ev
              // The durable stream stays open after a park: anything read past
              // the boundary is a hang in production.
              tailReads += 1
              yield { type: 'message.appended', data: { delta: 'NEVER READ' } } as unknown as HandleMessageStreamEvent
            })(),
          ),
        }
      }),
    },
  }
  return { client, fetchCalls, attachCalls, tailReads: () => tailReads }
}

describe('createConversationSessionOnce (step 3: the create→stamp window)', () => {
  it('POSTs the create route with the message AND the operationId (no mode → conversation), then attaches at index 0', async () => {
    const { client, fetchCalls, attachCalls } = makeOnceClient({ body: { ok: true, sessionId: 'wrun_ONCE' } })
    const handle = await createConversationSessionOnce(client as never, { message: 'brief', operationId: 'work-run:r1' })

    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].path).toBe('/eve/v1/session')
    expect(fetchCalls[0].init.method).toBe('POST')
    const body = JSON.parse(String(fetchCalls[0].init.body))
    expect(body).toEqual({ message: 'brief', operationId: 'work-run:r1' })
    expect(body.mode).toBeUndefined()
    expect(handle.sessionId).toBe('wrun_ONCE')
    expect(attachCalls).toEqual([{ sessionId: 'wrun_ONCE', options: { streamIndex: 0 } }])
  })

  it('createConversationSession routes to the create-once path when an operationId is given', async () => {
    const { client, fetchCalls } = makeOnceClient({ body: { sessionId: 'wrun_R' } })
    const handle = await createConversationSession(client as never, { message: 'm', operationId: 'op-1' })
    expect(fetchCalls).toHaveLength(1)
    expect(handle.sessionId).toBe('wrun_R')
  })

  it('reads the session id from the x-eve-session-id header when the body has none', async () => {
    const { client } = makeOnceClient({ body: { ok: true }, headerId: 'wrun_HDR' })
    const handle = await createConversationSessionOnce(client as never, { message: 'm', operationId: 'op' })
    expect(handle.sessionId).toBe('wrun_HDR')
  })

  it('the first-turn response stops AT the park boundary and never reads the open stream past it', async () => {
    const appended = { type: 'message.appended', data: { delta: 'hi' } } as unknown as HandleMessageStreamEvent
    const { client, tailReads } = makeOnceClient({ body: { sessionId: 'wrun_S' }, events: [appended, sessionWaiting()] })
    const handle = await createConversationSessionOnce(client as never, { message: 'm', operationId: 'op' })
    const seen: string[] = []
    for await (const ev of handle.response) seen.push(ev.type)
    expect(seen).toEqual(['message.appended', 'session.waiting'])
    expect(tailReads()).toBe(0)
  })

  it('throws on a refused create and on a create with no session id; refuses an empty operationId', async () => {
    await expect(
      createConversationSessionOnce(makeOnceClient({ status: 400, body: { ok: false } }).client as never, {
        message: 'm',
        operationId: 'op',
      }),
    ).rejects.toThrow(/create failed \(400\)/)
    await expect(
      createConversationSessionOnce(makeOnceClient({ body: { ok: true } }).client as never, { message: 'm', operationId: 'op' }),
    ).rejects.toThrow(/no sessionId/)
    await expect(
      createConversationSessionOnce(makeOnceClient({}).client as never, { message: 'm', operationId: '' }),
    ).rejects.toThrow(/non-empty operationId/)
  })
})

describe('untilTurnBoundary', () => {
  it('keeps reading through a session.waiting while a webhook authorization is pending, and stops at the next boundary', async () => {
    const events = [
      { type: 'authorization.required', data: { name: 'gh', webhookUrl: 'https://x' } },
      sessionWaiting(),
      { type: 'authorization.completed', data: { name: 'gh' } },
      sessionWaiting(),
      { type: 'message.appended', data: { delta: 'past the boundary' } },
    ] as unknown as HandleMessageStreamEvent[]
    const seen: string[] = []
    for await (const ev of untilTurnBoundary((async function* () { yield* events })() as never)) seen.push(ev.type)
    expect(seen).toEqual(['authorization.required', 'session.waiting', 'authorization.completed', 'session.waiting'])
  })
})

describe('resumeConversationSession', () => {
  it('attaches to the persisted cursor and RESPONDS when answering a park', async () => {
    const { client, attachCalls, respondCalls, sendCalls } = makeClient({
      streamEvents: [sessionWaiting()],
    })

    const { response } = await resumeConversationSession(client as never, {
      sessionId: 'wrun_ABC',
      snapshot: { sessionId: 'wrun_ABC', streamIndex: 7 },
      payload: {
        inputResponses: [{ requestId: 'req-1', optionId: 'approve' }],
        message: 'Here are my answers:\n- Env: Staging',
      },
    })

    // The handle was ATTACHED (no I/O) to the durable id at the persisted cursor.
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0].sessionId).toBe('wrun_ABC')
    expect(attachCalls[0].options).toMatchObject({ streamIndex: 7 })

    // A turn with inputResponses MUST go through respond(), positionally — eve's
    // route drops `message` on such a turn, so the answers ride on the response's
    // own `text` and as one-turn clientContext instead.
    expect(sendCalls).toHaveLength(0)
    expect(respondCalls).toHaveLength(1)
    expect(respondCalls[0].inputResponses).toEqual([
      { requestId: 'req-1', optionId: 'approve', text: 'Here are my answers:\n- Env: Staging' },
    ])
    expect(respondCalls[0].options).toMatchObject({
      clientContext: 'Here are my answers:\n- Env: Staging',
    })

    const seen: string[] = []
    for await (const ev of response) seen.push(ev.type)
    expect(seen).toEqual(['session.waiting'])
  })

  it('never clobbers an inputResponse that already carries its own text', async () => {
    const { client, respondCalls } = makeClient({ streamEvents: [sessionWaiting()] })
    await resumeConversationSession(client as never, {
      sessionId: 'wrun_ABC',
      snapshot: { sessionId: 'wrun_ABC', streamIndex: 3 },
      payload: {
        inputResponses: [{ requestId: 'req-1', text: 'freeform answer' }],
        message: 'the summary text',
      },
    })
    expect(respondCalls[0].inputResponses).toEqual([
      { requestId: 'req-1', text: 'freeform answer' },
    ])
  })

  it('SENDS a bare message positionally for a plain follow-up (no inputResponses)', async () => {
    const { client, sendCalls, respondCalls } = makeClient({ streamEvents: [sessionWaiting()] })
    await resumeConversationSession(client as never, {
      sessionId: 'wrun_ABC',
      snapshot: { sessionId: 'wrun_ABC', streamIndex: 30 },
      payload: { message: 'what did you change?' },
    })
    expect(respondCalls).toHaveLength(0)
    expect(sendCalls).toHaveLength(1)
    // POSITIONAL: the message is the first argument, not an options-bag key.
    expect(sendCalls[0].message).toBe('what did you change?')
  })

  it('throws when neither a message nor inputResponses were supplied', async () => {
    const { client } = makeClient({})
    await expect(
      resumeConversationSession(client as never, {
        sessionId: 'wrun_ABC',
        snapshot: { sessionId: 'wrun_ABC', streamIndex: 1 },
        payload: {},
      }),
    ).rejects.toThrow(/requires a message or inputResponses/)
  })
})

describe('readSessionSnapshot', () => {
  it('reads the advanced { sessionId, streamIndex } off session.state', () => {
    const session = { state: { sessionId: 'wrun_ABC', streamIndex: 42 } }
    expect(readSessionSnapshot(session as never)).toEqual({
      sessionId: 'wrun_ABC',
      streamIndex: 42,
    })
  })

  it('returns null when the session has no id (never dispatched)', () => {
    const session = { state: { sessionId: '', streamIndex: 0 } }
    expect(readSessionSnapshot(session as never)).toBeNull()
  })

  it('defaults streamIndex to 0 when absent but an id exists', () => {
    const session = { state: { sessionId: 'wrun_ABC' } }
    expect(readSessionSnapshot(session as never)).toEqual({
      sessionId: 'wrun_ABC',
      streamIndex: 0,
    })
  })
})

describe('parseConversationSnapshot (legacy degradation)', () => {
  it('REJECTS a pre-0.31 blob carrying a continuationToken', () => {
    // Continuation tokens were removed with no replacement — such a session can
    // never be re-addressed, so it must parse to null and let the caller degrade.
    expect(
      parseConversationSnapshot({ continuationToken: 'ct-old', streamIndex: 12 }, 'wrun_ABC'),
    ).toBeNull()
    expect(isLegacySessionState({ continuationToken: 'ct-old', streamIndex: 12 })).toBe(true)
  })

  it('accepts a post-upgrade blob carrying its own sessionId', () => {
    expect(parseConversationSnapshot({ sessionId: 'wrun_XYZ', streamIndex: 5 })).toEqual({
      sessionId: 'wrun_XYZ',
      streamIndex: 5,
    })
  })

  it('falls back to the sandbox session id when the blob has only a cursor', () => {
    expect(parseConversationSnapshot({ streamIndex: 9 }, 'wrun_ABC')).toEqual({
      sessionId: 'wrun_ABC',
      streamIndex: 9,
    })
  })

  it('returns null without any session id, or without a cursor', () => {
    expect(parseConversationSnapshot({ streamIndex: 9 }, null)).toBeNull()
    expect(parseConversationSnapshot({ sessionId: 'wrun_ABC' })).toBeNull()
    expect(parseConversationSnapshot(null)).toBeNull()
  })

  it('does not flag a post-upgrade blob as legacy', () => {
    expect(isLegacySessionState({ sessionId: 'wrun_ABC', streamIndex: 3 })).toBe(false)
  })
})

describe('isSessionNotActiveError', () => {
  it('matches the 409 session_not_active the message route now returns', () => {
    expect(isSessionNotActiveError({ status: 409, body: '{"code":"session_not_active"}' })).toBe(true)
  })

  it('matches a 423 locked session', () => {
    expect(isSessionNotActiveError({ status: 423 })).toBe(true)
  })

  it('does not match auth / transport failures', () => {
    expect(isSessionNotActiveError({ status: 401 })).toBe(false)
    expect(isSessionNotActiveError(new TypeError('Failed to parse URL'))).toBe(false)
    expect(isSessionNotActiveError(null)).toBe(false)
  })
})
