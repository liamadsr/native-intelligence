import { describe, it, expect, vi } from 'vitest'

vi.mock('next/server', async (importOriginal) => ({ ...(await importOriginal<typeof import('next/server')>()), after: vi.fn() }))

import { sessionHasOpenTurn } from '../bot-relay'

/**
 * The relay's busy check (bots v4 A3): a run's session in the middle of a turn
 * refuses the relayed message. eve 0.70+ holds a turn open on a question or an
 * approval (turn.waiting on input, no session.waiting); a relayed message
 * landing there would steer it, cancelling the approval or answering the
 * question, so a held turn counts as busy.
 */

const ev = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { turnId: 't', sequence: 1, ...data } })
function session(events: Array<ReturnType<typeof ev>>) {
  return {
    stream: () =>
      (async function* () {
        for (const e of events) yield e
      })(),
  } as never
}
const target = { kind: 'work_run', sessionState: { sessionId: 's', streamIndex: 0 } } as never

describe('sessionHasOpenTurn', () => {
  it('a turn held on a person (turn.waiting on input) is busy', async () => {
    expect(await sessionHasOpenTurn(session([ev('turn.started'), ev('input.requested', { requests: [] }), ev('turn.waiting', { on: 'input' })]), target)).toBe(true)
  })

  it('a turn that ended (turn.completed, session.waiting) is not', async () => {
    expect(await sessionHasOpenTurn(session([ev('turn.started'), ev('turn.completed'), ev('session.waiting')]), target)).toBe(false)
  })

  it('a turn waiting on its own tasks is still open', async () => {
    expect(await sessionHasOpenTurn(session([ev('turn.started'), ev('turn.waiting', { on: 'tasks' })]), target)).toBe(true)
  })
})
