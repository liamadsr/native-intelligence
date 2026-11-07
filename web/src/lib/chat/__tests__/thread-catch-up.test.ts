import { describe, it, expect } from 'vitest'
import type { UIMessage } from '@ai-sdk/react'
import { caughtUpThread } from '../thread-catch-up'
import { MAX_LIVE_MESSAGES, MIN_TRIMMED_MESSAGES } from '../message-retention'

const msg = (id: string, role: 'user' | 'assistant' = 'user'): UIMessage =>
  ({ id, role, parts: [{ type: 'text', text: id }] }) as UIMessage

const thread = (n: number, from = 0) => Array.from({ length: n }, (_, i) => msg(`m${from + i}`, i % 2 ? 'assistant' : 'user'))

describe('caughtUpThread — a restored thread against its conversation rows', () => {
  it('an empty stored copy takes the rows — the write that should have held them was refused', () => {
    const rows = thread(6)
    expect(caughtUpThread([], rows)).toEqual(rows)
  })

  it('a copy that fell behind takes the rows it is a part of', () => {
    const rows = thread(10)
    expect(caughtUpThread(rows.slice(0, 4), rows)?.map((m) => m.id)).toEqual(rows.map((m) => m.id))
  })

  it('a copy that started over from empty gets its earlier history back', () => {
    // Restored empty, the catch-up couldn't run (offline), and the chat went
    // on: the copy holds only the new turn, the conversation holds it all.
    const rows = [...thread(20), msg('u21'), msg('a21', 'assistant')]
    expect(caughtUpThread([msg('u21'), msg('a21', 'assistant')], rows)?.map((m) => m.id)).toEqual(rows.map((m) => m.id))
  })

  it('a copy that retention already trimmed from the front still counts as a part of them', () => {
    const rows = thread(MAX_LIVE_MESSAGES + 40)
    const stored = rows.slice(30, MAX_LIVE_MESSAGES + 30)
    const next = caughtUpThread(stored, rows)!
    // Bounded like every live thread — the newest messages, the last one included.
    expect(next).toHaveLength(MAX_LIVE_MESSAGES)
    expect(next.at(-1)!.id).toBe(`m${MAX_LIVE_MESSAGES + 39}`)
  })

  it('a trimmed copy that is current stays — the older rows it lacks are no news', () => {
    const rows = thread(MAX_LIVE_MESSAGES + 40)
    expect(caughtUpThread(rows.slice(40), rows)).toBeNull()
    // At the smallest size a trim leaves, still a trimmed copy.
    expect(caughtUpThread(rows.slice(rows.length - MIN_TRIMMED_MESSAGES), rows)).toBeNull()
  })

  it('a copy one short of the smallest trim was never trimmed — the older rows it lacks are news', () => {
    const rows = thread(MAX_LIVE_MESSAGES + 40)
    const next = caughtUpThread(rows.slice(rows.length - (MIN_TRIMMED_MESSAGES - 1)), rows)
    expect(next).not.toBeNull()
    expect(next!.at(-1)!.id).toBe(`m${MAX_LIVE_MESSAGES + 39}`)
  })

  it('rows that list two messages of one save the other way round are no news', () => {
    // One PATCH writes a turn's messages with the same created_at; the rows
    // may come back with the tie in either order.
    const short = [...thread(4), msg('a2', 'assistant'), msg('u2')]
    expect(caughtUpThread(short, [...thread(4), msg('u2'), msg('a2', 'assistant')])).toBeNull()
    const rows = [...thread(MAX_LIVE_MESSAGES + 40), msg('u2'), msg('a2', 'assistant')]
    const trimmed = [...rows.slice(rows.length - MIN_TRIMMED_MESSAGES, -2), msg('a2', 'assistant'), msg('u2')]
    expect(caughtUpThread(trimmed, rows)).toBeNull()
  })

  it('keeps a copy holding a message the rows never got — a catch-up never loses one', () => {
    const rows = thread(8)
    expect(caughtUpThread([...thread(4), msg('unsaved')], rows)).toBeNull()
  })

  it('keeps a copy the rows are no longer than', () => {
    const rows = thread(4)
    expect(caughtUpThread(rows, rows)).toBeNull()
    expect(caughtUpThread(thread(4), thread(3))).toBeNull()
    expect(caughtUpThread([], [])).toBeNull()
  })

  it('reads the rows defensively — no array, or rows that are not messages', () => {
    expect(caughtUpThread([], undefined)).toBeNull()
    expect(caughtUpThread([], { messages: thread(2) })).toBeNull()
    expect(caughtUpThread([], [null, 7, { id: 'no-parts' }, msg('ok')])).toEqual([msg('ok')])
  })
})

describe('caughtUpThread — the pages the person opened come back', () => {
  const opened = (id: string): UIMessage => ({ id: `opened-card-${id}`, role: 'user', parts: [{ type: 'data-chat-card', id, data: {} }] }) as unknown as UIMessage
  const ids = (next: UIMessage[] | null) => next?.map((m) => m.id) ?? null

  it('even when the copy holds a message of its own (a turn the rows never got)', () => {
    // Liam's chat: a question with no reply only in the copy, the pages only in the rows.
    const local = [msg('orphan'), msg('u1'), msg('a1', 'assistant')]
    const rows = [msg('u1'), msg('a1', 'assistant'), opened('p1'), opened('p2')]
    expect(ids(caughtUpThread(local, rows))).toEqual(['orphan', 'u1', 'a1', 'opened-card-p1', 'opened-card-p2'])
  })

  it('each where it sits among the rows: after the nearest earlier shared message', () => {
    const local = [msg('u1'), msg('a1', 'assistant'), msg('own'), msg('u2'), msg('a2', 'assistant')]
    const rows = [msg('u1'), msg('a1', 'assistant'), opened('p1'), msg('u2'), msg('a2', 'assistant'), opened('p2')]
    expect(ids(caughtUpThread(local, rows))).toEqual(['u1', 'a1', 'opened-card-p1', 'own', 'u2', 'a2', 'opened-card-p2'])
  })

  it('with no earlier shared message, before the next shared one; with none at all, at the end', () => {
    const local = [msg('own'), msg('u1'), msg('a1', 'assistant')]
    expect(ids(caughtUpThread(local, [opened('p0'), msg('u1'), msg('a1', 'assistant')]))).toEqual(['own', 'opened-card-p0', 'u1', 'a1'])
    expect(ids(caughtUpThread([msg('own')], [opened('p0')]))).toEqual(['own', 'opened-card-p0'])
  })

  it('never drops or reorders a message of the copy, and adds nothing else from the rows', () => {
    const local = [msg('b'), msg('a'), msg('own')]
    const rows = [msg('a'), msg('x'), opened('p1'), msg('b')]
    const next = ids(caughtUpThread(local, rows))!
    expect(next.filter((id) => !id.startsWith('opened-card-'))).toEqual(['b', 'a', 'own'])
    expect(next).toContain('opened-card-p1')
    expect(next).not.toContain('x')
  })

  it('no page missing: the copy stands', () => {
    expect(caughtUpThread([msg('orphan'), msg('u1')], [msg('u1')])).toBeNull()
    expect(caughtUpThread([msg('orphan'), opened('p1')], [opened('p1')])).toBeNull()
  })

  it('a trimmed copy leaves out the pages from before where it starts', () => {
    const rows = [opened('old'), ...thread(MAX_LIVE_MESSAGES + 10), opened('new')]
    const local = [msg('own'), ...rows.slice(rows.length - MIN_TRIMMED_MESSAGES - 1, -1)]
    const next = ids(caughtUpThread(local, rows))!
    expect(next).toContain('opened-card-new')
    expect(next).not.toContain('opened-card-old')
  })
})

describe('caughtUpThread — a copy whose only messages of its own are pages', () => {
  const opened = (id: string): UIMessage => ({ id: `opened-card-${id}`, role: 'user', parts: [{ type: 'data-chat-card', id, data: {} }] }) as unknown as UIMessage
  const ids = (next: UIMessage[] | null) => next?.map((m) => m.id) ?? null

  it('takes the rows, each page put back where it sat (DEV 10-20: two unsaved pages held a home thread on its old copy)', () => {
    const local = [msg('m0'), opened('p1'), msg('m1', 'assistant'), opened('p2'), msg('m2')]
    const rows = [msg('m0'), msg('m1', 'assistant'), msg('m2'), msg('m3', 'assistant'), msg('m4')]
    expect(ids(caughtUpThread(local, rows))).toEqual(['m0', 'opened-card-p1', 'm1', 'opened-card-p2', 'm2', 'm3', 'm4'])
  })

  it('the rows’ copy of a shared message wins (it is the newer one)', () => {
    const stale = { ...msg('m1', 'assistant'), metadata: { stale: true } } as UIMessage
    const fresh = { ...msg('m1', 'assistant'), metadata: { reaction: { emoji: '👍', at: '2026-10-20T10:00:00.000Z' } } } as UIMessage
    const next = caughtUpThread([msg('m0'), stale, opened('p1')], [msg('m0'), fresh, msg('m2')])!
    expect(next.find((m) => m.id === 'm1')).toBe(fresh)
    expect(ids(next)).toEqual(['m0', 'm1', 'opened-card-p1', 'm2'])
  })

  it('pages that lead the copy go before its first shared message, in their order; a copy of pages alone, at the end', () => {
    expect(ids(caughtUpThread([opened('a'), opened('b'), msg('m0')], [msg('m0'), msg('m1')]))).toEqual(['opened-card-a', 'opened-card-b', 'm0', 'm1'])
    expect(ids(caughtUpThread([opened('a')], [msg('m0'), msg('m1')]))).toEqual(['m0', 'm1', 'opened-card-a'])
  })

  it('nothing new in the rows: the copy stands', () => {
    expect(caughtUpThread([msg('m0'), opened('p1'), msg('m1')], [msg('m0'), msg('m1')])).toBeNull()
  })

  it('a turn of its own as well still keeps the copy (only the rows’ pages come back)', () => {
    const local = [msg('m0'), opened('p1'), msg('unsaved')]
    const rows = [msg('m0'), msg('m1'), opened('p9')]
    // m1 stays out (a copy with a turn of its own takes nothing else); p9 goes after m0, its nearest earlier shared row.
    expect(ids(caughtUpThread(local, rows))).toEqual(['m0', 'opened-card-p9', 'opened-card-p1', 'unsaved'])
  })

  it('a trimmed copy with a page of its own takes the newer rows, bounded', () => {
    const rows = thread(MAX_LIVE_MESSAGES + 40)
    const stored = [...rows.slice(30, MAX_LIVE_MESSAGES + 30)]
    stored.splice(10, 0, opened('mine'))
    const next = caughtUpThread(stored, rows)!
    expect(next).toHaveLength(MAX_LIVE_MESSAGES)
    expect(next.at(-1)!.id).toBe(`m${MAX_LIVE_MESSAGES + 39}`)
  })
})

describe('caughtUpThread — rows that are only the newest page (`partial`)', () => {
  // PROD 2026-10-31: a 616-message home thread at the retention cap, read on
  // focus as its newest MAX_LIVE_MESSAGES rows. One home turn landed, the page
  // no longer held the copy's oldest message, and that message counted as a
  // turn of the copy's own: the home turn never came in.
  it('a copy at the cap takes the one new row when its oldest message is past the page', () => {
    const all = thread(616)
    const stored = all.slice(all.length - MAX_LIVE_MESSAGES)
    const landed = msg('home-turn:new', 'assistant')
    const page = [...all, landed].slice(-MAX_LIVE_MESSAGES)
    // Without `partial` the page reads as the whole thread: no catch-up.
    expect(caughtUpThread(stored, page)).toBeNull()
    const next = caughtUpThread(stored, page, { partial: true })!
    expect(next.at(-1)!.id).toBe('home-turn:new')
    expect(next).toHaveLength(MAX_LIVE_MESSAGES)
  })

  it('a copy current with the page stays', () => {
    const page = thread(MAX_LIVE_MESSAGES, 300)
    expect(caughtUpThread(page, page, { partial: true })).toBeNull()
  })

  it('a message of its own inside the page still keeps the copy', () => {
    const all = thread(616)
    const stored = [...all.slice(all.length - MAX_LIVE_MESSAGES + 1), msg('unsaved')]
    const page = [...all, msg('home-turn:new', 'assistant')].slice(-MAX_LIVE_MESSAGES)
    expect(caughtUpThread(stored, page, { partial: true })).toBeNull()
  })

  it('a copy that doesn’t reach back to the page’s start keeps its unsaved turn, though a row after it is shared', () => {
    // The copy started over: an unsaved turn, then a home turn the live bridge brought in.
    const page = [...thread(MAX_LIVE_MESSAGES - 1, 300), msg('home-turn:r', 'assistant')]
    const stored = [msg('unsaved-u'), msg('unsaved-a', 'assistant'), msg('home-turn:r', 'assistant')]
    expect(caughtUpThread(stored, page, { partial: true })).toBeNull()
  })

  it('a page that shares nothing with the copy takes nothing', () => {
    expect(caughtUpThread(thread(MAX_LIVE_MESSAGES), thread(MAX_LIVE_MESSAGES, 1000), { partial: true })).toBeNull()
  })
})
