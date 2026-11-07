/**
 * A customer's reply goes out from the business number they texted, never
 * the Dial8 one (roadmap B2, src/lib/chat/text-turn-server.ts textGuest),
 * and a customer whose business number is gone is not texted at all.
 * sendSms sets that `From` (src/lib/twilio/client.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { textGuest } from '@/lib/chat/text-turn-server'
import { sendSms } from '@/lib/twilio/client'

const OWNER = 'user-owner'
const SARAH = '+12125550199'
const RUG = '+16465550173'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = {
    agent_guest: [
      { id: 'g-sarah', owner_user_id: OWNER, phone_e164: SARAH, state: 'active', opted_out_at: null, preset: 'customer', business_number_id: 'bn-1' },
      { id: 'g-jess', owner_user_id: OWNER, phone_e164: '+12125550111', state: 'active', opted_out_at: null, preset: 'household', business_number_id: null },
    ],
    business_phone_number: [{ id: 'bn-1', workspace_id: 'ws-rug', owner_user_id: OWNER, phone_e164: RUG, twilio_sid: 'PN1', state: 'active' }],
    sms_message: [],
  }
  db = memoryDb(tables)
})

describe("a customer's reply", () => {
  it('is sent from the business number they texted, and recorded as theirs', async () => {
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SMout' }))
    expect(await textGuest(db, { guestId: 'g-sarah', ownerUserId: OWNER, body: 'Cleaning an 8x10 is $400.', kind: 'guest_reply' }, { send, origin: 'https://dial8.ai' })).toEqual({ sent: true, sid: 'SMout' })
    expect(send).toHaveBeenCalledWith(SARAH, 'Cleaning an 8x10 is $400.', { from: RUG })
    expect(tables.sms_message).toEqual([expect.objectContaining({ direction: 'out', kind: 'guest_reply', guest_id: 'g-sarah', phone_e164: SARAH })])
  })

  it("an owner's own guest is still texted from the Dial8 number", async () => {
    const send = vi.fn(async () => ({ ok: true as const, sid: 'SMout' }))
    await textGuest(db, { guestId: 'g-jess', ownerUserId: OWNER, body: 'He is free at 3.', kind: 'guest_reply' }, { send })
    expect(send).toHaveBeenCalledWith('+12125550111', 'He is free at 3.')
  })

  it('a customer outside the US and Canada is never texted', async () => {
    tables.agent_guest[0].phone_e164 = '+447700900123'
    const send = vi.fn()
    expect(await textGuest(db, { guestId: 'g-sarah', ownerUserId: OWNER, body: 'hi', kind: 'guest_reply' }, { send })).toEqual({ sent: false, reason: 'no_phone' })
    expect(send).not.toHaveBeenCalled()
  })

  it('a customer whose business number was released is not texted', async () => {
    tables.business_phone_number[0].state = 'released'
    const send = vi.fn()
    expect(await textGuest(db, { guestId: 'g-sarah', ownerUserId: OWNER, body: 'hi', kind: 'guest_reply' }, { send })).toEqual({ sent: false, reason: 'no_phone' })
    expect(send).not.toHaveBeenCalled()
  })
})

describe('sendSms from a business number', () => {
  const config = { accountSid: 'AC1', authToken: 't', fromNumber: '+18885550100', messagingServiceSid: null }
  const fetchOk = () => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify({ sid: 'SM1' }), { status: 201 }))

  it("sets that number as From instead of the Dial8 one", async () => {
    const fetch = fetchOk()
    await sendSms(SARAH, 'hi', { fetch: fetch as never, config, from: RUG })
    expect(new URLSearchParams(String(fetch.mock.calls[0][1].body)).get('From')).toBe(RUG)
  })

  it("never through Dial8's messaging service, so Twilio can't pick a pool number for it (or it for Dial8)", async () => {
    const fetch = fetchOk()
    await sendSms(SARAH, 'hi', { fetch: fetch as never, config: { ...config, messagingServiceSid: 'MG1' }, from: RUG })
    const form = new URLSearchParams(String(fetch.mock.calls[0][1].body))
    expect(form.get('From')).toBe(RUG)
    expect(form.get('MessagingServiceSid')).toBeNull()
  })

  it('without one, the Dial8 sender as before', async () => {
    const fetch = fetchOk()
    await sendSms(SARAH, 'hi', { fetch: fetch as never, config })
    expect(new URLSearchParams(String(fetch.mock.calls[0][1].body)).get('From')).toBe('+18885550100')
    const viaService = fetchOk()
    await sendSms(SARAH, 'hi', { fetch: viaService as never, config: { ...config, messagingServiceSid: 'MG1' } })
    const form = new URLSearchParams(String(viaService.mock.calls[0][1].body))
    // Pinned to the Dial8 number: the service's pool holds agent numbers too (src/lib/sms/agent-number.ts).
    expect(form.get('From')).toBe('+18885550100')
    expect(form.get('MessagingServiceSid')).toBe('MG1')
  })
})
