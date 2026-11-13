import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/admin', () => ({ getServiceClient: () => { throw new Error('not in tests') } }))
vi.mock('@/lib/work/resolve', () => ({ resolveWorkForDeliverable: vi.fn(async () => 'none') }))
vi.mock('../thread-mailbox', () => ({ ownedMailbox: vi.fn(async () => null) }))

const { AUTO_DRAFT_TTL_MS, MAX_EXPIRED_PER_RUN, draftEventDay, draftExpiry, expireAutomaticDrafts, mentionedDays } = await import('../draft-expiry')

const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`)
const NOW = Date.parse('2026-10-27T15:00:00Z')

describe('mentionedDays: explicit calendar dates only', () => {
  const anchor = Date.parse('2026-10-12T12:00:00Z')
  it.each([
    ['Dinner @ Thu Oct 16, 2026 7pm - 9pm (EDT)', ['2026-10-16']],
    ['See you Thursday, October 16th', ['2026-10-16']],
    ['on 13 October', ['2026-10-13']],
    ['the 10th of Oct.', ['2026-10-10']],
    ['due 2026-10-20 and 11/02/2026', ['2026-10-20', '2026-11-02']],
    ['Sept 30 or Oct. 2', ['2026-09-30', '2026-10-02']],
  ])('%j', (text, expected) => {
    expect(mentionedDays(text, anchor)).toEqual(expected.map(day))
  })

  it('a date without a year takes the year nearest the draft', () => {
    expect(mentionedDays('Jan 5', Date.parse('2026-12-20T00:00:00Z'))).toEqual([day('2027-01-05')])
    expect(mentionedDays('Dec 30', Date.parse('2027-01-02T00:00:00Z'))).toEqual([day('2026-12-30')])
  })

  it('relative words, times, prices and impossible dates are not dates', () => {
    expect(mentionedDays('tomorrow at 3, Thursday, $10/16, Feb 30, 7:30, may we meet', day('2026-10-12'))).toEqual([])
  })
})

describe('draftEventDay: the latest day ahead when the draft was written', () => {
  const created = Date.parse('2026-10-12T12:00:00Z')
  it('takes the latest upcoming day, ignoring days already past', () => {
    expect(draftEventDay('Following up on our Oct 3 call. Can we do Oct 14 or Oct 16?', created)).toBe(day('2026-10-16'))
    expect(draftEventDay('Following up on our Oct 3 call.', created)).toBeNull()
    expect(draftEventDay('Thanks again!', created)).toBeNull()
  })
  it("yesterday and today are not what a draft is about (the review: \"great speaking on Oct 11\", \"your invoice dated today\")", () => {
    expect(draftEventDay('Great speaking on Oct 11', created)).toBeNull()
    expect(draftEventDay('your invoice dated 10/12/2026', created)).toBeNull()
    expect(draftEventDay('see you Oct 13', created)).toBe(day('2026-10-13'))
  })
})

describe('draftExpiry', () => {
  const draft = (created: string, subject: string, body = '') => ({ created_at: created, subject, body_text: body })
  it('a week old: age, whatever it is about', () => {
    expect(AUTO_DRAFT_TTL_MS).toBe(7 * 24 * 60 * 60_000)
    expect(draftExpiry(draft('2026-10-20T14:00:00Z', 'Re: Pricing'), NOW)).toBe('age')
    expect(draftExpiry(draft('2026-10-21T16:00:00Z', 'Re: Pricing'), NOW)).toBeNull()
  })
  it('the day it is about has passed (the Oct 16 dinner, the Oct 13 event)', () => {
    expect(draftExpiry(draft('2026-10-21T10:00:00Z', 'Re: Invitation: Dinner @ Fri Oct 23, 2026 7pm'), NOW)).toBe('event_passed')
    expect(draftExpiry(draft('2026-10-24T10:00:00Z', 'Re: Plans', 'See you on October 25th!'), NOW)).toBe('event_passed')
    // The whole day must be over everywhere: Oct 26 passes from Oct 28 00:00 UTC.
    expect(draftExpiry(draft('2026-10-24T10:00:00Z', 'Re: Plans', 'See you on October 26th!'), NOW)).toBeNull()
    expect(draftExpiry(draft('2026-10-24T10:00:00Z', 'Re: Plans', 'See you on October 26th!'), Date.parse('2026-10-28T00:00:00Z'))).toBe('event_passed')
    // Still ahead.
    expect(draftExpiry(draft('2026-10-24T10:00:00Z', 'Re: Plans', 'See you on Nov 2'), NOW)).toBeNull()
  })
  it('an unknown creation time waits', () => {
    expect(draftExpiry({ created_at: null, subject: 'Oct 1' }, NOW)).toBeNull()
  })
})

describe('expireAutomaticDrafts', () => {
  type Row = Record<string, unknown>
  interface Fake { othersOnHold?: Row[] | null; othersError?: boolean; holdStatus?: string; deleted?: (id: unknown) => boolean }
  function fakeDb(rows: Row[], fake: Fake = {}) {
    const calls: Array<{ table: string; op: string; filters: Array<[string, unknown]> }> = []
    const from = (table: string) => {
      const filters: Array<[string, unknown]> = []
      let op = 'select'
      const result = () => {
        calls.push({ table, op, filters })
        const id = filters.find(([k]) => k === 'id')?.[1]
        if (op === 'delete' && table === 'email_draft') return { data: (fake.deleted?.(id) ?? true) ? [{ id }] : [], error: null }
        if (op === 'delete') return { data: null, error: null }
        if (table === 'email_hold') return { data: { status: fake.holdStatus ?? 'held' }, error: null }
        if (filters.some(([k]) => k === 'hold_id')) return fake.othersError ? { data: null, error: { message: 'down' } } : { data: fake.othersOnHold ?? [], error: null }
        return { data: rows, error: null }
      }
      const api: Record<string, unknown> = {
        select: () => api,
        delete: () => { op = 'delete'; return api },
        eq: (k: string, v: unknown) => { filters.push([k, v]); return api },
        order: () => api,
        limit: () => api,
        maybeSingle: async () => result(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      }
      return api
    }
    return { db: { from } as never, calls }
  }
  const row = (id: string, created: string, extra: Row = {}) => ({
    id, user_id: 'u', account_id: 'acct', hold_id: `h-${id}`, provider_draft_id: `m-${id}`, subject: 'Re: Pricing', body_text: 'Thanks', created_at: created, ...extra,
  })
  const deps = () => ({ deleteMailboxDraft: vi.fn(async (_u: string, _a: string, _id: string) => true), resolveWork: vi.fn(async (_id: string) => {}) })
  const deletes = (calls: ReturnType<typeof fakeDb>['calls']) => calls.filter((c) => c.op === 'delete').map((c) => c.table)

  it('reads only untouched automatic drafts and dismisses the due ones: row, hold, mailbox draft, work item', async () => {
    const { db, calls } = fakeDb([row('old', '2026-10-12T10:00:00Z'), row('fresh', '2026-10-26T10:00:00Z')])
    const d = deps()
    const out = await expireAutomaticDrafts(db, new Date(NOW), d)
    expect(out).toEqual({ age: 1, eventPassed: 0 })
    expect(calls[0].filters).toEqual([['status', 'pending_review'], ['metadata->>origin', 'automatic']])
    expect(deletes(calls)).toEqual(['email_draft', 'email_hold'])
    expect(calls.find((c) => c.op === 'delete')!.filters).toEqual([['id', 'old'], ['user_id', 'u'], ['status', 'pending_review']])
    expect(calls.filter((c) => c.op === 'delete')[1].filters).toEqual([['user_id', 'u'], ['id', 'h-old']])
    expect(d.deleteMailboxDraft).toHaveBeenCalledWith('u', 'acct', 'm-old')
    expect(d.resolveWork).toHaveBeenCalledWith('old')
  })

  it('a hold another draft still rests on stays; a failed read of it keeps it too (its delete cascades)', async () => {
    const one = fakeDb([row('old', '2026-10-12T10:00:00Z')], { othersOnHold: [{ id: 'other' }] })
    await expireAutomaticDrafts(one.db, new Date(NOW), deps())
    expect(deletes(one.calls)).toEqual(['email_draft'])
    const two = fakeDb([row('old', '2026-10-12T10:00:00Z')], { othersError: true })
    await expireAutomaticDrafts(two.db, new Date(NOW), deps())
    expect(deletes(two.calls)).toEqual(['email_draft'])
  })

  it('a draft edited or sent since the read is left alone: nothing in the mailbox, no work item, not counted', async () => {
    const { db, calls } = fakeDb([row('old', '2026-10-12T10:00:00Z')], { deleted: () => false })
    const d = deps()
    expect(await expireAutomaticDrafts(db, new Date(NOW), d)).toEqual({ age: 0, eventPassed: 0 })
    expect(deletes(calls)).toEqual(['email_draft'])
    expect(d.deleteMailboxDraft).not.toHaveBeenCalled()
    expect(d.resolveWork).not.toHaveBeenCalled()
  })

  it('a draft whose hold is mid-send is not touched', async () => {
    const { db, calls } = fakeDb([row('old', '2026-10-12T10:00:00Z')], { holdStatus: 'sending' })
    expect(await expireAutomaticDrafts(db, new Date(NOW), deps())).toEqual({ age: 0, eventPassed: 0 })
    expect(deletes(calls)).toEqual([])
  })

  it('dismisses at most MAX_EXPIRED_PER_RUN a run; a failing mailbox delete stops nothing', async () => {
    const rows = Array.from({ length: MAX_EXPIRED_PER_RUN + 5 }, (_, i) => row(`d${i}`, '2026-10-01T10:00:00Z'))
    const { db } = fakeDb(rows)
    const out = await expireAutomaticDrafts(db, new Date(NOW), { deleteMailboxDraft: async () => { throw new Error('token revoked') }, resolveWork: async () => {} })
    expect(out.age).toBe(MAX_EXPIRED_PER_RUN)
  })

  it('a failed read expires nothing and never throws', async () => {
    const db = { from: () => { throw new Error('down') } } as never
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await expireAutomaticDrafts(db, new Date(NOW))).toEqual({ age: 0, eventPassed: 0 })
  })
})

const { memoryDb } = await import('@/test/memory-db')

describe('expireAutomaticDrafts — a draft with a send scheduled (send later)', () => {
  const draft = (id: string, thread: string) => ({
    id, user_id: 'u', account_id: 'acct', hold_id: null, provider_draft_id: `m-${id}`, provider_thread_id: thread,
    subject: 'Re: Pricing', body_text: 'Thanks', created_at: '2026-10-01T10:00:00Z', status: 'pending_review', 'metadata->>origin': 'automatic',
  })

  it('is never swept; one on another thread still is', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = {
      email_draft: [draft('kept', 't-scheduled'), draft('swept', 't-other')],
      email_scheduled_send: [{ id: 's1', user_id: 'u', thread_id: 't-scheduled', status: 'scheduled' }],
    }
    const deleteMailboxDraft = vi.fn(async () => true)
    const out = await expireAutomaticDrafts(memoryDb(tables), new Date('2026-10-27T12:00:00Z'), { deleteMailboxDraft, resolveWork: async () => {} })
    expect(out).toEqual({ age: 1, eventPassed: 0 })
    expect(tables.email_draft.map((d) => d.id)).toEqual(['kept'])
    expect(deleteMailboxDraft).toHaveBeenCalledTimes(1)
    expect(deleteMailboxDraft).toHaveBeenCalledWith('u', 'acct', 'm-swept')
  })

  it('sweeps nothing when the schedules cannot be read (fail closed)', async () => {
    const tables: Record<string, Array<Record<string, unknown>>> = { email_draft: [draft('a', 't-1')] }
    const db = memoryDb(tables)
    const from = db.from.bind(db)
    ;(db as unknown as { from: (t: string) => unknown }).from = (t: string) =>
      t === 'email_scheduled_send' ? { select: () => { throw new Error('down') } } : from(t)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(await expireAutomaticDrafts(db, new Date('2026-10-27T12:00:00Z'), { deleteMailboxDraft: vi.fn(), resolveWork: async () => {} })).toEqual({ age: 0, eventPassed: 0 })
    expect(tables.email_draft).toHaveLength(1)
    warn.mockRestore()
  })
})
