/**
 * A call's outcome in the home thread (P13, home-asks.ts; Liam: "Add them
 * itself when it's confident, with undo; only ask in chat when it isn't
 * sure"): what the runs added (Triage's existing gate) said with an Undo,
 * what they asked inline, one message per burst, grouped per call, asked
 * once; nothing to say, no message.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  ASKED_KEY,
  addedPhrase,
  announcePendingAsks,
  asksPhrase,
  groupAsks,
  groupLine,
  mergeHomeAsksRequests,
  parseHomeAsksRequested,
  sourceWords,
} from '../home-asks'
import { ASK_CARDS_MESSAGE_KIND, ASK_CARDS_PART_TYPE, askCardsPartData } from '../chat-asks'

const WS = 'ws-1'
const USER = 'user-1'
const CAP_A = 'aaaaaaaa-0000-4000-8000-000000000001'
const CAP_B = 'bbbbbbbb-0000-4000-8000-000000000002'
const id = (n: number) => `cccccccc-0000-4000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.parse('2026-10-20T12:00:00.000Z')
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString()

const card = (n: number, over: Record<string, unknown> = {}) => ({
  id: id(n),
  workspace_id: WS,
  member_id: 'm1',
  kind: 'action_card',
  title: `Suggestion ${n}`,
  status: 'pending',
  expires_at: null,
  run_key: 'fire-1',
  created_at: ago(10 - n),
  payload: { change_type: 'update', entity_type: 'action', capture_id: CAP_A, capture_title: 'Acme sync' },
  ...over,
})

const added = (n: number, capture = CAP_A, over: Record<string, unknown> = {}) => ({
  change_id: id(100 + n),
  entity_id: id(200 + n),
  entity_type: 'action',
  capture_id: capture,
  source: capture === CAP_A ? 'your call “Acme sync”' : 'your call “Globex intro”',
  ...over,
})

let db: FakeSupabase
const append = vi.fn(async (..._a: unknown[]) => ({ written: true }))
const messages = () => append.mock.calls.map((c) => c[1] as { messageId: string; parts: Array<{ type: string; text?: string; data?: unknown }>; metadata: Record<string, unknown> })

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('member', [{ id: 'm1', workspace_id: WS, user_id: USER }])
  db.seed('actions', [
    { id: id(201), workspace_id: WS, identifier: 'ENG-51' },
    { id: id(202), workspace_id: WS, identifier: 'ENG-52' },
  ])
  append.mockClear()
})

describe('the words', () => {
  it('a source is the call’s title, else the skill, else one of your loops', () => {
    expect(sourceWords('Acme sync', 'triage')).toBe('your call “Acme sync”')
    expect(sourceWords(null, 'Weekly review')).toBe('Weekly review')
    expect(sourceWords(' ', null)).toBe('one of your loops')
  })

  it('what was added, with its identifiers; what asks, by kind', () => {
    expect(addedPhrase([{ ...added(1), identifier: 'ENG-51' }, { ...added(2), identifier: 'ENG-52' }])).toBe('added 2 actions (ENG-51, ENG-52)')
    expect(addedPhrase([added(1)])).toBe('added one action')
    expect(asksPhrase([card(1)])).toBe('one suggestion to look at')
    expect(asksPhrase([card(1, { kind: 'question', payload: {} }), card(2, { kind: 'question', payload: {} })])).toBe('2 questions')
    expect(asksPhrase([card(1, { kind: 'work_proposal', payload: {} })])).toBe('one piece of work to start')
    expect(asksPhrase([card(1, { payload: { change_type: 'create', entity_type: 'contact' } }), card(2, { payload: { change_type: 'create', entity_type: 'milestone' } })])).toBe('2 things to add')
  })

  it('a title is anyone’s text: escaped, so it can never become a link or emphasis in the agent’s line', () => {
    const evil = groupAsks([], [{ ...added(1), source: sourceWords('[Reset your password](https://evil.example/x) *now*', null) }])[0]
    const line = groupLine(evil)
    expect(line).toBe('From your call “\\[Reset your password\\](https://evil.example/x) \\*now\\*”: added one action.')
    expect(line).not.toMatch(/(?<!\\)\[Reset/)
  })

  it('one line per call: what it added, and what it asks', () => {
    const [group] = groupAsks([card(1), card(2)], [{ ...added(1), identifier: 'ENG-51' }, { ...added(2), identifier: 'ENG-52' }])
    expect(groupLine(group)).toBe('From your call “Acme sync”: added 2 actions (ENG-51, ENG-52), and 2 suggestions to look at.')
    expect(groupLine(groupAsks([], [added(1)])[0])).toBe('From your call “Acme sync”: added one action.')
    expect(groupLine(groupAsks([card(1, { payload: {}, run_key: 'loop-1' })])[0])).toBe('From one of your loops: one suggestion to look at.')
  })
})

describe('a batch of requests', () => {
  it('every run’s added items, each once; unreadable ones dropped', () => {
    const merged = mergeHomeAsksRequests([
      { workspaceId: WS, userId: USER, added: [added(1), { change_id: 'nope' }] },
      { workspaceId: WS, userId: USER, added: [added(1), added(2, CAP_B)] },
      { nonsense: true },
    ])
    expect(merged?.added?.map((a) => a.change_id)).toEqual([id(101), id(102)])
    expect(parseHomeAsksRequested({ workspaceId: WS })).toBeNull()
  })
})

describe('announcePendingAsks', () => {
  it('ONE message for the burst: per call, what was added (with identifiers, for Undo) and what asks inline; each card asked once', async () => {
    db.seed('attention_item', [
      card(1),
      card(2),
      card(3, { payload: { change_type: 'update', entity_type: 'action', capture_id: CAP_B, capture_title: 'Globex intro' }, run_key: 'fire-2' }),
      // Never asked here: a post draft (For you's), an approval (asks by itself), one asked already, another person's.
      card(4, { kind: 'question', payload: { post_draft: { text: 'We shipped SSO.', surface: 'x' } } }),
      card(5, { kind: 'approval', payload: { approval_id: 'a1' } }),
      card(6, { payload: { capture_id: CAP_A, [ASKED_KEY]: ago(60) } }),
      card(7, { member_id: 'm9' }),
    ])
    const out = await announcePendingAsks(db as never, { workspaceId: WS, userId: USER, added: [added(1), added(2)], nowMs: NOW }, { append })
    expect(out).toMatchObject({ written: true, cards: 3, added: 2, groups: 2 })
    expect(append).toHaveBeenCalledTimes(1)
    const msg = messages()[0]
    expect(msg.metadata).toMatchObject({ kind: ASK_CARDS_MESSAGE_KIND })
    expect(msg.parts.map((p) => p.type)).toEqual(['text', ASK_CARDS_PART_TYPE, 'text', ASK_CARDS_PART_TYPE])
    expect(msg.parts[0].text).toBe('From your call “Acme sync”: added 2 actions (ENG-51, ENG-52), and 2 suggestions to look at.')
    expect(askCardsPartData(msg.parts[1].data)).toMatchObject({
      card_ids: [id(1), id(2)],
      added: [
        { change_id: id(101), entity_id: id(201), capture_id: CAP_A, identifier: 'ENG-51' },
        { change_id: id(102), entity_id: id(202), capture_id: CAP_A, identifier: 'ENG-52' },
      ],
    })
    expect(msg.parts[2].text).toBe('From your call “Globex intro”: one suggestion to look at.')
    expect(askCardsPartData(msg.parts[3].data)?.card_ids).toEqual([id(3)])
    // Asked: marked, so the next burst never asks them again.
    const asked = db.rows('attention_item').filter((r) => (r.payload as Record<string, unknown>)?.[ASKED_KEY])
    expect(asked.map((r) => r.id).sort()).toEqual([id(1), id(2), id(3), id(6)].sort())
    append.mockClear()
    const again = await announcePendingAsks(db as never, { workspaceId: WS, userId: USER, nowMs: NOW }, { append })
    expect(again).toMatchObject({ written: false, reason: 'nothing_to_say' })
    expect(append).not.toHaveBeenCalled()
  })

  it('a call that added and asked nothing writes nothing (hide-empty)', async () => {
    expect(await announcePendingAsks(db as never, { workspaceId: WS, userId: USER, nowMs: NOW }, { append })).toMatchObject({ written: false, reason: 'nothing_to_say' })
    expect(append).not.toHaveBeenCalled()
  })

  it('only added: the line says so, with its Undo data and no cards', async () => {
    await announcePendingAsks(db as never, { workspaceId: WS, userId: USER, added: [added(1)], nowMs: NOW }, { append })
    const msg = messages()[0]
    expect(msg.parts[0].text).toBe('From your call “Acme sync”: added one action (ENG-51).')
    expect(askCardsPartData(msg.parts[1].data)).toMatchObject({ card_ids: [], added: [{ change_id: id(101), identifier: 'ENG-51' }] })
  })

  it('not a member of the workspace: nothing', async () => {
    expect(await announcePendingAsks(db as never, { workspaceId: 'ws-x', userId: USER, added: [added(1)], nowMs: NOW }, { append })).toMatchObject({ written: false, reason: 'not_a_member' })
  })
})
