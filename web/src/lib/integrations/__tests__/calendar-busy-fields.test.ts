/**
 * What listCalendarEventsUnified tells the availability engine about each
 * event (src/lib/availability): marked as free time (Google's transparency,
 * Outlook's showAs), the person's own answer to the invite (Google's `self`
 * attendee, Outlook's responseStatus); an account named with no calendars is
 * left out, never read as its primary; and a strict read throws when the
 * desktop's Exchange rows fail to load.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async (id: string) => ({ token: `tok-${id}`, email: null, accountId: id })),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'gte', 'lte', 'order', 'not', 'limit']) chain[m] = () => chain
      chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(hoisted.tables[table] ?? { data: [], error: null }).then(resolve, reject)
      return chain
    },
  }),
}))

const { listCalendarEventsUnified } = await import('@/lib/integrations/calendar')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

const RANGE = { timeMin: '2026-11-02T05:00:00.000Z', timeMax: '2026-11-09T05:00:00.000Z', workspaceId: 'ws-1' }

function setTables(accounts: Array<{ id: string; provider: string }>, localError: string | null = null) {
  hoisted.tables = {
    local_calendar_event: { data: localError ? null : [], error: localError ? { message: localError } : null },
    connected_account_workspace: { data: accounts.map((a) => ({ account_id: a.id })), error: null },
    connected_account: { data: accounts.map((a) => ({ ...a, account_email: `${a.id}@example.com`, color: null })), error: null },
  }
}

const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body })

describe('the busy fields', () => {
  it('Google: transparency and the self attendee’s answer', async () => {
    setTables([{ id: 'g', provider: 'google' }])
    globalThis.fetch = vi.fn(async () =>
      json({
        items: [
          { id: 'free', summary: 'Hold', start: { dateTime: '2026-11-03T09:00:00-05:00' }, end: { dateTime: '2026-11-03T10:00:00-05:00' }, transparency: 'transparent' },
          {
            id: 'declined',
            summary: 'Sync',
            start: { dateTime: '2026-11-03T11:00:00-05:00' },
            end: { dateTime: '2026-11-03T12:00:00-05:00' },
            attendees: [
              { email: 'g@example.com', self: true, responseStatus: 'declined' },
              { email: 'bo.marsh@example.com', responseStatus: 'accepted' },
            ],
          },
          { id: 'mine', summary: 'Focus', start: { dateTime: '2026-11-03T13:00:00-05:00' }, end: { dateTime: '2026-11-03T14:00:00-05:00' }, transparency: 'opaque', attendees: [{ email: 'bo.marsh@example.com', responseStatus: 'declined' }] },
        ],
      }),
    ) as unknown as typeof fetch
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, strict: true })
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId.free.transparent).toBe(true)
    expect(byId.free.myResponse).toBeUndefined()
    expect(byId.declined.myResponse).toBe('declined')
    expect(byId.declined.transparent).toBeUndefined()
    // Someone else's decline is not the person's.
    expect(byId.mine.myResponse).toBeUndefined()
    expect(byId.mine.transparent).toBeUndefined()
  })

  it("Outlook: showAs free, and the person's responseStatus", async () => {
    setTables([{ id: 'm', provider: 'microsoft' }])
    globalThis.fetch = vi.fn(async () =>
      json({
        value: [
          { id: 'free', subject: 'FYI', start: { dateTime: '2026-11-03T14:00:00.0000000' }, end: { dateTime: '2026-11-03T15:00:00.0000000' }, showAs: 'free' },
          { id: 'declined', subject: 'Sync', start: { dateTime: '2026-11-03T16:00:00.0000000' }, end: { dateTime: '2026-11-03T17:00:00.0000000' }, showAs: 'busy', responseStatus: { response: 'declined' } },
          { id: 'tentative', subject: 'Maybe', start: { dateTime: '2026-11-03T18:00:00.0000000' }, end: { dateTime: '2026-11-03T19:00:00.0000000' }, showAs: 'tentative' },
        ],
      }),
    ) as unknown as typeof fetch
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, strict: true })
    const byId = Object.fromEntries(events.map((e) => [e.id, e]))
    expect(byId.free.transparent).toBe(true)
    expect(byId.declined).toMatchObject({ myResponse: 'declined' })
    expect(byId.declined.transparent).toBeUndefined()
    expect(byId.tentative.transparent).toBeUndefined()
  })
})

describe('the calendars read', () => {
  it('an account named with no calendars is left out; one not named reads its primary', async () => {
    setTables([
      { id: 'g1', provider: 'google' },
      { id: 'g2', provider: 'google' },
    ])
    const fetchMock = vi.fn(async (_url: string) => json({ items: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await listCalendarEventsUnified('user-1', { ...RANGE, strict: true, calendarIds: { g1: [] } })
    const urls = fetchMock.mock.calls.map(([url]) => String(url))
    expect(urls).toHaveLength(1)
    expect(urls[0]).toContain('/calendars/primary/events')
  })

  it('every named calendar is read', async () => {
    setTables([{ id: 'g1', provider: 'google' }])
    const fetchMock = vi.fn(async (_url: string) => json({ items: [] }))
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await listCalendarEventsUnified('user-1', { ...RANGE, strict: true, calendarIds: { g1: ['g1@example.com', 'family'] } })
    expect(fetchMock.mock.calls.map(([url]) => String(url).split('/events')[0].split('/calendars/')[1]).sort()).toEqual(['family', 'g1%40example.com'])
  })
})

describe('strict', () => {
  it("throws when the desktop's Exchange rows fail to load: unread, never no events", async () => {
    setTables([], 'statement timeout')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, strict: true })).rejects.toThrow('Exchange calendar could not be read: statement timeout')
  })

  it('a non-strict read still names them and goes on', async () => {
    setTables([], 'statement timeout')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    const onSkipped = vi.fn()
    expect(await listCalendarEventsUnified('user-1', { ...RANGE, onSkipped })).toEqual([])
    expect(onSkipped).toHaveBeenCalledWith({ provider: 'local_exchange', reason: 'statement timeout' })
  })
})
