/**
 * Steering a running reply with the held message (queued-turn.ts, UI-2): which
 * messages may steer (plain words on the same page, with the same agent), the
 * page key they compare, and the row's state machine.
 */
import { describe, it, expect } from 'vitest'
import {
  canSteer,
  mergeQueuedTurn,
  steerAfterPhase,
  steerContextKey,
  withSteer,
  type QueuedSteer,
  type QueuedTurn,
  type RunningTurnKey,
} from '../queued-turn'

const turn = (over: Partial<QueuedTurn> = {}): QueuedTurn => ({
  text: 'actually, the Q3 numbers',
  spokenOnly: false,
  files: [],
  notes: [],
  contacts: [],
  companies: [],
  skill: null,
  agentId: null,
  selection: null,
  context: { assistantName: 'Dial' },
  contextSwitched: false,
  ...over,
})
const key = (t: QueuedTurn) => steerContextKey(t.context)
const running = (t: QueuedTurn = turn()): RunningTurnKey => ({
  contextKey: key(t),
  agentId: t.agentId,
})

describe('canSteer', () => {
  it('lets plain words typed on the running turn’s page, with its agent, steer', () => {
    const t = turn()
    expect(canSteer(t, running(), key(t))).toBe(true)
  })

  it('never steers without a running composer turn', () => {
    const t = turn()
    expect(canSteer(t, null, key(t))).toBe(false)
  })

  it('keeps files, mentions, a skill, a selection, spoken words and Interactive asks wait-only', () => {
    const cases: Array<Partial<QueuedTurn>> = [
      { files: [{ id: 'f', file: new File(['x'], 'a.png'), status: 'ready' }] },
      { notes: [{ id: 'n' } as never] },
      { contacts: [{ id: 'c' } as never] },
      { companies: [{ id: 'co' } as never] },
      // A mentioned action, doc, project or initiative rides only a turn's own context: it waits too.
      { records: [{ kind: 'action', id: 'a', title: 'x' }] },
      { skill: { id: 's', slug: 's' } as never },
      { selection: { text: 'x' } as never },
      { spokenOnly: true },
      { voiceAsk: { kind: 'x' } as never },
      { contextSwitched: true },
      { text: '   ' },
    ]
    for (const over of cases) {
      const t = turn(over)
      expect(canSteer(t, running(), key(t))).toBe(false)
    }
  })

  it('keeps an agent change or another page wait-only (a steer carries no turn context)', () => {
    const t = turn({ agentId: 'agent-2' })
    expect(canSteer(t, running(turn({ agentId: 'agent-1' })), key(t))).toBe(false)
    const other = turn({ context: { assistantName: 'Dial', prospectingSelection: { listId: 'l1' } as never } })
    expect(canSteer(other, running(), key(other))).toBe(false)
    // A call the running turn didn't know of is another page too.
    const t2 = turn()
    const onCall = turn({ context: { onCallCaptureId: 'cap-1' } })
    expect(canSteer(t2, running(t2), key(onCall))).toBe(false)
  })
})

describe('steerContextKey', () => {
  it('is the same for equal contexts whatever the key order', () => {
    expect(steerContextKey({ assistantName: 'A', isDesktopClient: true })).toBe(
      steerContextKey({ isDesktopClient: true, assistantName: 'A' }),
    )
  })

  it('leaves out the reactions since the last message (they never make two pages different)', () => {
    const reactions = [{ emoji: '❤️', excerpt: 'Your calendar is connected.', asked: false, at: '2026-10-20T10:00:00.000Z' }]
    expect(steerContextKey({ assistantName: 'A', reactions })).toBe(steerContextKey({ assistantName: 'A' }))
  })
})

describe('steerAfterPhase (the row’s state machine)', () => {
  const held: QueuedSteer = { id: 's1', state: 'held' }

  it('held → posting → posted, and stays posted for applied / next_turn until the flush adopts it', () => {
    const posting = steerAfterPhase(held, 'posting')
    expect(posting).toEqual({ id: 's1', state: 'posting' })
    const posted = steerAfterPhase(posting, 'posted')
    expect(posted).toEqual({ id: 's1', state: 'posted' })
    expect(steerAfterPhase(posted, 'applied')).toBe(posted)
    expect(steerAfterPhase(posted, 'next_turn')).toBe(posted)
  })

  it('failed → no steer: the message waits for the end as an ordinary held turn', () => {
    expect(steerAfterPhase({ id: 's1', state: 'posting' }, 'failed')).toBeUndefined()
    expect(steerAfterPhase(held, 'failed')).toBeUndefined()
  })

  it('keeps an Edit-came-too-late note across phases', () => {
    expect(steerAfterPhase({ id: 's1', state: 'posting', onItsWay: true }, 'posted')).toEqual({ id: 's1', state: 'posted', onItsWay: true })
  })
})

describe('withSteer / mergeQueuedTurn', () => {
  it('sets and removes the steer', () => {
    const t = withSteer(turn(), { id: 's1', state: 'held' })
    expect(t.steer).toEqual({ id: 's1', state: 'held' })
    expect('steer' in withSteer(t, undefined)).toBe(false)
  })

  it('a joined turn carries no steer (the held one is taken back and asked again)', () => {
    const merged = mergeQueuedTurn(withSteer(turn({ text: 'one' }), { id: 's1', state: 'held' }), turn({ text: 'two' }))
    expect(merged.steer).toBeUndefined()
    expect(merged.text).toBe('one\n\ntwo')
  })
})
