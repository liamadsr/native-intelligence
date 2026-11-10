/**
 * Signing up by text (roadmap track A1): a number nobody linked texts the
 * Native Intelligence number, and after inbound.ts has run STOP / START / HELP, the opt-out,
 * the rate limit and the guest checks, the text comes here. In this order:
 *
 *   1. only a US/Canada number can sign up (a +1 long code under 10DLC, and
 *      the allow-list against SMS pumping); anything else gets silence;
 *   2. a text that is a 6-digit code is a guess at this number's newest live
 *      code (unconsumed, unexpired, under SIGNUP_CODE_MAX_ATTEMPTS). The
 *      attempt is counted BEFORE comparing, with a conditional update, so
 *      parallel guesses can't exceed it. A wrong one is ledgered
 *      ('signup_code_miss'), and past SIGNUP_WRONG_CODES_PER_DAY a day the
 *      number's codes pause: no guess is checked and no code is sent;
 *   3. the right code is consumed (once, conditionally) and makes the
 *      account: a new user and workspace with the number already verified
 *      (./signup-account.ts), and the welcome, with the "connect your
 *      Google account" link, is the reply. Their home thread is where every
 *      text from now on goes;
 *   4. anything else (or a code with no live code to match) asks for a code:
 *      a fresh one, which voids the number's earlier ones (one pending code
 *      per number, migration 457's partial unique index), at most
 *      SIGNUP_CODES_PER_WINDOW in SIGNUP_CODES_WINDOW_MS and
 *      SIGNUP_CODES_PER_DAY a day. Across all numbers, at most
 *      SIGNUP_CODES_PER_HOUR codes an hour (their own cap, so sign-ups never
 *      starve HELP and START) and SIGNUP_ACCOUNTS_PER_DAY new accounts a day,
 *      and only while the global auto-reply cap holds. Past any of them:
 *      silence.
 *
 * Never says whether a number has an account: a number reaches this only when
 * no verified NI-line user_phone row has it (a business line, migration
 * 464, is another account's on a business's own number, never the Native Intelligence
 * one's), every such number is treated the same,
 * and a number an older account once held is freed for the new one only after
 * the code proved who holds it (./signup-account.ts).
 *
 * Only the code's HMAC is stored (bound to the number, keyed on the internal
 * secret: phone-verification.ts codeKey). Pure over {@link SignupDeps};
 * {@link supabaseSignupDeps} is the real store.
 */
import { createHmac } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { isNanpNumber } from '@/lib/twilio/phone'
import { SMS_TEXT_SIGNUP_CONSENT_VERSION, signupCodeText } from './consent'
import { generatePhoneCode, hashesMatch } from './phone-verification'
import { countInboundKindSince, countOutboundKindsSince, markInboundKind, recordOutbound } from './store'
import { createPhoneAccount, welcomeNewAccount, type PhoneAccount } from './signup-account'

/** How long a sign-up code works. */
export const SIGNUP_CODE_TTL_MS = 10 * 60_000
/** Wrong guesses one code takes before it is dead. */
export const SIGNUP_CODE_MAX_ATTEMPTS = 5
/** Codes one number may be sent: 3 in 10 minutes, 5 a day. */
export const SIGNUP_CODES_PER_WINDOW = 3
export const SIGNUP_CODES_WINDOW_MS = 10 * 60_000
export const SIGNUP_CODES_PER_DAY = 5
/** Wrong codes one number may text in a day before its sign-up pauses. */
export const SIGNUP_WRONG_CODES_PER_DAY = 10
/** Sign-up codes sent to anyone in an hour (against SMS pumping and mass sign-ups). */
export const SIGNUP_CODES_PER_HOUR = 60
/** New accounts by text in a day, across all numbers: past it, no code is sent until the day rolls on. */
export const SIGNUP_ACCOUNTS_PER_DAY = 200

const DAY_MS = 24 * 60 * 60_000
const HOUR_MS = 60 * 60_000

export const WRONG_CODE_REPLY = "Dial8: That code didn't match. Reply with the 6-digit code from our last text, or text anything for a new one."
export const DEAD_CODE_REPLY = 'Dial8: Too many tries with that code. Text anything for a new one.'
export const SIGNUP_FAILED_REPLY = "Dial8: Something went wrong setting up your account. Text anything for a new code and we'll try again."

export type SignupOutcome =
  | 'signup_code_sent'
  | 'signup_limited'
  | 'signup_code_miss'
  | 'signup_code_dead'
  | 'signup_paused'
  | 'signed_up'
  | 'signup_failed'
  | 'signup_unsupported'

export interface SignupResult {
  outcome: SignupOutcome
  reply: string | null
}

/** A number's newest unconsumed sign-up code. */
export interface PendingSignupCode {
  id: string
  codeHash: string
  attempts: number
  expiresAt: string
}

export interface SignupDeps {
  /** The NANP-only, globally capped reply (inbound.ts autoReply): the text to send, or null for silence. */
  autoReply(kind: 'signup_code' | 'auto_reply', text: string): Promise<string | null>
  /** Sign-up codes sent to `phone` since `sinceMs`. */
  countCodesSince(phone: string, sinceMs: number): Promise<number>
  /** Sign-up codes sent to anyone since `sinceMs`. */
  countCodesSentSince(sinceMs: number): Promise<number>
  /** Accounts made by text since `sinceMs` (a Settings → Phone link is not one). */
  countSignupsSince(sinceMs: number): Promise<number>
  /** Wrong sign-up codes `phone` texted since `sinceMs`. */
  countWrongCodesSince(phone: string, sinceMs: number): Promise<number>
  newestPendingCode(phone: string): Promise<PendingSignupCode | null>
  /** Store a fresh code's HMAC, voiding the number's earlier pending codes. False when a parallel text stored one first. */
  storeCode(row: { phone: string; codeHash: string; expiresAt: string }, nowMs: number): Promise<boolean>
  /** Count one attempt (attempts → attempts + 1 only if nobody counted another meanwhile). */
  countAttempt(code: PendingSignupCode): Promise<boolean>
  /** Consume the code, once. */
  consumeCode(id: string, nowMs: number): Promise<boolean>
  /** Ledger this text as a wrong code (the daily guess cap). */
  markWrongCode(sid: string): Promise<void>
  /** Make the account with the number verified. */
  createAccount(phone: string, nowMs: number): Promise<{ ok: true; account: PhoneAccount } | { ok: false; error: string }>
  /** The welcome: written into their home thread, recorded, and returned as the reply. */
  welcome(account: PhoneAccount, nowMs: number): Promise<string>
  /** The HMAC key (the internal secret), or null: then nobody can sign up (fail closed). */
  key: string | null
  code?: () => string
  now: number
}

/** The code in a text: six digits, alone, maybe split "123 456" or "123-456". */
export function signupCodeIn(text: string): string | null {
  const match = /^\s*(\d{3})[\s-]?(\d{3})\s*$/.exec(text)
  return match ? `${match[1]}${match[2]}` : null
}

/** The stored form of a sign-up code: an HMAC bound to the number. Exported for the tests. */
export function hashSignupCode(code: string, phone: string, key: string): string {
  return createHmac('sha256', key).update(`signup-code:${phone}:${code}`).digest('hex')
}

/** Handle a text from a number nobody linked, on the Native Intelligence line. Throws only on a failed store call. */
export async function handleSignupText(input: { phone: string; text: string; sid: string | null }, deps: SignupDeps): Promise<SignupResult> {
  const { phone, sid } = input
  const now = deps.now
  if (!isNanpNumber(phone) || !deps.key) return { outcome: 'signup_unsupported', reply: null }
  const key = deps.key

  const guess = signupCodeIn(input.text)
  if (guess) {
    if ((await deps.countWrongCodesSince(phone, now - DAY_MS)) >= SIGNUP_WRONG_CODES_PER_DAY) return { outcome: 'signup_paused', reply: null }
    const pending = await deps.newestPendingCode(phone)
    if (pending && Date.parse(pending.expiresAt) > now && pending.attempts < SIGNUP_CODE_MAX_ATTEMPTS) {
      // Counted first: a guess that loses the race to a parallel one is not checked.
      if (!(await deps.countAttempt(pending))) return { outcome: 'signup_code_miss', reply: null }
      if (!hashesMatch(hashSignupCode(guess, phone, key), pending.codeHash)) {
        if (sid) await deps.markWrongCode(sid)
        const dead = pending.attempts + 1 >= SIGNUP_CODE_MAX_ATTEMPTS
        const reply = await deps.autoReply('auto_reply', dead ? DEAD_CODE_REPLY : WRONG_CODE_REPLY)
        return { outcome: dead ? 'signup_code_dead' : 'signup_code_miss', reply }
      }
      if (!(await deps.consumeCode(pending.id, now))) return { outcome: 'signup_code_miss', reply: null }
      const created = await deps.createAccount(phone, now)
      if (!created.ok) {
        console.error(`[sms-signup] ALERT account not created: ${created.error}`)
        return { outcome: 'signup_failed', reply: await deps.autoReply('auto_reply', SIGNUP_FAILED_REPLY) }
      }
      return { outcome: 'signed_up', reply: await deps.welcome(created.account, now) }
    }
    // No live code to match (none, expired or dead): this text asks for a fresh one.
  }

  const [recent, today] = await Promise.all([deps.countCodesSince(phone, now - SIGNUP_CODES_WINDOW_MS), deps.countCodesSince(phone, now - DAY_MS)])
  if (recent >= SIGNUP_CODES_PER_WINDOW || today >= SIGNUP_CODES_PER_DAY) return { outcome: 'signup_limited', reply: null }
  if ((await deps.countWrongCodesSince(phone, now - DAY_MS)) >= SIGNUP_WRONG_CODES_PER_DAY) return { outcome: 'signup_paused', reply: null }
  const [hour, accounts] = await Promise.all([deps.countCodesSentSince(now - HOUR_MS), deps.countSignupsSince(now - DAY_MS)])
  if (hour >= SIGNUP_CODES_PER_HOUR || accounts >= SIGNUP_ACCOUNTS_PER_DAY) {
    console.warn('[sms-signup] ALERT sign-up cap reached: code withheld')
    return { outcome: 'signup_limited', reply: null }
  }
  const code = (deps.code ?? generatePhoneCode)()
  const reply = await deps.autoReply('signup_code', signupCodeText(code))
  if (!reply) return { outcome: 'signup_limited', reply: null }
  // A parallel text that stored a code first wins: this one says nothing (the reply is never sent).
  if (!(await deps.storeCode({ phone, codeHash: hashSignupCode(code, phone, key), expiresAt: new Date(now + SIGNUP_CODE_TTL_MS).toISOString() }, now))) {
    return { outcome: 'signup_limited', reply: null }
  }
  return { outcome: 'signup_code_sent', reply }
}

interface PendingRow {
  id: string
  code_hash: string
  attempts: number
  expires_at: string
}

/** The real store behind {@link handleSignupText}, on the service client. */
export function supabaseSignupDeps(
  supabase: SupabaseClient,
  args: { autoReply: SignupDeps['autoReply']; key: string | null; origin: string; now: number },
): SignupDeps {
  return {
    autoReply: args.autoReply,
    key: args.key,
    now: args.now,
    countCodesSince: async (phone, sinceMs) => {
      const { count, error } = await supabase
        .from('phone_signup_code')
        .select('id', { count: 'exact', head: true })
        .eq('phone_e164', phone)
        .gte('created_at', new Date(sinceMs).toISOString())
      if (error) throw new Error(`phone_signup_code count failed: ${error.message}`)
      return count ?? 0
    },
    countWrongCodesSince: (phone, sinceMs) => countInboundKindSince(supabase, phone, 'signup_code_miss', sinceMs),
    countCodesSentSince: (sinceMs) => countOutboundKindsSince(supabase, ['signup_code'], sinceMs),
    countSignupsSince: async (sinceMs) => {
      // A text sign-up's number carries the sign-up words' consent version (./signup-account.ts).
      const { count, error } = await supabase
        .from('user_phone')
        .select('id', { count: 'exact', head: true })
        .eq('consent_version', SMS_TEXT_SIGNUP_CONSENT_VERSION)
        .gte('created_at', new Date(sinceMs).toISOString())
      if (error) throw new Error(`user_phone count failed: ${error.message}`)
      return count ?? 0
    },
    newestPendingCode: async (phone) => {
      const { data, error } = await supabase
        .from('phone_signup_code')
        .select('id, code_hash, attempts, expires_at')
        .eq('phone_e164', phone)
        .is('consumed_at', null)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<PendingRow>()
      if (error) throw new Error(`phone_signup_code read failed: ${error.message}`)
      return data ? { id: data.id, codeHash: data.code_hash, attempts: data.attempts, expiresAt: data.expires_at } : null
    },
    storeCode: async (row, nowMs) => {
      // Only the newest code works: the earlier ones are void.
      const at = new Date(nowMs).toISOString()
      const { error: voidError } = await supabase.from('phone_signup_code').update({ consumed_at: at }).eq('phone_e164', row.phone).is('consumed_at', null)
      if (voidError) throw new Error(`phone_signup_code void failed: ${voidError.message}`)
      const { error } = await supabase.from('phone_signup_code').insert({ phone_e164: row.phone, code_hash: row.codeHash, expires_at: row.expiresAt })
      // One pending code per number (457's partial unique index): a parallel text stored one first.
      if (error?.code === '23505') return false
      if (error) throw new Error(`phone_signup_code insert failed: ${error.message}`)
      return true
    },
    countAttempt: async (code) => {
      const { data, error } = await supabase
        .from('phone_signup_code')
        .update({ attempts: code.attempts + 1 })
        .eq('id', code.id)
        .eq('attempts', code.attempts)
        .is('consumed_at', null)
        .select('id')
      if (error) throw new Error(`phone_signup_code attempt failed: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    consumeCode: async (id, nowMs) => {
      const { data, error } = await supabase
        .from('phone_signup_code')
        .update({ consumed_at: new Date(nowMs).toISOString() })
        .eq('id', id)
        .is('consumed_at', null)
        .select('id')
      if (error) throw new Error(`phone_signup_code consume failed: ${error.message}`)
      return Array.isArray(data) && data.length > 0
    },
    markWrongCode: (sid) => markInboundKind(supabase, sid, 'signup_code_miss'),
    createAccount: (phone, nowMs) => createPhoneAccount(supabase, { phone, nowMs }),
    welcome: async (account, nowMs) => {
      const text = await welcomeNewAccount(supabase, account, { origin: args.origin, nowMs })
      await recordOutbound(supabase, { phone: account.phone, kind: 'welcome', userId: account.userId })
      return text
    },
  }
}
