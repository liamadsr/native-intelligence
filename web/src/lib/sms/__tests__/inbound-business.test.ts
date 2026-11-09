/**
 * The number that was texted decides (roadmap B2, shared with track A, and
 * migration 464's one phone, two accounts): a stranger texting a business's
 * own number is its customer (src/lib/customers/texting.ts), never the
 * unknown-number reply or a guest lookup; the business's own people (the
 * `businessPerson` row, a business-line row first) go on as by the Dial8
 * number, in the business's workspace whichever workspace their phone is
 * linked to; the Dial8 number reaches only the phone's Dial8-line account;
 * STOP / START change only the texted number's account; HELP and START name
 * the business; and a text to the Dial8 number is unchanged.
 */
import { describe, expect, it, vi } from 'vitest'
import { START_REPLY, handleInboundSms, unknownNumberReply, type InboundDeps, type InboundSms } from '../inbound'
import type { LinkedPhone } from '../store'
import { businessHelpReply, businessStartReply } from '@/lib/customers/texting'
import type { BusinessNumber } from '@/lib/customers/numbers'

const ORIGIN = 'https://dial8.ai'
const DIAL8 = '+18885550100'
const RUG = '+16465550173'
const STRANGER = '+12125550199'
const NUMBER: BusinessNumber = { id: 'bn-1', workspaceId: 'ws-rug', ownerUserId: 'user-owner', phone: RUG, twilioSid: 'PN1' }

/** Account A: the phone's Dial8 line, their own workspace. Not one of Bright Loom's people. */
const ACCOUNT_A: LinkedPhone = { id: 'p-a', userId: 'user-a', workspaceId: 'ws-home', phone: STRANGER, optedOut: false, line: 'dial8' }
/** Account B: Bright Loom's own account, the same phone on its business line. */
const ACCOUNT_B: LinkedPhone = { id: 'p-b', userId: 'user-b', workspaceId: 'ws-rug', phone: STRANGER, optedOut: false, line: 'business' }

function fakeDeps(over: { linked?: LinkedPhone | null; person?: LinkedPhone | null; businessResult?: Awaited<ReturnType<NonNullable<InboundDeps['businessText']>>> } = {}) {
  const seen = new Set<string>()
  const outbound: Array<{ phone: string; kind: string }> = []
  const deps: InboundDeps = {
    recordInbound: vi.fn(async (row) => {
      if (row.sid && seen.has(row.sid)) return 'duplicate' as const
      if (row.sid) seen.add(row.sid)
      return 'new' as const
    }),
    forgetInbound: vi.fn(async (sid: string) => {
      seen.delete(sid)
    }),
    findLinkedPhone: vi.fn(async () => over.linked ?? null),
    businessPerson: vi.fn(async () => over.person ?? null),
    setPhoneOptOut: vi.fn(async () => {}),
    setPhoneRowOptOut: vi.fn(async () => {}),
    setGuestOptOut: vi.fn(async () => {}),
    unlinkedNumberOptedOut: vi.fn(async () => false),
    countInboundSince: vi.fn(async () => 0),
    countOutboundKindsSince: vi.fn(async () => 0),
    hasOutbound: vi.fn(async (phone: string, kind: string) => outbound.some((o) => o.phone === phone && o.kind === kind)),
    recordOutbound: vi.fn(async (row) => {
      outbound.push(row)
    }),
    isWorkspaceMember: vi.fn(async () => true),
    guestText: vi.fn(async () => null),
    businessLine: vi.fn(async (to: string) => (to === RUG ? { number: NUMBER, name: 'Bright Loom' } : null)),
    businessText: vi.fn(async (_input, tools) => {
      if (over.businessResult !== undefined) return over.businessResult
      return { outcome: 'customer_welcomed' as const, reply: await tools.autoReply(STRANGER, 'guest_welcome', 'Thanks for texting Bright Loom!', 'g-1') }
    }),
    deliverText: vi.fn(async () => {}),
    origin: ORIGIN,
  }
  return { deps, outbound }
}

const sms = (body: string, over: Partial<InboundSms> = {}): InboundSms => ({ from: STRANGER, body, sid: `SM${Math.random().toString(36).slice(2)}`, numMedia: 0, to: RUG, ...over })

describe("a text to a business's number", () => {
  it("is the business's customer: their path, never a guest lookup or the unknown-number reply", async () => {
    const f = fakeDeps()
    const out = await handleInboundSms(sms('How much to clean an 8x10?'), f.deps)
    expect(out).toEqual({ outcome: 'customer_welcomed', reply: 'Thanks for texting Bright Loom!' })
    expect(f.deps.businessText).toHaveBeenCalledWith(expect.objectContaining({ number: NUMBER, phone: STRANGER, text: 'How much to clean an 8x10?' }), expect.anything())
    expect(f.deps.guestText).not.toHaveBeenCalled()
    expect(f.outbound.some((o) => o.kind === 'unknown_reply')).toBe(false)
    // Its welcome counts toward the global auto-reply cap, as a guest's.
    expect(f.outbound).toEqual([{ phone: STRANGER, kind: 'guest_welcome', guestId: 'g-1' }])
  })

  it("the phone's Dial8-line account, when it isn't one of the business's people, is still its customer there", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: null })
    expect((await handleInboundSms(sms('How much for a runner?'), f.deps)).outcome).toBe('customer_welcomed')
    // The Dial8 line is never read for a business's number: the number decides who is texting.
    expect(f.deps.findLinkedPhone).not.toHaveBeenCalled()
    expect(f.deps.businessPerson).toHaveBeenCalledWith(STRANGER, 'ws-rug')
    expect(f.deps.deliverText).not.toHaveBeenCalled()
  })

  it("one phone, two accounts: the business's own account (its business line) talks to its agent, in its workspace", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: ACCOUNT_B })
    expect(await handleInboundSms(sms('what did Sarah ask for?'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.deps.businessText).not.toHaveBeenCalled()
    expect(f.deps.isWorkspaceMember).toHaveBeenCalledWith('user-b', 'ws-rug')
    expect(f.deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ linked: ACCOUNT_B, text: 'what did Sarah ask for?' }))
  })

  it("one of its people whose phone is linked to another workspace talks to that business's agent (one phone, two agents)", async () => {
    const ownerElsewhere: LinkedPhone = { id: 'p1', userId: 'user-owner', workspaceId: 'ws-home', phone: STRANGER, optedOut: false, line: 'dial8' }
    const f = fakeDeps({ linked: ownerElsewhere, person: ownerElsewhere })
    expect(await handleInboundSms(sms('yes, send it'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.deps.isWorkspaceMember).toHaveBeenCalledWith('user-owner', 'ws-rug')
    expect(f.deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ linked: { ...ownerElsewhere, workspaceId: 'ws-rug' }, text: 'yes, send it' }))
  })

  it('the membership check runs on the business: a person no longer in it is not delivered there', async () => {
    const f = fakeDeps({ person: ACCOUNT_B })
    f.deps.isWorkspaceMember = vi.fn(async (_userId: string, workspaceId: string) => workspaceId !== 'ws-rug')
    expect((await handleInboundSms(sms('hello'), f.deps)).outcome).toBe('not_member')
    expect(f.deps.deliverText).not.toHaveBeenCalled()
  })

  it("an approval code texted to the business's number is answered by that account's own approvals", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: ACCOUNT_B })
    f.deps.answerApproval = vi.fn(async () => ({ outcome: 'approval_answered' as const, reply: 'Approved.' }))
    expect(await handleInboundSms(sms('yes K7Q4MX'), f.deps)).toEqual({ outcome: 'approval_answered', reply: 'Approved.' })
    expect(f.deps.answerApproval).toHaveBeenCalledWith(expect.objectContaining({ linked: ACCOUNT_B, text: 'yes K7Q4MX' }))
    expect(f.deps.deliverText).not.toHaveBeenCalled()
  })

  it("the opt-out is the business account's: its line said STOP, so its texts are ignored (the Dial8 line's state doesn't matter)", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: { ...ACCOUNT_B, optedOut: true } })
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'opted_out', reply: null })
    const g = fakeDeps({ linked: { ...ACCOUNT_A, optedOut: true }, person: ACCOUNT_B })
    expect((await handleInboundSms(sms('hi'), g.deps)).outcome).toBe('queued')
  })

  it('one of its people found only on a second read (a member row added meanwhile) still reaches its agent, never the stranger path', async () => {
    const f = fakeDeps({ businessResult: null })
    f.deps.businessPerson = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(ACCOUNT_B)
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ linked: ACCOUNT_B }))
    expect(f.deps.guestText).not.toHaveBeenCalled()
  })

  it('HELP and START name the business, not Dial8', async () => {
    expect((await handleInboundSms(sms('HELP'), fakeDeps().deps)).reply).toBe(businessHelpReply('Bright Loom'))
    expect((await handleInboundSms(sms('START'), fakeDeps().deps)).reply).toBe(businessStartReply('Bright Loom'))
    expect(businessHelpReply('Bright Loom')).toContain('Reply STOP to opt out')
  })

  it("STOP to it changes exactly the row it resolves to (account B's business line), never account A's Dial8 line; the customer path never runs", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: ACCOUNT_B })
    expect(await handleInboundSms(sms('STOP'), f.deps)).toEqual({ outcome: 'stop', reply: null })
    expect(f.deps.setPhoneRowOptOut).toHaveBeenCalledWith('p-b', true)
    expect(f.deps.setPhoneOptOut).not.toHaveBeenCalled()
    expect(f.deps.setGuestOptOut).toHaveBeenCalledWith(STRANGER, true)
    expect(f.deps.recordInbound).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stop' }))
    expect(f.deps.businessText).not.toHaveBeenCalled()
  })

  it("a single-account owner (their Dial8-line row, a member there) is the row it resolves to: STOP and START there toggle it", async () => {
    const owner: LinkedPhone = { id: 'p-o', userId: 'user-owner', workspaceId: 'ws-home', phone: STRANGER, optedOut: false, line: 'dial8' }
    const f = fakeDeps({ linked: owner, person: owner })
    await handleInboundSms(sms('STOP'), f.deps)
    expect(f.deps.setPhoneRowOptOut).toHaveBeenCalledWith('p-o', true)
    const g = fakeDeps({ linked: { ...owner, optedOut: true }, person: { ...owner, optedOut: true } })
    expect(await handleInboundSms(sms('START'), g.deps)).toEqual({ outcome: 'start', reply: businessStartReply('Bright Loom') })
    expect(g.deps.setPhoneRowOptOut).toHaveBeenCalledWith('p-o', false)
    expect(g.deps.setPhoneOptOut).not.toHaveBeenCalled()
  })

  it("STOP from a customer tells the business's reminders (issue #11), after the opt-out is set; never for one of its people", async () => {
    const f = fakeDeps()
    f.deps.customerStopped = vi.fn(async () => 1)
    expect(await handleInboundSms(sms('STOP'), f.deps)).toEqual({ outcome: 'stop', reply: null })
    expect(f.deps.setGuestOptOut).toHaveBeenCalledWith(STRANGER, true)
    expect(f.deps.customerStopped).toHaveBeenCalledWith({ number: NUMBER, name: 'Bright Loom' }, STRANGER)
    // A failure there never costs the STOP.
    const broken = fakeDeps()
    broken.deps.customerStopped = vi.fn(async () => {
      throw new Error('down')
    })
    expect(await handleInboundSms(sms('STOP'), broken.deps)).toEqual({ outcome: 'stop', reply: null })
    // One of the business's own people, START, or STOP to the Dial8 number: nothing.
    const own = fakeDeps({ linked: ACCOUNT_A, person: ACCOUNT_B })
    own.deps.customerStopped = vi.fn(async () => 1)
    await handleInboundSms(sms('STOP'), own.deps)
    const start = fakeDeps()
    start.deps.customerStopped = vi.fn(async () => 1)
    await handleInboundSms(sms('START'), start.deps)
    const dial8 = fakeDeps()
    dial8.deps.customerStopped = vi.fn(async () => 1)
    await handleInboundSms(sms('STOP', { to: DIAL8 }), dial8.deps)
    expect([own, start, dial8].map((x) => (x.deps.customerStopped as ReturnType<typeof vi.fn>).mock.calls.length)).toEqual([0, 0, 0])
  })

  it('START from a stranger (a customer) touches no person row: guests, customers and the ledger only', async () => {
    const f = fakeDeps()
    await handleInboundSms(sms('START'), f.deps)
    expect(f.deps.setPhoneRowOptOut).not.toHaveBeenCalled()
    expect(f.deps.setPhoneOptOut).not.toHaveBeenCalled()
    expect(f.deps.setGuestOptOut).toHaveBeenCalledWith(STRANGER, false)
  })

  it('YES from the row it resolves to, when that row said STOP, is a START for that row', async () => {
    const y = fakeDeps({ linked: ACCOUNT_A, person: { ...ACCOUNT_B, optedOut: true } })
    expect(await handleInboundSms(sms('YES'), y.deps)).toEqual({ outcome: 'start', reply: businessStartReply('Bright Loom') })
    expect(y.deps.setPhoneRowOptOut).toHaveBeenCalledWith('p-b', false)
    expect(y.deps.setPhoneOptOut).not.toHaveBeenCalled()
  })

  it('a failed customer delivery forgets the sid, so a re-delivery is handled in full', async () => {
    const f = fakeDeps()
    f.deps.businessText = vi.fn(async () => {
      throw new Error('down')
    })
    const text = sms('hi', { sid: 'SM-1' })
    await expect(handleInboundSms(text, f.deps)).rejects.toThrow('down')
    expect(f.deps.forgetInbound).toHaveBeenCalledWith('SM-1')
  })
})

describe('the same phone texting the Dial8 number', () => {
  it("reaches its Dial8-line account (A) in A's own workspace, never the business's account", async () => {
    const f = fakeDeps({ linked: ACCOUNT_A, person: ACCOUNT_B })
    await handleInboundSms(sms("what's on tomorrow?", { to: DIAL8 }), f.deps)
    expect(f.deps.businessText).not.toHaveBeenCalled()
    expect(f.deps.businessPerson).not.toHaveBeenCalled()
    expect(f.deps.deliverText).toHaveBeenCalledWith(expect.objectContaining({ linked: ACCOUNT_A }))
  })

  it("a business-line account is not reached there: with no Dial8-line holder, the phone is a stranger to the Dial8 number", async () => {
    const f = fakeDeps({ linked: null, person: ACCOUNT_B })
    expect(await handleInboundSms(sms('hello', { to: DIAL8 }), f.deps)).toEqual({ outcome: 'unknown_replied', reply: unknownNumberReply(ORIGIN) })
    expect(f.deps.deliverText).not.toHaveBeenCalled()
  })

  it('STOP / START there change the Dial8 line only, never the business lines', async () => {
    const f = fakeDeps({ linked: ACCOUNT_A })
    expect(await handleInboundSms(sms('STOP', { to: DIAL8 }), f.deps)).toEqual({ outcome: 'stop', reply: null })
    expect(f.deps.setPhoneOptOut).toHaveBeenCalledWith(STRANGER, true)
    expect(f.deps.setPhoneRowOptOut).not.toHaveBeenCalled()
    expect((await handleInboundSms(sms('START', { to: DIAL8 }), f.deps)).reply).toBe(START_REPLY)
    expect(f.deps.setPhoneOptOut).toHaveBeenCalledWith(STRANGER, false)
    expect(f.deps.setPhoneRowOptOut).not.toHaveBeenCalled()
  })
})

describe('the real lookup never costs a STOP or a text', () => {
  it('a failed business-number read is taken as the Dial8 line, never thrown', async () => {
    const { supabaseInboundDeps } = await import('../inbound')
    const failing = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'down' } }) }) }) }) }) }
    const deps = supabaseInboundDeps(failing as never, { origin: ORIGIN, deliverText: async () => {} })
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await deps.businessLine!(RUG)).toBeNull()
    expect(errors).toHaveBeenCalledWith(expect.stringContaining('ALERT business number lookup failed'), 'business_phone_number read failed: down')
    errors.mockRestore()
  })
})

describe('a text to the Dial8 number (track A owns its strangers)', () => {
  it('never asks the customer path; a stranger gets the unknown-number reply as before', async () => {
    const f = fakeDeps()
    expect(await handleInboundSms(sms('hello', { to: DIAL8 }), f.deps)).toEqual({ outcome: 'unknown_replied', reply: unknownNumberReply(ORIGIN) })
    expect(f.deps.businessText).not.toHaveBeenCalled()
    expect(f.deps.guestText).toHaveBeenCalled()
  })

  it('no To at all reads as the Dial8 number', async () => {
    const f = fakeDeps()
    expect((await handleInboundSms(sms('START', { to: undefined }), f.deps)).reply).toBe(START_REPLY)
    expect(f.deps.businessLine).not.toHaveBeenCalled()
  })
})
