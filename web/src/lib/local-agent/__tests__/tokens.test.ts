import { createHmac } from 'crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MODEL_TOKEN_MAX,
  MODEL_TOKEN_TTL_SECONDS,
  modelTokenSecret,
  signModelToken,
  verifyModelToken,
} from '../tokens'
import { __resetInternalSecretLogForTests } from '@/lib/eve/internal-secret'

const claims = { sid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', uid: 'u1', wid: 'w1' }

describe('local agent model tokens', () => {
  const env = { ...process.env }
  beforeEach(() => {
    __resetInternalSecretLogForTests()
    vi.spyOn(console, 'info').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    process.env.LOCAL_AGENT_TOKEN_SECRET = 'dedicated-secret-for-tests'
    process.env.RUN_SKILL_INTERNAL_SECRET = 'root-secret-for-tests'
  })
  afterEach(() => {
    process.env = { ...env }
    vi.restoreAllMocks()
  })

  it('signs and verifies, with a 2 h expiry', () => {
    const now = Date.parse('2026-10-20T22:00:00Z')
    const { token, expiresAt } = signModelToken(claims, { now })
    expect(token.startsWith('la1.')).toBe(true)
    expect(token.length).toBeLessThan(MODEL_TOKEN_MAX)
    expect(Date.parse(expiresAt) - now).toBe(MODEL_TOKEN_TTL_SECONDS * 1000)
    const v = verifyModelToken(token, { now: now + 60_000 })
    expect(v).toEqual({ ok: true, claims: { ...claims, exp: Math.floor(now / 1000) + MODEL_TOKEN_TTL_SECONDS } })
  })

  it('carries the ChatGPT plan flag as `cp` only when set, and verifies it back', () => {
    const now = Date.parse('2026-10-20T22:00:00Z')
    const plain = signModelToken(claims, { now }).token
    const onPlan = signModelToken({ ...claims, plan: true }, { now }).token
    const payload = (t: string) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString('utf8'))
    expect(payload(plain)).not.toHaveProperty('cp')
    expect(signModelToken({ ...claims, plan: false }, { now }).token).toBe(plain)
    expect(payload(onPlan).cp).toBe(true)
    expect(verifyModelToken(plain, { now })).toEqual({ ok: true, claims: { ...claims, exp: Math.floor(now / 1000) + MODEL_TOKEN_TTL_SECONDS } })
    expect(verifyModelToken(onPlan, { now })).toEqual({ ok: true, claims: { ...claims, plan: true, exp: Math.floor(now / 1000) + MODEL_TOKEN_TTL_SECONDS } })
  })

  it('never trusts a `cp` added to a signed token', () => {
    const { token } = signModelToken(claims)
    const [p, body, sig] = token.split('.')
    const withPlan = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), cp: true })).toString('base64url')
    expect(verifyModelToken(`${p}.${withPlan}.${sig}`)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses an expired token', () => {
    const now = Date.parse('2026-10-20T22:00:00Z')
    const { token } = signModelToken(claims, { now })
    expect(verifyModelToken(token, { now: now + MODEL_TOKEN_TTL_SECONDS * 1000 })).toEqual({ ok: false, reason: 'expired' })
    expect(verifyModelToken(token, { now: now + MODEL_TOKEN_TTL_SECONDS * 1000 - 1000 }).ok).toBe(true)
  })

  it('refuses a tampered payload or a token signed with another key', () => {
    const { token } = signModelToken(claims)
    const [p, body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...claims, uid: 'someone-else', exp: 9_999_999_999 })).toString('base64url')
    expect(verifyModelToken(`${p}.${forged}.${sig}`)).toEqual({ ok: false, reason: 'signature' })
    process.env.LOCAL_AGENT_TOKEN_SECRET = 'a-different-secret'
    expect(verifyModelToken(`${p}.${body}.${sig}`)).toEqual({ ok: false, reason: 'signature' })
  })

  it('refuses malformed tokens', () => {
    expect(verifyModelToken(undefined)).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyModelToken('eyJhbGciOi.x.y')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyModelToken('la1.only-two')).toEqual({ ok: false, reason: 'malformed' })
    expect(verifyModelToken(`la1.${'a'.repeat(MODEL_TOKEN_MAX)}.b`)).toEqual({ ok: false, reason: 'malformed' })
  })

  it('MACs a domain prefix: a bare-payload HMAC (another family) never verifies', () => {
    const { token } = signModelToken(claims)
    const [p, body] = token.split('.')
    const bare = createHmac('sha256', 'dedicated-secret-for-tests').update(body).digest('base64url')
    expect(verifyModelToken(`${p}.${body}.${bare}`)).toEqual({ ok: false, reason: 'signature' })
  })

  it('falls back to RUN_SKILL_INTERNAL_SECRET when the dedicated secret is unset or empty, and logs the source', () => {
    process.env.LOCAL_AGENT_TOKEN_SECRET = ''
    expect(modelTokenSecret()).toBe('root-secret-for-tests')
    const warn = console.warn as unknown as ReturnType<typeof vi.fn>
    expect(warn.mock.calls.flat().join(' ')).toContain('"secretSource":"fallback"')
    expect(warn.mock.calls.flat().join(' ')).not.toContain('root-secret-for-tests')
    const { token } = signModelToken(claims)
    expect(verifyModelToken(token).ok).toBe(true)
  })

  it('logs its source like every family, and a value shared with another internal secret is named (never shown)', () => {
    process.env.CHAT_INTERNAL_SECRET = 'dedicated-secret-for-tests'
    expect(modelTokenSecret()).toBe('dedicated-secret-for-tests')
    const warn = (console.warn as unknown as ReturnType<typeof vi.fn>).mock.calls.flat().join(' ')
    expect(warn).toContain('"family":"local-agent"')
    expect(warn).toContain('"secretSource":"shared"')
    expect(warn).toContain('"sharedWith":["CHAT_INTERNAL_SECRET"]')
    expect(warn).not.toContain('dedicated-secret-for-tests')
  })

  it('is unconfigured with neither secret', () => {
    delete process.env.LOCAL_AGENT_TOKEN_SECRET
    delete process.env.RUN_SKILL_INTERNAL_SECRET
    expect(modelTokenSecret()).toBeNull()
    expect(() => signModelToken(claims)).toThrow(/not configured/)
    expect(verifyModelToken('la1.a.b')).toEqual({ ok: false, reason: 'unconfigured' })
  })
})
