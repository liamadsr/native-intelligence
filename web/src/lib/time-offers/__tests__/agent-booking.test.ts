/**
 * The person's agent booking from an offer's own times (../agent-booking.ts):
 * from an offer whose guests the person saw (its card, or their own turn
 * made it) nothing is held; from any other, the card names every guest and
 * their address, and what booking does (the calendar emails them); a poll's
 * card names all its guests; an offer that isn't the person's, or isn't
 * there, is the tool's to refuse; a read that fails is held. Made-up people.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { offerBookingHold } from '../agent-booking'
import { HOST, offerDb, WS, ZONE } from './fake-db'

type Row = Record<string, unknown>
const OFFER = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const POLL = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4e'
const later = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString()

function offerRow(over: Row = {}): Row {
  return {
    id: OFFER, workspace_id: WS, host_user_id: HOST, created_by: HOST, host_name: 'Ava Lin', recipient_name: 'Mallory Kent', recipient_email: 'mallory@globex.example', recipient_phone: null,
    contact_id: null, title: 'Intro call', duration_minutes: 30, video: true, location: null, message: null, time_zone: ZONE, state: 'open', sent_via: 'link', card_hash: null,
    recipients_shown: false, approval_id: null, booking_id: null, expires_at: later(48), created_at: later(-1), mode: 'pick', co_host_ids: [], ...over,
  }
}

const recipient = (id: string, name: string, email: string | null, position: number): Row => ({
  id, offer_id: POLL, workspace_id: WS, position, name, email, phone: null, contact_id: null, peer_user_id: null, token_hash: null, answered_at: null, answered_via: null, note: null, nudges: 0, nudged_at: null, attending: null, declined_at: null,
})

const hold = (db: SupabaseClient, toolName: string, offerId: string = OFFER, userId: string = HOST) => offerBookingHold(db, { workspaceId: WS, userId, toolName, input: { offer_id: offerId, start: later(26) } })

describe('offerBookingHold', () => {
  it('an offer the person saw runs as it is', async () => {
    const { db } = offerDb({ time_offer: [offerRow({ recipients_shown: true })] })
    expect(await hold(db, 'accept_time_offer')).toBeNull()
  })

  it('an offer they never saw is their card, naming the guest and their address and what booking sends', async () => {
    const { db } = offerDb({ time_offer: [offerRow()] })
    const found = await hold(db, 'accept_time_offer')
    expect(found?.card.title).toBe('Book "Intro call" with Mallory Kent (mallory@globex.example)?')
    expect(found?.card.why).toContain('your calendar emails the invitation (its title, description and video link) to Mallory Kent (mallory@globex.example)')
    expect(found?.card.why).toContain("You haven't approved who this offer went to")
    expect(found?.refusal).toContain('Do not retry')
  })

  it("a poll's card names every guest; recording an answer says it may book", async () => {
    const { db } = offerDb({
      time_offer: [offerRow({ id: POLL, mode: 'poll', recipient_name: 'Dana Reyes', recipient_email: null })],
      time_offer_recipient: [recipient('r-1', 'Dana Reyes', 'dana@initech.example', 0), recipient('r-2', 'Sam Ortiz', 'sam@globex.example', 1), recipient('r-3', 'Lee Park', null, 2)],
    })
    const found = await hold(db, 'record_time_offer_answer', POLL)
    expect(found?.card.title).toBe('Book "Intro call" with Dana Reyes (dana@initech.example) and 2 more?')
    expect(found?.card.why).toContain('If it is the last answer, the meeting is booked')
    expect(found?.card.why).toContain('Dana Reyes (dana@initech.example), Sam Ortiz (sam@globex.example), Lee Park')
    expect((await hold(db, 'book_poll_time', POLL))?.card.why).toContain('This books "Intro call" on your calendar')
  })

  it("an offer that isn't there, or isn't the person's, is the tool's to refuse: nothing held here", async () => {
    const { db } = offerDb({ time_offer: [offerRow()] })
    expect(await hold(db, 'accept_time_offer', '0a1b2c3d-4e5f-4a6b-8c7d-000000000000')).toBeNull()
    expect(await hold(db, 'accept_time_offer', OFFER, 'user-ben')).toBeNull()
    expect(await offerBookingHold(db, { workspaceId: WS, userId: HOST, toolName: 'accept_time_offer', input: { start: later(26) } })).toBeNull()
  })

  it('a read that fails is held, never let through', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { from: () => { throw new Error('db down') } } as unknown as SupabaseClient
    expect(await hold(broken, 'accept_time_offer')).toMatchObject({ card: { title: 'Approve accept_time_offer?' } })
  })
})
