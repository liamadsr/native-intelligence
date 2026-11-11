/**
 * Settings > Availability's calendars (../calendar-choices.ts): the person's
 * calendar accounts in the workspace, each calendar with whether it counts
 * as busy (their choice, else the default) and the default; an account that
 * can't be listed comes back with its error, the others still there; a
 * choice is saved only on the person's own account.
 */
import { describe, expect, it, vi } from 'vitest'
import { memoryDb } from '@/test/memory-db'
import type { SubCalendar } from '@/lib/integrations/calendar'
import { listCalendarChoices, saveCalendarChoice } from '../calendar-choices'

const USER = 'user-ada'
const WS = 'ws-fernhill'
const cal = (id: string, extra: Partial<SubCalendar> = {}): SubCalendar => ({ id, summary: id, ...extra })

function tables() {
  return {
    connected_account: [
      { id: 'acc-g', user_id: USER, provider: 'google', account_email: 'ada.finch@example.com', capability: 'calendar', is_enabled: true, created_at: '2026-01-01' },
      { id: 'acc-m', user_id: USER, provider: 'microsoft', account_email: 'ada.finch@example.org', capability: 'calendar', is_enabled: true, created_at: '2026-02-01' },
      { id: 'acc-elsewhere', user_id: USER, provider: 'google', account_email: 'side@example.com', capability: 'calendar', is_enabled: true, created_at: '2026-03-01' },
      { id: 'acc-bo', user_id: 'user-bo', provider: 'google', account_email: 'bo@example.com', capability: 'calendar', is_enabled: true, created_at: '2026-01-01' },
    ],
    connected_account_workspace: [
      { account_id: 'acc-g', workspace_id: WS },
      { account_id: 'acc-m', workspace_id: WS },
      { account_id: 'acc-elsewhere', workspace_id: 'ws-other' },
      { account_id: 'acc-bo', workspace_id: WS },
    ],
    calendar_sub_preference: [
      { user_id: USER, account_id: 'acc-g', provider_calendar_id: 'en.usa#holiday', counts_as_busy: true, is_visible: false },
      { user_id: USER, account_id: 'acc-g', provider_calendar_id: 'family', counts_as_busy: null, is_visible: true },
    ] as Record<string, unknown>[],
  }
}

const deps = () => ({
  token: vi.fn(async (id: string) => (id === 'acc-m' ? null : { token: `tok-${id}` })) as never,
  googleCalendars: vi.fn(async () => [cal('ada.finch@example.com', { primary: true, accessRole: 'owner', backgroundColor: '#4285f4' }), cal('family', { accessRole: 'owner' }), cal('en.usa#holiday', { accessRole: 'reader', summary: 'Holidays' })]),
  microsoftCalendars: vi.fn(async () => []),
})

describe('listCalendarChoices', () => {
  it("the person's accounts in this workspace, each calendar's choice or default", async () => {
    const out = await listCalendarChoices(memoryDb(tables()), USER, WS, deps())
    expect(out.map((a) => [a.id, a.error])).toEqual([
      ['acc-g', null],
      ['acc-m', 'Needs signing in again'],
    ])
    expect(out[0].calendars).toEqual([
      { id: 'ada.finch@example.com', name: 'ada.finch@example.com', color: '#4285f4', primary: true, counts: true, countsByDefault: true },
      { id: 'family', name: 'family', color: null, primary: false, counts: true, countsByDefault: true },
      // Followed, so off by default; the person turned it on.
      { id: 'en.usa#holiday', name: 'Holidays', color: null, primary: false, counts: true, countsByDefault: false },
    ])
    expect(out[1].calendars).toEqual([])
  })

  it('an account whose calendars fail to list says so; the others stay', async () => {
    const d = deps()
    d.googleCalendars.mockRejectedValue(new Error('Google 500'))
    const out = await listCalendarChoices(memoryDb(tables()), USER, WS, d)
    expect(out[0]).toMatchObject({ id: 'acc-g', error: "Its calendars couldn't be listed", calendars: [] })
  })
})

describe('saveCalendarChoice', () => {
  it("saves counts_as_busy on the person's own account, keeping the row's other choices", async () => {
    const t = tables()
    await saveCalendarChoice(memoryDb(t), USER, { accountId: 'acc-g', calendarId: 'family', counts: false })
    expect(t.calendar_sub_preference.find((r) => r.provider_calendar_id === 'family')).toMatchObject({ counts_as_busy: false, is_visible: true })
    await saveCalendarChoice(memoryDb(t), USER, { accountId: 'acc-g', calendarId: 'work', counts: true })
    expect(t.calendar_sub_preference.find((r) => r.provider_calendar_id === 'work')).toMatchObject({ user_id: USER, account_id: 'acc-g', counts_as_busy: true })
  })

  it("refuses someone else's account", async () => {
    const t = tables()
    await expect(saveCalendarChoice(memoryDb(t), USER, { accountId: 'acc-bo', calendarId: 'bo@example.com', counts: false })).rejects.toThrow('Unknown calendar account')
    expect(t.calendar_sub_preference).toHaveLength(2)
  })
})
