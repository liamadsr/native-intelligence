/**
 * create_calendar_event's `account_email` names the calendar to create the
 * event on. The model often re-cases the address it read, so the match is
 * case-insensitive (an ilike on the escaped literal), while a name that matches
 * no connected calendar still errors instead of using the first one.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const hoisted = vi.hoisted(() => ({
  ilikes: [] as Array<[string, string]>,
  account: null as { id: string } | null,
  createCalendarEvent: vi.fn(async () => ({ id: 'evt-1' })),
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      limit: () => chain,
      ilike: (col: string, pattern: string) => {
        hoisted.ilikes.push([col, pattern])
        return chain
      },
      maybeSingle: async () => ({ data: hoisted.account, error: null }),
    }
    return { from: () => chain }
  },
}))

vi.mock('@/lib/integrations/calendar', () => ({
  listCalendarEventsUnified: vi.fn(),
  listCalendarEvents: vi.fn(),
  createCalendarEvent: hoisted.createCalendarEvent,
  updateCalendarEvent: vi.fn(),
  deleteCalendarEvent: vi.fn(),
  getCalendarProvider: vi.fn(async () => 'google'),
}))

import { createCalendarTools } from '@/lib/ai/tools/calendar'

type Exec = (input: Record<string, unknown>, opts: unknown) => Promise<{ success: boolean; error?: string }>
const create = () =>
  (createCalendarTools('user-1').create_calendar_event as unknown as { execute: Exec }).execute

const INPUT = { title: 'Sync', start: '2026-10-22T10:00:00Z', end: '2026-10-22T10:30:00Z', is_all_day: false }

beforeEach(() => {
  hoisted.ilikes = []
  hoisted.account = null
  hoisted.createCalendarEvent.mockClear()
})

describe('create_calendar_event account_email', () => {
  it('matches the account case-insensitively and creates on it', async () => {
    hoisted.account = { id: 'acct-work' }
    const result = await create()({ ...INPUT, account_email: ' Me@Work.com ' }, {})
    expect(result.success).toBe(true)
    expect(hoisted.ilikes).toEqual([['account_email', 'Me@Work.com']])
    expect(hoisted.createCalendarEvent).toHaveBeenCalledWith('user-1', expect.anything(), 'acct-work')
  })

  it('escapes ilike wildcards so an address cannot match another account', async () => {
    await create()({ ...INPUT, account_email: 'a_b%c@x.com' }, {})
    expect(hoisted.ilikes).toEqual([['account_email', 'a\\_b\\%c@x.com']])
  })

  it('still errors when no connected calendar has that address', async () => {
    const result = await create()({ ...INPUT, account_email: 'nobody@x.com' }, {})
    expect(result.success).toBe(false)
    expect(hoisted.createCalendarEvent).not.toHaveBeenCalled()
  })
})
