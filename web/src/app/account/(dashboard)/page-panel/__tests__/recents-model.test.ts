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
  DEFAULT_RECENT_FILTER,
  filterRecents,
  frontRecentKey,
  isDefaultRecentFilter,
  parseRecentFilter,
  recentGroupLabel,
  recentTypesPresent,
  toggleRecentType,
  SEEN_MAX,
  groupRecents,
  markSeen,
  mergeRecents,
  parseSeen,
  recentGroupOf,
  shortRecentTime,
  type RecentItem,
  CODE_ROW_STATE_WORDS,
  codeChatRowKey,
  codeRowState,
  codeStateNeedsYou,
  withLiveCodeChat,
} from '../recents-model'
import { CODING_TYPE_LABEL, RECENT_TYPES, recentTypeOf } from '@/lib/entities/recents-model'

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

describe('sections by time', () => {
  const doc = (when: string, i: number): RecentItem => ({ key: `document:${i}`, type: 'document', id: String(i), title: `Doc ${i}`, context: null, at: when, needsYou: false, inboxAt: null })
  const mins = (n: number, now = NOW) => new Date(now.getTime() - n * 60_000).toISOString()

  it('the last few minutes (10), then the last hour', () => {
    expect(recentGroupOf(mins(0), NOW)).toBe('minutes')
    expect(recentGroupOf(mins(9), NOW)).toBe('minutes')
    expect(recentGroupOf(mins(10), NOW)).toBe('hour')
    expect(recentGroupOf(mins(59), NOW)).toBe('hour')
    // A clock a little behind the server's: the last few minutes.
    expect(recentGroupOf(at(10, 11, 15, 2), NOW)).toBe('minutes')
  })

  it('today, older than an hour: the part of the day it is now, else Earlier today', () => {
    // At 3pm: 1pm is this afternoon; this morning is Earlier today.
    expect(recentGroupOf(at(10, 11, 13, 0), NOW)).toBe('afternoon')
    expect(recentGroupOf(at(10, 11, 12, 0), NOW)).toBe('afternoon')
    expect(recentGroupOf(at(10, 11, 11, 59), NOW)).toBe('today')
    expect(recentGroupOf(at(10, 11, 0, 0), NOW)).toBe('today')
    const evening = new Date(2026, 10, 11, 21, 0)
    expect(recentGroupOf(at(10, 11, 18, 0), evening)).toBe('evening')
    expect(recentGroupOf(at(10, 11, 17, 59), evening)).toBe('today')
    const morning = new Date(2026, 10, 11, 10, 0)
    expect(recentGroupOf(at(10, 11, 7, 0), morning)).toBe('morning')
  })

  it('yesterday is the calendar day before, not 24 hours ago; then each day', () => {
    const late = new Date(2026, 10, 11, 1, 20)
    expect(recentGroupOf(at(10, 10, 23, 50), late)).toBe('yesterday')
    expect(recentGroupOf(at(10, 10, 13, 0), NOW)).toBe('yesterday')
    expect(recentGroupOf(at(10, 10, 0, 0), NOW)).toBe('yesterday')
    expect(recentGroupOf(at(10, 9, 23, 59), NOW)).toBe('date:2026-11-09')
    expect(recentGroupOf(new Date(2025, 10, 11).toISOString(), NOW)).toBe('date:2025-11-11')
    expect(recentGroupOf('not a date', NOW)).toBe('date:unknown')
  })

  it('heads each section: its words, or the day (a past year’s with its year)', () => {
    expect(recentGroupLabel('minutes', NOW)).toBe('Last few minutes')
    expect(recentGroupLabel('hour', NOW)).toBe('Last hour')
    expect(recentGroupLabel('today', NOW)).toBe('Earlier today')
    expect(recentGroupLabel('date:2026-11-09', NOW)).toBe('Mon, Nov 9')
    expect(recentGroupLabel('date:2025-11-11', NOW)).toBe('Tue, Nov 11, 2025')
    expect(recentGroupLabel('date:unknown', NOW)).toBe('Earlier')
  })

  it('orders the sections as the list (newest first), drops empty ones, keeps the order inside each', () => {
    const items = [mins(2), mins(30), at(10, 11, 13), at(10, 11, 8), at(10, 11, 7), at(10, 10, 22), at(10, 8), at(10, 8, 9), at(9, 20)].map(doc)
    expect(groupRecents(items, NOW).map((g) => [g.label, g.items.map((x) => x.title)])).toEqual([
      ['Last few minutes', ['Doc 0']],
      ['Last hour', ['Doc 1']],
      ['This afternoon', ['Doc 2']],
      ['Earlier today', ['Doc 3', 'Doc 4']],
      ['Yesterday', ['Doc 5']],
      ['Sun, Nov 8', ['Doc 6', 'Doc 7']],
      ['Tue, Oct 20', ['Doc 8']],
    ])
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
        entry('flow', DEAL, 'Fernhill renewal', at(10, 9), true),
      ],
    })
    expect(items.map((i) => [i.key, i.at])).toEqual([
      [`document:${DOC}`, at(10, 11, 14, 30)],
      // In both: once, at the later time (the inbox's).
      [`action:${ACTION}`, at(10, 11, 14, 0)],
      [`flow:${DEAL}`, at(10, 9)],
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

describe('what the person did to records the log doesn’t hold', () => {
  const FILE = 'b0000000-0000-4000-8000-000000000001'
  const JOB = 'c0000000-0000-4000-8000-000000000001'
  it('joins the list from their own tables, once per record, at its newest time', () => {
    const items = mergeRecents({
      inbox: null,
      recent: [entry('document', DOC, 'Q4 renewals plan', at(10, 11, 9), true)],
      sources: [
        { type: 'attachment', id: FILE, label: 'fernhill-quote.pdf', context: null, at: at(10, 11, 14) },
        { type: 'code_job', id: JOB, label: 'Fix the export', context: 'Code', at: at(10, 11, 10) },
        // The same doc, later, from another source: one row, at the later time.
        { type: 'document', id: DOC, label: 'Q4 renewals plan', context: null, at: at(10, 11, 11) },
        { type: 'attachment', id: '', label: 'broken', context: null, at: at(10, 11, 12) },
      ],
    })
    expect(items.map((i) => [i.key, i.at, i.needsYou])).toEqual([
      [`attachment:${FILE}`, at(10, 11, 14), false],
      [`document:${DOC}`, at(10, 11, 11), false],
      [`code_job:${JOB}`, at(10, 11, 10), false],
    ])
  })
})

describe('the filter', () => {
  const item = (type: RecentItem['type'], id: string, needsYou: boolean): RecentItem => ({ key: `${type}:${id}`, type, id, title: id, context: null, at: at(10, 11), needsYou, inboxAt: needsYou ? at(10, 11) : null })
  const list = [item('team_chat_message', 'm', true), item('document', 'd', false), item('data_row', 'r', false), item('attachment', 'f', true), item('code_job', 'j', false)]

  it('Status: Unread is the dot, Read everything else, All both', () => {
    expect(filterRecents(list, { status: 'unread', types: [] }).map((i) => i.id)).toEqual(['m', 'f'])
    expect(filterRecents(list, { status: 'read', types: [] }).map((i) => i.id)).toEqual(['d', 'r', 'j'])
    expect(filterRecents(list, DEFAULT_RECENT_FILTER)).toHaveLength(5)
  })

  it('Type: only the kinds chosen, with Status on top; a Type per kind the list has', () => {
    expect(filterRecents(list, { status: 'all', types: ['channels', 'agents'] }).map((i) => i.id)).toEqual(['m', 'j'])
    expect(filterRecents(list, { status: 'unread', types: ['docs', 'files'] }).map((i) => i.id)).toEqual(['f'])
    expect(recentTypesPresent(list)).toEqual(['channels', 'docs', 'tables', 'files', 'agents'])
  })

  it('toggles a Type, resets, and reads a saved filter back (junk is the default)', () => {
    const one = toggleRecentType(DEFAULT_RECENT_FILTER, 'docs')
    expect(one.types).toEqual(['docs'])
    expect(toggleRecentType(one, 'docs').types).toEqual([])
    expect(isDefaultRecentFilter(DEFAULT_RECENT_FILTER)).toBe(true)
    expect(isDefaultRecentFilter(one)).toBe(false)
    const known = ['docs', 'channels'] as const
    expect(parseRecentFilter(JSON.stringify({ status: 'unread', types: ['docs', 'docs', 'nope', 3] }), known)).toEqual({ status: 'unread', types: ['docs'] })
    expect(parseRecentFilter('{oops', known)).toBe(DEFAULT_RECENT_FILTER)
    expect(parseRecentFilter(JSON.stringify({ status: 'weird' }), known)).toEqual({ status: 'all', types: [] })
    expect(parseRecentFilter(null, known)).toBe(DEFAULT_RECENT_FILTER)
  })
})

describe('a coding chat’s state (docs/plans/one-home.md)', () => {
  const code = (status: string, lastSignal: 'ask' | 'finish' | null = null, queuedOnMac = false) => ({ status, lastSignal, queuedOnMac })

  it('working, queued, asks, review, done, failed', () => {
    expect(codeRowState(code('running'))).toBe('working')
    expect(codeRowState(code('starting'))).toBe('working')
    expect(codeRowState(code('queued'))).toBe('queued')
    // Claimed by the Mac and waiting in its line.
    expect(codeRowState(code('starting', null, true))).toBe('queued')
    expect(codeRowState(code('waiting', 'ask'))).toBe('asks')
    expect(codeRowState(code('waiting', 'finish'))).toBe('done')
    expect(codeRowState(code('waiting', 'finish'), true)).toBe('review')
    expect(codeRowState(code('interrupted'))).toBe('done')
    expect(codeRowState(code('failed'))).toBe('failed')
    expect(codeRowState(code('expired'))).toBe('failed')
    expect(codeRowState(code('cancelled'))).toBe('failed')
    // Ended with its work still waiting on a review: the review is what it says.
    expect(codeRowState(code('failed'), true)).toBe('review')
    // While it works, a review left from its last turn doesn't speak over it.
    expect(codeRowState(code('running'), true)).toBe('working')
  })

  it('only a chat that asks or waits on a review needs the person: the orange dot, and Status → Unread', () => {
    expect((['working', 'queued', 'asks', 'review', 'done', 'failed'] as const).filter(codeStateNeedsYou)).toEqual(['asks', 'review'])
    expect(codeStateNeedsYou(undefined)).toBe(false)
  })

  it('every state has its words, and a chat with nothing to say has none', () => {
    expect(CODE_ROW_STATE_WORDS.done).toBe('')
    for (const state of ['working', 'queued', 'asks', 'review', 'failed'] as const) expect(CODE_ROW_STATE_WORDS[state]).not.toBe('')
  })

  const JOB = 'c0000000-0000-4000-8000-0000000000b1'
  const source = (over: Record<string, unknown> = {}) => ({ type: 'code_job' as const, id: JOB, label: 'Fix the export', context: 'Code', at: at(10, 11, 10), code: { status: 'waiting', lastSignal: 'finish' as const, workItemId: 'tj-1', actionIdentifier: 'ENG-42', queuedOnMac: false, ...over } })

  it('the merged row carries its state, its action and its work item; it needs the person by its state, opened here or not', () => {
    const [idle] = mergeRecents({ inbox: null, recent: null, sources: [source()] })
    expect(idle).toMatchObject({ key: codeChatRowKey(JOB), codeState: 'done', codeAction: 'ENG-42', codeWorkItem: 'tj-1', needsYou: false })
    const [review] = mergeRecents({ inbox: null, recent: null, sources: [source()], codeReview: new Set(['tj-1']) })
    expect(review).toMatchObject({ codeState: 'review', needsYou: true })
    // Seen here before: it still waits on the review.
    const [seen] = mergeRecents({ inbox: null, recent: null, sources: [source({ lastSignal: 'ask' })], seen: { [codeChatRowKey(JOB)]: at(10, 11, 30) } })
    expect(seen).toMatchObject({ codeState: 'asks', needsYou: true })
    // A row from before the read carried the state: a plain coding row, nothing to say.
    const [bare] = mergeRecents({ inbox: null, recent: null, sources: [{ type: 'code_job', id: JOB, label: 'Fix the export', context: 'Code', at: at(10, 11, 10) }] })
    expect(bare.codeState).toBeUndefined()
    expect(bare.needsYou).toBe(false)
  })

  it('the current chat’s row follows its conversation’s reader; the same list when nothing changes', () => {
    const items = mergeRecents({ inbox: null, recent: null, sources: [source({ status: 'running', lastSignal: null })] })
    expect(withLiveCodeChat(items, null)).toBe(items)
    expect(withLiveCodeChat(items, { sessionId: JOB, status: 'running', lastSignal: null })).toBe(items)
    expect(withLiveCodeChat(items, { sessionId: 'another', status: 'failed', lastSignal: null })).toBe(items)
    const asked = withLiveCodeChat(items, { sessionId: JOB, status: 'waiting', lastSignal: 'ask' })
    expect(asked[0]).toMatchObject({ codeState: 'asks', needsYou: true })
    const finished = withLiveCodeChat(items, { sessionId: JOB, status: 'waiting', lastSignal: 'finish' }, new Set(['tj-1']))
    expect(finished[0]).toMatchObject({ codeState: 'review', needsYou: true })
  })

  it('the Type filter’s word for them is "Coding", under the key a saved filter already holds', () => {
    expect(RECENT_TYPES.find((t) => t.key === 'agents')).toEqual({ key: 'agents', label: CODING_TYPE_LABEL })
    expect(recentTypeOf('code_job')).toBe('agents')
  })
})
