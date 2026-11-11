/**
 * Which calendars count as busy (../busy.ts): the primary and the ones the
 * person owns, never the ones they only follow; their own saved choice wins
 * either way; an account with nothing counted is named with an empty list (so
 * the read leaves it out, not reads its primary); and every failure throws,
 * so a time is never free because a calendar couldn't be read. No network:
 * the token and the calendar lists are injected.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import type { SubCalendar } from '@/lib/integrations/calendar'
import { countedCalendarIds, countedOf, countsByDefault, listCountedEvents } from '../busy'

const GOOGLE = { provider: 'google', account_email: 'ada.finch@example.com' }
const OUTLOOK = { provider: 'microsoft', account_email: 'Ada.Finch@Example.org' }

const cal = (id: string, extra: Partial<SubCalendar> = {}): SubCalendar => ({ id, summary: id, ...extra })

describe('countsByDefault', () => {
  it('Google: the primary and the calendars the person owns; not ones they follow', () => {
    expect(countsByDefault(cal('primary', { primary: true, accessRole: 'owner' }), GOOGLE)).toBe(true)
    expect(countsByDefault(cal('personal', { accessRole: 'owner' }), GOOGLE)).toBe(true)
    expect(countsByDefault(cal('holidays', { accessRole: 'reader' }), GOOGLE)).toBe(false)
    expect(countsByDefault(cal('teammate', { accessRole: 'writer' }), GOOGLE)).toBe(false)
    expect(countsByDefault(cal('free-busy-only', { accessRole: 'freeBusyReader' }), GOOGLE)).toBe(false)
  })

  it("Outlook: the default calendar and the person's own mailbox's others (any case); not one shared with them", () => {
    expect(countsByDefault(cal('default', { primary: true }), OUTLOOK)).toBe(true)
    expect(countsByDefault(cal('second', { ownerEmail: ' ada.finch@example.org ', accessRole: 'owner' }), OUTLOOK)).toBe(true)
    // Editable, but someone else's mailbox.
    expect(countsByDefault(cal('shared', { ownerEmail: 'bo.marsh@example.org', accessRole: 'owner' }), OUTLOOK)).toBe(false)
    expect(countsByDefault(cal('unknown', {}), OUTLOOK)).toBe(false)
    expect(countsByDefault(cal('second', { ownerEmail: 'ada.finch@example.org' }), { provider: 'microsoft', account_email: null })).toBe(false)
  })
})

describe('countedOf', () => {
  const calendars = [cal('primary', { primary: true, accessRole: 'owner' }), cal('personal', { accessRole: 'owner' }), cal('holidays', { accessRole: 'reader' })]

  it('the defaults with no choice saved', () => {
    expect(countedOf(calendars, GOOGLE, new Map())).toEqual(['primary', 'personal'])
  })

  it('a saved choice wins in both directions: a followed calendar in, the primary out', () => {
    expect(countedOf(calendars, GOOGLE, new Map([['holidays', true], ['primary', false]]))).toEqual(['personal', 'holidays'])
  })
})

const USER = 'user-ada'
const WS = 'ws-fernhill'

function tables(extra: Partial<Record<string, Record<string, unknown>[]>> = {}) {
  return {
    connected_account: [
      { id: 'acc-g', user_id: USER, provider: 'google', account_email: 'ada.finch@example.com', capability: 'calendar', is_enabled: true },
      { id: 'acc-m', user_id: USER, provider: 'microsoft', account_email: 'ada.finch@example.org', capability: 'calendar', is_enabled: true },
      // Not counted at all: disabled, another capability, another person, another workspace.
      { id: 'acc-off', user_id: USER, provider: 'google', account_email: 'old@example.com', capability: 'calendar', is_enabled: false },
      { id: 'acc-mail', user_id: USER, provider: 'google', account_email: 'ada.finch@example.com', capability: 'email', is_enabled: true },
      { id: 'acc-other', user_id: 'user-bo', provider: 'google', account_email: 'bo.marsh@example.com', capability: 'calendar', is_enabled: true },
      { id: 'acc-elsewhere', user_id: USER, provider: 'google', account_email: 'side@example.com', capability: 'calendar', is_enabled: true },
    ],
    connected_account_workspace: [
      { account_id: 'acc-g', workspace_id: WS },
      { account_id: 'acc-m', workspace_id: WS },
      { account_id: 'acc-off', workspace_id: WS },
      { account_id: 'acc-mail', workspace_id: WS },
      { account_id: 'acc-other', workspace_id: WS },
      { account_id: 'acc-elsewhere', workspace_id: 'ws-other' },
    ],
    calendar_sub_preference: [] as Record<string, unknown>[],
    ...extra,
  }
}

const GOOGLE_CALENDARS = [cal('ada.finch@example.com', { primary: true, accessRole: 'owner' }), cal('family', { accessRole: 'owner' }), cal('en.usa#holiday', { accessRole: 'reader' })]
const OUTLOOK_CALENDARS = [
  cal('AAM-default', { primary: true, accessRole: 'owner', ownerEmail: 'ada.finch@example.org' }),
  cal('AAM-side', { accessRole: 'owner', ownerEmail: 'ada.finch@example.org' }),
  cal('AAM-boss', { accessRole: 'reader', ownerEmail: 'cy.reed@example.org' }),
]

function deps(t = tables()) {
  return {
    supabase: memoryDb(t),
    token: vi.fn(async (accountId: string) => ({ token: `tok-${accountId}`, email: null, accountId })),
    googleCalendars: vi.fn(async (_token: string) => GOOGLE_CALENDARS),
    microsoftCalendars: vi.fn(async (_token: string) => OUTLOOK_CALENDARS),
  }
}

describe('countedCalendarIds', () => {
  it("each of the person's enabled calendar accounts in the workspace, its counted calendars by default", async () => {
    const d = deps()
    expect(await countedCalendarIds(USER, WS, d)).toEqual({
      'acc-g': ['ada.finch@example.com', 'family'],
      'acc-m': ['AAM-default', 'AAM-side'],
    })
    // Each list is read with its own account's token.
    expect(d.googleCalendars).toHaveBeenCalledWith('tok-acc-g')
    expect(d.microsoftCalendars).toHaveBeenCalledWith('tok-acc-m')
  })

  it('with no workspace, every enabled calendar account of theirs', async () => {
    expect(Object.keys(await countedCalendarIds(USER, undefined, deps())).sort()).toEqual(['acc-elsewhere', 'acc-g', 'acc-m'])
  })

  it('saved choices win both ways, per account; a null choice keeps the default', async () => {
    const t = tables({
      calendar_sub_preference: [
        { user_id: USER, account_id: 'acc-g', provider_calendar_id: 'en.usa#holiday', counts_as_busy: true },
        { user_id: USER, account_id: 'acc-g', provider_calendar_id: 'family', counts_as_busy: false },
        { user_id: USER, account_id: 'acc-g', provider_calendar_id: 'ada.finch@example.com', counts_as_busy: null },
        { user_id: USER, account_id: 'acc-m', provider_calendar_id: 'AAM-boss', counts_as_busy: true },
        // Someone else's choice, and the same id on another account, change nothing here.
        { user_id: 'user-bo', account_id: 'acc-g', provider_calendar_id: 'ada.finch@example.com', counts_as_busy: false },
        { user_id: USER, account_id: 'acc-m', provider_calendar_id: 'family', counts_as_busy: true },
      ],
    })
    expect(await countedCalendarIds(USER, WS, deps(t))).toEqual({
      'acc-g': ['ada.finch@example.com', 'en.usa#holiday'],
      'acc-m': ['AAM-default', 'AAM-side', 'AAM-boss'],
    })
  })

  it('an account with nothing counted is there with an empty list', async () => {
    const t = tables({
      calendar_sub_preference: [
        { user_id: USER, account_id: 'acc-m', provider_calendar_id: 'AAM-default', counts_as_busy: false },
        { user_id: USER, account_id: 'acc-m', provider_calendar_id: 'AAM-side', counts_as_busy: false },
      ],
    })
    const out = await countedCalendarIds(USER, WS, deps(t))
    expect(out['acc-m']).toEqual([])
    expect(out['acc-g']).toHaveLength(2)
  })

  it('an account that needs signing in again throws', async () => {
    const d = deps()
    d.token.mockImplementation(async (accountId: string) => (accountId === 'acc-m' ? null : { token: `tok-${accountId}`, email: null, accountId }) as never)
    await expect(countedCalendarIds(USER, WS, d)).rejects.toThrow('A calendar account needs signing in again')
  })

  it('a calendar list that fails throws', async () => {
    const d = deps()
    d.googleCalendars.mockRejectedValue(new Error('Google CalendarList API error: 503'))
    await expect(countedCalendarIds(USER, WS, d)).rejects.toThrow('Google CalendarList API error: 503')
  })

  it('a failed read of the accounts or the choices throws', async () => {
    const failing = (table: string) => {
      const db = memoryDb(tables())
      return {
        from: (name: string) => {
          if (name !== table) return db.from(name)
          const chain: Record<string, unknown> = {}
          for (const m of ['select', 'eq', 'in', 'not']) chain[m] = () => chain
          chain.then = (ok: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'statement timeout' } }).then(ok)
          return chain
        },
      } as never
    }
    await expect(countedCalendarIds(USER, WS, { ...deps(), supabase: failing('connected_account') })).rejects.toThrow('Calendar accounts could not be read: statement timeout')
    await expect(countedCalendarIds(USER, WS, { ...deps(), supabase: failing('connected_account_workspace') })).rejects.toThrow('Calendar accounts could not be read: statement timeout')
    await expect(countedCalendarIds(USER, WS, { ...deps(), supabase: failing('calendar_sub_preference') })).rejects.toThrow('Calendar choices could not be read: statement timeout')
  })
})

describe('listCountedEvents', () => {
  it('reads every counted calendar strictly, whatever the caller passed', async () => {
    const listEvents = vi.fn(async () => [])
    await listCountedEvents(USER, { timeMin: '2026-11-02T05:00:00.000Z', timeMax: '2026-11-09T05:00:00.000Z', maxResults: 500, workspaceId: WS, strict: false }, { ...deps(), listEvents })
    expect(listEvents).toHaveBeenCalledWith(USER, {
      timeMin: '2026-11-02T05:00:00.000Z',
      timeMax: '2026-11-09T05:00:00.000Z',
      maxResults: 500,
      workspaceId: WS,
      calendarIds: { 'acc-g': ['ada.finch@example.com', 'family'], 'acc-m': ['AAM-default', 'AAM-side'] },
      strict: true,
    })
  })

  it('a calendar that cannot be listed never reaches the events read', async () => {
    const listEvents = vi.fn(async () => [])
    const d = deps()
    d.microsoftCalendars.mockRejectedValue(new Error('Microsoft Calendars API error: 401'))
    await expect(listCountedEvents(USER, { timeMin: 'a', timeMax: 'b', workspaceId: WS }, { ...d, listEvents })).rejects.toThrow('Microsoft Calendars API error: 401')
    expect(listEvents).not.toHaveBeenCalled()
  })
})
