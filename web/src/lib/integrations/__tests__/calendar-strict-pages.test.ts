/**
 * A strict events read (every availability reader: find_times, slot checks,
 * booking pages, customer slots) reads the whole range: it follows the
 * provider's next pages, and throws past STRICT_READ_MAX_PAGES instead of
 * handing back part of it, since an unread event would be offered as free
 * time. A non-strict read keeps its one page. A person whose only calendar
 * is the desktop's Exchange rows reads strictly too.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null; count?: number }>,
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(async () => null),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async () => ({ token: 't' })),
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

const { listCalendarEventsUnified, STRICT_READ_MAX_PAGES } = await import('@/lib/integrations/calendar')

const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

const RANGE = { timeMin: '2026-11-02T05:00:00.000Z', timeMax: '2026-12-02T05:00:00.000Z', maxResults: 2 }

function setTables(provider: 'google' | 'microsoft' | null, local: unknown[] = []) {
  hoisted.tables = {
    local_calendar_event: { data: local, error: null, count: local.length },
    connected_account: { data: provider ? [{ id: 'a1', provider, account_email: 'dana@example.com', color: null }] : [], error: null },
  }
}

const googleEvent = (n: number) => ({ id: `g${n}`, summary: `Job ${n}`, start: { dateTime: `2026-11-${String(n).padStart(2, '0')}T15:00:00Z` }, end: { dateTime: `2026-11-${String(n).padStart(2, '0')}T16:00:00Z` }, status: 'confirmed' })
const graphEvent = (n: number) => ({ id: `m${n}`, subject: `Job ${n}`, start: { dateTime: `2026-11-${String(n).padStart(2, '0')}T15:00:00.0000000` }, end: { dateTime: `2026-11-${String(n).padStart(2, '0')}T16:00:00.0000000` } })

/** Google pages of two events each; the last page has no next token. */
function googlePages(pages: number) {
  return vi.fn(async (url: string) => {
    const token = new URL(url).searchParams.get('pageToken')
    const page = token ? Number(token) : 0
    const next = page + 1 < pages ? { nextPageToken: String(page + 1) } : {}
    return { ok: true, status: 200, json: async () => ({ summary: 'Work', items: [googleEvent(page * 2 + 1), googleEvent(page * 2 + 2)], ...next }) }
  })
}

describe('strict reads follow the next pages', () => {
  it('reads every Google page of a strict read', async () => {
    setTables('google')
    const fetchMock = googlePages(3)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['primary'] }, strict: true })
    expect(events.map((e) => e.id)).toEqual(['g1', 'g2', 'g3', 'g4', 'g5', 'g6'])
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(events[0].calendarName).toBe('Work')
  })

  it('keeps a non-strict read to its first page', async () => {
    setTables('google')
    const fetchMock = googlePages(3)
    globalThis.fetch = fetchMock as unknown as typeof fetch
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['primary'] } })
    expect(events.map((e) => e.id)).toEqual(['g1', 'g2'])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('throws, never a partial list, when a strict Google read passes the page ceiling', async () => {
    setTables('google')
    globalThis.fetch = googlePages(STRICT_READ_MAX_PAGES + 1) as unknown as typeof fetch
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['primary'] }, strict: true })).rejects.toThrow(/more events in this range/)
  })

  it('throws when a later Google page fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setTables('google')
    let calls = 0
    globalThis.fetch = vi.fn(async () => {
      calls++
      if (calls === 1) return { ok: true, status: 200, json: async () => ({ items: [googleEvent(1)], nextPageToken: '1' }) }
      return { ok: false, status: 503, json: async () => ({}) }
    }) as unknown as typeof fetch
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['primary'] }, strict: true })).rejects.toThrow('Google Calendar API error: 503')
  })

  it('follows Outlook next links on a strict read, and not on a non-strict one', async () => {
    const make = () =>
      vi.fn(async (url: string) => {
        const page = url.includes('skip=2') ? 1 : 0
        const next = page === 0 ? { '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/calendars/c1/calendarview?skip=2' } : {}
        return { ok: true, status: 200, json: async () => ({ value: [graphEvent(page * 2 + 1), graphEvent(page * 2 + 2)], ...next }) }
      })
    setTables('microsoft')
    globalThis.fetch = make() as unknown as typeof fetch
    const strict = await listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['c1'] }, strict: true })
    expect(strict.map((e) => e.id)).toEqual(['m1', 'm2', 'm3', 'm4'])
    globalThis.fetch = make() as unknown as typeof fetch
    const loose = await listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['c1'] } })
    expect(loose.map((e) => e.id)).toEqual(['m1', 'm2'])
  })

  it('throws when a strict Outlook read passes the page ceiling', async () => {
    setTables('microsoft')
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [graphEvent(1)], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/next' }) })) as unknown as typeof fetch
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, calendarIds: { a1: ['c1'] }, strict: true })).rejects.toThrow(/more events in this range/)
  })
})

describe('the desktop Exchange rows alone', () => {
  const row = { external_id: 'x1', title: 'Work call', start_at: '2026-11-05T12:00:00+00:00', end_at: '2026-11-05T12:30:00+00:00', is_all_day: false }

  it('reads strictly with no OAuth account: the Exchange rows are the calendar', async () => {
    setTables(null, [row])
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, strict: true })
    expect(events.map((e) => e.id)).toEqual(['x1'])
  })

  it('still throws when there is no calendar at all', async () => {
    setTables(null, [])
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, strict: true })).rejects.toThrow('No calendar provider connected')
  })

  it('throws on a strict read whose account list fails, instead of falling back', async () => {
    hoisted.tables = {
      local_calendar_event: { data: [row], error: null, count: 1 },
      connected_account: { data: null, error: { message: 'statement timeout' } },
    }
    await expect(listCalendarEventsUnified('user-1', { ...RANGE, strict: true })).rejects.toThrow('Calendar accounts could not be read: statement timeout')
  })
})
