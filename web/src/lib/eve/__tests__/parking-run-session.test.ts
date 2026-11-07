import { describe, it, expect, vi } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import { verdictOutputSchema } from '@/lib/flows/verdict-schema'
import { createParkingRunSession } from '../task-session'

/**
 * createParkingRunSession (bots v3 Phase 4): the unattended run whose session
 * PARKS when its turn ends, so the loop's bot can continue it. Pinned here:
 *   - the create POST carries no `mode` (eve 0.67 removed run modes), with the
 *     outputSchema lowered to JSON Schema for this first turn;
 *   - the stream is CUT at the turn boundary (a parked session's durable stream
 *     never closes on its own, so an uncut read would hang the run), and a
 *     clean end reads as status `waiting`;
 *   - the attached session is handed back, its state the resume snapshot.
 */
function makeClient(events: HandleMessageStreamEvent[]) {
  const bodies: Array<Record<string, unknown>> = []
  let readPastBoundary = false
  const session = {
    state: { sessionId: 'sess-1', streamIndex: 0 },
    cancel: vi.fn(async () => ({ status: 'no_active_turn' as const })),
    stream: () => {
      async function* gen() {
        for (const ev of events) yield ev
        // A parked session's stream stays open: reaching here means the cut failed.
        readPastBoundary = true
        await new Promise(() => {})
      }
      return gen()
    },
  }
  const client = {
    fetch: vi.fn(async (_path: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return { ok: true, status: 200, json: async () => ({ ok: true, sessionId: 'sess-1' }), headers: new Headers() }
    }),
    sessions: { attach: vi.fn(() => session) },
  }
  return { client, bodies, session, readPastBoundary: () => readPastBoundary }
}

const ev = (type: string, data: Record<string, unknown> = {}) =>
  ({ type, data: { sequence: 0, stepIndex: 0, turnId: 't', ...data } }) as unknown as HandleMessageStreamEvent

describe('createParkingRunSession', () => {
  it('creates the session with the first turn’s outputSchema as JSON Schema and no `mode` (eve 0.67+ ignores it)', async () => {
    const { client, bodies } = makeClient([ev('session.waiting')])
    await createParkingRunSession(client as never, { message: 'triage this', outputSchema: verdictOutputSchema })
    expect(bodies[0].mode).toBeUndefined()
    expect(bodies[0].message).toBe('triage this')
    expect(typeof bodies[0].outputSchema).toBe('object')
    expect(bodies[0].outputSchema).not.toHaveProperty('~standard')
  })

  it('cuts the stream at session.waiting: the run ends, status waiting, nothing read past the park', async () => {
    const tapped: string[] = []
    const { client, session, readPastBoundary } = makeClient([
      ev('step.completed', { finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1 } }),
      ev('message.completed', { finishReason: 'stop', message: 'done' }),
      ev('session.waiting'),
    ])
    const { response, session: handed } = await createParkingRunSession(client as never, {
      message: 'go',
      onEvent: (e) => tapped.push(e.type),
    })
    const result = await response.result()
    expect(result.status).toBe('waiting')
    expect(result.message).toBe('done')
    expect(tapped).toEqual(['step.completed', 'message.completed', 'session.waiting'])
    expect(readPastBoundary()).toBe(false)
    expect(handed).toBe(session)
    expect(response.sessionId).toBe('sess-1')
  })

  it('a turn that asks for input parks on it: the caller sees the request', async () => {
    const { client } = makeClient([
      ev('input.requested', { requests: [{ requestId: 'r1', kind: 'question' }] }),
      ev('session.waiting'),
    ])
    const { response } = await createParkingRunSession(client as never, { message: 'go' })
    const result = await response.result()
    expect(result.status).toBe('waiting')
    expect(result.inputRequests).toHaveLength(1)
  })
})
