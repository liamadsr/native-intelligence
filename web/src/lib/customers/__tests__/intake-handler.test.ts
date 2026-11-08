/**
 * POST /api/intake/quotes/<key> (roadmap B1, ../intake-handler.ts): the key,
 * the origin, the hourly cap, the body, then the quote received; and the
 * CORS answers a browser form needs.
 */
import { describe, expect, it, vi } from 'vitest'
import { QUOTE_INTAKE_HOURLY_CAP, corsHeaders, handleQuoteIntake, safeRedirect, type QuoteIntakeDeps } from '../intake-handler'
import { cleanOrigins, generateIntakeKey, hashIntakeKey, isIntakeKeyShape } from '../intake-key'
import type { IntakeKey } from '../intake-key'

const KEY = generateIntakeKey()
const LIVE: IntakeKey = { id: 'k1', workspaceId: 'ws-rug', createdBy: 'user-owner', allowedOrigins: [] }

function deps(over: Partial<QuoteIntakeDeps> = {}) {
  const receive = vi.fn<QuoteIntakeDeps['receive']>(async (_args, quote) => ({
    ok: true,
    created: true,
    contactId: 'c-1',
    quote: { id: 'q-1', workspaceId: 'ws-rug', contactId: 'c-1', source: 'web_form', externalId: null, status: 'new', customerName: quote.customerName, customerEmail: quote.customerEmail, customerPhone: quote.customerPhone, address: null, service: null, items: [], totalCents: null, currency: 'usd', requestedDates: [], notes: null, createdAt: '', updatedAt: '' },
  }))
  const d: QuoteIntakeDeps = {
    findKey: vi.fn(async (k) => (k === KEY ? LIVE : null)),
    ownerOf: vi.fn(async () => 'user-owner'),
    countSince: vi.fn(async () => 0),
    receive,
    touchKey: vi.fn(async () => {}),
    ...over,
  }
  return { d, receive }
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request('https://dial8.ai/api/intake/quotes/x', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
}

describe('the key', () => {
  it('a wrong or malformed key is 404 and reads nothing', async () => {
    const { d, receive } = deps()
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }), 'qk_wrong', d)).status).toBe(404)
    expect(receive).not.toHaveBeenCalled()
  })

  it('keys are qk_ plus 43 base64url characters, stored only as their SHA-256', () => {
    expect(isIntakeKeyShape(KEY)).toBe(true)
    expect(isIntakeKeyShape('qk_short')).toBe(false)
    expect(hashIntakeKey(KEY)).toMatch(/^[0-9a-f]{64}$/)
    expect(hashIntakeKey(KEY)).not.toContain(KEY.slice(3))
  })
})

describe('a quote post', () => {
  it('stores it (201) and answers its id, nothing of the business', async () => {
    const { d, receive } = deps()
    const res = await handleQuoteIntake(post({ name: 'Sarah', email: 'sarah@example.com' }), KEY, d)
    expect(res.status).toBe(201)
    expect(await res.json()).toEqual({ ok: true, quote_id: 'q-1' })
    expect(receive).toHaveBeenCalledWith({ workspaceId: 'ws-rug', ownerUserId: 'user-owner' }, expect.objectContaining({ customerName: 'Sarah', customerEmail: 'sarah@example.com' }))
    expect(d.touchKey).toHaveBeenCalledWith('k1')
  })

  it('a re-posted submission is 200', async () => {
    const { d } = deps({ receive: async () => ({ ok: true, created: false, contactId: null, quote: { id: 'q-1' } as never }) })
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }), KEY, d)).status).toBe(200)
  })

  it('no phone and no email is 400; a honeypot hit is answered 200 and stores nothing', async () => {
    const { d, receive } = deps()
    expect((await handleQuoteIntake(post({ name: 'Sarah' }), KEY, d)).status).toBe(400)
    const bot = await handleQuoteIntake(post({ email: 'a@b.co', website: 'spam' }), KEY, d)
    expect(bot.status).toBe(200)
    expect(receive).not.toHaveBeenCalled()
  })

  it('past the hourly cap: 429, nothing stored', async () => {
    const { d, receive } = deps({ countSince: async () => QUOTE_INTAKE_HOURLY_CAP })
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }), KEY, d)).status).toBe(429)
    expect(receive).not.toHaveBeenCalled()
  })

  it('a key with no owner to hear it, or a failed store, is 500', async () => {
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }), KEY, deps({ ownerOf: async () => null }).d)).status).toBe(500)
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }), KEY, deps({ receive: async () => ({ ok: false, error: 'down' }) }).d)).status).toBe(500)
  })
})

describe('origins', () => {
  const listed = { ...LIVE, allowedOrigins: ['https://brightweave.com'] }

  it('with origins listed, another site is refused and the listed one gets its CORS answer', async () => {
    const { d } = deps({ findKey: async () => listed })
    expect((await handleQuoteIntake(post({ email: 'a@b.co' }, { origin: 'https://evil.example' }), KEY, d)).status).toBe(403)
    const ok = await handleQuoteIntake(post({ email: 'a@b.co' }, { origin: 'https://brightweave.com' }), KEY, d)
    expect(ok.status).toBe(201)
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://brightweave.com')
  })

  it('with none listed, any site may post (the key is the gate)', async () => {
    const res = await handleQuoteIntake(post({ email: 'a@b.co' }, { origin: 'https://anywhere.example' }), KEY, deps().d)
    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
  })

  it("a plain form's _redirect goes only to a listed origin's page", async () => {
    const { d } = deps({ findKey: async () => listed })
    const res = await handleQuoteIntake(post({ email: 'a@b.co', _redirect: 'https://brightweave.com/thanks' }), KEY, d)
    expect(res.status).toBe(303)
    expect(res.headers.get('location')).toBe('https://brightweave.com/thanks')
    expect(safeRedirect('https://evil.example/x', listed)).toBeNull()
    expect(safeRedirect('https://brightweave.com/x', LIVE)).toBeNull()
  })

  it('cleans stored origins to https origins (localhost may be http)', () => {
    expect(cleanOrigins(['https://BrightWeave.com/quote', 'http://brightweave.com', 'http://localhost:3000', 'nope', 7])).toEqual(['https://brightweave.com', 'http://localhost:3000'])
    expect(corsHeaders(null, LIVE)).toEqual({ Vary: 'Origin' })
  })
})

describe("the website flow's live check (roadmap track E)", () => {
  const form = (fields: Record<string, string>, origin = 'https://janescleaning.com') =>
    new Request('https://dial8.ai/api/intake/quotes/x', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin }, body: new URLSearchParams(fields).toString() })
  const test = { name: 'Native Intelligence website check', email: 'website-check@dial8.ai', message: 'A test', _dial8_test: 'n'.repeat(24) }

  it("a post carrying a pending check's nonce is the check: answered as a test, never stored as a quote", async () => {
    const takeTest = vi.fn(async () => true)
    const { d, receive } = deps({ takeTest })
    const res = await handleQuoteIntake(form(test), KEY, d)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, test: true })
    expect(takeTest).toHaveBeenCalledWith('ws-rug', 'n'.repeat(24))
    expect(receive).not.toHaveBeenCalled()
  })

  it('it went through the origin check first, like a customer’s post', async () => {
    const takeTest = vi.fn(async () => true)
    const { d } = deps({ takeTest, findKey: vi.fn(async () => ({ ...LIVE, allowedOrigins: ['https://janescleaning.com'] })) })
    expect((await handleQuoteIntake(form(test, 'https://elsewhere.com'), KEY, d)).status).toBe(403)
    expect(takeTest).not.toHaveBeenCalled()
  })

  it('a nonce that is no check goes on as an ordinary post', async () => {
    const { d, receive } = deps({ takeTest: vi.fn(async () => false) })
    expect((await handleQuoteIntake(form(test), KEY, d)).status).toBe(201)
    expect(receive).toHaveBeenCalledOnce()
  })
})
