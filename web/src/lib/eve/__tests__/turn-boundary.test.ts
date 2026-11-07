import { describe, it, expect } from 'vitest'
import type { MessageStreamEvent } from 'eve/client'
import { classifyOneShot, createTurnBoundary, turnHasEnded } from '../turn-boundary'

/**
 * The turn-boundary rules for readers of a durable eve stream on eve 0.79:
 * every session parks after its turn (0.67), and a question, approval or
 * sign-in holds the turn open at `turn.waiting` (0.70).
 */

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { turnId: 't', sequence: 1, ...data } }) as unknown as MessageStreamEvent
const waiting = () => ev('session.waiting', { continuationToken: 's', wait: 'next-user-message' })

function stopsAt(events: MessageStreamEvent[]): number {
  const ends = createTurnBoundary()
  return events.findIndex((e) => ends(e))
}

describe('createTurnBoundary', () => {
  it('ends at session.waiting / completed / failed, never at turn.completed alone', () => {
    expect(stopsAt([ev('turn.started'), ev('turn.completed'), waiting()])).toBe(2)
    expect(stopsAt([ev('turn.started'), ev('session.completed')])).toBe(1)
    expect(stopsAt([ev('turn.started'), ev('turn.failed', { code: 'X', message: 'm', terminal: true }), ev('session.failed', { code: 'X', message: 'm' })])).toBe(2)
  })

  it('ends at a turn.waiting on a person (eve 0.70+ holds the turn on an approval)', () => {
    const request = { requestId: 'r1', kind: 'approval' }
    expect(stopsAt([ev('turn.started'), ev('input.requested', { requests: [request] }), ev('turn.waiting', { on: 'input' })])).toBe(2)
  })

  it('does not end at a turn.waiting on its own tasks, unless a question is open', () => {
    expect(stopsAt([ev('turn.started'), ev('turn.waiting', { on: 'tasks' }), ev('turn.completed'), waiting()])).toBe(3)
    const request = { requestId: 'r1', kind: 'question' }
    expect(stopsAt([ev('input.requested', { requests: [request] }), ev('turn.waiting', { on: 'tasks' })])).toBe(1)
    // An answered question no longer holds the drain open on a tasks wait.
    expect(stopsAt([
      ev('input.requested', { requests: [request] }),
      ev('input.resolved', { resolutions: [{ requestId: 'r1', kind: 'question', outcome: 'answered' }] }),
      ev('turn.waiting', { on: 'tasks' }),
      waiting(),
    ])).toBe(3)
  })

  it('keeps reading across a webhook sign-in, whether eve parks the turn or the session', () => {
    const signIn = ev('authorization.required', { name: 'linear', attemptId: 'a1', webhookUrl: 'https://x/cb', description: 'd' })
    const done = ev('authorization.completed', { name: 'linear', attemptId: 'a1', outcome: 'authorized' })
    expect(stopsAt([signIn, ev('turn.waiting', { on: 'input' }), done, ev('turn.completed'), waiting()])).toBe(4)
    expect(stopsAt([signIn, waiting(), done, waiting()])).toBe(3)
  })
})

describe('classifyOneShot', () => {
  it('a turn that completed and parked is completed, and nothing is left running', () => {
    const events = [ev('turn.started'), ev('turn.completed'), waiting()]
    expect(classifyOneShot(events[2], events)).toEqual({ status: 'completed', failureCode: null, semanticErrorId: null, turnEnded: true })
  })

  it('a turn that failed and parked carries the turn.failed code', () => {
    const events = [ev('turn.started'), ev('turn.failed', { code: 'MODEL_ERROR', message: 'm', details: { semanticErrorId: 'sem-1' } }), waiting()]
    expect(classifyOneShot(events[2], events)).toEqual({ status: 'failed', failureCode: 'MODEL_ERROR', semanticErrorId: 'sem-1', turnEnded: true })
  })

  it('session.failed and a cancelled turn are failures; session.completed is a success', () => {
    const failed = ev('session.failed', { code: 'SESSION_TOKEN_LIMIT_REACHED', message: 'm' })
    expect(classifyOneShot(failed, [failed])).toMatchObject({ status: 'failed', failureCode: 'SESSION_TOKEN_LIMIT_REACHED' })
    const cancelled = [ev('turn.started'), ev('turn.cancelled'), waiting()]
    expect(classifyOneShot(cancelled[2], cancelled)).toMatchObject({ status: 'failed', failureCode: 'TURN_CANCELLED', turnEnded: true })
    const done = ev('session.completed')
    expect(classifyOneShot(done, [done])).toMatchObject({ status: 'completed' })
  })

  it('a park on a person, or a park with no turn end, is waiting and still alive', () => {
    const held = [ev('turn.started'), ev('turn.waiting', { on: 'input' })]
    expect(classifyOneShot(held[1], held)).toMatchObject({ status: 'waiting', turnEnded: false })
    const bare = [ev('turn.started'), waiting()]
    expect(classifyOneShot(bare[1], bare)).toMatchObject({ status: 'waiting', turnEnded: false })
  })

  it('only the current turn counts, and no boundary is null (never a silent success)', () => {
    const events = [ev('turn.completed'), ev('turn.started'), waiting()]
    expect(classifyOneShot(events[2], events)).toMatchObject({ status: 'waiting' })
    expect(classifyOneShot(undefined, [ev('turn.completed')])).toBeNull()
  })
})

describe('turnHasEnded', () => {
  it('is true once eve reports a turn or the session over', () => {
    expect(turnHasEnded([ev('turn.started'), ev('turn.completed')])).toBe(true)
    expect(turnHasEnded([ev('turn.started'), ev('turn.failed', { code: 'X', message: 'm' })])).toBe(true)
    expect(turnHasEnded([ev('session.failed', { code: 'X', message: 'm' })])).toBe(true)
    expect(turnHasEnded([ev('turn.started'), ev('turn.waiting', { on: 'input' })])).toBe(false)
  })
})
