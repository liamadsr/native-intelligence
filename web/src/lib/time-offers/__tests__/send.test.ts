/**
 * offer_times (src/lib/time-offers/send.ts), modelled on send_quote: by link
 * it makes the offer and returns the link and the text to paste, sending
 * nothing; by email or text it sends only as the replay of the person's card,
 * whose words (all but the link's token) are pinned by hash. The card's offer
 * is made only when the card is raised (prepare), reused for the same card,
 * and let go when the card is declined, lapses or no longer matches; a text
 * needs the workspace's business number.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runOfferTimes, settleTimeOfferApproval, timeOfferHold, type SendDeps } from '../send'
import { offerTokenHash } from '../tokens'
import { OFFER_CARD_WHY_MAX } from '../words'
import { freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW)]
const INPUT = {
  recipient: { name: 'Dana Reyes', email: 'dana@initech.example', phone: '+13125550142' },
  title: 'Intro call',
  slots: SLOTS,
  duration_minutes: 30,
  message: 'Great to meet you at the expo.',
}

function seams<T extends Partial<SendDeps>>(over: T = {} as T) {
  const cal = freeCalendar()
  const defaults = {
    ...cal,
    origin: 'https://app.example',
    optedOut: vi.fn(async () => false),
    businessNumber: vi.fn(async (): Promise<{ phone: string } | null> => ({ phone: '+13125550100' })),
    sendEmail: vi.fn(async () => ({ id: 'm-1' }) as never),
    sendText: vi.fn(async () => true),
  }
  return { ...defaults, ...over }
}

const args = { userId: HOST, workspaceId: WS }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('offer_times by link', () => {
  it('makes the offer, holds the times, and returns the link and ready-to-paste text in the host zone; nothing is sent', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const out = await runOfferTimes(db, args, { ...INPUT }, deps)
    expect(out).toMatchObject({ success: true, sent_via: 'link', time_zone: 'America/New_York' })
    const link = String(out.link)
    expect(link).toMatch(/^https:\/\/app\.example\/t\/[A-Za-z0-9_-]{24}$/)
    expect(tables.time_offer[0].token_hash).toBe(offerTokenHash(link.split('/t/')[1]))
    expect(String(out.paste_text)).toContain('These times work for me (E')
    expect(String(out.paste_text)).toContain(link)
    expect(String(out.paste_text)).toContain('Great to meet you at the expo.')
    expect((out.times as Array<{ label: string }>)[0].label).toMatch(/ E[SD]T$/)
    expect(tables.host_time_claim).toHaveLength(2)
    expect(deps.sendEmail).not.toHaveBeenCalled()
    expect(deps.sendText).not.toHaveBeenCalled()
    // Made outside the person's own attended turn: not shown to them (their agent's booking from it waits on their card).
    expect(tables.time_offer[0].recipients_shown).toBe(false)
  })

  it("made in the person's own attended turn, it is marked shown to them", async () => {
    const { db, tables } = offerDb()
    expect(await runOfferTimes(db, { ...args, personAttended: true }, { ...INPUT }, seams())).toMatchObject({ success: true })
    expect(tables.time_offer[0].recipients_shown).toBe(true)
  })
})

describe('offer_times by email or text', () => {
  it("never sends on the model's word: without the card's replay it refuses, saying why first when it couldn't send at all", async () => {
    const { db, tables } = offerDb()
    expect(await runOfferTimes(db, args, { ...INPUT, send_by: 'email' }, seams())).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(await runOfferTimes(db, args, { ...INPUT, send_by: 'text' }, seams({ businessNumber: vi.fn(async () => null) }))).toMatchObject({
      success: false,
      code: 'NO_BUSINESS_NUMBER',
      error: expect.stringContaining("send_by 'link'"),
    })
    expect(await runOfferTimes(db, args, { ...INPUT, send_by: 'text' }, seams({ optedOut: vi.fn(async () => true) }))).toMatchObject({ code: 'OPTED_OUT' })
    expect(tables.time_offer).toHaveLength(0)
    expect(tables.host_time_claim).toHaveLength(0)
  })

  it("the gate's card: the exact recipient and words (the link's token left out), fitted to the card; no offer until it is raised", async () => {
    const { db, tables } = offerDb()
    const hold = await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, seams())
    expect(hold).not.toBeNull()
    expect(hold!.card.title).toBe('Email Dana Reyes (dana@initech.example) times to meet?')
    expect(hold!.card.why).toContain('From your mailbox, subject “Intro call: a few times to meet”: “Hi Dana,')
    expect(hold!.card.why).toContain('https://app.example/t/…')
    expect(hold!.card.why).toContain('Great to meet you at the expo.')
    expect(hold!.card.why.length).toBeLessThanOrEqual(OFFER_CARD_WHY_MAX)
    expect(tables.time_offer).toHaveLength(0)
    const text = await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'text' } }, seams())
    expect(text!.card.title).toBe('Text Dana Reyes (+1 312-555-0142) times to meet?')
    expect(text!.card.why).toContain('From the business number +1 312-555-0100:')
    // By link, or a call the tool would refuse: no card.
    expect(await timeOfferHold(db, { ...args, input: { ...INPUT } }, seams())).toBeNull()
    expect(await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'text' } }, seams({ businessNumber: vi.fn(async () => null) }))).toBeNull()
  })

  it('the card raised: its offer is made (times held, no token), the same card again reuses it, and the replay sends exactly those words', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    const prepared = await hold.prepare()
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) return
    const again = await (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!.prepare()
    expect(again.ok && again.context.timeOffer.offer_id).toBe(prepared.context.timeOffer.offer_id)
    expect(tables.time_offer).toMatchObject([{ state: 'pending_send', token_hash: null, card_hash: hold.context.timeOffer.card_hash }])
    expect(tables.host_time_claim).toHaveLength(2)
    await hold.held(prepared.context, 'appr-1')
    expect(tables.time_offer[0].approval_id).toBe('appr-1')

    const out = await runOfferTimes(db, { ...args, approvedCall: { approvalId: 'appr-1', tool: 'offer_times', timeOffer: prepared.context.timeOffer } }, { ...INPUT, send_by: 'email' }, deps)
    expect(out).toMatchObject({ success: true, sent_via: 'email', to: 'dana@initech.example' })
    const sent = deps.sendEmail.mock.calls[0] as unknown as [string, string, { to: string[]; subject: string; body_text: string; body_html: string }]
    expect(sent[0]).toBe(HOST)
    expect(sent[2].to).toEqual(['dana@initech.example'])
    expect(sent[2].subject).toBe('Intro call: a few times to meet')
    const link = String(out.link)
    expect(sent[2].body_text).toContain(link)
    expect(sent[2].body_html).toContain(`<a href="${link}">`)
    // Every word the card showed went out, the link's token in place of its "…".
    const shownWords = hold.card.why.split('”: “')[1].split('” The times stay held')[0]
    expect(sent[2].body_text.replace(/\s+/g, ' ').trim()).toBe(shownWords.replace('https://app.example/t/…', link))
    // Its card named who it went to: shown, whoever made the call.
    expect(tables.time_offer[0]).toMatchObject({ state: 'open', sent_via: 'email', token_hash: offerTokenHash(link.split('/t/')[1]), recipients_shown: true })
    // The same replay twice sends nothing more.
    expect(await runOfferTimes(db, { ...args, approvedCall: { approvalId: 'appr-1', tool: 'offer_times', timeOffer: prepared.context.timeOffer } }, { ...INPUT, send_by: 'email' }, deps)).toMatchObject({ success: false, code: 'CLOSED' })
    expect(deps.sendEmail).toHaveBeenCalledTimes(1)
  })

  it('by text from the business number, as the SMS formatter sends it', async () => {
    const { db } = offerDb()
    const deps = seams()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'text' } }, deps))!
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    const out = await runOfferTimes(db, { ...args, approvedCall: { approvalId: 'a', tool: 'offer_times', timeOffer: prepared.context.timeOffer } }, { ...INPUT, send_by: 'text' }, deps)
    expect(out).toMatchObject({ success: true, sent_via: 'text', to: '+13125550142' })
    const [{ to, body }] = deps.sendText.mock.calls[0] as unknown as [{ to: string; body: string }]
    expect(to).toBe('+13125550142')
    expect(body).toContain('Hi Dana, Ava Lin here. Great to meet you at the expo. Could we meet for Intro call (30 min, on a video call)?')
    expect(body).toContain(String(out.link))
    expect(body).toContain('or reply here with the one that works.')
  })

  it("a card whose words no longer match, or a time no longer free, sends nothing and lets the times go", async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'text' } }, deps))!
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    // The business number changed since the card.
    deps.businessNumber.mockResolvedValue({ phone: '+13125550111' })
    expect(await runOfferTimes(db, { ...args, approvedCall: { approvalId: 'a', tool: 'offer_times', timeOffer: prepared.context.timeOffer } }, { ...INPUT, send_by: 'text' }, deps)).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    expect(deps.sendText).not.toHaveBeenCalled()
    expect(tables.time_offer[0].state).toBe('withdrawn')
    expect(tables.host_time_claim).toHaveLength(0)

    const second = offerDb()
    const d2 = seams()
    const h2 = (await timeOfferHold(second.db, { ...args, input: { ...INPUT, send_by: 'email' } }, d2))!
    const p2 = await h2.prepare()
    if (!p2.ok) throw new Error(p2.message)
    d2.checkFree.mockResolvedValueOnce({ known: true, busy: [false, true] })
    expect(await runOfferTimes(second.db, { ...args, approvedCall: { approvalId: 'a', tool: 'offer_times', timeOffer: p2.context.timeOffer } }, { ...INPUT, send_by: 'email' }, d2)).toMatchObject({ success: false, code: 'SLOT_TAKEN' })
    expect(d2.sendEmail).not.toHaveBeenCalled()
    expect(second.tables.host_time_claim).toHaveLength(0)
  })

  it('a send that fails reaches no one and lets the times go', async () => {
    const { db, tables } = offerDb()
    const deps = seams({ sendEmail: vi.fn(async () => { throw new Error('No email integration connected') }) })
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    expect(await runOfferTimes(db, { ...args, approvedCall: { approvalId: 'a', tool: 'offer_times', timeOffer: prepared.context.timeOffer } }, { ...INPUT, send_by: 'email' }, deps)).toMatchObject({
      success: false,
      code: 'NOT_SENT',
      error: expect.stringContaining('no mailbox is connected'),
    })
    expect(tables.time_offer[0].state).toBe('withdrawn')
    expect(tables.host_time_claim).toHaveLength(0)
  })

  it('a card declined or lapsed lets its times go; a card not raised (abandon) too', async () => {
    for (const outcome of ['denied', 'expired'] as const) {
      const { db, tables } = offerDb()
      const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, seams()))!
      const prepared = await hold.prepare()
      if (!prepared.ok) throw new Error(prepared.message)
      await settleTimeOfferApproval(db, { context: prepared.context }, outcome)
      expect(tables.time_offer[0].state).toBe(outcome === 'denied' ? 'declined' : 'expired')
      expect(tables.host_time_claim).toHaveLength(0)
    }
    const { db, tables } = offerDb()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, seams()))!
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    await hold.abandon(prepared.context)
    expect(tables.time_offer[0].state).toBe('withdrawn')
    expect(tables.host_time_claim).toHaveLength(0)
  })

  it('a prepare whose times are no longer free makes no offer and says why', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    deps.checkFree.mockResolvedValueOnce({ known: true, busy: [true, false] })
    expect(await hold.prepare()).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was sent or held') })
    expect(tables.time_offer).toHaveLength(0)
  })
})
