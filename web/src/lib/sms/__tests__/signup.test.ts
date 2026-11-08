import { describe, expect, it, vi } from 'vitest'
import {
  DEAD_CODE_REPLY,
  SIGNUP_ACCOUNTS_PER_DAY,
  SIGNUP_CODES_PER_DAY,
  SIGNUP_CODES_PER_HOUR,
  SIGNUP_CODES_PER_WINDOW,
  SIGNUP_CODES_WINDOW_MS,
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_TTL_MS,
  SIGNUP_FAILED_REPLY,
  SIGNUP_WRONG_CODES_PER_DAY,
  WRONG_CODE_REPLY,
  handleSignupText,
  hashSignupCode,
  signupCodeIn,
  type PendingSignupCode,
  type SignupDeps,
} from '../signup'
import { signupCodeText } from '../consent'
import type { PhoneAccount } from '../signup-account'

/**
 * Signing up by text: a number nobody linked texts the Native Intelligence number and gets
 * a code; the code texted back makes the account. Codes expire, sending and
 * guessing are both capped, and nothing says whether the number had an
 * account before.
 */
const PHONE = '+15551234567'
const KEY = 'test-internal-secret'
const T0 = Date.parse('2026-11-02T15:00:00Z')
const ACCOUNT: PhoneAccount = { userId: 'user-new', workspaceId: 'ws-new', phone: PHONE }

interface CodeRow extends PendingSignupCode {
  phone: string
  createdAt: number
  consumed: boolean
}

function harness(over: { now?: number; capReached?: boolean; createFails?: boolean; codes?: string[]; codesThisHour?: number; welcomesToday?: number; storeRace?: boolean } = {}) {
  const codes: CodeRow[] = []
  const wrong: Array<{ at: number; sid: string }> = []
  const replies: Array<{ kind: string; text: string }> = []
  const queue = [...(over.codes ?? ['123456', '234567', '345678', '456789', '567890', '678901'])]
  let now = over.now ?? T0
  const deps = (): SignupDeps => ({
    autoReply: vi.fn(async (kind, text) => {
      if (over.capReached) return null
      replies.push({ kind, text })
      return text
    }),
    countCodesSince: vi.fn(async (phone, since) => codes.filter((c) => c.phone === phone && c.createdAt >= since).length),
    countCodesSentSince: vi.fn(async (since) => over.codesThisHour ?? codes.filter((c) => c.createdAt >= since).length),
    countSignupsSince: vi.fn(async () => over.welcomesToday ?? 0),
    countWrongCodesSince: vi.fn(async (_phone, since) => wrong.filter((w) => w.at >= since).length),
    newestPendingCode: vi.fn(async (phone) => {
      const row = [...codes].reverse().find((c) => c.phone === phone && !c.consumed)
      return row ? { id: row.id, codeHash: row.codeHash, attempts: row.attempts, expiresAt: row.expiresAt } : null
    }),
    storeCode: vi.fn(async (row, at) => {
      if (over.storeRace) return false
      for (const c of codes) if (c.phone === row.phone) c.consumed = true
      codes.push({ id: `code-${codes.length + 1}`, phone: row.phone, codeHash: row.codeHash, attempts: 0, expiresAt: row.expiresAt, createdAt: at, consumed: false })
      return true
    }),
    countAttempt: vi.fn(async (code) => {
      const row = codes.find((c) => c.id === code.id)
      if (!row || row.consumed || row.attempts !== code.attempts) return false
      row.attempts += 1
      return true
    }),
    consumeCode: vi.fn(async (id) => {
      const row = codes.find((c) => c.id === id)
      if (!row || row.consumed) return false
      row.consumed = true
      return true
    }),
    markWrongCode: vi.fn(async (sid) => {
      wrong.push({ at: now, sid })
    }),
    createAccount: vi.fn(async () => (over.createFails ? { ok: false as const, error: 'boom' } : { ok: true as const, account: ACCOUNT })),
    welcome: vi.fn(async () => 'WELCOME'),
    key: KEY,
    code: () => queue.shift() ?? '999999',
    now,
  })
  const text = (body: string, sid = `SM${Math.random().toString(36).slice(2)}`) => handleSignupText({ phone: PHONE, text: body, sid }, deps())
  return {
    codes,
    wrong,
    replies,
    text,
    deps,
    at: (ms: number) => {
      now = ms
    },
  }
}

describe('asking for a code', () => {
  it('any text from a new number gets a code with the consent words, and only its HMAC is stored', async () => {
    const h = harness()
    expect(await h.text('hi, I run a rug cleaning business')).toEqual({ outcome: 'signup_code_sent', reply: signupCodeText('123456') })
    expect(h.replies).toEqual([{ kind: 'signup_code', text: signupCodeText('123456') }])
    expect(h.codes).toHaveLength(1)
    expect(h.codes[0].codeHash).toBe(hashSignupCode('123456', PHONE, KEY))
    expect(h.codes[0].codeHash).not.toContain('123456')
    expect(Date.parse(h.codes[0].expiresAt) - T0).toBe(SIGNUP_CODE_TTL_MS)
    // The words carriers review: what they're signing up for, frequency, rates, STOP and HELP.
    expect(signupCodeText('123456')).toMatch(/^Dial8: Your code is 123456\. Reply with it to create your Dial8 account/)
    for (const words of ['Msg frequency varies', 'Msg & data rates may apply', 'Reply STOP to opt out', 'HELP for help', 'dial8.ai/terms']) {
      expect(signupCodeText('123456')).toContain(words)
    }
  })

  it('the code is bound to the number: the same code from another number never matches', () => {
    expect(hashSignupCode('123456', PHONE, KEY)).not.toBe(hashSignupCode('123456', '+15557654321', KEY))
  })

  it('only the newest code works: asking again voids the last one', async () => {
    const h = harness()
    await h.text('hello')
    await h.text('hello?')
    expect(h.codes.map((c) => c.consumed)).toEqual([true, false])
    // The first code, now void, is a wrong guess at the newest one, which still works.
    expect(await h.text('123456')).toEqual({ outcome: 'signup_code_miss', reply: WRONG_CODE_REPLY })
    expect((await h.text('234567')).outcome).toBe('signed_up')
  })

  it(`sends at most ${SIGNUP_CODES_PER_WINDOW} codes in 10 minutes and ${SIGNUP_CODES_PER_DAY} a day; past that, silence`, async () => {
    const h = harness()
    for (let i = 0; i < SIGNUP_CODES_PER_WINDOW; i++) expect((await h.text('hi')).outcome).toBe('signup_code_sent')
    expect(await h.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
    expect(h.codes).toHaveLength(SIGNUP_CODES_PER_WINDOW)
    h.at(T0 + SIGNUP_CODES_WINDOW_MS + 1000)
    for (let i = SIGNUP_CODES_PER_WINDOW; i < SIGNUP_CODES_PER_DAY; i++) expect((await h.text('hi')).outcome).toBe('signup_code_sent')
    h.at(T0 + 2 * SIGNUP_CODES_WINDOW_MS + 2000)
    expect(await h.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
    expect(h.codes).toHaveLength(SIGNUP_CODES_PER_DAY)
    // A day later it works again.
    h.at(T0 + 24 * 60 * 60_000 + 3000)
    expect((await h.text('hi')).outcome).toBe('signup_code_sent')
  })

  it('past the global auto-reply cap (or to a number outside US/Canada) nothing is sent and no code is stored', async () => {
    const capped = harness({ capReached: true })
    expect(await capped.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
    expect(capped.codes).toHaveLength(0)
    const intl = harness()
    expect(await handleSignupText({ phone: '+447700900123', text: 'hi', sid: 'SM1' }, intl.deps())).toEqual({ outcome: 'signup_unsupported', reply: null })
    expect(intl.codes).toHaveLength(0)
  })

  it(`across all numbers: at most ${SIGNUP_CODES_PER_HOUR} codes an hour and ${SIGNUP_ACCOUNTS_PER_DAY} new accounts a day; past either, silence`, async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const hour = harness({ codesThisHour: SIGNUP_CODES_PER_HOUR })
    expect(await hour.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
    const day = harness({ welcomesToday: SIGNUP_ACCOUNTS_PER_DAY })
    expect(await day.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
    expect([...hour.codes, ...day.codes, ...hour.replies, ...day.replies]).toEqual([])
    expect((await harness({ codesThisHour: SIGNUP_CODES_PER_HOUR - 1, welcomesToday: SIGNUP_ACCOUNTS_PER_DAY - 1 }).text('hi')).outcome).toBe('signup_code_sent')
  })

  it('two texts at once: the one that stored its code first is the one sent; the other says nothing', async () => {
    const h = harness({ storeRace: true })
    expect(await h.text('hi')).toEqual({ outcome: 'signup_limited', reply: null })
  })

  it('fails closed without the internal secret: nobody can sign up', async () => {
    const h = harness()
    expect(await handleSignupText({ phone: PHONE, text: 'hi', sid: 'SM1' }, { ...h.deps(), key: null })).toEqual({ outcome: 'signup_unsupported', reply: null })
    expect(h.codes).toHaveLength(0)
  })
})

describe('texting the code back', () => {
  it('the right code, within 10 minutes, makes the account and the welcome is the reply', async () => {
    const h = harness()
    await h.text('hi')
    h.at(T0 + SIGNUP_CODE_TTL_MS - 1000)
    const d = h.deps()
    expect(await handleSignupText({ phone: PHONE, text: ' 123 456 ', sid: 'SM2' }, d)).toEqual({ outcome: 'signed_up', reply: 'WELCOME' })
    expect(d.createAccount).toHaveBeenCalledWith(PHONE, T0 + SIGNUP_CODE_TTL_MS - 1000)
    expect(d.welcome).toHaveBeenCalledWith(ACCOUNT, T0 + SIGNUP_CODE_TTL_MS - 1000)
    expect(h.codes[0].consumed).toBe(true)
  })

  it('a code works once: the same code again is just a text asking for a new one', async () => {
    const h = harness()
    await h.text('hi')
    expect((await h.text('123456')).outcome).toBe('signed_up')
    const again = h.deps()
    expect((await handleSignupText({ phone: PHONE, text: '123456', sid: 'SM3' }, again)).outcome).toBe('signup_code_sent')
    expect(again.createAccount).not.toHaveBeenCalled()
  })

  it('an expired code makes no account: the text gets a fresh code instead', async () => {
    const h = harness()
    await h.text('hi')
    h.at(T0 + SIGNUP_CODE_TTL_MS)
    const d = h.deps()
    expect(await handleSignupText({ phone: PHONE, text: '123456', sid: 'SM2' }, d)).toEqual({ outcome: 'signup_code_sent', reply: signupCodeText('234567') })
    expect(d.createAccount).not.toHaveBeenCalled()
  })

  it(`a wrong code says so; the ${SIGNUP_CODE_MAX_ATTEMPTS}th wrong one kills the code, and even the right one no longer works`, async () => {
    const h = harness()
    await h.text('hi')
    for (let i = 1; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) expect(await h.text('000000')).toEqual({ outcome: 'signup_code_miss', reply: WRONG_CODE_REPLY })
    expect(await h.text('000000')).toEqual({ outcome: 'signup_code_dead', reply: DEAD_CODE_REPLY })
    expect(h.codes[0].attempts).toBe(SIGNUP_CODE_MAX_ATTEMPTS)
    const d = h.deps()
    expect((await handleSignupText({ phone: PHONE, text: '123456', sid: 'SM9' }, d)).outcome).toBe('signup_code_sent')
    expect(d.createAccount).not.toHaveBeenCalled()
    expect(h.wrong).toHaveLength(SIGNUP_CODE_MAX_ATTEMPTS)
  })

  it(`past ${SIGNUP_WRONG_CODES_PER_DAY} wrong codes in a day the number's sign-up pauses: no guess is checked, no code is sent`, async () => {
    const h = harness()
    await h.text('hi')
    for (let i = 0; i < SIGNUP_WRONG_CODES_PER_DAY; i++) h.wrong.push({ at: T0, sid: `SMw${i}` })
    const d = h.deps()
    // Even the right code: the guesses are what's capped.
    expect(await handleSignupText({ phone: PHONE, text: '123456', sid: 'SMx' }, d)).toEqual({ outcome: 'signup_paused', reply: null })
    expect(await handleSignupText({ phone: PHONE, text: 'new code please', sid: 'SMy' }, d)).toEqual({ outcome: 'signup_paused', reply: null })
    expect(d.createAccount).not.toHaveBeenCalled()
    expect(d.countAttempt).not.toHaveBeenCalled()
    expect(h.codes).toHaveLength(1)
    // A day on, the number can ask again.
    h.at(T0 + 24 * 60 * 60_000 + 1000)
    expect((await h.text('hi')).outcome).toBe('signup_code_sent')
  })

  it('two guesses in parallel: the attempt is counted first, so the one that loses the race is not checked', async () => {
    const h = harness()
    await h.text('hi')
    const d = h.deps()
    d.countAttempt = vi.fn(async () => false)
    expect(await handleSignupText({ phone: PHONE, text: '123456', sid: 'SM2' }, d)).toEqual({ outcome: 'signup_code_miss', reply: null })
    expect(d.createAccount).not.toHaveBeenCalled()
  })

  it('two right codes in parallel make one account: only the one that consumed the code goes on', async () => {
    const h = harness()
    await h.text('hi')
    const d = h.deps()
    d.consumeCode = vi.fn(async () => false)
    expect(await handleSignupText({ phone: PHONE, text: '123456', sid: 'SM2' }, d)).toEqual({ outcome: 'signup_code_miss', reply: null })
    expect(d.createAccount).not.toHaveBeenCalled()
  })

  it('an account that fails to make says so and asks them to text for a new code', async () => {
    const h = harness({ createFails: true })
    await h.text('hi')
    expect(await h.text('123456')).toEqual({ outcome: 'signup_failed', reply: SIGNUP_FAILED_REPLY })
  })
})

describe('signupCodeIn', () => {
  it('reads six digits alone, split by a space or a dash; anything else is not a code', () => {
    expect(signupCodeIn('123456')).toBe('123456')
    expect(signupCodeIn(' 123 456 ')).toBe('123456')
    expect(signupCodeIn('123-456')).toBe('123456')
    for (const text of ['12345', '1234567', 'my code is 123456', 'abc123', '123456!', '']) expect(signupCodeIn(text), text).toBeNull()
  })
})
