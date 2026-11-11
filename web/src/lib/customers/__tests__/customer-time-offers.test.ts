/**
 * A guest who texts the business's number about times someone offered them
 * (availability phase 3a): the customer agent's record shows the open
 * offers made to that number (../lookup.ts, ../customer-spec.ts), with each
 * time's exact start and the offer's id, and pick_offered_time books one
 * (../customer-tools.ts): only an offer made to the number on their live
 * row, only that offer's own time, the offer's own recipient as the guest.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))
const offers = vi.hoisted(() => ({ accept: vi.fn() }))
vi.mock('@/lib/time-offers/accept', () => ({ acceptOffer: offers.accept }))

import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import type { AgentGuest } from '@/lib/guests/store'
import { buildCustomerWhoYouAre, customerRecordSection } from '../customer-spec'
import { customerToolCall } from '../customer-tools'
import { findCustomerByPhone } from '../lookup'

const WS = 'ws-rug'
const OWNER = 'user-owner'
const SARAH = '+12125550199'
const NOW = Date.now()
const at = (hours: number) => new Date(Math.ceil(NOW / 3_600_000) * 3_600_000 + hours * 3_600_000).toISOString()

type Row = Record<string, unknown>
let db: SupabaseClient

const offerRow = (over: Row = {}): Row => ({
  id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601',
  workspace_id: WS,
  host_user_id: OWNER,
  host_name: 'Moe Ortiz',
  recipient_name: 'Sarah Lee',
  recipient_email: null,
  recipient_phone: SARAH,
  title: 'Rug consult',
  duration_minutes: 30,
  video: false,
  time_zone: 'America/New_York',
  state: 'open',
  expires_at: at(20),
  created_at: new Date(NOW - 60_000).toISOString(),
  ...over,
})

beforeEach(() => {
  db = memoryDb({
    contact: [],
    agent_guest: [],
    customer_quote: [],
    customer_booking: [],
    time_offer: [
      offerRow(),
      // Expired, another number's, and another workspace's: never shown.
      offerRow({ id: 'o-expired', expires_at: new Date(NOW - 60_000).toISOString() }),
      offerRow({ id: 'o-bob', recipient_phone: '+12125550111' }),
      offerRow({ id: 'o-elsewhere', workspace_id: 'ws-other' }),
    ],
    time_offer_slot: [
      { id: 's-1', offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', starts_at: at(24), ends_at: at(24.5), state: 'open' },
      { id: 's-2', offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', starts_at: at(48), ends_at: at(48.5), state: 'released' },
      { id: 's-3', offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', starts_at: at(72), ends_at: at(72.5), state: 'open' },
    ],
  })
  offers.accept.mockReset()
})

describe("the customer agent's record", () => {
  it('shows the open offers made to their number, each open time with its exact start, and the offer id', async () => {
    const found = await findCustomerByPhone(db, { workspaceId: WS, phone: SARAH }, NOW)
    expect(found.offers.map((o) => o.id)).toEqual(['7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601'])
    const section = customerRecordSection('Sarah Lee', [], [], 'America/New_York', [], found.offers, NOW)!
    expect(section).toContain('Times offered by Moe Ortiz for Rug consult (30 min):')
    expect(section).toContain(`(start ${at(24)})`)
    expect(section).toContain(`(start ${at(72)})`)
    expect(section).not.toContain(at(48))
    expect(section).toContain('[offer 7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601]')
    // Nothing open: no section for it.
    expect(customerRecordSection('Sarah Lee', [], [], 'America/New_York', [], [], NOW)).toBeNull()
  })

  it('the prompt says to book only those times, with pick_offered_time', () => {
    const prompt = buildCustomerWhoYouAre({ businessName: 'Bright Loom', ownerName: 'Moe', customerName: 'Sarah Lee', bookingKind: 'pickup', facts: null, memory: [] })
    expect(prompt).toContain('call pick_offered_time once with that offer and that time\'s exact start')
    expect(prompt).toContain('Only those times: for any other time, pass it on with message_owner.')
  })
})

describe('pick_offered_time', () => {
  const guest = { id: 'g-sarah', ownerUserId: OWNER, workspaceId: WS, displayName: 'Sarah Lee', phone: SARAH, contactId: null, preset: 'customer' } as AgentGuest
  const claims = { userId: OWNER, workspaceId: WS }
  const call = async (input: unknown, who: AgentGuest = guest) => (await (await customerToolCall(db, claims, who, 'pick_offered_time', { input })).json()) as { output?: Record<string, unknown>; code?: string }

  it('books as the number on their live row, in this business only', async () => {
    offers.accept.mockResolvedValueOnce({ ok: true, already: false, offer: {}, booking: { id: 'b-1', state: 'confirmed', title: 'Rug consult', conferenceUrl: null }, manageUrl: 'https://app.example/b/x' })
    const out = await call({ offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: at(24) })
    expect(offers.accept).toHaveBeenCalledWith(db, { offer: { id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', workspaceId: WS }, slotStart: at(24), via: 'customer', guestPhone: SARAH })
    expect(out.output).toMatchObject({ success: true, status: 'confirmed', booking_id: 'b-1', message: expect.stringContaining("Tell them it's confirmed") })
  })

  it('a time no longer open says so with what is still open; no number on their row, or a bad input, books nothing', async () => {
    offers.accept.mockResolvedValueOnce({ ok: false, code: 'SLOT_TAKEN', message: 'That time is no longer available.', openSlots: [{ startsAt: at(72) }] })
    expect((await call({ offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: at(24) })).output).toEqual({
      success: false,
      code: 'SLOT_TAKEN',
      message: 'That time is no longer available. Offer them the times still open from their section.',
      still_open: [{ start: at(72) }],
    })
    expect((await call({ offer_id: '7d1b2c3e-4f50-4a61-8b72-9c83d4e5f601', start: at(24) }, { ...guest, phone: null })).output).toMatchObject({ success: false, code: 'NOT_FOUND' })
    expect((await call({ offer_id: 'not-a-uuid', start: at(24) })).code).toBe('INPUT_INVALID')
    expect(offers.accept).toHaveBeenCalledTimes(1)
  })
})
