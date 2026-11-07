import { describe, it, expect, vi } from 'vitest'
import type { UserContent } from 'ai'
import { createDataUrlFilePart, type HandleMessageStreamEvent } from 'eve/client'
import { z } from 'zod'
import { VERDICT_POLICY_GUIDANCE, verdictOutputSchema } from '@/lib/flows/verdict-schema'
import { cancelTaskSession, createTaskSession } from '../task-session'
import { classifyOneShot } from '../turn-boundary'

/**
 * Unit tests for createTaskSession — the shared helper that starts an UNATTENDED
 * one-shot eve session.
 *
 * eve 0.67 removed run modes: every session parks after its turn, and the create
 * route ignores `mode`, so the body no longer carries one. The load-bearing
 * behaviour is now the cut at the turn's boundary: a parked session's stream
 * never closes, so the response must end at `session.waiting` (or a
 * `turn.waiting` on a person) instead of hanging an unattended run.
 *
 * Also covered: the message rides in the create body (a string, or UserContent
 * with file parts — the same `string | UserContent` eve's SendTurnInput takes); NO continuationToken is sent
 * (eve 0.47.7's create route rejects one); an outputSchema is lowered to a plain
 * draft-07 JSON Schema object (the create route rejects a raw Zod schema); the
 * returned MessageResponse exposes the created sessionId synchronously and streams
 * the ATTACHED session's events via result()/for-await; and a non-2xx create throws.
 */

/** A fake eve Client capturing the create-fetch body and serving an attached stream. */
function makeClient(opts: {
  createBody?: { ok?: boolean; sessionId?: string }
  createOk?: boolean
  createStatus?: number
  streamEvents?: HandleMessageStreamEvent[]
  /** Thrown by the stream after every streamEvents entry (an aborted stream). */
  streamError?: Error
}) {
  const fetchCalls: Array<{ path: string; init?: RequestInit }> = []
  const attachCalls: Array<{ sessionId: string; options: unknown }> = []
  const createOk = opts.createOk ?? true

  const client = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      fetchCalls.push({ path, init })
      if (!createOk) {
        return { ok: false, status: opts.createStatus ?? 500, json: async () => ({}), headers: new Headers() }
      }
      return {
        ok: true,
        status: 200,
        json: async () => opts.createBody ?? { ok: true, sessionId: 'wrun_NEW' },
        headers: new Headers(),
      }
    }),
    // client.sessions.attach(id, { streamIndex }) → a handle whose .stream()
    // yields the fake events (eve 0.31.0: attach replaces client.session(state)).
    sessions: {
      attach: vi.fn((sessionId: string, options?: unknown) => {
        attachCalls.push({ sessionId, options })
        return {
          cancel: vi.fn(async () => ({ status: 'no_active_turn' as const })),
          stream: () => {
            async function* gen() {
              for (const ev of opts.streamEvents ?? []) yield ev
              if (opts.streamError) throw opts.streamError
            }
            return gen()
          },
        }
      }),
    },
  }
  return { client, fetchCalls, attachCalls }
}

function messageCompleted(text: string): HandleMessageStreamEvent {
  return {
    type: 'message.completed',
    data: { finishReason: 'stop', messageId: 'm', message: text, sequence: 0, stepIndex: 0, turnId: 't' },
  } as unknown as HandleMessageStreamEvent
}
function sessionCompleted(): HandleMessageStreamEvent {
  return { type: 'session.completed' } as HandleMessageStreamEvent
}

describe('createTaskSession', () => {
  it('creates the session with the message in the body and no `mode` (eve 0.67+ ignores it)', async () => {
    const { client, fetchCalls } = makeClient({
      streamEvents: [messageCompleted('done'), sessionCompleted()],
    })

    const response = await createTaskSession(client as never, { message: 'do the thing' })

    // The create POST hit the eve create route.
    expect(fetchCalls).toHaveLength(1)
    expect(fetchCalls[0].path).toBe('/eve/v1/session')
    expect(fetchCalls[0].init?.method).toBe('POST')

    const body = JSON.parse(fetchCalls[0].init!.body as string) as {
      message: string
      mode?: string
      outputSchema?: unknown
    }
    expect(body.mode).toBeUndefined()
    expect(body.message).toBe('do the thing')
    expect(body.outputSchema).toBeUndefined()

    // sessionId is available synchronously from the create response.
    expect(response.sessionId).toBe('wrun_NEW')
  })

  it('a UserContent message (file part + text, like reference ingest sends) rides the create body verbatim', async () => {
    const { client, fetchCalls } = makeClient({ streamEvents: [sessionCompleted()] })
    const message: UserContent = [
      createDataUrlFilePart({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mediaType: 'application/pdf' }),
      { type: 'file', data: 'https://storage.test/seg.pdf?sig=1', mediaType: 'application/pdf' },
      { type: 'text', text: 'File name: spec.pdf' },
    ]
    await createTaskSession(client as never, { message })
    const body = JSON.parse(fetchCalls[0].init!.body as string) as { message: unknown; mode?: string }
    expect(body.mode).toBeUndefined()
    expect(body.message).toEqual([
      { type: 'file', data: 'data:application/pdf;base64,JVBERg==', mediaType: 'application/pdf' },
      { type: 'file', data: 'https://storage.test/seg.pdf?sig=1', mediaType: 'application/pdf' },
      { type: 'text', text: 'File name: spec.pdf' },
    ])
  })

  it('streams the attached session so result() aggregates the terminal message', async () => {
    const { client, attachCalls } = makeClient({
      createBody: { ok: true, sessionId: 'wrun_ABC' },
      streamEvents: [messageCompleted('the report'), sessionCompleted()],
    })

    const response = await createTaskSession(client as never, { message: 'go' })
    const result = await response.result()

    expect(result.status).toBe('completed')
    expect(result.message).toBe('the report')
    // The handle was ATTACHED to the CREATED id at index 0 (eve 0.31.0 — no
    // continuation token is involved, and attach performs no I/O).
    expect(attachCalls).toHaveLength(1)
    expect(attachCalls[0].sessionId).toBe('wrun_ABC')
    expect(attachCalls[0].options).toMatchObject({ streamIndex: 0 })
  })

  it('the create POST uses `signal` by default, and `createSignal` in its place when given', async () => {
    const signal = new AbortController().signal
    const createSignal = new AbortController().signal
    const a = makeClient({ streamEvents: [sessionCompleted()] })
    await createTaskSession(a.client as never, { message: 'go', signal })
    expect(a.fetchCalls[0].init?.signal).toBe(signal)
    const b = makeClient({ streamEvents: [sessionCompleted()] })
    await createTaskSession(b.client as never, { message: 'go', signal, createSignal })
    expect(b.fetchCalls[0].init?.signal).toBe(createSignal)
  })

  it('never sends a continuationToken in the create body (0.47.7 rejects one)', async () => {
    const { client, fetchCalls } = makeClient({ streamEvents: [sessionCompleted()] })
    await createTaskSession(client as never, { message: 'go' })
    const body = JSON.parse(fetchCalls[0].init!.body as string) as Record<string, unknown>
    expect(body.continuationToken).toBeUndefined()
  })

  it('lowers a Zod outputSchema to a plain draft-07 JSON Schema object in the body', async () => {
    const { client, fetchCalls } = makeClient({
      streamEvents: [sessionCompleted()],
    })
    const schema = z.object({ summary: z.string(), count: z.number() })

    await createTaskSession(client as never, { message: 'verdict', outputSchema: schema })

    const body = JSON.parse(fetchCalls[0].init!.body as string) as {
      mode?: string
      outputSchema: { $schema?: string; type?: string; properties?: Record<string, unknown> }
    }
    expect(body.mode).toBeUndefined()
    // A plain JSON Schema object, NOT a Zod instance — draft-07 (matches the
    // typed client's normalizeJsonSchemaDefinition → ~standard.jsonSchema.output).
    expect(body.outputSchema.$schema).toContain('draft-07')
    expect(body.outputSchema.type).toBe('object')
    expect(Object.keys(body.outputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(['summary', 'count']),
    )
  })

  // On eve the verdict triage policy rides ONLY on the outputSchema's top-level
  // description (eve's eve__reply tool has a fixed description and takes the
  // lowered schema as its input schema). Drive the real verdict schema through
  // createTaskSession's own lowering so a change there cannot drop it silently.
  it('keeps the verdict schema’s policy description through the lowering into the create body', async () => {
    const { client, fetchCalls } = makeClient({ streamEvents: [sessionCompleted()] })

    await createTaskSession(client as never, { message: 'verdict', outputSchema: verdictOutputSchema })

    const body = JSON.parse(fetchCalls[0].init!.body as string) as {
      outputSchema: { description?: string; properties?: Record<string, unknown> }
    }
    expect(body.outputSchema.description).toBe(VERDICT_POLICY_GUIDANCE)
    expect(Object.keys(body.outputSchema.properties ?? {})).toEqual(['decisions', 'needs_user', 'summary'])
  })

  it('falls back to the x-eve-session-id header when the JSON omits sessionId', async () => {
    const fetchCalls: Array<{ path: string; init?: RequestInit }> = []
    const client = {
      fetch: vi.fn(async (path: string, init?: RequestInit) => {
        fetchCalls.push({ path, init })
        const headers = new Headers()
        headers.set('x-eve-session-id', 'wrun_FROM_HEADER')
        return { ok: true, status: 200, json: async () => ({ ok: true }), headers }
      }),
      sessions: {
        attach: vi.fn(() => ({
          cancel: vi.fn(async () => ({ status: 'no_active_turn' as const })),
          stream: () => {
            async function* gen() {
              yield sessionCompleted()
            }
            return gen()
          },
        })),
      },
    }

    const response = await createTaskSession(client as never, { message: 'go' })
    expect(response.sessionId).toBe('wrun_FROM_HEADER')
  })

  it('cuts the stream at the turn boundary: a parked session (eve 0.67+) never closes its stream', async () => {
    const tail = vi.fn()
    const client = {
      fetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'wrun_PARK' }), headers: new Headers() })),
      sessions: {
        attach: vi.fn(() => ({
          cancel: vi.fn(async () => ({ status: 'no_active_turn' as const })),
          stream: () => {
            async function* gen() {
              yield { type: 'turn.started', data: { turnId: 't', sequence: 1 } } as HandleMessageStreamEvent
              yield messageCompleted('the answer')
              yield { type: 'turn.completed', data: { turnId: 't', sequence: 1 } } as HandleMessageStreamEvent
              yield { type: 'session.waiting', data: { continuationToken: 'wrun_PARK', wait: 'next-user-message' } } as HandleMessageStreamEvent
              tail()
              await new Promise(() => {}) // the durable stream stays open on a park
            }
            return gen()
          },
        })),
      },
    }
    const response = await createTaskSession(client as never, { message: 'go' })
    const result = await response.result()
    expect(result.message).toBe('the answer')
    // A clean end reads `waiting` (the session parked); classifyOneShot reads the turn.
    expect(result.status).toBe('waiting')
    expect(classifyOneShot(result.events.at(-1), result.events)).toMatchObject({ status: 'completed', turnEnded: true })
    expect(tail).not.toHaveBeenCalled()
  })

  it('throws when the create POST fails', async () => {
    const { client } = makeClient({ createOk: false, createStatus: 503 })
    await expect(createTaskSession(client as never, { message: 'go' })).rejects.toThrow(
      /task-session create failed \(503\)/,
    )
  })

  it('throws when the create response carries no session id', async () => {
    const { client } = makeClient({ createBody: { ok: true } })
    await expect(createTaskSession(client as never, { message: 'go' })).rejects.toThrow(/no sessionId/)
  })

  it('onEvent taps every streamed event, in order, and result() still aggregates them', async () => {
    const events = [messageCompleted('the report'), sessionCompleted()]
    const { client } = makeClient({ streamEvents: events })
    const tapped: HandleMessageStreamEvent[] = []

    const response = await createTaskSession(client as never, {
      message: 'go',
      onEvent: (ev) => tapped.push(ev as HandleMessageStreamEvent),
    })
    const result = await response.result()

    expect(tapped).toEqual(events)
    expect(result.status).toBe('completed')
    expect(result.message).toBe('the report')
  })

  it('onEvent keeps the events a stream delivered before it threw (result() loses them)', async () => {
    const { client } = makeClient({
      streamEvents: [messageCompleted('partial')],
      streamError: new Error('This operation was aborted'),
    })
    const tapped: HandleMessageStreamEvent[] = []

    const response = await createTaskSession(client as never, {
      message: 'go',
      onEvent: (ev) => tapped.push(ev as HandleMessageStreamEvent),
    })

    await expect(response.result()).rejects.toThrow(/aborted/)
    expect(tapped.map((e) => e.type)).toEqual(['message.completed'])
  })
})

describe('cancelTaskSession', () => {
  /** A fake client whose attached handle records its cancel options. */
  function cancelClient(cancelImpl: (opts: unknown) => Promise<unknown>) {
    const cancel = vi.fn(cancelImpl)
    const attach = vi.fn(() => ({ cancel }))
    return { client: { sessions: { attach } } as never, attach, cancel }
  }

  it('cancels the whole session (eve 0.69+ stops its working tasks too) with no turnId guard', async () => {
    const { client, attach, cancel } = cancelClient(async () => ({ status: 'accepted', sessionId: 'wrun_1' }))
    await expect(cancelTaskSession(client, 'wrun_1')).resolves.toBe(true)
    expect(attach).toHaveBeenCalledWith('wrun_1')
    expect(cancel).toHaveBeenCalledTimes(1)
    const opts = cancel.mock.calls[0][0] as { tasks?: boolean; turnId?: string; signal?: AbortSignal }
    // eve 0.69 removed the `tasks` option: a plain cancel stops working tasks.
    expect(opts.tasks).toBeUndefined()
    // Session-level: a wall that fires before turn.started must still stop the turn.
    expect(opts.turnId).toBeUndefined()
    // Bounded — a hung cancel route cannot stall the caller.
    expect(opts.signal).toBeInstanceOf(AbortSignal)
  })

  it('bounds the cancel POST at 5s by default, or at opts.timeoutMs for a caller with a tighter wall', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    try {
      const { client } = cancelClient(async () => ({ status: 'accepted' }))
      await cancelTaskSession(client, 'wrun_1')
      expect(timeoutSpy).toHaveBeenLastCalledWith(5_000)
      await cancelTaskSession(client, 'wrun_1', { timeoutMs: 1234 })
      expect(timeoutSpy).toHaveBeenLastCalledWith(1234)
    } finally {
      timeoutSpy.mockRestore()
    }
  })

  it("'no_active_turn' (already settled) is a success", async () => {
    const { client } = cancelClient(async () => ({ status: 'no_active_turn' }))
    await expect(cancelTaskSession(client, 'wrun_1')).resolves.toBe(true)
  })

  it('never throws when the cancel request fails', async () => {
    const { client } = cancelClient(async () => {
      throw new Error('Cancel route returned an invalid response (500).')
    })
    await expect(cancelTaskSession(client, 'wrun_1')).resolves.toBe(false)
  })
})
