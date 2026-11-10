/**
 * show and read_card for calendar and mail cards (P2), on an in-memory double
 * that projects selected columns and holds rows a person must NOT see: a
 * teammate's mail, another workspace's thread copies, a mailbox linked only
 * to another workspace, a teammate's calendar account. Mail and calendar are
 * per person, and the tools run on the service client, so every fence is the
 * code's own.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { buildCardContextEntry, type CardContextEntry } from '@/lib/chat-cards/context'
import { UNTRUSTED_EMAIL_PREFIX } from '@/lib/email/untrusted'

const listCalendarEventsUnified = vi.fn()
vi.mock('@/lib/integrations/calendar', () => ({ listCalendarEventsUnified: (...args: unknown[]) => listCalendarEventsUnified(...args) }))
// The default client is never the one these reads use: they take the tools' own.
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    throw new Error('the service client must come from the caller')
  },
}))

// No stored mail: a card's subjects and sender names come live from the
// mailbox (one batched call per mailbox), and search runs at the provider.
const liveHeaders = vi.fn(async (_db: unknown, args: { rows: Array<{ id: string; provider_thread_id: string }> }) =>
  Object.fromEntries(args.rows.map((r) => [r.id, { subject: `Subject ${r.provider_thread_id}`, snippet: null, from_name: 'Sarah Lee' }])),
)
vi.mock('@/lib/email/thread-headers', () => ({ fetchThreadHeaders: liveHeaders }))
// A searched card runs the list's own provider search (live-thread-search.ts):
// the hits are the count and the items, over the mailboxes it is handed.
const liveSearches: Array<{ query: string; folder: string; accountIds?: readonly string[] | null; unreadOnly?: boolean }> = []
vi.mock('@/lib/email/live-thread-search', () => ({
  searchThreadsLive: async (_u: string, _w: string, opts: { query: string; folder: string; accountIds?: readonly string[] | null; unreadOnly?: boolean }) => {
    liveSearches.push(opts)
    const hits = [
      { accountId: 'acct-gmail', provider: 'google', threadId: 't1', messageId: 'm1', subject: 'Acme invoice', snippet: null, fromName: 'Sarah Lee', fromEmail: 'sarah@acme.com', date: '2026-10-08T12:00:00Z', isUnread: true, isStarred: false, hasAttachments: false, folder: 'inbox' },
      // Older than the index: a provider hit all the same.
      { accountId: 'acct-gmail', provider: 'google', threadId: 't-2024', messageId: 'm9', subject: 'Acme 2024 renewal', snippet: null, fromName: null, fromEmail: 'ops@acme.com', date: '2024-05-01T00:00:00Z', isUnread: false, isStarred: false, hasAttachments: false, folder: 'inbox' },
    ]
    return { hits: hits.filter((h) => opts.accountIds?.includes(h.accountId)), cursor: null, accounts: [] }
  },
}))

const { createShowTools } = await import('../show')

const WS = 'ws-1'
const ME = 'user-me'
const MATE = 'user-mate'
const MY_GMAIL = 'acct-gmail'
const MY_WORK = 'acct-work'
const MY_ELSEWHERE = 'acct-elsewhere' // mine, but linked only to another workspace
const MATE_MAIL = 'acct-mate'

function thread(id: string, extra: Record<string, unknown>) {
  return {
    id: `row-${id}`,
    provider_thread_id: id,
    user_id: ME,
    workspace_id: WS,
    account_id: MY_GMAIL,
    subject: `Subject ${id}`,
    snippet: '',
    from_name: 'Sarah Lee',
    from_email: 'sarah@acme.com',
    last_message_at: '2026-10-08T10:00:00Z',
    is_unread: false,
    is_starred: false,
    needs_reply: false,
    folder: 'inbox',
    message_count: 2,
    ...extra,
  }
}

function seeded() {
  const db = makeFakeSupabase({ project: true })
  db.seed('connected_account', [
    { id: MY_GMAIL, user_id: ME, capability: 'email', is_enabled: true, provider: 'google', account_email: 'me@gmail.com', created_at: '1' },
    { id: MY_WORK, user_id: ME, capability: 'email', is_enabled: true, provider: 'microsoft', account_email: 'me@acme.com', created_at: '2' },
    { id: MY_ELSEWHERE, user_id: ME, capability: 'email', is_enabled: true, provider: 'google', account_email: 'me@side.com', created_at: '3' },
    { id: MATE_MAIL, user_id: MATE, capability: 'email', is_enabled: true, provider: 'google', account_email: 'mate@acme.com', created_at: '4' },
    { id: 'acct-off', user_id: ME, capability: 'email', is_enabled: false, provider: 'google', account_email: 'me@old.com', created_at: '5' },
    { id: 'cal-mine', user_id: ME, capability: 'calendar', is_enabled: true, provider: 'google', account_email: 'me@gmail.com' },
    { id: 'cal-off', user_id: ME, capability: 'calendar', is_enabled: false, provider: 'google', account_email: 'me@old.com' },
    { id: 'cal-mine-elsewhere', user_id: ME, capability: 'calendar', is_enabled: true, provider: 'google', account_email: 'me@side.com' },
    { id: 'cal-mate', user_id: MATE, capability: 'calendar', is_enabled: true, provider: 'google', account_email: 'mate@acme.com' },
  ])
  db.seed('connected_account_workspace', [
    { account_id: MY_GMAIL, workspace_id: WS },
    { account_id: MY_WORK, workspace_id: WS },
    { account_id: MY_ELSEWHERE, workspace_id: 'ws-other' },
    { account_id: MATE_MAIL, workspace_id: WS },
    { account_id: 'acct-off', workspace_id: WS },
    { account_id: 'cal-mine', workspace_id: WS },
    { account_id: 'cal-off', workspace_id: WS },
    { account_id: 'cal-mine-elsewhere', workspace_id: 'ws-other' },
    { account_id: 'cal-mate', workspace_id: WS },
  ])
  db.seed('email_thread_index', [
    thread('t1', { subject: 'Acme invoice', last_message_at: '2026-10-08T12:00:00Z', is_unread: true }),
    thread('t2', { subject: 'Lunch', account_id: MY_WORK, from_name: 'Bob', from_email: 'bob@example.com', last_message_at: '2026-10-07T12:00:00Z' }),
    thread('t3', { subject: 'Old Acme deal', folder: 'archive' }),
    // Mine, but another workspace's copy.
    thread('t4', { subject: 'Acme copy elsewhere', workspace_id: 'ws-other' }),
    // Mine, in a mailbox linked only to another workspace.
    thread('t5', { subject: 'Acme side project', account_id: MY_ELSEWHERE }),
    // Mine, in a disabled mailbox linked here.
    thread('t7', { subject: 'Acme from the old mailbox', account_id: 'acct-off' }),
    // A teammate's mail, in this workspace.
    thread('t6', { subject: 'Acme mate secret', user_id: MATE, account_id: MATE_MAIL }),
  ])
  return db
}

type Exec = (input: unknown) => Promise<Record<string, unknown>>
/**
 * The browser sends its zone on every turn of every chat, so a turn's zone
 * defaults to New York here; pass `timeZone: undefined` for a turn without one.
 */
function tools(db: ReturnType<typeof makeFakeSupabase>, opts: { cards?: CardContextEntry[]; kinds?: Array<'calendar' | 'mail'>; timeZone?: string } = {}) {
  const timeZone = 'timeZone' in opts ? opts.timeZone : 'America/New_York'
  const t = createShowTools(ME, db as never, WS, opts.cards, opts.kinds ?? ['calendar', 'mail'], timeZone)
  return {
    show: ((input: unknown) => (t.show.execute as unknown as Exec)(input)) as Exec,
    readCard: ((input: unknown) => (t.read_card.execute as unknown as Exec)(input)) as Exec,
  }
}

beforeEach(() => {
  listCalendarEventsUnified.mockReset()
  listCalendarEventsUnified.mockResolvedValue([])
})

describe('show: mail', () => {
  it('a search counts and lists the provider hits in the person’s own readable mailboxes here, subjects marked untrusted', async () => {
    liveSearches.length = 0
    const out = await tools(seeded()).show({ kind: 'mail', title: 'Acme', mail: { search: 'acme' } })
    expect(out.success).toBe(true)
    expect(out.card).toEqual({ kind: 'mail', title: 'Acme', mail: { folder: 'inbox', search: 'acme' } })
    // The same search the card's list runs: the folder, only the readable mailboxes
    // (not one linked elsewhere, a disabled one or a teammate's).
    expect(liveSearches).toEqual([{ query: 'acme', folder: 'inbox', accountIds: [MY_GMAIL, MY_WORK], unreadOnly: false }])
    expect(out.count).toBe(2)
    const items = out.items as Array<{ thread_id: string; from: string; subject: string; unread?: boolean }>
    expect(items.map((i) => i.thread_id)).toEqual(['t1', 't-2024'])
    expect(items[0].from).toBe('Sarah Lee <sarah@acme.com>')
    expect(items[1].from).toBe('ops@acme.com')
    expect(items[0].subject.startsWith(UNTRUSTED_EMAIL_PREFIX)).toBe(true)
    expect(items[0].unread).toBe(true)
  })

  it('filters to a mailbox named by address, holds its id, and refuses one that is not the person’s here, naming only theirs', async () => {
    const db = seeded()
    const ok = await tools(db).show({ kind: 'mail', title: 'Work', mail: { accounts: ['ME@ACME.COM'] } })
    expect(ok.card).toEqual({ kind: 'mail', title: 'Work', mail: { folder: 'inbox', accounts: [MY_WORK] } })
    expect((ok.items as Array<{ thread_id: string }>).map((i) => i.thread_id)).toEqual(['t2'])

    for (const other of ['mate@acme.com', 'me@side.com', MATE_MAIL, 'me@old.com']) {
      const bad = await tools(db).show({ kind: 'mail', title: 'x', mail: { accounts: [other] } })
      expect(bad).toMatchObject({ success: false, code: 'INPUT_INVALID' })
      expect(bad.error).toContain(`mail.accounts: '${other.toLowerCase()}' is not one of your mailboxes here. Use one of: me@gmail.com, me@acme.com`)
      expect(bad.error).not.toContain('mate@acme.com, ')
      expect(bad.error).not.toContain('me@side.com,')
    }
  })

  it('lists only unread threads when asked ("unread from Acme")', async () => {
    const db = seeded()
    const all = await tools(db).show({ kind: 'mail', title: 'Inbox', mail: {} })
    expect(all.count).toBe(2)
    const unread = await tools(db).show({ kind: 'mail', title: 'Unread', mail: { unread: true } })
    expect(unread.card).toEqual({ kind: 'mail', title: 'Unread', mail: { folder: 'inbox', unread: true } })
    expect((unread.items as Array<{ thread_id: string }>).map((i) => i.thread_id)).toEqual(['t1'])
  })

  it('opens one thread the person may read, and refuses anyone else’s as not found', async () => {
    const db = seeded()
    const ok = await tools(db).show({ kind: 'mail', title: 'Invoice', mail: { thread_id: 't1' } })
    expect(ok).toMatchObject({ success: true, card: { kind: 'mail', mail: { folder: 'inbox', thread_id: 't1' } }, item: { thread_id: 't1', messages: 2 } })
    for (const id of ['t4', 't5', 't6', 't7']) {
      const bad = await tools(db).show({ kind: 'mail', title: 'x', mail: { thread_id: id } })
      expect(bad.success, id).toBe(false)
      expect(bad.error).toContain(`mail.thread_id: no thread '${id}' in your mailboxes here. Use a thread_id from list_emails`)
    }
  })

  it('is refused where the mail tools are not allowed (MCP, unattended runs, a ceiling without list_emails)', async () => {
    const out = await tools(seeded(), { kinds: ['calendar'] }).show({ kind: 'mail', title: 'Inbox' })
    expect(out).toEqual({
      success: false,
      code: 'NOT_AVAILABLE',
      error: "kind 'mail' shows only in a Native Intelligence chat that can read mail. Here, use list_emails and read_email instead",
    })
  })
})

describe('read_card: mail', () => {
  const spec = { kind: 'mail' as const, title: 'Inbox', base: { folder: 'inbox' as const } }

  it('returns the threads the card shows now, the person’s folder change included', async () => {
    const moved = buildCardContextEntry({ n: 1, id: 'm', spec, mail: { folder: 'archive' } })
    const out = await tools(seeded(), { cards: [moved] }).readCard({})
    expect(out).toMatchObject({ success: true, card: 1, folder: 'archive', total: 1 })
    expect((out.threads as Array<{ thread_id: string }>).map((t) => t.thread_id)).toEqual(['t3'])
  })

  it('never reads a forged mailbox: a card naming a teammate’s account is refused', async () => {
    const forged = buildCardContextEntry({ n: 1, id: 'm', spec, mail: { folder: 'inbox', accounts: [MATE_MAIL] } })
    const out = await tools(seeded(), { cards: [forged] }).readCard({ card: 1 })
    expect(out).toEqual({
      success: false,
      error: `mail.accounts: '${MATE_MAIL}' is not one of your mailboxes here. Use one of: me@gmail.com, me@acme.com, or leave accounts out for all`,
    })
  })

  it('is refused where mail cards are', async () => {
    const card = buildCardContextEntry({ n: 1, id: 'm', spec })
    const out = await tools(seeded(), { cards: [card], kinds: [] }).readCard({})
    expect(out).toMatchObject({ success: false, code: 'NOT_AVAILABLE' })
  })
})

describe('show: calendar', () => {
  it('counts the range in the person’s time zone, through get_calendar_events’ own reader, and returns the first ten', async () => {
    listCalendarEventsUnified.mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ id: `e${i}`, title: `Event ${i}`, start: `2026-10-0${(i % 6) + 4}T15:00:00Z`, end: `2026-10-0${(i % 6) + 4}T16:00:00Z`, accountEmail: 'me@gmail.com' })),
    )
    const out = await tools(seeded()).show({ kind: 'calendar', title: 'My week', calendar: { from: '2026-10-08', view: 'week' } })
    expect(out.success).toBe(true)
    expect(out.card).toEqual({ kind: 'calendar', title: 'My week', calendar: { from: '2026-10-04', to: '2026-10-10', view: 'week' } })
    expect(out.count).toBe(12)
    expect((out.items as unknown[]).length).toBe(10)
    expect((out.items as unknown[])[0]).toEqual({ id: 'e0', title: 'Event 0', start: '2026-10-04T15:00:00Z', end: '2026-10-04T16:00:00Z', account: 'me@gmail.com' })
    // New York midnights (EDT, UTC-4), the person's own events in this workspace.
    expect(listCalendarEventsUnified).toHaveBeenCalledWith(ME, {
      timeMin: '2026-10-04T04:00:00.000Z',
      timeMax: '2026-10-11T04:00:00.000Z',
      maxResults: 250,
      workspaceId: WS,
    })
  })

  it('filters to the person’s own calendar here, and refuses a teammate’s or one linked elsewhere, naming only theirs', async () => {
    const db = seeded()
    const ok = await tools(db).show({ kind: 'calendar', title: 'Gmail', calendar: { from: '2026-10-08', accounts: ['me@gmail.com'] } })
    expect(ok.card).toEqual({ kind: 'calendar', title: 'Gmail', calendar: { from: '2026-10-08', to: '2026-10-08', view: 'day', accounts: ['cal-mine'] } })
    expect(listCalendarEventsUnified.mock.calls[0][1]).toMatchObject({ accountIds: ['cal-mine'] })
    for (const other of ['mate@acme.com', 'me@side.com', 'cal-mate', 'me@old.com']) {
      const bad = await tools(db).show({ kind: 'calendar', title: 'x', calendar: { from: '2026-10-08', accounts: [other] } })
      expect(bad.success, other).toBe(false)
      expect(bad.error).toBe(`calendar.accounts: '${other}' is not one of your calendars here. Use one of: me@gmail.com, or leave accounts out for all`)
    }
  })

  it('is refused where the calendar tool is not allowed', async () => {
    const out = await tools(seeded(), { kinds: ['mail'] }).show({ kind: 'calendar', title: 'x', calendar: { from: '2026-10-08' } })
    expect(out).toMatchObject({ success: false, code: 'NOT_AVAILABLE', error: expect.stringContaining('use get_calendar_events instead') })
  })
})

describe('the zone a calendar card counts its days in', () => {
  const show = (db: ReturnType<typeof makeFakeSupabase>, timeZone?: string) =>
    tools(db, { timeZone }).show({ kind: 'calendar', title: 'Day', calendar: { from: '2026-10-08' } })

  it('is the browser’s zone the turn sent', async () => {
    await show(seeded(), 'America/New_York')
    // A New York day: an 8pm event (00:00Z next day) is inside it.
    expect(listCalendarEventsUnified.mock.calls[0][1]).toMatchObject({ timeMin: '2026-10-08T04:00:00.000Z', timeMax: '2026-10-09T04:00:00.000Z' })
  })

  it('is UTC without one, and a forged zone is ignored; no stored zone is read', async () => {
    const db = seeded()
    await show(db, 'Mars/Olympus')
    expect(listCalendarEventsUnified.mock.calls[0][1]).toMatchObject({ timeMin: '2026-10-08T00:00:00.000Z', timeMax: '2026-10-09T00:00:00.000Z' })
    await show(db, undefined)
    expect(listCalendarEventsUnified.mock.calls[1][1]).toMatchObject({ timeMin: '2026-10-08T00:00:00.000Z', timeMax: '2026-10-09T00:00:00.000Z' })
    // The legacy user_profiles table has no zone to read (its preferences read always failed).
    expect(db.calls.some((c) => c.table === 'user_profiles')).toBe(false)
  })

  it('read_card uses the zone the card was drawn in', async () => {
    const db = seeded()
    const card = buildCardContextEntry({
      n: 1,
      id: 'c',
      spec: { kind: 'calendar', title: 'Day', base: { from: '2026-10-08', to: '2026-10-08', view: 'day' } },
      timeZone: 'Asia/Tokyo',
    })
    await tools(db, { cards: [card], timeZone: 'America/New_York' }).readCard({})
    expect(listCalendarEventsUnified.mock.calls[0][1]).toMatchObject({ timeMin: '2026-10-07T15:00:00.000Z', timeMax: '2026-10-08T15:00:00.000Z' })
  })
})

describe('read_card: calendar', () => {
  it('returns the events in the range the card shows now', async () => {
    listCalendarEventsUnified.mockResolvedValue([{ id: 'e1', title: 'Board', start: '2026-10-20T15:00:00Z', end: '2026-10-20T16:00:00Z' }])
    const card = buildCardContextEntry({
      n: 4,
      id: 'c',
      spec: { kind: 'calendar', title: 'Week', base: { from: '2026-10-04', to: '2026-10-10', view: 'week' } },
      calendar: { from: '2026-10-01', to: '2026-10-31', view: 'month' },
    })
    const out = await tools(seeded(), { cards: [card] }).readCard({ card: 4 })
    expect(out).toEqual({
      success: true,
      card: 4,
      title: 'Week',
      range: { from: '2026-10-01', to: '2026-10-31', view: 'month' },
      total: 1,
      events: [{ id: 'e1', title: 'Board', start: '2026-10-20T15:00:00Z', end: '2026-10-20T16:00:00Z' }],
    })
    expect(listCalendarEventsUnified.mock.calls[0][1]).toMatchObject({ timeMin: '2026-10-01T04:00:00.000Z', timeMax: '2026-11-01T04:00:00.000Z' })
  })
})
