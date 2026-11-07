import { describe, it, expect, vi } from 'vitest'
import { NO_TEXT_REPLY, START_REPLY, handleInboundSms, helpReply, notMemberReply, unknownNumberReply, type InboundDeps, type InboundSms } from '../inbound'
import { SMS_AUTO_REPLY_HOURLY_CAP, SMS_INBOUND_RATE_LIMIT } from '../store'
import type { LinkedPhone } from '../store'

/**
 * An inbound text, after its signature checked out: the compliance keywords
 * come before everything; then the opt-out, the rate limit, From → the
 * verified number (an unknown sender gets one reply, ever), membership, and
 * delivery into the home thread.
 */

const ORIGIN = 'https://dial8.ai'
const PHONE = '+15551234567'
const LINKED: LinkedPhone = { id: 'p1', userId: 'user-1', workspaceId: 'ws-1', phone: PHONE, optedOut: false, line: 'dial8' }

function fakeDeps(over: { linked?: LinkedPhone | null; member?: boolean; inboundCount?: number; unlinkedOptedOut?: boolean; sent?: string[]; autoRepliesThisHour?: number } = {}) {
  const seenSids = new Set<string>()
  const outbound: Array<{ phone: string; kind: string }> = [...(over.sent ?? []).map((kind) => ({ phone: PHONE, kind }))]
  const inbound: Array<{ phone: string; kind: string; sid: string | null }> = []
  const optOuts: Array<[string, boolean]> = []
  const delivered: Array<{ linked: LinkedPhone; text: string; sid: string }> = []
  const deps: InboundDeps = {
    recordInbound: vi.fn(async (row) => {
      if (row.sid && seenSids.has(row.sid)) return 'duplicate' as const
      if (row.sid) seenSids.add(row.sid)
      inbound.push(row)
      return 'new' as const
    }),
    forgetInbound: vi.fn(async (sid: string) => {
      seenSids.delete(sid)
    }),
    findLinkedPhone: vi.fn(async () => (over.linked === undefined ? LINKED : over.linked)),
    businessPerson: vi.fn(async () => null),
    setPhoneOptOut: vi.fn(async (phone: string, optedOut: boolean) => {
      optOuts.push([phone, optedOut])
    }),
    setPhoneRowOptOut: vi.fn(async () => {}),
    unlinkedNumberOptedOut: vi.fn(async () => over.unlinkedOptedOut ?? false),
    countInboundSince: vi.fn(async () => over.inboundCount ?? inbound.length),
    countOutboundKindsSince: vi.fn(async (kinds: readonly string[]) => over.autoRepliesThisHour ?? outbound.filter((o) => kinds.includes(o.kind)).length),
    hasOutbound: vi.fn(async (phone: string, kind: string) => outbound.some((o) => o.phone === phone && o.kind === kind)),
    recordOutbound: vi.fn(async (row) => {
      outbound.push(row)
    }),
    isWorkspaceMember: vi.fn(async () => over.member ?? true),
    deliverText: vi.fn(async (args) => {
      delivered.push(args)
    }),
    origin: ORIGIN,
  }
  return { deps, inbound, outbound, optOuts, delivered }
}

const sms = (body: string, over: Partial<InboundSms> = {}): InboundSms => ({ from: PHONE, body, sid: `SM${Math.random().toString(36).slice(2)}`, numMedia: 0, ...over })

describe('compliance keywords come first', () => {
  it('STOP opts the number out and says nothing back (the carrier sends the confirmation); nothing is delivered', async () => {
    for (const body of ['STOP', 'stop', 'Unsubscribe', 'CANCEL', 'end', 'QUIT', 'stopall']) {
      const f = fakeDeps()
      expect(await handleInboundSms(sms(body), f.deps)).toEqual({ outcome: 'stop', reply: null })
      expect(f.optOuts).toEqual([[PHONE, true]])
      expect(f.inbound[0]).toMatchObject({ kind: 'stop' })
      expect(f.delivered).toHaveLength(0)
      // Never even looks the number up: STOP works for anyone, linked or not.
      expect(f.deps.findLinkedPhone).not.toHaveBeenCalled()
    }
  })

  it('START opts back in and says so; HELP answers with what this is and how to stop', async () => {
    const start = fakeDeps({ linked: { ...LINKED, optedOut: true } })
    expect(await handleInboundSms(sms('START'), start.deps)).toEqual({ outcome: 'start', reply: START_REPLY })
    expect(start.optOuts).toEqual([[PHONE, false]])
    const help = fakeDeps({ linked: null })
    const out = await handleInboundSms(sms('HELP'), help.deps)
    expect(out).toEqual({ outcome: 'help', reply: helpReply(ORIGIN) })
    // The exact copy carriers review (US 10DLC).
    expect(out.reply).toBe('Dial8 AI assistant. Help: liam@dial8.ai. Reply STOP to opt out. Msg & data rates may apply.')
    expect(help.delivered).toHaveLength(0)
  })

  it('a keyword Twilio already answered (OptOutType) updates the state and says nothing back, so nobody gets two replies', async () => {
    const start = fakeDeps({ linked: { ...LINKED, optedOut: true } })
    expect(await handleInboundSms(sms('START', { optOutType: 'START' }), start.deps)).toEqual({ outcome: 'start', reply: null })
    expect(start.optOuts).toEqual([[PHONE, false]])
    const help = fakeDeps({ linked: null })
    expect(await handleInboundSms(sms('HELP', { optOutType: 'HELP' }), help.deps)).toEqual({ outcome: 'help', reply: null })
    // Nothing of ours went out, so the auto-reply cap is untouched.
    expect(help.outbound).toEqual([])
    // Twilio's keyword wins: its opt-out state is the one carriers enforce.
    const custom = fakeDeps()
    expect(await handleInboundSms(sms('ARRET', { optOutType: 'STOP' }), custom.deps)).toEqual({ outcome: 'stop', reply: null })
    expect(custom.optOuts).toEqual([[PHONE, true]])
    expect(custom.delivered).toHaveLength(0)
    // An OptOutType nobody knows changes nothing: the words decide.
    const odd = fakeDeps()
    expect(await handleInboundSms(sms('Move my 3pm', { optOutType: 'MAYBE' }), odd.deps)).toEqual({ outcome: 'queued', reply: null })
  })

  it('"stop the 3pm meeting" is a message for the agent, not an opt-out', async () => {
    const f = fakeDeps()
    expect(await handleInboundSms(sms('stop the 3pm meeting'), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.optOuts).toEqual([])
  })
})

describe('From → the verified number', () => {
  it('a linked member’s text is delivered (trimmed) and the webhook says nothing back', async () => {
    const f = fakeDeps()
    const msg = sms('  Move my 3pm to Friday  ', { sid: 'SM1' })
    expect(await handleInboundSms(msg, f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered).toEqual([{ linked: LINKED, text: 'Move my 3pm to Friday', sid: 'SM1' }])
  })

  it('an unknown number gets ONE reply pointing to Settings → Phone, then silence', async () => {
    const f = fakeDeps({ linked: null })
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'unknown_replied', reply: unknownNumberReply(ORIGIN) })
    expect(unknownNumberReply(ORIGIN)).toContain('/account/settings/phone')
    expect(await handleInboundSms(sms('hello?'), f.deps)).toEqual({ outcome: 'unknown_ignored', reply: null })
    expect(await handleInboundSms(sms('anyone?'), f.deps)).toEqual({ outcome: 'unknown_ignored', reply: null })
    expect(f.outbound.filter((o) => o.kind === 'unknown_reply')).toHaveLength(1)
    expect(f.delivered).toHaveLength(0)
  })

  it('an opted-out number is ignored, linked or not (nothing could be texted back)', async () => {
    const linked = fakeDeps({ linked: { ...LINKED, optedOut: true } })
    expect(await handleInboundSms(sms('hi'), linked.deps)).toEqual({ outcome: 'opted_out', reply: null })
    const unlinked = fakeDeps({ linked: null, unlinkedOptedOut: true })
    expect(await handleInboundSms(sms('hi'), unlinked.deps)).toEqual({ outcome: 'opted_out', reply: null })
    expect(unlinked.outbound).toHaveLength(0)
  })

  it('someone no longer in their number’s workspace gets one notice a day, and nothing is delivered', async () => {
    const f = fakeDeps({ member: false })
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'not_member', reply: notMemberReply(ORIGIN) })
    expect(await handleInboundSms(sms('hi again'), f.deps)).toEqual({ outcome: 'not_member_ignored', reply: null })
    expect(f.delivered).toHaveLength(0)
  })
})

describe('SMS pumping: replies nobody can be held to', () => {
  it('HELP, START and the unknown-sender reply go only to US/Canada numbers', async () => {
    for (const body of ['HELP', 'START', 'hello']) {
      const f = fakeDeps({ linked: null })
      const out = await handleInboundSms(sms(body, { from: '+442079460958' }), f.deps)
      expect([body, out.reply]).toEqual([body, null])
      expect(f.outbound).toHaveLength(0)
    }
  })

  it('past the global hourly cap, HELP, START and unknown senders get no reply (START still opts back in)', async () => {
    const f = fakeDeps({ linked: null, autoRepliesThisHour: SMS_AUTO_REPLY_HOURLY_CAP })
    expect(await handleInboundSms(sms('HELP'), f.deps)).toEqual({ outcome: 'help', reply: null })
    expect(await handleInboundSms(sms('START'), f.deps)).toEqual({ outcome: 'start', reply: null })
    expect(f.optOuts).toEqual([[PHONE, false]])
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'unknown_ignored', reply: null })
    expect(f.outbound).toHaveLength(0)
  })

  it('HELP and START replies are recorded as auto_reply (what the cap counts)', async () => {
    const f = fakeDeps()
    await handleInboundSms(sms('HELP'), f.deps)
    await handleInboundSms(sms('START'), f.deps)
    expect(f.outbound.map((o) => o.kind)).toEqual(['auto_reply', 'auto_reply'])
  })
})

describe('YES, as Twilio treats it', () => {
  it('re-subscribes an opted-out number (recorded as a start)', async () => {
    const f = fakeDeps({ linked: { ...LINKED, optedOut: true } })
    expect(await handleInboundSms(sms('Yes'), f.deps)).toEqual({ outcome: 'start', reply: START_REPLY })
    expect(f.optOuts).toEqual([[PHONE, false]])
    expect(f.inbound[0]).toMatchObject({ kind: 'start' })
  })

  it('is the person answering the agent otherwise', async () => {
    const f = fakeDeps()
    expect(await handleInboundSms(sms('yes', { sid: 'SM-yes' }), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered).toEqual([{ linked: LINKED, text: 'yes', sid: 'SM-yes' }])
    expect(f.optOuts).toEqual([])
  })
})

describe('limits and edge cases', () => {
  it('past the per-number rate limit, texts are ignored', async () => {
    const f = fakeDeps({ inboundCount: SMS_INBOUND_RATE_LIMIT + 1 })
    expect(await handleInboundSms(sms('hi'), f.deps)).toEqual({ outcome: 'rate_limited', reply: null })
    expect(f.delivered).toHaveLength(0)
  })

  it('a retried webhook (same MessageSid) does nothing the second time', async () => {
    const f = fakeDeps()
    const msg = sms('hi', { sid: 'SM-retry' })
    await handleInboundSms(msg, f.deps)
    expect(await handleInboundSms(msg, f.deps)).toEqual({ outcome: 'duplicate', reply: null })
    expect(f.delivered).toHaveLength(1)
  })

  it('a failed delivery forgets the sid and throws, so a second delivery (the fallback URL) runs in full', async () => {
    const f = fakeDeps()
    f.deps.deliverText = vi.fn(async () => {
      throw new Error('db down')
    })
    const msg = sms('hi', { sid: 'SM-fail' })
    await expect(handleInboundSms(msg, f.deps)).rejects.toThrow('db down')
    f.deps.deliverText = vi.fn(async () => {})
    expect(await handleInboundSms(msg, f.deps)).toEqual({ outcome: 'queued', reply: null })
  })

  it('a texted contacts file reaches the agent as a saved file it can import, with or without words (roadmap track G1)', async () => {
    const f = fakeDeps()
    const media = [{ url: 'https://api.twilio.com/2010-04-01/Accounts/AC1/Messages/MM1/Media/ME1', contentType: 'text/csv' }]
    f.deps.saveTextedFiles = vi.fn(async () => [{ storagePath: 'user-1/chat-uploads/f1.csv', extension: 'csv' as const }])
    expect(await handleInboundSms(sms('my customers', { numMedia: 1, media }), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(await handleInboundSms(sms('', { numMedia: 1, media }), f.deps)).toEqual({ outcome: 'queued', reply: null })
    expect(f.delivered.map((d) => d.text)).toEqual([
      'my customers\n\n[They texted a spreadsheet (CSV): storage_path user-1/chat-uploads/f1.csv]',
      '[They texted a spreadsheet (CSV): storage_path user-1/chat-uploads/f1.csv]',
    ])
    expect(f.deps.saveTextedFiles).toHaveBeenCalledWith({ linked: LINKED, media })
  })

  it('a picture with no words gets a short note; a From that is not E.164 is dropped', async () => {
    const f = fakeDeps()
    expect(await handleInboundSms(sms('   ', { numMedia: 1 }), f.deps)).toEqual({ outcome: 'no_text', reply: NO_TEXT_REPLY })
    expect(await handleInboundSms(sms('hi', { from: 'whatsapp:+1555' }), f.deps)).toEqual({ outcome: 'invalid', reply: null })
    expect(f.delivered).toHaveLength(0)
  })
})

describe('guests (a number no one linked)', () => {
  it("a guest's text is theirs: the guest handler answers before the unknown-number reply, with this handler's capped reply", async () => {
    const f = fakeDeps({ linked: null })
    const guestText = vi.fn(async (_input: unknown, tools: { autoReply: (phone: string, kind: 'guest_welcome' | 'guest_notice', text: string, guestId: string | null) => Promise<string | null> }) => ({
      outcome: 'guest_welcomed' as const,
      reply: await tools.autoReply(PHONE, 'guest_welcome', 'welcome', 'g1'),
    }))
    f.deps.guestText = guestText
    expect(await handleInboundSms(sms('K7Q4MX'), f.deps)).toEqual({ outcome: 'guest_welcomed', reply: 'welcome' })
    expect(f.outbound).toEqual([{ phone: PHONE, kind: 'guest_welcome', guestId: 'g1' }])
    expect(f.deps.hasOutbound).not.toHaveBeenCalledWith(PHONE, 'unknown_reply')
  })

  it('not a guest text: the unknown-number reply as before', async () => {
    const f = fakeDeps({ linked: null })
    f.deps.guestText = vi.fn(async () => null)
    expect(await handleInboundSms(sms('who is this'), f.deps)).toEqual({ outcome: 'unknown_replied', reply: unknownNumberReply(ORIGIN) })
  })

  it('a linked number never reaches the guest handler', async () => {
    const f = fakeDeps()
    f.deps.guestText = vi.fn(async () => null)
    await handleInboundSms(sms('hello'), f.deps)
    expect(f.deps.guestText).not.toHaveBeenCalled()
    expect(f.delivered).toHaveLength(1)
  })

  it('an opted-out or rate-limited number never reaches it either', async () => {
    const out = fakeDeps({ linked: null, unlinkedOptedOut: true })
    out.deps.guestText = vi.fn(async () => null)
    expect((await handleInboundSms(sms('hello'), out.deps)).outcome).toBe('opted_out')
    const limited = fakeDeps({ linked: null, inboundCount: SMS_INBOUND_RATE_LIMIT + 1 })
    limited.deps.guestText = vi.fn(async () => null)
    expect((await handleInboundSms(sms('hello'), limited.deps)).outcome).toBe('rate_limited')
    expect(out.deps.guestText).not.toHaveBeenCalled()
    expect(limited.deps.guestText).not.toHaveBeenCalled()
  })

  it('a failed guest delivery forgets the sid, so a retried delivery is handled in full', async () => {
    const f = fakeDeps({ linked: null })
    f.deps.guestText = vi.fn(async () => {
      throw new Error('down')
    })
    const text = sms('hi', { sid: 'SMguest' })
    await expect(handleInboundSms(text, f.deps)).rejects.toThrow('down')
    expect(f.deps.forgetInbound).toHaveBeenCalledWith('SMguest')
  })

  it("STOP and START also mark a guest's row", async () => {
    const f = fakeDeps({ linked: null })
    f.deps.setGuestOptOut = vi.fn(async () => {})
    await handleInboundSms(sms('STOP'), f.deps)
    await handleInboundSms(sms('START'), f.deps)
    expect(f.deps.setGuestOptOut).toHaveBeenNthCalledWith(1, PHONE, true)
    expect(f.deps.setGuestOptOut).toHaveBeenNthCalledWith(2, PHONE, false)
  })
})

/**
 * The `To`-number rule, this side of it (roadmap track A): a stranger texting
 * the Dial8 number is signing up. A business's own number is track B's
 * (businessLine / businessText, liamadsr/dial8-website#1012), which runs after
 * the shared compliance steps and before this, so signupText only ever sees
 * strangers on the Dial8 line.
 */
describe('the line, by the number texted (`To`)', () => {
  const DIAL8 = '+19287698774'

  it('a stranger texting the Dial8 number is a sign-up', async () => {
    const stranger = fakeDeps({ linked: null })
    const signupText = vi.fn(async () => ({ outcome: 'signup_code_sent' as const, reply: 'CODE' }))
    expect(await handleInboundSms(sms('hi', { to: DIAL8 }), { ...stranger.deps, signupText })).toEqual({ outcome: 'signup_code_sent', reply: 'CODE' })
    expect(signupText).toHaveBeenCalledWith({ phone: PHONE, text: 'hi', sid: expect.any(String) }, expect.objectContaining({ autoReply: expect.any(Function) }))
  })

  it("a linked person's text reaches their agent whatever `To` says, and never signs anyone up", async () => {
    const signupText = vi.fn()
    for (const to of [DIAL8, '+16265550142', null, undefined]) {
      const owner = fakeDeps()
      expect(await handleInboundSms(sms('Move my 3pm', { to }), { ...owner.deps, signupText }), String(to)).toEqual({ outcome: 'queued', reply: null })
    }
    expect(signupText).not.toHaveBeenCalled()
  })
})

describe('signing up from an unknown number (./signup.ts)', () => {
  it('runs after the compliance keywords, the opt-out, the rate limit and the guest check', async () => {
    const signupText = vi.fn(async () => ({ outcome: 'signup_code_sent' as const, reply: 'CODE' }))
    const stop = fakeDeps({ linked: null })
    expect((await handleInboundSms(sms('STOP'), { ...stop.deps, signupText })).outcome).toBe('stop')
    const optedOut = fakeDeps({ linked: null, unlinkedOptedOut: true })
    expect((await handleInboundSms(sms('hi'), { ...optedOut.deps, signupText })).outcome).toBe('opted_out')
    const flooded = fakeDeps({ linked: null, inboundCount: SMS_INBOUND_RATE_LIMIT + 1 })
    expect((await handleInboundSms(sms('hi'), { ...flooded.deps, signupText })).outcome).toBe('rate_limited')
    const guest = fakeDeps({ linked: null })
    const guestText = vi.fn(async () => ({ outcome: 'guest_queued' as const, reply: null }))
    expect((await handleInboundSms(sms('hi'), { ...guest.deps, guestText, signupText })).outcome).toBe('guest_queued')
    expect(signupText).not.toHaveBeenCalled()
  })

  it('its replies go through the auto-reply guard: US/Canada only, under the global cap (which sign-up codes do not count toward), recorded as a sign-up code', async () => {
    const f = fakeDeps({ linked: null })
    const signupText: InboundDeps['signupText'] = async (_input, tools) => ({ outcome: 'signup_code_sent', reply: await tools.autoReply('signup_code', 'CODE') })
    expect(await handleInboundSms(sms('hi'), { ...f.deps, signupText })).toEqual({ outcome: 'signup_code_sent', reply: 'CODE' })
    expect(f.outbound).toEqual([{ phone: PHONE, kind: 'signup_code' }])
    const capped = fakeDeps({ linked: null, autoRepliesThisHour: SMS_AUTO_REPLY_HOURLY_CAP })
    expect(await handleInboundSms(sms('hi'), { ...capped.deps, signupText })).toEqual({ outcome: 'signup_code_sent', reply: null })
    const intl = fakeDeps({ linked: null })
    expect(await handleInboundSms(sms('hi', { from: '+447700900123' }), { ...intl.deps, signupText })).toEqual({ outcome: 'signup_code_sent', reply: null })
  })

  it('a sign-up that throws forgets the sid, so a re-delivered text is handled in full', async () => {
    const f = fakeDeps({ linked: null })
    const signupText = vi.fn(async () => {
      throw new Error('store down')
    })
    await expect(handleInboundSms(sms('hi', { sid: 'SMthrow' }), { ...f.deps, signupText })).rejects.toThrow('store down')
    expect(f.deps.forgetInbound).toHaveBeenCalledWith('SMthrow')
  })

  it('without the signupText dep, an unknown number keeps the one-time Settings → Phone reply', async () => {
    const f = fakeDeps({ linked: null })
    expect((await handleInboundSms(sms('hi'), f.deps)).outcome).toBe('unknown_replied')
  })
})
