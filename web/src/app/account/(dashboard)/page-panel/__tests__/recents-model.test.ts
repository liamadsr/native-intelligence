/**
 * Home's recents as data (recents-model.ts): the sections by day (Liam,
 * 11-11: "so you see today, yesterday…") and the short times on a pinned clock (local time: built with local constructors, so the
 * runner's zone doesn't matter), and the one list: the inbox and the
 * person's own records merged, each record once, newest first, the dot on
 * what came to them until they open it or act on it. Fixtures are made up.
 */
import { describe, expect, it } from 'vitest'
import type { FeedEntry } from '@/lib/entities/feed-model'
import {
  frontRecentKey,
  SEEN_MAX,
  groupRecents,
  markSeen,
  mergeRecents,
  parseSeen,
  recentGroupOf,
  shortRecentTime,
  type RecentItem,
} from '../recents-model'

/** 3pm on Wednesday Nov 11 2026, local. */
const NOW = new Date(2026, 10, 11, 15, 0, 0)
const at = (...parts: [number, number, number?, number?]) => new Date(2026, parts[0], parts[1], parts[2] ?? 12, parts[3] ?? 0).toISOString()

const entry = (type: FeedEntry['type'], id: string, label: string, when: string, me = false): FeedEntry => ({
  type,
  id,
  label,
  context: null,
  count: 1,
  last: {
    id: `ev-${id}-${when}`,
    action: me ? 'renamed' : 'mentioned',
    at: when,
    actor: me ? { kind: 'member', member_id: 'm-ana', name: 'Ana Reyes', me: true } : { kind: 'member', member_id: 'm-maya', name: 'Maya Chen', me: false },
    subject: me ? null : { member_id: 'm-ana', name: 'Ana Reyes', me: true },
    from: null,
    to: null,
    relation: null,
    other: null,
  },
})

const DOC = 'd0000000-0000-4000-8000-000000000001'
const ACTION = 'a0000000-0000-4000-8000-000000000001'
const DEAL = 'e0000000-0000-4000-8000-000000000001'
const MSG = 'f0000000-0000-4000-8000-000000000001'

describe('sections by day', () => {
  const doc = (when: string, i: number): RecentItem => ({ key: `document:${i}`, type: 'document', id: String(i), title: `Doc ${i}`, context: null, at: when, needsYou: false, inboxAt: null })

  it('splits today by part of the day: before noon the morning, to 17:59 the afternoon, from 18:00 the evening', () => {
    const evening = new Date(2026, 10, 11, 21, 0)
    expect(recentGroupOf(at(10, 11, 0, 0), evening)).toBe('morning')
    expect(recentGroupOf(at(10, 11, 11, 59), evening)).toBe('morning')
    expect(recentGroupOf(at(10, 11, 12, 0), evening)).toBe('afternoon')
    expect(recentGroupOf(at(10, 11, 17, 59), evening)).toBe('afternoon')
    expect(recentGroupOf(at(10, 11, 18, 0), evening)).toBe('evening')
    expect(recentGroupOf(at(10, 11, 20, 59), evening)).toBe('evening')
    // At 3pm: this morning's is still the morning's, and a minute ago is the afternoon's.
    expect(recentGroupOf(at(10, 11, 9, 30), NOW)).toBe('morning')
    expect(recentGroupOf(at(10, 11, 14, 59), NOW)).toBe('afternoon')
    // A clock a little behind the server's: the part of the day it is now.
    expect(recentGroupOf(at(10, 11, 15, 2), NOW)).toBe('afternoon')
    expect(recentGroupOf(new Date(2026, 10, 12, 0, 1).toISOString(), new Date(2026, 10, 11, 23, 59))).toBe('evening')
  })

  it('yesterday is the calendar day before, not 24 hours ago (midnight is the line)', () => {
    const late = new Date(2026, 10, 11, 0, 20)
    // Ten minutes ago, but before midnight: yesterday. Just after midnight: this morning.
    expect(recentGroupOf(at(10, 10, 23, 50), late)).toBe('yesterday')
    expect(recentGroupOf(at(10, 11, 0, 0), late)).toBe('morning')
    expect(recentGroupOf(at(10, 11, 0, 10), late)).toBe('morning')
    // At 3pm, 26 hours ago is still yesterday; the day before is not.
    expect(recentGroupOf(at(10, 10, 13, 0), NOW)).toBe('yesterday')
    expect(recentGroupOf(at(10, 10, 0, 0), NOW)).toBe('yesterday')
    expect(recentGroupOf(at(10, 9, 23, 59), NOW)).toBe('week')
  })

  it('the last 7 days are today and the six before it; the last 30, today and the 29 before it; then older', () => {
    expect(recentGroupOf(at(10, 5, 0, 0), NOW)).toBe('week')
    expect(recentGroupOf(at(10, 4, 23, 59), NOW)).toBe('month')
    expect(recentGroupOf(at(10, 4, 12, 0), NOW)).toBe('month')
    // Oct 13 is 29 days before Nov 11.
    expect(recentGroupOf(at(9, 13, 0, 0), NOW)).toBe('month')
    expect(recentGroupOf(at(9, 12, 23, 59), NOW)).toBe('older')
    expect(recentGroupOf(new Date(2025, 10, 11).toISOString(), NOW)).toBe('older')
    expect(recentGroupOf('not a date', NOW)).toBe('older')
  })

  it('orders the sections newest first, drops empty ones, and keeps the list’s own order inside each', () => {
    const evening = new Date(2026, 10, 11, 19, 30)
    const items = [at(10, 11, 19, 10), at(10, 11, 18, 5), at(10, 11, 13), at(10, 11, 8), at(10, 11, 7), at(10, 10, 22), at(10, 8), at(9, 20), at(8, 1)].map(doc)
    expect(groupRecents(items, evening).map((g) => [g.label, g.items.map((x) => x.title)])).toEqual([
      ['This evening', ['Doc 0', 'Doc 1']],
      ['This afternoon', ['Doc 2']],
      ['This morning', ['Doc 3', 'Doc 4']],
      ['Yesterday', ['Doc 5']],
      ['Last 7 days', ['Doc 6']],
      ['Last 30 days', ['Doc 7']],
      ['Older', ['Doc 8']],
    ])
    // At 3pm with nothing this afternoon: the morning's section, then the week's.
    expect(groupRecents([at(10, 11, 10), at(10, 9)].map(doc), NOW).map((g) => g.label)).toEqual(['This morning', 'Last 7 days'])
    expect(groupRecents([], NOW)).toEqual([])
  })

  it('says a short time: now, minutes, hours, days, then the day, then a past year’s month', () => {
    expect(shortRecentTime(new Date(NOW.getTime() - 20_000).toISOString(), NOW)).toBe('now')
    expect(shortRecentTime(at(10, 11, 14, 48), NOW)).toBe('12m')
    expect(shortRecentTime(at(10, 11, 12, 0), NOW)).toBe('3h')
    expect(shortRecentTime(at(10, 9, 14, 0), NOW)).toBe('2d')
    expect(shortRecentTime(at(10, 2), NOW)).toBe('Nov 2')
    expect(shortRecentTime(new Date(2025, 10, 9).toISOString(), NOW)).toBe('Nov 2025')
    expect(shortRecentTime('not a date', NOW)).toBe('')
  })
})

describe('the one list', () => {
  it('merges the inbox and the person’s own records, each record once, newest first', () => {
    const items = mergeRecents({
      inbox: [entry('action', ACTION, 'Send the Fernhill quote', at(10, 11, 14, 0))],
      recent: [
        entry('document', DOC, 'Q4 renewals plan', at(10, 11, 14, 30), true),
        entry('action', ACTION, 'Send the Fernhill quote', at(10, 10), true),
        entry('deal', DEAL, 'Fernhill renewal', at(10, 9), true),
      ],
    })
    expect(items.map((i) => [i.key, i.at])).toEqual([
      [`document:${DOC}`, at(10, 11, 14, 30)],
      // In both: once, at the later time (the inbox's).
      [`action:${ACTION}`, at(10, 11, 14, 0)],
      [`deal:${DEAL}`, at(10, 9)],
    ])
  })

  it('dots what came to the person after their own last touch, until they open it', () => {
    const inbox = [entry('action', ACTION, 'Send the Fernhill quote', at(10, 11, 14, 0)), entry('document', DOC, 'Q4 renewals plan', at(10, 11, 9, 0))]
    // They edited the doc after its mention: no dot. The action is new to them: a dot.
    const recent = [entry('document', DOC, 'Q4 renewals plan', at(10, 11, 10, 0), true)]
    const items = mergeRecents({ inbox, recent })
    expect(items.find((i) => i.id === ACTION)).toMatchObject({ needsYou: true, inboxAt: at(10, 11, 14, 0) })
    expect(items.find((i) => i.id === DOC)?.needsYou).toBe(false)
    // Opened here: the dot goes, and comes back only with something newer.
    const seen = markSeen({}, `action:${ACTION}`, at(10, 11, 14, 0))
    expect(mergeRecents({ inbox, recent, seen }).find((i) => i.id === ACTION)?.needsYou).toBe(false)
    const newer = [entry('action', ACTION, 'Send the Fernhill quote', at(10, 11, 14, 45)), inbox[1]]
    expect(mergeRecents({ inbox: newer, recent, seen }).find((i) => i.id === ACTION)?.needsYou).toBe(true)
    // Only the person's own records: never a dot.
    expect(mergeRecents({ inbox: [], recent }).some((i) => i.needsYou)).toBe(false)
  })

  it('leaves out what can’t be opened, and anything malformed; a missing list is no rows', () => {
    const odd = { ...entry('document', 'x', 'Odd', at(10, 11)), type: 'nothing_like_it' } as unknown as FeedEntry
    const items = mergeRecents({
      inbox: null,
      recent: [entry('team_chat_message', MSG, 'Can you check the quote?', at(10, 11, 14, 0), true), odd, { ...entry('document', '', '', at(10, 11)) }],
    })
    expect(items.map((i) => i.key)).toEqual([`team_chat_message:${MSG}`])
    expect(mergeRecents({ inbox: null, recent: null })).toEqual([])
  })

  it('names an untitled record, on one line', () => {
    const [item] = mergeRecents({ inbox: null, recent: [entry('document', DOC, '  Q4\n renewals ', at(10, 11), true)] })
    expect(item.title).toBe('Q4 renewals')
    const [blank] = mergeRecents({ inbox: null, recent: [entry('document', DOC, '   ', at(10, 11), true)] })
    expect(blank.title).toBe('Untitled')
  })
})

describe('the seen map', () => {
  it('keeps the newest seen time per record, and only the newest SEEN_MAX records', () => {
    const one = markSeen({}, 'document:1', at(10, 11, 10))
    expect(markSeen(one, 'document:1', at(10, 11, 9))).toBe(one)
    expect(markSeen(one, 'document:1', at(10, 11, 11))).toEqual({ 'document:1': at(10, 11, 11) })
    let many = {}
    for (let i = 0; i < SEEN_MAX + 5; i++) many = markSeen(many, `document:${i}`, new Date(2026, 10, 1, 0, i).toISOString())
    expect(Object.keys(many)).toHaveLength(SEEN_MAX)
    expect(many).not.toHaveProperty('document:0')
    expect(many).toHaveProperty(`document:${SEEN_MAX + 4}`)
  })

  it('reads back only string times; junk is an empty map', () => {
    expect(parseSeen(JSON.stringify({ 'document:1': '2026-11-11T10:00:00.000Z', 'document:2': 3 }))).toEqual({ 'document:1': '2026-11-11T10:00:00.000Z' })
    expect(parseSeen('[1,2]')).toEqual({})
    expect(parseSeen('{oops')).toEqual({})
    expect(parseSeen(null)).toEqual({})
  })
})

describe('the row a card in front lights', () => {
  it('a record card, or a page card on one place; nothing for a card on no one record', () => {
    expect(frontRecentKey(null)).toBeNull()
    expect(frontRecentKey({ kind: 'record', title: 'Doc', record: { type: 'document', id: 'd1' } } as never)).toBe('document:d1')
    expect(frontRecentKey({ kind: 'sequences', title: 'Seq', target: { type: 'sequence', id: 's1', label: 'Seq' } } as never)).toBe('sequence:s1')
    expect(frontRecentKey({ kind: 'sequences', title: 'Sequences' } as never)).toBeNull()
    expect(frontRecentKey({ kind: 'team_chat', title: 'Team chat' } as never)).toBeNull()
    expect(frontRecentKey({ kind: 'calendar', title: 'Calendar', calendar: { start: '2026-11-09', end: '2026-11-16', view: 'week' } } as never)).toBeNull()
  })
})
