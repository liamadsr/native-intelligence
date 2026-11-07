/**
 * listCalendarEventsUnified's onSkipped: a non-strict read that leaves a
 * calendar out says so. On PROD (2026-11-02) a bare date made Google answer
 * 400, the read skipped it in silence, and a week came back Exchange-only as
 * if it were the whole week.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  token: { token: 't' } as { token: string } | null,
}))

vi.mock('@/lib/oauth/token-manager', () => ({
  getValidToken: vi.fn(),
  getValidTokenForCapability: vi.fn(),
  getAllValidTokens: vi.fn(),
  getValidTokenForAccount: vi.fn(async () => hoisted.token),
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
  hoisted.token = { token: 't' }
  vi.restoreAllMocks()
})

const RANGE = { timeMin: '2026-11-02T05:00:00.000Z', timeMax: '2026-11-08T05:00:00.000Z', workspaceId: 'ws-1' }
const EXCHANGE_ROW = { external_id: 'x1', title: 'Work call', start_at: '2026-11-05T12:00:00+00:00', end_at: '2026-11-05T12:30:00+00:00', is_all_day: false }

function setTables(googleAccount = true, localError: string | null = null) {
  hoisted.tables = {
    local_calendar_event: { data: localError ? null : [EXCHANGE_ROW], error: localError ? { message: localError } : null },
    connected_account_workspace: { data: [{ account_id: 'a1' }], error: null },
    connected_account: { data: googleAccount ? [{ id: 'a1', provider: 'google', account_email: 'me@gmail.com', color: null }] : [], error: null },
  }
}

describe('listCalendarEventsUnified: onSkipped', () => {
  it('names a Google calendar that answered with an error, and still lists the Exchange rows', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    setTables()
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })) as unknown as typeof fetch
    const onSkipped = vi.fn()
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, onSkipped })
    expect(events.map((e) => e.id)).toEqual(['x1'])
    expect(onSkipped).toHaveBeenCalledWith({ provider: 'google', accountEmail: 'me@gmail.com', reason: 'Google Calendar API error: 400' })
  })

  it('names an account whose sign-in cannot be renewed', async () => {
    setTables()
    hoisted.token = null
    const onSkipped = vi.fn()
    await listCalendarEventsUnified('user-1', { ...RANGE, onSkipped })
    expect(onSkipped).toHaveBeenCalledWith({ provider: 'google', accountEmail: 'me@gmail.com', reason: 'it needs signing in again' })
  })

  it('names the Exchange rows when they fail to load', async () => {
    setTables(false, 'statement timeout')
    globalThis.fetch = vi.fn() as unknown as typeof fetch
    const onSkipped = vi.fn()
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, onSkipped })
    expect(events).toEqual([])
    expect(onSkipped).toHaveBeenCalledWith({ provider: 'local_exchange', reason: 'statement timeout' })
  })

  it('says nothing when every calendar was read', async () => {
    setTables()
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: 'g1', summary: 'Standup', start: { dateTime: '2026-11-05T06:30:00-05:00' }, end: { dateTime: '2026-11-05T06:45:00-05:00' } }] }),
    })) as unknown as typeof fetch
    const onSkipped = vi.fn()
    const events = await listCalendarEventsUnified('user-1', { ...RANGE, onSkipped })
    expect(events.map((e) => e.id)).toEqual(['g1', 'x1'])
    expect(onSkipped).not.toHaveBeenCalled()
  })
})

// Outlook writes send `{ dateTime, timeZone: 'UTC' }`: a time read back in the person's zone must land at that instant.
describe('graphUtcDateTime', () => {
  it('an instant with an offset or Z goes as its UTC wall time; a wall time or a date as it was', async () => {
    const { graphUtcDateTime } = await import('../calendar')
    expect(graphUtcDateTime('2026-11-05T07:00:00-05:00')).toBe('2026-11-05T12:00:00.000')
    expect(graphUtcDateTime('2026-11-05T12:00:00Z')).toBe('2026-11-05T12:00:00.000')
    expect(graphUtcDateTime('2026-11-05T07:00:00+05:30')).toBe('2026-11-05T01:30:00.000')
    expect(graphUtcDateTime('2026-11-05T07:00:00')).toBe('2026-11-05T07:00:00')
    expect(graphUtcDateTime('2026-11-05')).toBe('2026-11-05')
  })
})
