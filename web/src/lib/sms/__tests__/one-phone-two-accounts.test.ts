/**
 * One phone, two separate accounts (migration 464; founder decision,
 * 2026-11-01: "I wanna treat it as a completely separate workspace. I should
 * still be able to connect my phone number to that workspace's agent").
 * Account A, their own,
 * holds the phone on the Dial8 line; account B, a business's own account
 * (its own workspace, A is not a member), adds the same phone as its business
 * line and is reached on the business's own number. Over the real store on an
 * in-memory database:
 *
 *   - the store's rules (findLinkedPhone reads the Dial8 line only;
 *     findBusinessPerson prefers a business line; each opt-out stays on its
 *     own row);
 *   - linking a phone (verifyPhoneCode): a business's account adds a business
 *     line beside the other account's Dial8 line and emails that account;
 *     anyone else, or a Dial8-line account with no email to tell, moves the
 *     number, as before;
 *   - inbound texts end to end: the Dial8 number reaches A, the business's
 *     number reaches B in B's workspace, B's approval code is answered there,
 *     a stranger is still a customer, and STOP / START stay on the number
 *     they were texted to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { memoryDb } from '@/test/memory-db'
import { handleBusinessText, supabaseBusinessTextDeps } from '@/lib/customers/texting'
import { ensureCustomerGuest } from '@/lib/customers/customer-guests'
import type { AgentGuest } from '@/lib/guests/store'
import { handleInboundSms, supabaseInboundDeps, type InboundDeps, type InboundSms } from '../inbound'
import { WELCOME_TEXT, hashPhoneCode, verifyPhoneCode } from '../phone-verification'
import { businessLineNoticeEmail, businessLineWelcomeText } from '../business-line'
import { findBusinessPerson, findLinkedPhone, setPhoneOptOut, setPhoneRowOptOut, type LinkedPhone } from '../store'

const KEY = 'run-skill-secret-0123456789'
const PHONE = '+16465550123'
const DIAL8 = '+18885550100'
const RUG = '+16465550173'
const SARAH = '+12125550199'
const T0 = Date.parse('2026-11-01T12:00:00Z')

type Row = Record<string, unknown>
let tables: Record<string, Row[]>
let db: SupabaseClient

const dial8Row = (over: Row = {}): Row => ({
  id: 'p-a',
  user_id: 'user-a',
  workspace_id: 'ws-home',
  phone_e164: PHONE,
  line: 'dial8',
  verified_at: '2026-10-01T00:00:00Z',
  opted_out_at: null,
  created_at: '2026-10-01T00:00:00Z',
  ...over,
})
const businessRow = (over: Row = {}): Row => ({
  id: 'p-b',
  user_id: 'user-b',
  workspace_id: 'ws-rug',
  phone_e164: PHONE,
  line: 'business',
  verified_at: '2026-11-01T00:00:00Z',
  opted_out_at: null,
  created_at: '2026-11-01T00:00:00Z',
  ...over,
})

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = KEY
  tables = {
    // Account A: their own, on the Dial8 line. Account B: Bright Loom's own account; A is not one of its members.
    user_phone: [dial8Row()],
    member: [
      { id: 'm-a', user_id: 'user-a', workspace_id: 'ws-home', role: 'owner' },
      { id: 'm-b', user_id: 'user-b', workspace_id: 'ws-rug', role: 'owner' },
      { id: 'm-c', user_id: 'user-c', workspace_id: 'ws-c', role: 'owner' },
    ],
    workspace: [
      { id: 'ws-home', name: 'Home' },
      { id: 'ws-rug', name: 'Bright Loom' },
      { id: 'ws-c', name: 'Someone' },
    ],
    business_profile: [{ workspace_id: 'ws-rug', owner_user_id: 'user-b', business_name: 'Bright Loom', booking_kind: 'pickup' }],
    business_phone_number: [{ id: 'bn-1', workspace_id: 'ws-rug', owner_user_id: 'user-b', phone_e164: RUG, twilio_sid: 'PN1', state: 'active' }],
    phone_verification: [],
    sms_message: [],
    agent_guest: [],
  }
  db = memoryDb(tables, {
    // user_phone_user_key, and 464's user_phone_dial8_phone_key: one Dial8-line holder per phone.
    user_phone: (a, b) =>
      a.user_id === b.user_id || (a.phone_e164 === b.phone_e164 && a.verified_at != null && b.verified_at != null && a.line === 'dial8' && b.line === 'dial8'),
    sms_message: (a, b) => a.twilio_sid != null && a.twilio_sid === b.twilio_sid && a.direction === b.direction,
  })
})

describe('the store', () => {
  it('findLinkedPhone reads the Dial8 line only: a business-line row is never who the Dial8 number reaches', async () => {
    tables.user_phone.push(businessRow())
    expect(await findLinkedPhone(db, PHONE)).toMatchObject({ userId: 'user-a', line: 'dial8' })
    tables.user_phone = tables.user_phone.filter((r) => r.line !== 'dial8')
    expect(await findLinkedPhone(db, PHONE)).toBeNull()
  })

  it("findBusinessPerson: a verified row whose person is one of the business's members, a business line before the Dial8 line, deterministic", async () => {
    // Only A's Dial8 row, and A isn't a member: nobody (a customer).
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toBeNull()
    // A joins Bright Loom: their Dial8 row answers there.
    tables.member.push({ id: 'm-a2', user_id: 'user-a', workspace_id: 'ws-rug', role: 'member' })
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toMatchObject({ userId: 'user-a', line: 'dial8' })
    // B's business line wins over the Dial8 line, whatever the order the rows come back in.
    tables.user_phone.unshift(businessRow())
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toMatchObject({ id: 'p-b', userId: 'user-b', line: 'business' })
    tables.user_phone.reverse()
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toMatchObject({ id: 'p-b' })
    // Two business lines of members: the oldest.
    tables.member.push({ id: 'm-d', user_id: 'user-d', workspace_id: 'ws-rug', role: 'member' })
    tables.user_phone.push(businessRow({ id: 'p-d', user_id: 'user-d', created_at: '2026-10-15T00:00:00Z' }))
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toMatchObject({ id: 'p-d' })
  })

  it('findBusinessPerson ignores a row that was never verified (the same filter as the Dial8 line)', async () => {
    tables.user_phone.push(businessRow({ verified_at: null }))
    expect(await findBusinessPerson(db, PHONE, 'ws-rug')).toBeNull()
  })

  it('each opt-out stays on its own row: the Dial8 line, or the one row a business number resolved to', async () => {
    tables.user_phone.push(businessRow(), businessRow({ id: 'p-x', user_id: 'user-x', workspace_id: 'ws-x' }))
    await setPhoneRowOptOut(db, 'p-b', true)
    expect(tables.user_phone.map((r) => [r.id, r.opted_out_at !== null])).toEqual([['p-a', false], ['p-b', true], ['p-x', false]])
    await setPhoneOptOut(db, PHONE, true)
    expect(tables.user_phone.map((r) => [r.id, r.opted_out_at !== null])).toEqual([['p-a', true], ['p-b', true], ['p-x', false]])
    await setPhoneRowOptOut(db, 'p-b', false)
    expect(tables.user_phone.map((r) => [r.id, r.opted_out_at !== null])).toEqual([['p-a', true], ['p-b', false], ['p-x', false]])
  })
})

describe('linking a phone (Settings › Phone)', () => {
  const pending = (userId: string, workspaceId: string) =>
    tables.phone_verification.push({
      id: `v-${userId}`,
      user_id: userId,
      workspace_id: workspaceId,
      phone_e164: PHONE,
      code_hash: hashPhoneCode('123456', { userId, phone: PHONE }, KEY),
      attempts: 0,
      expires_at: '2999-01-01T00:00:00.000Z',
      consumed_at: null,
      consented_at: '2026-11-01T11:59:00.000Z',
      consent_version: '2026-11-01',
      created_at: '2026-11-01T11:59:00.000Z',
    })
  const sent = () => vi.fn(async (_to: string, _body: string, _opts?: { from?: string }) => ({ ok: true as const, sid: 'SMw' }))
  /** Account A has an email (it can be told); a text sign-up's phone-only account has none. */
  const emails: Record<string, string | null> = { 'user-a': 'owner-a@example.com' }
  const dial8HolderEmail = async (userId: string) => emails[userId] ?? null

  it("a business's account adds the number as its business line beside the other account's Dial8 line, emails that account, and welcomes from its own number", async () => {
    pending('user-b', 'ws-rug')
    const send = sent()
    const notifyDial8Holder = vi.fn(async () => true)
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send, notifyDial8Holder, dial8HolderEmail, now: () => T0 })).toEqual({ ok: true, phone: PHONE, welcomed: true, line: 'business' })
    expect(tables.user_phone).toEqual([
      expect.objectContaining({ id: 'p-a', user_id: 'user-a', line: 'dial8', opted_out_at: null }),
      expect.objectContaining({ user_id: 'user-b', workspace_id: 'ws-rug', phone_e164: PHONE, line: 'business', verified_at: new Date(T0).toISOString() }),
    ])
    expect(notifyDial8Holder).toHaveBeenCalledWith({ to: 'owner-a@example.com', phone: PHONE })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(PHONE, businessLineWelcomeText('Bright Loom'), { from: RUG })
  })

  it('a business with no live number yet gets its business line, and no welcome from the Dial8 number (it would point at the other agent)', async () => {
    tables.business_phone_number = []
    pending('user-b', 'ws-rug')
    const send = sent()
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send, notifyDial8Holder: async () => true, dial8HolderEmail, now: () => T0 })).toEqual({ ok: true, phone: PHONE, welcomed: false, line: 'business' })
    expect(tables.user_phone.map((r) => r.line)).toEqual(['dial8', 'business'])
    expect(send).not.toHaveBeenCalled()
  })

  it("an account that isn't a business's moves the number, as before: the other account's row goes, and the Dial8 welcome goes out", async () => {
    pending('user-c', 'ws-c')
    const send = sent()
    const notifyDial8Holder = vi.fn(async () => true)
    expect(await verifyPhoneCode(db, { userId: 'user-c', code: '123456' }, { send, notifyDial8Holder, dial8HolderEmail, now: () => T0 })).toEqual({ ok: true, phone: PHONE, welcomed: true, line: 'dial8' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-c', line: 'dial8' })])
    expect(notifyDial8Holder).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(PHONE, WELCOME_TEXT)
  })

  it('with no Dial8-line holder, even a business takes the Dial8 line and the business lines of others go (as before)', async () => {
    tables.user_phone = [businessRow({ id: 'p-x', user_id: 'user-x', workspace_id: 'ws-x' })]
    pending('user-b', 'ws-rug')
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send: sent(), notifyDial8Holder: async () => true, dial8HolderEmail, now: () => T0 })).toMatchObject({ ok: true, line: 'dial8' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-b', line: 'dial8' })])
  })

  it('one row per person: re-linking replaces their own row (never a second), with no second notice or welcome', async () => {
    tables.user_phone.push(businessRow({ id: 'p-b-old', phone_e164: '+16465550999', line: 'dial8' }))
    pending('user-b', 'ws-rug')
    await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send: sent(), notifyDial8Holder: async () => true, dial8HolderEmail, now: () => T0 })
    expect(tables.user_phone.filter((r) => r.user_id === 'user-b')).toEqual([expect.objectContaining({ id: 'p-b-old', phone_e164: PHONE, line: 'business' })])
    // Again, the same number: already theirs.
    tables.phone_verification = []
    pending('user-b', 'ws-rug')
    const send = sent()
    const notifyDial8Holder = vi.fn(async () => true)
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send, notifyDial8Holder, dial8HolderEmail, now: () => T0 + 1000 })).toEqual({ ok: true, phone: PHONE, welcomed: false, line: 'business' })
    expect(tables.user_phone.filter((r) => r.user_id === 'user-b')).toHaveLength(1)
    expect(notifyDial8Holder).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it("a Dial8-line account with no email (a phone-only text sign-up) can't be told, so the number moves to the business, as before 464", async () => {
    tables.user_phone = [dial8Row({ user_id: 'user-phone-only', workspace_id: 'ws-p' })]
    pending('user-b', 'ws-rug')
    const send = sent()
    const notifyDial8Holder = vi.fn(async () => true)
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send, notifyDial8Holder, dial8HolderEmail, now: () => T0 })).toEqual({ ok: true, phone: PHONE, welcomed: true, line: 'dial8' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-b', line: 'dial8' })])
    expect(notifyDial8Holder).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledWith(PHONE, WELCOME_TEXT)
  })

  it("a failed read of the holder's email decides nothing: no link, the code still unused", async () => {
    pending('user-b', 'ws-rug')
    const failing = async () => {
      throw new Error('auth down')
    }
    expect(await verifyPhoneCode(db, { userId: 'user-b', code: '123456' }, { send: sent(), dial8HolderEmail: failing, now: () => T0 })).toEqual({ ok: false, reason: 'lookup_failed' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-a' })])
    expect(tables.phone_verification[0].consumed_at).toBeNull()
  })

  it('a failed read of the business decides nothing: no link, the code still unused', async () => {
    pending('user-b', 'ws-rug')
    const failing = {
      from: (table: string) =>
        table === 'business_profile'
          ? { select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }
          : db.from(table),
    } as unknown as SupabaseClient
    expect(await verifyPhoneCode(failing, { userId: 'user-b', code: '123456' }, { send: sent(), now: () => T0 })).toEqual({ ok: false, reason: 'lookup_failed' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-a' })])
    expect(tables.phone_verification[0].consumed_at).toBeNull()
  })

  it('the notice says what it means, that nothing is needed if it was them, and how to take the number back; it never names the other account', () => {
    const { subject, text } = businessLineNoticeEmail({ maskedPhone: '+1 ••• ••• 0123', origin: 'https://dial8.ai' })
    expect(subject).toBe('Your phone number was added to another Dial8 account')
    expect(text).toContain('+1 ••• ••• 0123')
    expect(text).toContain("as that account's business line")
    expect(text).toContain('Your own Dial8 agent is unchanged')
    expect(text).toContain('If you did this yourself, for a business you run, there is nothing to do.')
    expect(text).toContain('remove it in Settings › Phone and add your new one: https://dial8.ai/account/settings/phone')
    expect(text).toContain('verifying it again with a new code takes it off every other Dial8 account')
    expect(text).not.toContain('Rug')
  })

  it('taking it back works: the Dial8-line account removing and verifying the number again takes it off the business account', async () => {
    tables.user_phone.push(businessRow())
    // Settings › Phone: Remove (its own row, under RLS), then add the number again with a new code.
    tables.user_phone = tables.user_phone.filter((r) => r.user_id !== 'user-a')
    pending('user-a', 'ws-home')
    expect(await verifyPhoneCode(db, { userId: 'user-a', code: '123456' }, { send: sent(), dial8HolderEmail, now: () => T0 })).toMatchObject({ ok: true, line: 'dial8' })
    expect(tables.user_phone).toEqual([expect.objectContaining({ user_id: 'user-a', line: 'dial8' })])
  })
})

describe('inbound texts over the real store', () => {
  function setup() {
    tables.user_phone.push(businessRow())
    const delivered: Array<{ linked: LinkedPhone; text: string; sid: string }> = []
    const customers: Array<{ guest: AgentGuest; text: string }> = []
    const answerApproval = vi.fn(async ({ linked, text }: { linked: LinkedPhone; text: string }) =>
      /K7Q4MX/.test(text) ? { outcome: 'approval_answered' as const, reply: `Approved for ${linked.userId} in ${linked.workspaceId}.` } : { outcome: 'not_a_code' as const, reply: null },
    )
    const deps: InboundDeps = {
      ...supabaseInboundDeps(db, {
        origin: 'https://dial8.ai',
        deliverText: async (args) => {
          delivered.push(args)
        },
      }),
      answerApproval,
      guestText: async () => null,
      businessText: (input, tools) =>
        handleBusinessText(input, {
          ...supabaseBusinessTextDeps(db, tools),
          ensureCustomer: (number, phone) => ensureCustomerGuest(db, { number, phone, contact: null }),
          businessName: async () => 'Bright Loom',
          bookingKind: async () => 'pickup',
          deliver: async ({ guest, text }) => {
            customers.push({ guest, text })
          },
        }),
    }
    let n = 0
    const sms = (from: string, to: string, body: string): InboundSms => ({ from, to, body, sid: `SM${++n}`, numMedia: 0 })
    return { deps, delivered, customers, answerApproval, sms }
  }

  it("the Dial8 number reaches account A, in A's workspace", async () => {
    const f = setup()
    expect(await handleInboundSms(f.sms(PHONE, DIAL8, "what's on tomorrow?"), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered).toEqual([expect.objectContaining({ linked: expect.objectContaining({ userId: 'user-a', workspaceId: 'ws-home', line: 'dial8' }) })])
  })

  it("the business's number reaches account B, in B's workspace", async () => {
    const f = setup()
    expect(await handleInboundSms(f.sms(PHONE, RUG, 'any new quotes?'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered).toEqual([expect.objectContaining({ linked: expect.objectContaining({ userId: 'user-b', workspaceId: 'ws-rug', line: 'business' }) })])
    expect(f.customers).toEqual([])
  })

  it("account B's approval code, texted to the business's number, is answered by B's own approvals", async () => {
    const f = setup()
    expect(await handleInboundSms(f.sms(PHONE, RUG, 'yes K7Q4MX'), f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved for user-b in ws-rug.' })
    expect(f.delivered).toEqual([])
  })

  it('a stranger texting the business is still its customer', async () => {
    const f = setup()
    expect((await handleInboundSms(f.sms(SARAH, RUG, 'How much for an 8x10?'), f.deps)).outcome).toBe('customer_welcomed')
    expect(f.customers).toEqual([expect.objectContaining({ text: 'How much for an 8x10?' })])
    expect(tables.agent_guest).toEqual([expect.objectContaining({ phone_e164: SARAH, preset: 'customer', workspace_id: 'ws-rug' })])
    expect(f.delivered).toEqual([])
  })

  it('a single-account owner (a Dial8-line row, a member of the business): STOP / START on either number toggle that one row, and the business number undoes the Dial8 STOP', async () => {
    tables.member.push({ id: 'm-a2', user_id: 'user-a', workspace_id: 'ws-rug', role: 'owner' })
    const f = setup()
    // One account: no business-line row on the phone.
    tables.user_phone = tables.user_phone.filter((r) => r.user_id === 'user-a')
    const optedOut = () => tables.user_phone[0].opted_out_at !== null
    // The business number reaches them there, as its own person.
    expect(await handleInboundSms(f.sms(PHONE, RUG, 'any new quotes?'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered.at(-1)!.linked).toMatchObject({ userId: 'user-a', workspaceId: 'ws-rug' })
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'STOP'), f.deps)).outcome).toBe('stop')
    expect(optedOut()).toBe(true)
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'hi'), f.deps)).outcome).toBe('opted_out')
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'START'), f.deps)).outcome).toBe('start')
    expect(optedOut()).toBe(false)
    expect((await handleInboundSms(f.sms(PHONE, DIAL8, 'STOP'), f.deps)).outcome).toBe('stop')
    expect(optedOut()).toBe(true)
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'START'), f.deps)).outcome).toBe('start')
    expect(optedOut()).toBe(false)
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'hi'), f.deps)).outcome).toBe('queued')
  })

  it('STOP / START stay on the number they were texted to', async () => {
    const f = setup()
    const optedOut = () => Object.fromEntries(tables.user_phone.map((r) => [r.user_id, r.opted_out_at !== null]))
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'STOP'), f.deps)).outcome).toBe('stop')
    expect(optedOut()).toEqual({ 'user-a': false, 'user-b': true })
    // A still hears on the Dial8 number; B's texts are ignored until START.
    expect((await handleInboundSms(f.sms(PHONE, DIAL8, 'hi'), f.deps)).outcome).toBe('queued')
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'hi'), f.deps)).outcome).toBe('opted_out')
    expect((await handleInboundSms(f.sms(PHONE, DIAL8, 'STOP'), f.deps)).outcome).toBe('stop')
    expect(optedOut()).toEqual({ 'user-a': true, 'user-b': true })
    expect((await handleInboundSms(f.sms(PHONE, RUG, 'START'), f.deps)).outcome).toBe('start')
    expect(optedOut()).toEqual({ 'user-a': true, 'user-b': false })
    expect((await handleInboundSms(f.sms(PHONE, DIAL8, 'START'), f.deps)).outcome).toBe('start')
    expect(optedOut()).toEqual({ 'user-a': false, 'user-b': false })
  })
})
