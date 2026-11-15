/**
 * The bot check on a form (forms phase 3, migration 661): a stateless,
 * signed, timed proof of work, with no third-party service.
 *
 *   issueChallenge    a token `v1.<issuedAtMs>.<random>.<hmac>`: the HMAC is
 *                     keyed with the server's secret and binds the form's id,
 *                     the time and the random part, so a token is good for
 *                     one form only and can't be made up or moved in time.
 *   verifyChallenge   a submission's token and answer: the signature (compared
 *                     in constant time), then its age, then the work. The work
 *                     is an answer whose sha256(token + ":" + answer) starts
 *                     with CHALLENGE_DIFFICULTY zero bits.
 *
 * Why each bound: under CHALLENGE_MIN_AGE_MS no person has read and filled a
 * form (the page fetches its challenge when it loads, so a person never waits
 * on it); over CHALLENGE_MAX_AGE_MS the page has sat open long enough that
 * reloading costs nothing; the work makes a script run something per post,
 * which a plain form-spamming bot does not. None of this stops a determined
 * sender, which is what the caps are for (./submit.ts).
 *
 * Single use is not kept here: the random part is recorded on the try that
 * stores the submission (data_form_attempt.challenge_id, 661), and a second
 * try with it is refused by the unique index (./store.ts claimAttempt). A try
 * whose write fails gives it back, so the person can send again.
 *
 * Pure but for the secret's default, which is the server's (Server only).
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { oauthStateSecret } from '@/lib/oauth/state'

/**
 * Leading zero bits the work needs: 2^14 hashes on average. A phone's browser
 * does that in well under a second with crypto.subtle (the page starts on it
 * as it loads, while the person types); a fresh challenge costs the server one
 * HMAC and nothing stored.
 */
export const CHALLENGE_DIFFICULTY = 14
/** No person fills in a form faster than this. */
export const CHALLENGE_MIN_AGE_MS = 2_000
/** A page open longer than this fetches a new one. */
export const CHALLENGE_MAX_AGE_MS = 2 * 60 * 60_000

const TOKEN_SHAPE = /^v1\.(\d{13})\.([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/
const ANSWER_SHAPE = /^\d{1,15}$/

function sign(secret: string, formId: string, issuedAt: string, random: string): string {
  return createHmac('sha256', secret).update(`form-challenge:v1:${formId}:${issuedAt}:${random}`).digest('base64url')
}

export interface IssuedChallenge {
  token: string
  difficulty: number
}

/** A fresh challenge for one form. */
export function issueChallenge(formId: string, now: number, secret: string = oauthStateSecret()): IssuedChallenge {
  const issuedAt = String(Math.floor(now)).padStart(13, '0')
  const random = randomBytes(16).toString('base64url')
  return { token: `v1.${issuedAt}.${random}.${sign(secret, formId, issuedAt, random)}`, difficulty: CHALLENGE_DIFFICULTY }
}

/** Zero bits at the start of `bytes`. Pure. */
export function leadingZeroBits(bytes: Uint8Array): number {
  let bits = 0
  for (const byte of bytes) {
    if (byte === 0) {
      bits += 8
      continue
    }
    return bits + Math.clz32(byte) - 24
  }
  return bits
}

/** The hash the work is judged by. Pure. */
export function challengeDigest(token: string, answer: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(`${token}:${answer}`, 'utf8').digest())
}

/** An answer to a token: what the page does in the browser, here for the tests and the server's own checks. */
export function solveChallenge(token: string, difficulty: number = CHALLENGE_DIFFICULTY): string {
  for (let n = 0; ; n++) if (leadingZeroBits(challengeDigest(token, String(n))) >= difficulty) return String(n)
}

/** Why a challenge was refused: not one of ours (or another form's), too soon, too late, or the work not done. */
export type ChallengeRefusal = 'malformed' | 'signature' | 'too_young' | 'too_old' | 'answer'
export type ChallengeCheck = { ok: true; id: string } | { ok: false; reason: ChallengeRefusal }

/** One submission's challenge (see the header). `id` is its random part, what single use is kept by. Pure but for the secret's default. */
export function verifyChallenge(args: { formId: string; token: unknown; answer: unknown; now: number; secret?: string; difficulty?: number }): ChallengeCheck {
  const token = typeof args.token === 'string' ? args.token.trim() : ''
  const answer = typeof args.answer === 'number' && Number.isSafeInteger(args.answer) && args.answer >= 0 ? String(args.answer) : typeof args.answer === 'string' ? args.answer.trim() : ''
  const shape = TOKEN_SHAPE.exec(token)
  if (!shape || !ANSWER_SHAPE.test(answer)) return { ok: false, reason: 'malformed' }
  const [, issuedAt, random, mac] = shape
  const want = new Uint8Array(Buffer.from(sign(args.secret ?? oauthStateSecret(), args.formId, issuedAt, random)))
  const got = new Uint8Array(Buffer.from(mac))
  if (got.length !== want.length || !timingSafeEqual(got, want)) return { ok: false, reason: 'signature' }
  const age = args.now - Number(issuedAt)
  // A time ahead of the server's is as young as can be.
  if (age < CHALLENGE_MIN_AGE_MS) return { ok: false, reason: 'too_young' }
  if (age > CHALLENGE_MAX_AGE_MS) return { ok: false, reason: 'too_old' }
  if (leadingZeroBits(challengeDigest(token, answer)) < (args.difficulty ?? CHALLENGE_DIFFICULTY)) return { ok: false, reason: 'answer' }
  return { ok: true, id: random }
}
