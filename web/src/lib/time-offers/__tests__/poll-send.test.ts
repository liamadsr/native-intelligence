/**
 * A poll's offer_times and nudge_time_offer (src/lib/time-offers/poll-send.ts):
 * by link nothing is sent and each guest's own link comes back with words to
 * paste; by email or text only as the replay of the person's card, which
 * names every guest with their address and shows the exact words (the same
 * for each but their link), pinned by hash; a card too long to show it all
 * is refused; a reminder goes only to guests still to answer, and its card
 * changes when one answers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApprovedCall } from '@/lib/safety/approved-call'
import { runNudge } from '../poll-send'
import { recordAnswer } from '../polls'
import { runOfferTimes, timeOfferHold, type SendDeps } from '../send'
import { offerTokenHash, pollTokenFor } from '../tokens'
import { OFFER_CARD_WHY_MAX } from '../words'
import { bookingSeams, freeCalendar, hoursFromNow, HOST, offerDb, WS } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW), hoursFromNow(74, NOW)]
const INPUT = {
  recipients: [
    { name: 'Dana Reyes', email: 'dana@initech.example', phone: '+13125550142' },
    { name: 'Sam Ortiz', email: 'sam@globex.example', phone: '+13125550143' },
  ],
  title: 'Planning',
  slots: SLOTS,
  duration_minutes: 30,
}

function seams<T extends Partial<SendDeps>>(over: T = {} as T) {
  const cal = freeCalendar()
  return {
    ...cal,
    origin: 'https://app.example',
    secret: 'test-secret',
    linkedGrant: vi.fn(async () => null),
    optedOut: vi.fn(async () => false),
    businessNumber: vi.fn(async (): Promise<{ phone: string } | null> => ({ phone: '+13125550100' })),
    sendEmail: vi.fn(async () => ({ id: 'm-1' }) as never),
    sendText: vi.fn(async () => true),
    ...over,
  }
}

const args = { userId: HOST, workspaceId: WS }

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('offer_times with several recipients, by link', () => {
  it('makes one poll and gives each guest their own link and words to paste; nothing is sent', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const out = await runOfferTimes(db, args, INPUT, deps)
    expect(out).toMatchObject({ success: true, mode: 'poll', state: 'open', sent_via: 'link' })
    const guests = out.guests as Array<{ guest_id: string; name: string; link: string; paste_text: string; answered: boolean }>
    expect(guests.map((g) => g.name)).toEqual(['Dana Reyes', 'Sam Ortiz'])
    for (const g of guests) {
      expect(g.link).toBe(`https://app.example/t/${pollTokenFor(g.guest_id, 'test-secret')}`)
      expect(g.paste_text).toContain('Which of these times work for you (E')
      expect(g.paste_text).toContain(g.link)
      expect(g.answered).toBe(false)
    }
    expect(tables.time_offer_recipient.map((r) => r.token_hash)).toEqual(guests.map((g) => offerTokenHash(pollTokenFor(g.guest_id, 'test-secret'))))
    expect(deps.sendEmail).not.toHaveBeenCalled()
    expect(deps.sendText).not.toHaveBeenCalled()
  })

  it('one recipient without co-hosts is a single offer, exactly as before', async () => {
    const { db, tables } = offerDb()
    const out = await runOfferTimes(db, args, { ...INPUT, recipients: [INPUT.recipients[0]], slots: SLOTS.slice(0, 2) }, seams())
    expect(out).toMatchObject({ success: true, sent_via: 'link', recipient_name: 'Dana Reyes' })
    expect(out.mode).toBeUndefined()
    expect(tables.time_offer[0].mode).toBeUndefined()
    expect(tables.time_offer_recipient).toHaveLength(0)
  })

  it('refuses a call naming both recipient and recipients, or neither', async () => {
    const { db } = offerDb()
    expect(await runOfferTimes(db, args, { ...INPUT, recipient: INPUT.recipients[0] }, seams())).toMatchObject({ success: false, code: 'BAD_INPUT' })
    expect(await runOfferTimes(db, args, { ...INPUT, recipients: undefined }, seams())).toMatchObject({ success: false, code: 'BAD_INPUT' })
  })
})

describe('offer_times with several recipients, by email or text', () => {
  it('in the turn it sends nothing: the card names every guest and their address, and the exact words', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    expect(await runOfferTimes(db, args, { ...INPUT, send_by: 'email' }, deps)).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    expect(tables.time_offer).toHaveLength(0)
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    expect(hold.card.title).toBe('Email Dana Reyes (dana@initech.example), Sam Ortiz (sam@globex.example) times to meet?')
    expect(hold.card.why).toContain('From your mailbox, each with their own link, subject “Planning: which times work?”')
    expect(hold.card.why).toContain('https://app.example/t/…')
    expect(hold.card.why.length).toBeLessThanOrEqual(OFFER_CARD_WHY_MAX)
    const text = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'text' } }, deps))!
    expect(text.card.title).toBe('Text Dana Reyes (+1 312-555-0142), Sam Ortiz (+1 312-555-0143) times to meet?')
    expect(text.card.why).toContain('From the business number +1 312-555-0100, each with their own link')
  })

  it('the replay of its card makes the poll live and sends each guest their own link; a changed card sends nothing', async () => {
    const { db, tables } = offerDb()
    const deps = seams()
    const hold = (await timeOfferHold(db, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    expect(tables.time_offer[0]).toMatchObject({ state: 'pending_send', mode: 'poll' })
    expect(tables.time_offer_recipient.every((r) => r.token_hash == null)).toBe(true)
    const approvedCall = { tool: 'offer_times', timeOffer: prepared.context.timeOffer } as ApprovedCall
    const out = await runOfferTimes(db, { ...args, approvedCall }, { ...INPUT, send_by: 'email' }, deps)
    expect(out).toMatchObject({ success: true, mode: 'poll', sent_via: 'email' })
    expect(tables.time_offer[0]).toMatchObject({ state: 'open', sent_via: 'email' })
    expect(deps.sendEmail).toHaveBeenCalledTimes(2)
    const ids = tables.time_offer_recipient.map((r) => String(r.id))
    const bodies = deps.sendEmail.mock.calls.map((c) => (c as unknown as [string, string, { to: string[]; body_text: string }])[2])
    expect(bodies.map((b) => b.to[0])).toEqual(['dana@initech.example', 'sam@globex.example'])
    bodies.forEach((b, i) => expect(b.body_text).toContain(`https://app.example/t/${pollTokenFor(ids[i], 'test-secret')}`))

    // Another card's replay: its poll was made with other words.
    const { db: db2, tables: tables2 } = offerDb()
    const hold2 = (await timeOfferHold(db2, { ...args, input: { ...INPUT, send_by: 'email' } }, deps))!
    const prepared2 = await hold2.prepare()
    if (!prepared2.ok) throw new Error(prepared2.message)
    const forged = { tool: 'offer_times', timeOffer: { ...prepared2.context.timeOffer, card_hash: 'other' } } as ApprovedCall
    expect(await runOfferTimes(db2, { ...args, approvedCall: forged }, { ...INPUT, send_by: 'email' }, deps)).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    expect(tables2.time_offer[0].state).toBe('withdrawn')
  })

  it('a card too long to show every guest and every word is refused: by link, or fewer', async () => {
    const { db } = offerDb()
    const many = Array.from({ length: 8 }, (_, i) => ({ name: `Guest Number ${i + 1}`, email: `guest.number.${i + 1}@long-company-name.example` }))
    expect(await runOfferTimes(db, args, { ...INPUT, recipients: many, send_by: 'email' }, seams())).toMatchObject({ success: false, code: 'CARD_TOO_LONG' })
    expect(await timeOfferHold(db, { ...args, input: { ...INPUT, recipients: many, send_by: 'email' } }, seams())).toBeNull()
    // Four guests and six times on the real address fit, by email and by text.
    const four = [...INPUT.recipients, { name: 'Ira Chen', email: 'ira@hooli.example', phone: '+13125550144' }, { name: 'Mo Diaz', email: 'mo@umbrella.example', phone: '+13125550145' }]
    const six = [26, 30, 50, 54, 74, 78].map((h) => hoursFromNow(h, NOW))
    for (const send_by of ['email', 'text'] as const) {
      const hold = await timeOfferHold(db, { ...args, input: { ...INPUT, recipients: four, slots: six, send_by } }, seams({ origin: 'https://nativeintelligence.dev' }))
      expect(hold, send_by).not.toBeNull()
      expect(hold!.card.why.length).toBeLessThanOrEqual(OFFER_CARD_WHY_MAX)
    }
  })
})

describe('nudge_time_offer', () => {
  async function poll() {
    const db = offerDb()
    const deps = seams()
    const out = await runOfferTimes(db.db, args, INPUT, deps)
    const offerId = String(out.offer_id)
    const tokens = (out.guests as Array<{ guest_id: string }>).map((g) => pollTokenFor(g.guest_id, 'test-secret'))
    return { ...db, deps, offerId, tokens }
  }

  it('by link: each guest still to answer comes back with their link and a reminder; nothing is sent; not again within 12 hours', async () => {
    const { db, deps, offerId, tokens } = await poll()
    await recordAnswer(db, { ref: { token: tokens[0] }, works: [SLOTS[0]], via: 'link' }, { ...bookingSeams(), checkFree: deps.checkFree, calendarAccount: deps.calendarAccount })
    const out = await runNudge(db, args, { offer_id: offerId }, deps)
    expect(out).toMatchObject({ success: true, sent_via: 'link' })
    const guests = out.guests as Array<{ name: string; paste_text: string; link: string }>
    expect(guests.map((g) => g.name)).toEqual(['Sam Ortiz'])
    expect(guests[0].paste_text).toContain('A quick reminder')
    expect(guests[0].paste_text).toContain(guests[0].link)
    expect(deps.sendEmail).not.toHaveBeenCalled()
    expect(await runNudge(db, args, { offer_id: offerId }, deps)).toMatchObject({ success: false, code: 'NOTHING_TO_SEND' })
  })

  it('by email: only as its card\'s replay, to the guests the card named; one who answered since changes the card', async () => {
    const { db, tables, deps, offerId, tokens } = await poll()
    expect(await runNudge(db, args, { offer_id: offerId, send_by: 'email' }, deps)).toMatchObject({ success: false, code: 'APPROVAL_REQUIRED' })
    const hold = (await timeOfferHold(db, { ...args, input: { offer_id: offerId, send_by: 'email' }, toolName: 'nudge_time_offer' }, deps))!
    expect(hold.card.title).toBe('Email Dana Reyes (dana@initech.example), Sam Ortiz (sam@globex.example) a reminder about the times?')
    const prepared = await hold.prepare()
    if (!prepared.ok) throw new Error(prepared.message)
    const approvedCall = { tool: 'nudge_time_offer', timeOffer: prepared.context.timeOffer } as ApprovedCall
    await recordAnswer(db, { ref: { token: tokens[1] }, works: [SLOTS[0]], via: 'link' }, { ...bookingSeams(), checkFree: deps.checkFree, calendarAccount: deps.calendarAccount })
    expect(await runNudge(db, { ...args, approvedCall }, { offer_id: offerId, send_by: 'email' }, deps)).toMatchObject({ success: false, code: 'CARD_CHANGED' })
    expect(deps.sendEmail).not.toHaveBeenCalled()
    const fresh = (await timeOfferHold(db, { ...args, input: { offer_id: offerId, send_by: 'email' }, toolName: 'nudge_time_offer' }, deps))!
    const ready = await fresh.prepare()
    if (!ready.ok) throw new Error(ready.message)
    const out = await runNudge(db, { ...args, approvedCall: { tool: 'nudge_time_offer', timeOffer: ready.context.timeOffer } as ApprovedCall }, { offer_id: offerId, send_by: 'email' }, deps)
    expect(out).toMatchObject({ success: true, sent_via: 'email', guests: [{ name: 'Dana Reyes' }] })
    expect(deps.sendEmail).toHaveBeenCalledTimes(1)
    expect(tables.time_offer_recipient[0]).toMatchObject({ nudges: 1 })
  })

  it('only the host\'s own open poll', async () => {
    const { db, deps, offerId } = await poll()
    expect(await runNudge(db, { ...args, userId: 'user-other' }, { offer_id: offerId }, deps)).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })
})
