/**
 * Making a time offer (src/lib/time-offers/offers.ts): the request read in
 * the host's zone and checked; each time checked free right now (strict:
 * unknown refuses); each held on the host's time, an overlap with any other
 * claim refused; the link's token stored only as its hash; the CRM contact
 * linked, none made; an offer for a card reused when the same card is asked
 * again; withdrawing lets the times go.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { closeOffer, createOffer, normalizeOfferRequest, planOffer, withdrawOffer, type OfferRequest } from '../offers'
import { offerTokenHash } from '../tokens'
import { freeCalendar, hoursFromNow, HOST, HOST_NAME, offerDb, WS, ZONE } from './fake-db'

const NOW = Date.now()
const SLOTS = [hoursFromNow(26, NOW), hoursFromNow(50, NOW), hoursFromNow(74, NOW)]

const request = (over: Partial<OfferRequest> = {}): OfferRequest => ({
  workspaceId: WS,
  hostUserId: HOST,
  recipient: { name: 'Dana Reyes', email: 'Dana@Initech.example' },
  title: 'Intro call',
  slots: SLOTS,
  durationMinutes: 30,
  sendBy: 'link',
  ...over,
})

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('normalizeOfferRequest', () => {
  const ctx = { timeZone: ZONE, hostName: HOST_NAME, now: NOW }

  it('reads the times, sorted, each with its end; the email lower-cased; a default expiry of 3 days on the hour, never past the first time', () => {
    const planned = normalizeOfferRequest(request({ slots: [SLOTS[2], SLOTS[0]] }), ctx)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    expect(planned.plan.slots).toEqual([
      { startsAt: SLOTS[0], endsAt: new Date(Date.parse(SLOTS[0]) + 30 * 60_000).toISOString() },
      { startsAt: SLOTS[2], endsAt: new Date(Date.parse(SLOTS[2]) + 30 * 60_000).toISOString() },
    ])
    expect(planned.plan.recipient).toEqual({ name: 'Dana Reyes', email: 'dana@initech.example', phone: null })
    // The first time starts in about a day: the offer closes then.
    expect(planned.plan.expiresAt).toBe(SLOTS[0])
    expect(planned.plan.video).toBe(true)
    const far = normalizeOfferRequest(request({ slots: [hoursFromNow(100, NOW), hoursFromNow(120, NOW)] }), ctx)
    expect(far.ok && Date.parse(far.plan.expiresAt) % 3_600_000).toBe(0)
    expect(far.ok && Date.parse(far.plan.expiresAt) <= NOW + 3 * 24 * 3_600_000).toBe(true)
  })

  it('reads a wall-clock time in the host zone', () => {
    const day = new Date(NOW + 5 * 24 * 3_600_000).toISOString().slice(0, 10)
    const planned = normalizeOfferRequest(request({ slots: [`${day}T10:00`, `${day}T14:00`] }), ctx)
    expect(planned.ok).toBe(true)
    if (!planned.ok) return
    const hour = new Intl.DateTimeFormat('en-US', { timeZone: ZONE, hour: 'numeric', hourCycle: 'h23' }).format(new Date(planned.plan.slots[0].startsAt))
    expect(hour).toBe('10')
  })

  it('refuses what it cannot offer: one time, four, a past or overlapping time, no name, a bad email or phone, a link in the words, email without an email', () => {
    const cases: Array<[Partial<OfferRequest>, string]> = [
      [{ slots: [SLOTS[0]] }, 'BAD_INPUT'],
      [{ slots: [...SLOTS, hoursFromNow(98, NOW)] }, 'BAD_INPUT'],
      [{ slots: [new Date(NOW - 3_600_000).toISOString(), SLOTS[1]] }, 'PAST'],
      [{ slots: [SLOTS[0], new Date(Date.parse(SLOTS[0]) + 10 * 60_000).toISOString()] }, 'OVERLAP'],
      [{ slots: [hoursFromNow(24 * 70, NOW), SLOTS[0]] }, 'TOO_FAR'],
      [{ slots: ['2026-12-01', SLOTS[0]] }, 'BAD_INPUT'],
      [{ recipient: { name: '  ' } }, 'BAD_INPUT'],
      [{ recipient: { name: 'Dana', email: 'not-an-email' } }, 'BAD_INPUT'],
      [{ recipient: { name: 'Dana', phone: '12' } }, 'BAD_INPUT'],
      [{ message: 'see https://evil.example/x' }, 'HAS_LINK'],
      [{ title: 'Call www.example.com' }, 'HAS_LINK'],
      [{ sendBy: 'email', recipient: { name: 'Dana' } }, 'NEEDS_EMAIL'],
      [{ sendBy: 'text', recipient: { name: 'Dana', email: 'dana@initech.example' } }, 'NEEDS_PHONE'],
      [{ durationMinutes: 2 }, 'BAD_INPUT'],
    ]
    for (const [over, code] of cases) {
      const planned = normalizeOfferRequest(request(over), ctx)
      expect(planned.ok ? 'ok' : planned.code, JSON.stringify(over)).toBe(code)
    }
  })
})

describe('createOffer', () => {
  async function made(db = offerDb(), deps = freeCalendar()) {
    const planned = await planOffer(db.db, request(), { ...deps, now: () => NOW })
    if (!planned.ok) throw new Error(planned.message)
    return { ...db, deps, plan: planned.plan, result: await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, { ...deps, now: () => NOW }) }
  }

  it('checks the times free, writes the offer and holds every time on the host; only the token hash is stored', async () => {
    const { tables, deps, result } = await made()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(deps.checkFree).toHaveBeenCalledWith(expect.objectContaining({ userId: HOST, workspaceId: WS, timeZone: ZONE }))
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const row = tables.time_offer[0]
    expect(row).toMatchObject({ state: 'open', host_name: HOST_NAME, recipient_email: 'dana@initech.example', sent_via: 'link', token_hash: offerTokenHash(result.token!) })
    expect(JSON.stringify(tables)).not.toContain(result.token!)
    expect(tables.time_offer_slot).toHaveLength(3)
    expect(tables.host_time_claim.map((c) => [c.kind, c.claim_key, c.starts_at, c.expires_at])).toEqual(
      SLOTS.map((s) => ['hold', row.id, s, row.expires_at]),
    )
  })

  it('refuses when the calendar is unknown, a time is busy, or there is no calendar to book on, and holds nothing', async () => {
    const unknown = freeCalendar()
    unknown.checkFree.mockResolvedValueOnce({ known: false, reason: 'a calendar account needs signing in again' } as never)
    const a = await made(offerDb(), unknown)
    expect(a.result).toMatchObject({ ok: false, code: 'CALENDAR_UNKNOWN' })
    expect(a.tables.host_time_claim).toHaveLength(0)

    const busy = freeCalendar()
    busy.checkFree.mockResolvedValueOnce({ known: true, busy: [false, true, false] })
    const b = await made(offerDb(), busy)
    expect(b.result).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(b.tables.time_offer).toHaveLength(0)

    const none = freeCalendar()
    none.calendarAccount.mockResolvedValueOnce(null as never)
    expect((await made(offerDb(), none)).result).toMatchObject({ ok: false, code: 'NO_CALENDAR' })
  })

  it('an overlap with another claim of the host refuses the whole offer (the exclusion constraint), and nothing of it stays', async () => {
    const db = offerDb({
      host_time_claim: [{ id: 'c-other', workspace_id: WS, host_user_id: HOST, starts_at: SLOTS[1], ends_at: new Date(Date.parse(SLOTS[1]) + 60 * 60_000).toISOString(), kind: 'booking', claim_key: 'b-other', booking_id: 'b-other' }],
    })
    const { tables, result } = await made(db)
    expect(result).toMatchObject({ ok: false, code: 'SLOT_TAKEN' })
    expect(tables.time_offer).toHaveLength(0)
    expect(tables.time_offer_slot).toHaveLength(0)
    expect(tables.host_time_claim.map((c) => c.id)).toEqual(['c-other'])
  })

  it('an expired hold never blocks: it is deleted before the insert', async () => {
    const db = offerDb({
      host_time_claim: [{ id: 'c-old', workspace_id: WS, host_user_id: HOST, starts_at: SLOTS[0], ends_at: SLOTS[1], kind: 'hold', claim_key: 'o-old', offer_id: 'o-old', slot_id: 's-old', expires_at: new Date(NOW - 60_000).toISOString() }],
    })
    const { tables, result } = await made(db)
    expect(result.ok).toBe(true)
    expect(tables.host_time_claim.some((c) => c.id === 'c-old')).toBe(false)
  })

  it("links the CRM contact the email matches, and never makes one", async () => {
    const deps = freeCalendar()
    deps.findContact.mockResolvedValueOnce({ id: 'contact-dana' } as never)
    const { tables, result } = await made(offerDb(), deps)
    expect(result.ok).toBe(true)
    expect(tables.time_offer[0].contact_id).toBe('contact-dana')
    expect(deps.findContact).toHaveBeenCalledWith(WS, { email: 'dana@initech.example', phone: null })
    expect(tables.contact).toBeUndefined()
  })

  it("an offer for a card gets no token, and the same card asked again gets its offer back (its times held once)", async () => {
    const db = offerDb()
    const deps = freeCalendar()
    const planned = await planOffer(db.db, request({ sendBy: 'email' }), { ...deps, now: () => NOW })
    if (!planned.ok) throw new Error(planned.message)
    const first = await createOffer(db.db, planned.plan, { state: 'pending_send', createdBy: HOST, cardHash: 'hash-1' }, { ...deps, now: () => NOW })
    const again = await createOffer(db.db, planned.plan, { state: 'pending_send', createdBy: HOST, cardHash: 'hash-1' }, { ...deps, now: () => NOW })
    expect(first).toMatchObject({ ok: true, token: null })
    expect(again).toMatchObject({ ok: true, reused: true })
    expect(first.ok && again.ok && again.offer.id === first.offer.id).toBe(true)
    expect(db.tables.time_offer).toHaveLength(1)
    expect(db.tables.time_offer[0]).toMatchObject({ state: 'pending_send', token_hash: null, card_hash: 'hash-1' })
    expect(db.tables.host_time_claim).toHaveLength(3)
  })

  it('caps the live offers one host may hold', async () => {
    const live = Array.from({ length: 20 }, (_, i) => ({ id: `o-${i}`, workspace_id: WS, host_user_id: HOST, state: 'open', expires_at: new Date(NOW + 3_600_000).toISOString() }))
    const { result } = await made(offerDb({ time_offer: live }))
    expect(result).toMatchObject({ ok: false, code: 'TOO_MANY_OFFERS' })
  })
})

describe('withdrawOffer and closeOffer', () => {
  it('the host takes it back: withdrawn, holds gone, slots released; anyone else is told there is no such offer', async () => {
    const db = offerDb()
    const deps = freeCalendar()
    const planned = await planOffer(db.db, request(), { ...deps, now: () => NOW })
    if (!planned.ok) throw new Error(planned.message)
    const made = await createOffer(db.db, planned.plan, { state: 'open', createdBy: HOST }, { ...deps, now: () => NOW })
    if (!made.ok) throw new Error(made.message)
    expect(await withdrawOffer(db.db, { workspaceId: WS, userId: 'user-someone-else', offerId: made.offer.id })).toMatchObject({ ok: false, code: 'NOT_FOUND' })
    const out = await withdrawOffer(db.db, { workspaceId: WS, userId: HOST, offerId: made.offer.id })
    expect(out).toMatchObject({ ok: true, offer: { state: 'withdrawn' } })
    expect(db.tables.host_time_claim).toHaveLength(0)
    expect(db.tables.time_offer_slot.every((s) => s.state === 'released')).toBe(true)
    expect(await withdrawOffer(db.db, { workspaceId: WS, userId: HOST, offerId: made.offer.id })).toMatchObject({ ok: false, code: 'CLOSED' })
    // A second close finds nothing to move.
    expect(await closeOffer(db.db, made.offer.id, ['open'], 'expired')).toBeNull()
  })
})
