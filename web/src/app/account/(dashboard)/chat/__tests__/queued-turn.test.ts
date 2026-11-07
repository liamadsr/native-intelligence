/**
 * Adding a send to the message already waiting for the reply (queued-turn.ts):
 * one turn, the words in order, everything attached kept once, the first skill,
 * the newest agent, selection and ask; and Edit's words go back ahead of
 * anything typed since.
 */
import { describe, it, expect } from 'vitest'
import { canSteer, composerTextWithQueued, mergeQueuedTurn, steerContextKey, type QueuedTurn } from '../queued-turn'

const file = (id: string) => ({ id, file: new File(['x'], `${id}.png`), status: 'ready' as const, url: `https://x/${id}` })
const turn = (over: Partial<QueuedTurn> = {}): QueuedTurn => ({
  text: '',
  spokenOnly: false,
  files: [],
  notes: [],
  contacts: [],
  companies: [],
  skill: null,
  agentId: null,
  selection: null,
  context: {},
  contextSwitched: false,
  ...over,
})
const skill = (id: string) => ({ id, slug: id, name: id, icon: null, color: null, description: null, views_context: null }) as never

describe('mergeQueuedTurn', () => {
  it('takes the first send as it is', () => {
    const next = turn({ text: 'hi' })
    expect(mergeQueuedTurn(null, next)).toBe(next)
  })

  it('joins the words with a blank line and skips an empty send', () => {
    expect(mergeQueuedTurn(turn({ text: 'one' }), turn({ text: 'two' })).text).toBe('one\n\ntwo')
    expect(mergeQueuedTurn(turn({ text: 'one' }), turn({ text: '  ', files: [file('a')] })).text).toBe('one')
  })

  it('keeps every file and mention once', () => {
    const merged = mergeQueuedTurn(
      turn({ files: [file('a')], contacts: [{ id: 'c1' } as never] }),
      turn({ files: [file('a'), file('b')], contacts: [{ id: 'c1' } as never, { id: 'c2' } as never] }),
    )
    expect(merged.files.map((f) => f.id)).toEqual(['a', 'b'])
    expect(merged.contacts.map((c) => c.id)).toEqual(['c1', 'c2'])
  })

  it('keeps the first skill, and the newest agent, selection and ask', () => {
    const merged = mergeQueuedTurn(
      turn({ skill: skill('s1'), agentId: 'a1', selection: { text: 'old' } as never }),
      turn({ skill: skill('s2'), agentId: 'a2', selection: { text: 'new' } as never, voiceAsk: { kind: 'x' } as never }),
    )
    expect((merged.skill as { id: string }).id).toBe('s1')
    expect(merged.agentId).toBe('a2')
    expect(merged.selection).toEqual({ text: 'new' })
    expect(merged.voiceAsk).toEqual({ kind: 'x' })
  })

  it('goes with the newest page, and says the user moved if either send did', () => {
    const merged = mergeQueuedTurn(
      turn({ context: { assistantName: 'A' }, contextSwitched: true }),
      turn({ context: { assistantName: 'B' }, contextSwitched: false }),
    )
    expect(merged.context).toEqual({ assistantName: 'B' })
    expect(merged.contextSwitched).toBe(true)
  })

  it('stays spoken only while every part was spoken', () => {
    expect(mergeQueuedTurn(turn({ spokenOnly: true }), turn({ spokenOnly: true })).spokenOnly).toBe(true)
    expect(mergeQueuedTurn(turn({ spokenOnly: true }), turn({ spokenOnly: false })).spokenOnly).toBe(false)
  })

  it('stays a voice-mode turn only while every part was said in voice mode', () => {
    expect(mergeQueuedTurn(turn({ voiceMode: true }), turn({ voiceMode: true })).voiceMode).toBe(true)
    expect(mergeQueuedTurn(turn({ voiceMode: true }), turn({})).voiceMode).toBeUndefined()
    expect(mergeQueuedTurn(turn({}), turn({ voiceMode: true })).voiceMode).toBeUndefined()
  })
})

describe('composerTextWithQueued', () => {
  it('puts the waiting words back, ahead of anything typed since', () => {
    expect(composerTextWithQueued('queued', '')).toBe('queued')
    expect(composerTextWithQueued('queued', 'typed since')).toBe('queued\n\ntyped since')
    expect(composerTextWithQueued('', 'typed since')).toBe('typed since')
  })
})

describe('surface turns (A3 verification)', () => {
  it('stays a surface turn only when both are, and keeps the cards of both, once, in order', () => {
    const a = turn({ text: 'one', surface: true, context: { aboutCardIds: ['c1', 'c2'] } })
    const b = turn({ text: 'two', surface: true, context: { aboutCardIds: ['c2', 'c3'] } })
    const merged = mergeQueuedTurn(a, b)
    expect(merged.surface).toBe(true)
    expect(merged.context.aboutCardIds).toEqual(['c1', 'c2', 'c3'])
    const typed = mergeQueuedTurn(a, turn({ text: 'typed' }))
    expect(typed.surface).toBeUndefined()
    expect(typed.context.aboutCardIds).toEqual(['c1', 'c2'])
    expect(mergeQueuedTurn(turn({ text: 'x' }), turn({ text: 'y' })).context).toEqual({})
  })

  it('a replied card joining a waiting turn keeps its id first among the cards (the server keeps the first few)', () => {
    const replyCard = { kind: 'card' as const, id: 'r1', workspaceId: 'w', verb: 'Add', sentence: 's', subkind: 'action_card' }
    const a = turn({ text: 'one', surface: true, context: { aboutCardIds: ['c1', 'c2', 'c3', 'c4', 'c5'] } })
    const b = turn({ text: 'two', context: { replyCard, aboutCardIds: ['r1'] } })
    const merged = mergeQueuedTurn(a, b)
    expect(merged.context.replyCard).toEqual(replyCard)
    expect(merged.context.aboutCardIds).toEqual(['r1', 'c1', 'c2', 'c3', 'c4', 'c5'])
    // A review rides as itself: no id among the cards.
    // The message replied to rides the same way: the newer one's, else the one waiting.
    const replyTo = { messageId: 'eve-msg-a1', role: 'assistant' as const, quote: 'just your calendar', part: true }
    expect(mergeQueuedTurn(turn({ text: 'x', context: { replyTo } }), turn({ text: 'y' })).context.replyTo).toEqual(replyTo)
    const newer = { ...replyTo, messageId: 'eve-msg-a2' }
    expect(mergeQueuedTurn(turn({ text: 'x', context: { replyTo } }), turn({ text: 'y', context: { replyTo: newer } })).context.replyTo).toEqual(newer)
    const review = { ...replyCard, kind: 'review' as const, subkind: 'work_run' }
    expect(mergeQueuedTurn(turn({ text: 'x' }), turn({ text: 'y', context: { replyCard: review } })).context).toEqual({ replyCard: review })
  })

  it('a surface turn is plain words, never spoken: it can steer by the same rules as typed words', () => {
    const context = {}
    const running = { contextKey: steerContextKey(context), agentId: null }
    expect(canSteer(turn({ text: 'shorter', surface: true, context }), running, steerContextKey(context))).toBe(true)
    // Its cards are its page: a running reply sent without them is not steered by it.
    const withCards = { aboutCardIds: ['c1'] }
    expect(canSteer(turn({ text: 'shorter', surface: true, context: withCards }), running, steerContextKey(withCards))).toBe(false)
  })
})
