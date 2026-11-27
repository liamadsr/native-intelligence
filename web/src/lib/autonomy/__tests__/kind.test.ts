/**
 * The kind of a held call (docs/plans/earned-autonomy.md §1): computed from the
 * tool and its stored input, never from model text; the edit ratio; the
 * switch; what the record writes; the Settings list's grouping and words.
 */
import { describe, expect, it } from 'vitest'
import { audienceOf, kindLabel, kindOfCall, parseKindKey } from '../kind'
import { editRatio, EDIT_RATIO_MAX_WORDS } from '../edit-ratio'
import { earnedAutonomyMode, earnedAutonomyRecording } from '../config'
import { outcomeRow } from '../record'
import { summarizeKinds, type OutcomeRow } from '../records'
import { needsLine, recordLine } from '../lines'

describe('kindOfCall', () => {
  it('a calendar invite: channel calendar, audience by attendees (case and duplicates folded)', () => {
    const k = kindOfCall({ tool: 'create_calendar_event', input: { title: 'Sync', attendees: ['Dana@example.com', { email: 'dana@example.com' }, 'lee@example.com'] } })
    expect(k).toMatchObject({ tool: 'create_calendar_event', channel: 'calendar', audience: 'few', key: 'create_calendar_event|calendar|few' })
    expect(k.recipients).toEqual(['dana@example.com', 'lee@example.com'])
  })

  it('the MCP surface\'s ni_ name is the same kind as the chat name', () => {
    const a = kindOfCall({ tool: 'ni_offer_times', input: { send_by: 'text', phone: '+13125550142' } })
    const b = kindOfCall({ tool: 'offer_times', input: { send_by: 'text', phone: '+13125550142' } })
    expect(a.key).toBe(b.key)
    expect(a).toMatchObject({ channel: 'text', audience: 'one' })
  })

  it('offer_times: by email, by text, or a link (which reaches nobody)', () => {
    expect(kindOfCall({ tool: 'offer_times', input: { send_by: 'email', email: 'dana@example.com' } }).key).toBe('offer_times|email|one')
    expect(kindOfCall({ tool: 'offer_times', input: {} }).key).toBe('offer_times|link|none')
  })

  it('book_quote reaches the quote\'s one customer', () => {
    expect(kindOfCall({ tool: 'book_quote', input: { quote_id: 'Q-1', start: '2026-12-01T10:00' }, context: { quoteReply: { kind: 'book', quote_id: 'Q-1', card_hash: 'h' } } })).toMatchObject({
      channel: 'customer',
      audience: 'one',
      recipients: ['quote:q-1'],
    })
  })

  it('a connected app\'s tool: its server is part of the kind', () => {
    const k = kindOfCall({ tool: 'mcp__gmail__label_thread', input: { thread_id: 't1', label: 'Receipts' } })
    expect(k).toMatchObject({ channel: 'app', app: 'gmail', audience: 'none', key: 'mcp__gmail__label_thread|app:gmail|none' })
    expect(kindOfCall({ tool: 'mcp__gmail__send', input: { to: 'a@example.com, b@example.com' } }).audience).toBe('few')
  })

  it('a tool the code does not know: channel unknown (never graduates), recipients still counted', () => {
    expect(kindOfCall({ tool: 'send_rocket', input: { to: ['a@x.com', 'b@x.com', 'c@x.com', 'd@x.com'] } })).toMatchObject({ channel: 'unknown', audience: 'many' })
  })

  it('garbage in degrades, never throws', () => {
    expect(kindOfCall({ tool: 42 as unknown as string, input: null })).toMatchObject({ channel: 'unknown', audience: 'none' })
  })

  it('a model\'s own words never move the kind: the same call with a different "reason" is the same kind', () => {
    const a = kindOfCall({ tool: 'create_calendar_event', input: { attendees: ['dana@example.com'] }, context: { why: 'just a booking confirmation' } })
    const b = kindOfCall({ tool: 'create_calendar_event', input: { attendees: ['dana@example.com'] }, context: {} })
    expect(a.key).toBe(b.key)
  })

  it('audience buckets: 0 none, 1 one, 2-3 few, 4+ many', () => {
    expect([0, 1, 2, 3, 4, 50].map(audienceOf)).toEqual(['none', 'one', 'few', 'few', 'many', 'many'])
  })

  it('keys round-trip, and labels read as words', () => {
    expect(parseKindKey('offer_times|text|one')).toEqual({ tool: 'offer_times', channel: 'text', app: undefined, audience: 'one' })
    expect(parseKindKey('mcp__gmail__label_thread|app:gmail|none')).toMatchObject({ channel: 'app', app: 'gmail' })
    expect(parseKindKey('nope')).toBeNull()
    expect(parseKindKey('x|bogus|one')).toBeNull()
    expect(kindLabel({ tool: 'offer_times', channel: 'text', audience: 'one' })).toBe('Offers of meeting times by text, to one person')
    expect(kindLabel({ tool: 'create_calendar_event', channel: 'calendar', audience: 'few' })).toBe('Calendar invites to a few people')
    expect(kindLabel({ tool: 'mcp__gmail__label_thread', channel: 'app', app: 'gmail', audience: 'none' })).toBe('Label thread in gmail')
  })
})

describe('editRatio', () => {
  it('0 unchanged (whatever the key order), small for a typo, 1 for a rewrite', () => {
    expect(editRatio({ a: 'hello there friend', b: 'x' }, { b: 'x', a: 'hello there friend' })).toBe(0)
    const typo = editRatio({ body: 'See you on Thursday at 2pm, looking forward to it. Best, Sam' }, { body: 'See you on Thursday at 2pm, looking forward to it. Thanks, Sam' })
    expect(typo).toBeGreaterThan(0)
    expect(typo).toBeLessThan(0.2)
    expect(editRatio({ body: 'one two three' }, { body: 'four five six' })).toBeGreaterThan(0.5)
  })

  it('past the word cap it reads as 1 (a big edit is never trivial by accident)', () => {
    const big = Array.from({ length: EDIT_RATIO_MAX_WORDS + 1 }, () => 'w').join(' ')
    expect(editRatio({ body: big }, { body: big })).toBe(1)
  })
})

describe('the switch', () => {
  it('empty (and anything unknown) is off; record and graduate record', () => {
    expect(earnedAutonomyMode({})).toBe('off')
    expect(earnedAutonomyMode({ EARNED_AUTONOMY: '' })).toBe('off')
    expect(earnedAutonomyMode({ EARNED_AUTONOMY: 'yes' })).toBe('off')
    expect(earnedAutonomyMode({ EARNED_AUTONOMY: ' Record ' })).toBe('record')
    expect(earnedAutonomyMode({ EARNED_AUTONOMY: 'graduate' })).toBe('graduate')
    expect(earnedAutonomyRecording({})).toBe(false)
    expect(earnedAutonomyRecording({ EARNED_AUTONOMY: 'record' })).toBe(true)
  })
})

describe('outcomeRow', () => {
  const approval = { id: '11111111-1111-4111-8111-111111111111', workspace_id: 'ws', user_id: 'u', tool: 'offer_times', input: { send_by: 'text', phone: '+13125550142' } }

  it('writes the kind, the approver and the source', () => {
    expect(outcomeRow({ approval, outcome: 'approved' })).toMatchObject({ user_id: 'u', kind_key: 'offer_times|text|one', source: 'tool_approval', source_id: approval.id, outcome: 'approved', edit_ratio: null })
  })

  it('a ratio only on an edited approval, clamped to [0,1]', () => {
    expect(outcomeRow({ approval, outcome: 'approved_edited', editRatio: 3 })?.edit_ratio).toBe(1)
    expect(outcomeRow({ approval, outcome: 'dismissed', editRatio: 0.5 })?.edit_ratio).toBeNull()
  })

  it('a guest\'s call is not the person\'s agent\'s work: not counted', () => {
    expect(outcomeRow({ approval: { ...approval, context: { guest: { id: 'g1' } } }, outcome: 'approved' })).toBeNull()
  })

  it('a row missing its owner or tool is dropped', () => {
    expect(outcomeRow({ approval: { ...approval, user_id: '' }, outcome: 'approved' })).toBeNull()
    expect(outcomeRow({ approval: { ...approval, tool: '' }, outcome: 'approved' })).toBeNull()
  })
})

describe('the Settings list (read-only)', () => {
  const NOW = new Date('2026-11-27T12:00:00Z')
  const row = (kind_key: string, outcome: OutcomeRow['outcome'], daysAgo: number): OutcomeRow => ({ kind_key, outcome, edit_ratio: null, created_at: new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString() })

  it('groups by kind, newest first, with its words; a never kind says why', () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => row('offer_times|text|one', 'approved', 0.2 + i * 0.9)),
      row('send_payment_link|unknown|one', 'approved', 3),
      row('bogus', 'approved', 1),
    ]
    const list = summarizeKinds(rows, [], NOW)
    expect(list.map((k) => k.key)).toEqual(['offer_times|text|one', 'send_payment_link|unknown|one'])
    const [offers, pay] = list
    expect(offers).toMatchObject({ level: 'ask', eligible: 'tell', alwaysAsks: null, label: 'Offers of meeting times by text, to one person' })
    expect(recordLine(offers)).toBe('10 approved as shown')
    expect(needsLine(offers)).toBe('Ready: the agent can offer to take this over')
    expect(pay.alwaysAsks).not.toBeNull()
    expect(needsLine(pay)).toMatch(/^Always asks/)
  })

  it('says what a kind still needs', () => {
    const [k] = summarizeKinds([row('offer_times|text|one', 'approved', 1), row('offer_times|text|one', 'dismissed', 2)], [], NOW)
    expect(recordLine(k)).toBe('1 approved as shown, 1 dismissed')
    expect(needsLine(k)).toBe('Needs 9 more clean approvals over 6 more days')
  })

  it('a stored grant on a kind that now hits a hard limit reads ask', () => {
    const [k] = summarizeKinds([], [{ kind_key: 'send_quote|customer|one', level: 'tell', pinned_ask: false, granted_at: '2026-11-01T00:00:00Z', demoted_at: null, offer_declined_at: null }], NOW)
    expect(k.level).toBe('ask')
    expect(k.alwaysAsks?.limit).toBe('commitment')
  })
})
