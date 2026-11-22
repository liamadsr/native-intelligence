/**
 * The bot check (../challenge.ts): a token is good for one form, after two
 * seconds and before two hours, with the work done; anything else is refused
 * with its reason. The browser's solver (../solve.ts) finds answers the
 * server takes. Single use is the attempt ledger's (../store.ts claimAttempt).
 */
import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  CHALLENGE_DIFFICULTY,
  CHALLENGE_MAX_AGE_MS,
  CHALLENGE_MIN_AGE_MS,
  challengeDigest,
  issueChallenge,
  leadingZeroBits,
  solveChallenge,
  verifyChallenge,
} from '../challenge'
import { solveFormChallenge, zeroBits } from '../solve'
import { claimAttempt } from '../store'

const SECRET = 'test-secret'
const T0 = Date.parse('2026-11-15T12:00:00Z')
const issued = issueChallenge('form-1', T0, SECRET)
const answer = solveChallenge(issued.token)
const check = (over: Partial<Parameters<typeof verifyChallenge>[0]> = {}) =>
  verifyChallenge({ formId: 'form-1', token: issued.token, answer, now: T0 + 5_000, secret: SECRET, ...over })

describe('a challenge', () => {
  it('is v1.<issued at>.<random>.<hmac>, at the difficulty the server keeps', () => {
    expect(issued.token).toMatch(/^v1\.\d{13}\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/)
    expect(issued.token.split('.')[1]).toBe(String(T0))
    expect(issued.difficulty).toBe(CHALLENGE_DIFFICULTY)
    // Two are never the same.
    expect(issueChallenge('form-1', T0, SECRET).token).not.toBe(issued.token)
  })

  it('solved and old enough, is taken: its id is its random part', () => {
    const ok = check()
    expect(ok).toEqual({ ok: true, id: issued.token.split('.')[2] })
    expect(leadingZeroBits(challengeDigest(issued.token, answer))).toBeGreaterThanOrEqual(CHALLENGE_DIFFICULTY)
    // A number answer (a JSON body) counts the same.
    expect(check({ answer: Number(answer) }).ok).toBe(true)
  })

  it.each([
    ['another form', { formId: 'form-2' }, 'signature'],
    ['another secret', { secret: 'other' }, 'signature'],
    ['under two seconds old', { now: T0 + CHALLENGE_MIN_AGE_MS - 1 }, 'too_young'],
    ['issued in the future', { now: T0 - 60_000 }, 'too_young'],
    ['over two hours old', { now: T0 + CHALLENGE_MAX_AGE_MS + 1 }, 'too_old'],
    ['missing', { token: undefined }, 'malformed'],
    ['no answer', { answer: undefined }, 'malformed'],
    ['an answer that is not digits', { answer: '12a' }, 'malformed'],
  ])('is refused when %s', (_what, over, reason) => {
    expect(check(over as Partial<Parameters<typeof verifyChallenge>[0]>)).toEqual({ ok: false, reason })
  })

  it('is refused with the work not done', () => {
    let wrong = 0
    while (leadingZeroBits(challengeDigest(issued.token, String(wrong))) >= CHALLENGE_DIFFICULTY) wrong++
    expect(check({ answer: String(wrong) })).toEqual({ ok: false, reason: 'answer' })
  })

  it('is refused when any part of it was changed', () => {
    const [v, at, random, mac] = issued.token.split('.')
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1)
    for (const token of [`${v}.${String(T0 - 1000)}.${random}.${mac}`, `${v}.${at}.${flip(random)}.${mac}`, `${v}.${at}.${random}.${flip(mac)}`, `v2.${at}.${random}.${mac}`]) {
      expect(check({ token }).ok, token).toBe(false)
    }
  })

  it("the browser's solver finds an answer the server takes", async () => {
    const solved = await solveFormChallenge(issued.token, CHALLENGE_DIFFICULTY)
    expect(check({ answer: solved })).toMatchObject({ ok: true })
    expect(zeroBits(new Uint8Array([0, 0x0f]))).toBe(12)
    expect(zeroBits(new Uint8Array([0x80]))).toBe(0)
    expect(leadingZeroBits(new Uint8Array([0, 0x0f]))).toBe(12)
  })
})

describe('one challenge stores one submission (the attempt ledger)', () => {
  /** The ledger's update as Postgres answers it: the unique index on (form_id, challenge_id), and the one on the sender's submission id. */
  function ledger(rows: Array<Record<string, unknown>>) {
    const update = (patch: Record<string, unknown>) => ({
      eq: async (_col: string, id: string) => {
        const row = rows.find((r) => r.id === id)!
        const next = { ...row, ...patch }
        if (next.challenge_id && rows.some((r) => r !== row && r.form_id === next.form_id && r.challenge_id === next.challenge_id)) {
          return { error: { code: '23505', message: 'duplicate key value violates unique constraint "data_form_attempt_challenge_key"' } }
        }
        if (next.external_id && rows.some((r) => r !== row && r.form_id === next.form_id && r.client_hash === next.client_hash && r.external_id === next.external_id)) {
          return { error: { code: '23505', message: 'duplicate key value violates unique constraint "data_form_attempt_external_key"' } }
        }
        Object.assign(row, patch)
        return { error: null }
      },
    })
    const select = () => {
      const filters: Array<(r: Record<string, unknown>) => boolean> = []
      const q = {
        eq(col: string, v: unknown) {
          filters.push((r) => r[col] === v)
          return q
        },
        is(col: string, v: unknown) {
          filters.push((r) => (r[col] ?? null) === v)
          return q
        },
        limit: () => q,
        maybeSingle: async () => ({ data: rows.find((r) => filters.every((f) => f(r))) ?? null, error: null }),
      }
      return q
    }
    return { from: () => ({ update, select }) } as unknown as SupabaseClient
  }

  it('a second try with the same challenge is refused; a re-post of the stored submission is still a repeat', async () => {
    const rows: Array<Record<string, unknown>> = [
      { id: 'a1', form_id: 'f', client_hash: 'c', external_id: null, challenge_id: null, row_id: null, stored_at: null },
      { id: 'a2', form_id: 'f', client_hash: 'c', external_id: null, challenge_id: null, row_id: null, stored_at: null },
      { id: 'a3', form_id: 'f', client_hash: 'c', external_id: null, challenge_id: null, row_id: null, stored_at: null },
    ]
    const db = ledger(rows)
    expect(await claimAttempt(db, { attemptId: 'a1', formId: 'f', clientHash: 'c', externalId: 'sub-1', rowId: 'r1', challengeId: 'ch-1' })).toEqual({ kind: 'new' })
    rows[0].stored_at = 'now'
    // Another submission, the same challenge: used.
    expect(await claimAttempt(db, { attemptId: 'a2', formId: 'f', clientHash: 'c', externalId: 'sub-2', rowId: 'r2', challengeId: 'ch-1' })).toEqual({ kind: 'challenge_used' })
    // The same submission again (a retry), the same challenge: answered with the row it stored.
    expect(await claimAttempt(db, { attemptId: 'a3', formId: 'f', clientHash: 'c', externalId: 'sub-1', rowId: 'r3', challengeId: 'ch-1' })).toEqual({ kind: 'repeat', rowId: 'r1' })
  })
})
