/**
 * A text to a business's number (roadmap B2, ../texting.ts): the business's
 * own people aren't customers, the owner's own guest reaches their agent,
 * and anyone else becomes (or is) the business's customer, a guest row with
 * preset 'customer' scoped to that number (../customer-guests.ts). Over the
 * real customer-row store on an in-memory database.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { GUEST_DAILY_TEXT_CAP } from '@/lib/guests/texting'
import { findActiveGuestByPhone, listGuests, toGuest, type AgentGuest } from '@/lib/guests/store'
import { guestCeiling } from '@/lib/guests/guest-turn'
import { CUSTOMER_TOOLS } from '../customer-tools-list'
import { customerPlaceholderName, ensureCustomerGuest, findCustomerGuest, linkCustomerContact } from '../customer-guests'
import { CUSTOMER_NO_TEXT_REPLY, customerLimitedReply, customerWelcomeReply, handleBusinessText, type BusinessTextDeps } from '../texting'
import type { BusinessNumber } from '../numbers'

const RUG: BusinessNumber = { id: 'bn-1', workspaceId: 'ws-rug', ownerUserId: 'user-owner', phone: '+16465550173', twilioSid: 'PN1' }
const SARAH = '+12125550199'

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

beforeEach(() => {
  tables = { agent_guest: [] }
  db = memoryDb(tables, {
    agent_guest: (a, b) =>
      a.state !== 'removed' && b.state !== 'removed' && a.phone_e164 === b.phone_e164 &&
      (a.preset === 'customer' && b.preset === 'customer' ? a.workspace_id === b.workspace_id : a.preset !== 'customer' && b.preset !== 'customer' && a.owner_user_id === b.owner_user_id),
  })
})

function deps(over: Partial<BusinessTextDeps> = {}) {
  const delivered: Array<{ guest: AgentGuest; text: string; sid: string }> = []
  const marked: Array<[string, string, string]> = []
  const d: BusinessTextDeps = {
    isBusinessPerson: vi.fn(async () => false),
    ownersGuest: vi.fn(async () => null),
    ensureCustomer: (number, phone) => ensureCustomerGuest(db, { number, phone, contact: null }),
    businessName: async () => 'Bright Loom',
    bookingKind: async () => 'pickup',
    countInboundSince: vi.fn(async () => 0),
    markInbound: vi.fn(async (sid, kind, guestId) => {
      marked.push([sid, kind, guestId])
    }),
    noticedSince: vi.fn(async () => false),
    autoReply: vi.fn(async (_phone, _kind, text) => text),
    deliver: vi.fn(async (args) => {
      delivered.push(args)
    }),
    ...over,
  }
  return { d, delivered, marked }
}

const text = (body: string, sid: string | null = 'SM1', numMedia = 0) => ({ number: RUG, phone: SARAH, text: body, sid, numMedia })

describe('a stranger texting the business', () => {
  it('becomes its customer on the first text: their row, their thread, and a welcome naming the business', async () => {
    const { d, delivered, marked } = deps()
    const out = await handleBusinessText(text('Hi, how much for an 8x10?'), d)
    expect(out).toEqual({ outcome: 'customer_welcomed', reply: customerWelcomeReply('Bright Loom', 'pickup') })
    expect(out?.reply).toContain('Reply STOP to opt out')
    expect(tables.agent_guest).toHaveLength(1)
    expect(tables.agent_guest[0]).toMatchObject({
      owner_user_id: 'user-owner',
      workspace_id: 'ws-rug',
      phone_e164: SARAH,
      preset: 'customer',
      state: 'active',
      business_number_id: 'bn-1',
      display_name: customerPlaceholderName(SARAH),
      channels: ['sms'],
    })
    expect(tables.agent_guest[0].phone_bound_at).toBeTruthy()
    expect(delivered).toHaveLength(1)
    expect(delivered[0].text).toBe('Hi, how much for an 8x10?')
    expect(marked).toEqual([['SM1', 'guest_text', tables.agent_guest[0].id]])
  })

  it('a second text is the same customer, and gets no second welcome', async () => {
    const { d, delivered } = deps()
    await handleBusinessText(text('hi', 'SM1'), d)
    expect(await handleBusinessText(text('still there?', 'SM2'), d)).toEqual({ outcome: 'customer_queued', reply: null })
    expect(tables.agent_guest).toHaveLength(1)
    expect(delivered.map((x) => x.guest.id)).toEqual([tables.agent_guest[0].id, tables.agent_guest[0].id])
  })

  it('past their daily cap: one notice, then silence', async () => {
    const { d, delivered } = deps({ countInboundSince: async () => GUEST_DAILY_TEXT_CAP })
    expect(await handleBusinessText(text('hi'), d)).toEqual({ outcome: 'customer_limited', reply: customerLimitedReply('Bright Loom') })
    const again = deps({ countInboundSince: async () => GUEST_DAILY_TEXT_CAP, noticedSince: async () => true })
    expect(await handleBusinessText(text('hi', 'SM2'), again.d)).toEqual({ outcome: 'customer_limited_ignored', reply: null })
    expect(delivered).toHaveLength(0)
  })

  it('a number outside the US and Canada is refused in silence: no row, no turn, no text', async () => {
    const { d, delivered } = deps()
    expect(await handleBusinessText({ ...text('hi'), phone: '+447700900123' }, d)).toEqual({ outcome: 'customer_refused', reply: null })
    expect(tables.agent_guest).toHaveLength(0)
    expect(delivered).toHaveLength(0)
    expect(d.autoReply).not.toHaveBeenCalled()
  })

  it('a picture alone gets the words-only note, and no row is made', async () => {
    const { d } = deps()
    expect(await handleBusinessText(text('', 'SM1', 1), d)).toEqual({ outcome: 'customer_no_text', reply: CUSTOMER_NO_TEXT_REPLY })
    expect(tables.agent_guest).toHaveLength(0)
  })

  it('their first text answering a reminder the business just texted them gets no welcome: that text named the business and the opt-out', async () => {
    const wasReminded = vi.fn(async () => true)
    const { d, delivered } = deps({ wasReminded })
    const out = await handleBusinessText(text('Yes'), d)
    expect(out).toEqual({ outcome: 'customer_queued', reply: null })
    expect(delivered.map((x) => x.text)).toEqual(['Yes'])
    expect(wasReminded).toHaveBeenCalledWith('ws-rug', SARAH)
    expect(d.autoReply).not.toHaveBeenCalled()
  })
})

describe("the business's own people", () => {
  it("a member's verified phone is not a customer: null, their own path takes it", async () => {
    const { d, delivered } = deps({ isBusinessPerson: async () => true })
    expect(await handleBusinessText(text('what came in today?'), d)).toBeNull()
    expect(delivered).toHaveLength(0)
    expect(tables.agent_guest).toHaveLength(0)
  })

  it("the owner's own guest reaches the agent the owner made for them, not a customer's", async () => {
    const jess = { id: 'g-jess', ownerUserId: 'user-owner', preset: 'household' } as AgentGuest
    const { d, delivered } = deps({ ownersGuest: async () => jess })
    expect(await handleBusinessText(text('dinner at 7?'), d)).toEqual({ outcome: 'owner_guest_queued', reply: null })
    expect(delivered[0].guest).toBe(jess)
    expect(tables.agent_guest).toHaveLength(0)
  })
})

describe('customer rows', () => {
  it("are one per business and phone, and fill in their contact and name once it's known", async () => {
    const first = await ensureCustomerGuest(db, { number: RUG, phone: SARAH, contact: null })
    expect(first.created).toBe(true)
    const named = await ensureCustomerGuest(db, { number: RUG, phone: SARAH, contact: { id: 'c-1', fullName: 'Sarah Lee' } })
    expect(named).toMatchObject({ created: false, guest: { id: first.guest.id, contactId: 'c-1', displayName: 'Sarah Lee' } })
    // Another business: its own customer row for the same person.
    const other = await ensureCustomerGuest(db, { number: { ...RUG, id: 'bn-2', workspaceId: 'ws-plumber', ownerUserId: 'user-plumber' }, phone: SARAH, contact: null })
    expect(other.created).toBe(true)
    expect(tables.agent_guest).toHaveLength(2)
    expect((await findCustomerGuest(db, 'ws-rug', SARAH))?.id).toBe(first.guest.id)
  })

  it("a customer's ceiling is the fixed customer list, whatever the row holds", async () => {
    const { guest } = await ensureCustomerGuest(db, { number: RUG, phone: SARAH, contact: null })
    expect([...guestCeiling({ ...guest, tools: ['get_calendar_events', 'send_email', 'delete_action'] })]).toEqual([...CUSTOMER_TOOLS])
    expect(CUSTOMER_TOOLS).not.toContain('ask_owner_agent')
  })

  it("never show in the owner's People tab, and are never reached through the Dial8 number", async () => {
    await ensureCustomerGuest(db, { number: RUG, phone: SARAH, contact: null })
    tables.agent_guest.push({ ...tables.agent_guest[0], id: 'g-jess', preset: 'household', phone_e164: '+12125550111', business_number_id: null, contact_id: null })
    expect((await listGuests(db, 'user-owner')).map((g) => g.id)).toEqual(['g-jess'])
    expect(await findActiveGuestByPhone(db, SARAH)).toBeNull()
    expect((await findActiveGuestByPhone(db, '+12125550111'))?.id).toBe('g-jess')
  })

  it('linking a contact later names a placeholder row, and leaves a named one alone', async () => {
    const { guest } = await ensureCustomerGuest(db, { number: RUG, phone: SARAH, contact: null })
    await linkCustomerContact(db, guest, { id: 'c-9', fullName: 'Sarah Lee' })
    expect(toGuest(tables.agent_guest[0] as never)).toMatchObject({ contactId: 'c-9', displayName: 'Sarah Lee', preset: 'customer', businessNumberId: 'bn-1' })
  })
})
