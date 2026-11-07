/**
 * A website's quote form, read (roadmap B1, ../intake.ts): Bright Loom's own
 * fields, a structured items list, money and phone shapes, the honeypot, and
 * what is refused.
 */
import { describe, expect, it } from 'vitest'
import { cleanText, dollarsToCents, parseQuoteForm, readFormBody } from '../intake'
import { quoteSummary } from '../types'

describe("Bright Loom's form", () => {
  it('reads Full Name, Email, Phone Number, the rugs box and the calculator', () => {
    const parsed = parseQuoteForm({
      'Full Name': 'Sarah Lee',
      Email: 'Sarah@Example.com',
      'Phone Number': '(646) 555-0173',
      message: 'Two Persian rugs, one has a wine stain.\r\nPickup next week please.',
      length: '10',
      width: '8',
      estimated_price: '$400.00',
      service: 'cleaning',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.quote).toMatchObject({
      customerName: 'Sarah Lee',
      customerEmail: 'sarah@example.com',
      customerPhone: '+16465550173',
      service: 'cleaning',
      totalCents: 40_000,
      notes: 'Two Persian rugs, one has a wine stain.\nPickup next week please.',
    })
    expect(parsed.quote.items).toEqual([{ description: 'Rug', service: 'cleaning', width: 8, length: 10, unit: 'ft' }])
    expect(quoteSummary({ ...parsed.quote, currency: 'usd' })).toBe('1 item (8x10 ft), cleaning, $400')
  })

  it('takes the call-back form: a number and nothing else', () => {
    const parsed = parseQuoteForm({ phone: '646-555-0173' })
    expect(parsed.ok && parsed.quote).toMatchObject({ customerPhone: '+16465550173', customerEmail: null, items: [], totalCents: null })
  })
})

describe('structured forms', () => {
  it('reads a JSON items list with sizes, services and prices, and sums the price when none is given', () => {
    const parsed = parseQuoteForm({
      name: 'Ann Park',
      email: 'ann@park.io',
      items: JSON.stringify([
        { description: 'Silk runner', width: 2.5, length: 12, unit: 'feet', service: 'repair', price: '150' },
        { description: 'Wool rug', size: '9x12', service: 'cleaning', price: 540, quantity: 2 },
      ]),
      requested_dates: '2026-11-04; 2026-11-05',
      submission_id: 'form-123',
      address: '12 Elm St, Brooklyn',
    })
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    expect(parsed.quote.items).toEqual([
      { description: 'Silk runner', service: 'repair', width: 2.5, length: 12, unit: 'ft', price_cents: 15_000 },
      { description: 'Wool rug', service: 'cleaning', size: '9x12', quantity: 2, price_cents: 54_000 },
    ])
    expect(parsed.quote.totalCents).toBe(15_000 + 2 * 54_000)
    expect(parsed.quote.requestedDates).toEqual(['2026-11-04', '2026-11-05'])
    expect(parsed.quote.externalId).toBe('form-123')
    expect(parsed.quote.address).toBe('12 Elm St, Brooklyn')
  })

  it('joins first and last names and an address in parts', () => {
    const parsed = parseQuoteForm({ first_name: 'Ann', last_name: 'Park', email: 'ann@park.io', street: '12 Elm St', city: 'Brooklyn', zip: '11201' })
    expect(parsed.ok && parsed.quote).toMatchObject({ customerName: 'Ann Park', address: '12 Elm St, Brooklyn, 11201' })
  })

  it('keeps the posted fields for the record, without the honeypot', () => {
    const parsed = parseQuoteForm({ email: 'a@b.co', message: 'hi', website: '' })
    expect(parsed.ok && parsed.quote.raw).toEqual({ email: 'a@b.co', message: 'hi' })
  })
})

describe('what is refused', () => {
  it('a post with no phone and no email: nobody to answer', () => {
    expect(parseQuoteForm({ name: 'Ann', message: 'call me' })).toEqual({ ok: false, reason: 'no_contact' })
    expect(parseQuoteForm({ name: 'Ann', email: 'not-an-email', phone: '12' })).toEqual({ ok: false, reason: 'no_contact' })
  })

  it('a bot that filled the honeypot', () => {
    expect(parseQuoteForm({ email: 'a@b.co', website: 'http://spam.example' })).toEqual({ ok: false, reason: 'bot' })
    expect(parseQuoteForm({ email: 'a@b.co', _gotcha: 'x' })).toEqual({ ok: false, reason: 'bot' })
  })

  it('a body that is not an object', () => {
    expect(parseQuoteForm(null)).toEqual({ ok: false, reason: 'bad_body' })
    expect(parseQuoteForm(['a'])).toEqual({ ok: false, reason: 'bad_body' })
  })
})

describe('cleaning the words', () => {
  it('drops control, zero-width and bidi characters and clips', () => {
    expect(cleanText('a\u0000b\u200bc\u202ed', 50)).toBe('abcd')
    expect(cleanText('x'.repeat(30), 10)).toBe(`${'x'.repeat(9)}…`)
    expect(cleanText('   ', 10)).toBeNull()
    expect(cleanText(42, 10)).toBe('42')
  })

  it('reads money as cents and refuses what is not money', () => {
    expect(dollarsToCents('$1,200')).toBe(120_000)
    expect(dollarsToCents('612.5')).toBe(61_250)
    expect(dollarsToCents(600)).toBe(60_000)
    expect(dollarsToCents('about 600')).toBeNull()
    expect(dollarsToCents(-1)).toBeNull()
    expect(dollarsToCents('9999999999')).toBeNull()
  })
})

describe('reading the body', () => {
  it('reads JSON, form and multipart, and refuses an oversized one', async () => {
    const json = new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@b.co' }) })
    expect(await readFormBody(json)).toEqual({ email: 'a@b.co' })
    const form = new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'email=a%40b.co&name=Ann' })
    expect(await readFormBody(form)).toEqual({ email: 'a@b.co', name: 'Ann' })
    const fd = new FormData()
    fd.set('email', 'a@b.co')
    fd.set('photo', new Blob(['png']), 'rug.png')
    expect(await readFormBody(new Request('http://x', { method: 'POST', body: fd }))).toEqual({ email: 'a@b.co' })
    const big = new Request('http://x', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'x'.repeat(40_000) }) })
    expect(await readFormBody(big)).toBeNull()
    const text = new Request('http://x', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' })
    expect(await readFormBody(text)).toBeNull()
  })
})

describe('submission ids', () => {
  it("only a form's explicit submission id dedupes, never a generic id field", () => {
    expect(parseQuoteForm({ email: 'a@b.co', id: '7' }).ok && (parseQuoteForm({ email: 'a@b.co', id: '7' }) as { quote: { externalId: string | null } }).quote.externalId).toBeNull()
    const explicit = parseQuoteForm({ email: 'a@b.co', submission_id: 'form-7' })
    expect(explicit.ok && explicit.quote.externalId).toBe('form-7')
  })
})
