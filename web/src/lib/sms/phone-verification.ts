/**
 * Linking a phone (Settings → Phone, docs/plans/text-and-calling.md decision
 * 3): the person types their number, Native Intelligence texts a 6-digit code, they type it
 * back. Possession of the phone is the proof.
 *
 *   start  the SMS consent ticked (./consent.ts, stored with the code and
 *          copied onto user_phone on verify), normalize to E.164, rate limit
 *          (per person, per person and number, and a higher cap per number),
 *          refuse a US/Canada-less number and one that said STOP, text a
 *          fresh code, store only its HMAC (keyed on the server's internal
 *          secret and bound to the person and the number) in
 *          `phone_verification` (migration 411), which no client can read.
 *   verify the person's newest unconsumed code, unexpired, under
 *          PHONE_CODE_MAX_ATTEMPTS (the attempt is counted BEFORE comparing,
 *          with a conditional update, so parallel guesses can't exceed it).
 *          A match consumes the code and links the number, and the person's
 *          own row is replaced (one number each). Which line (migration 464,
 *          one phone, two accounts):
 *            - the number is another account's Native Intelligence line, the account
 *              linking it is a business's (its workspace has a business
 *              profile or a live business number: ./business-line.ts), and
 *              that other account has an email: it is added as this
 *              account's business line, beside the other account's Native Intelligence
 *              line, which stays; that account is emailed a notice (what it
 *              means, and how to take the number back in Settings › Phone);
 *            - otherwise the number moves here, on the Native Intelligence line: anyone
 *              else's link to it is removed, business lines too (numbers get
 *              recycled; the code just proved this person holds it). A
 *              NI-line account with no email (a phone-only text sign-up)
 *              can't be told, so its number moves even to a business.
 *          Verification clears an opt-out: the code just reached the phone.
 *   The first link of a number texts a welcome that says it's an AI agent
 *   and how to STOP (decision 6): a Native Intelligence line's from the Native Intelligence number, a
 *   business line's from the business's own number (none while it has no
 *   live number: a text from the Native Intelligence number would point them at the other
 *   account's agent).
 */
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { sendSms, type SendSmsResult } from '@/lib/twilio/client'
import { agentSender } from './agent-number'
import { isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { businessName } from '@/lib/customers/store'
import { findLinkedPhone, recordOutbound, unlinkedNumberOptedOut, type LinkedPhone, type PhoneLine } from './store'
import { SMS_CONSENT_VERSION, consentCoversAlerts, verificationText } from './consent'
import { accountEmail, businessLineWelcomeText, isBusinessWorkspace, sendBusinessLineNotice } from './business-line'
import { workspaceLine } from './workspace-line'

/** How long a code works. */
export const PHONE_CODE_TTL_MS = 10 * 60_000
/** Wrong guesses one code takes before it is dead. */
export const PHONE_CODE_MAX_ATTEMPTS = 5
/** Codes one person may ask for, whatever the number: 3 in 10 minutes, 10 a day. */
export const PHONE_CODES_PER_USER_WINDOW = 3
export const PHONE_CODES_PER_USER_WINDOW_MS = 10 * 60_000
export const PHONE_CODES_PER_USER_DAY = 10
/** Codes one person may ask for one number in a day. */
export const PHONE_CODES_PER_USER_PHONE_DAY = 5
/**
 * Codes one number may be sent in a day, whoever asks: higher than the
 * per-person-and-number cap, so other accounts typing someone's number can't
 * use up that person's own codes for the day, yet still a bound on texts to it.
 */
export const PHONE_CODES_PER_PHONE_DAY = 15

const DAY_MS = 24 * 60 * 60_000

/** The key the code's HMAC is made with: the required internal secret (fail closed without it). Sign-up codes use it too (./signup.ts). */
export function codeKey(): string | null {
  const key = process.env.RUN_SKILL_INTERNAL_SECRET
  return key && key.length > 0 ? key : null
}

/** A fresh 6-digit code (uniform, leading zeros kept). */
export function generatePhoneCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/** The stored form of a code: an HMAC bound to the person and the number. Exported for the tests. */
export function hashPhoneCode(code: string, binding: { userId: string; phone: string }, key: string): string {
  return createHmac('sha256', key).update(`phone-code:${binding.userId}:${binding.phone}:${code}`).digest('hex')
}

export function hashesMatch(a: string, b: string): boolean {
  const x = new Uint8Array(Buffer.from(a, 'utf8'))
  const y = new Uint8Array(Buffer.from(b, 'utf8'))
  return x.length === y.length && timingSafeEqual(x, y)
}

export const WELCOME_TEXT =
  "You're set up to text Dial8. This number is your Dial8 AI agent: text it like you'd text an assistant, and it answers and acts for you. " +
  'Msg frequency varies. Msg & data rates may apply. Reply STOP to opt out, HELP for help.'

export type StartVerificationResult =
  | { ok: true; phone: string; expiresAt: string }
  | { ok: false; reason: 'invalid_phone' | 'unsupported_country' | 'no_consent' | 'rate_limited' | 'not_configured' | 'unsubscribed' | 'send_failed' | 'lookup_failed' }

/** Seams for the tests. */
export interface PhoneVerificationDeps {
  send?: (to: string, body: string, deps?: { from?: string }) => Promise<SendSmsResult>
  now?: () => number
  code?: () => string
  /** The NI-line account's deliverable email, or null for a phone-only one (./business-line.ts accountEmail). */
  niHolderEmail?: (userId: string) => Promise<string | null>
  /** Email the NI-line account that its number was also added as a business line (./business-line.ts). */
  notifyNiHolder?: (args: { to: string; phone: string }) => Promise<boolean>
}

/** Start (or restart) a verification. Never throws. */
export async function startPhoneVerification(
  supabase: SupabaseClient,
  args: { userId: string; workspaceId: string; phone: unknown; consent: unknown; consentVersion: unknown },
  deps: PhoneVerificationDeps = {},
): Promise<StartVerificationResult> {
  const phone = normalizeE164(args.phone)
  if (!phone) return { ok: false, reason: 'invalid_phone' }
  // US/Canada only (a +1 long code under 10DLC; an allow-list against SMS pumping).
  if (!isNanpNumber(phone)) return { ok: false, reason: 'unsupported_country' }
  // The SMS consent (US 10DLC): ticked, on the words Settings shows today.
  if (args.consent !== true || args.consentVersion !== SMS_CONSENT_VERSION) return { ok: false, reason: 'no_consent' }
  const key = codeKey()
  if (!key) return { ok: false, reason: 'not_configured' }
  const now = (deps.now ?? Date.now)()

  try {
    // A number that said STOP is texted nothing, not even a code: they text START first.
    const linked = await findLinkedPhone(supabase, phone)
    if (linked?.optedOut || (await unlinkedNumberOptedOut(supabase, phone))) return { ok: false, reason: 'unsubscribed' }
    const [recentUser, dayUser, dayUserPhone, dayPhone] = await Promise.all([
      countCodes(supabase, { user_id: args.userId }, now - PHONE_CODES_PER_USER_WINDOW_MS),
      countCodes(supabase, { user_id: args.userId }, now - DAY_MS),
      countCodes(supabase, { user_id: args.userId, phone_e164: phone }, now - DAY_MS),
      countCodes(supabase, { phone_e164: phone }, now - DAY_MS),
    ])
    if (
      recentUser >= PHONE_CODES_PER_USER_WINDOW ||
      dayUser >= PHONE_CODES_PER_USER_DAY ||
      dayUserPhone >= PHONE_CODES_PER_USER_PHONE_DAY ||
      dayPhone >= PHONE_CODES_PER_PHONE_DAY
    ) {
      return { ok: false, reason: 'rate_limited' }
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }

  const code = (deps.code ?? generatePhoneCode)()
  const expiresAt = new Date(now + PHONE_CODE_TTL_MS).toISOString()
  // Any earlier pending code of the person's is void: only the newest works.
  await supabase.from('phone_verification').update({ consumed_at: new Date(now).toISOString() }).eq('user_id', args.userId).is('consumed_at', null)
  const { error } = await supabase.from('phone_verification').insert({
    user_id: args.userId,
    workspace_id: args.workspaceId,
    phone_e164: phone,
    code_hash: hashPhoneCode(code, { userId: args.userId, phone }, key),
    expires_at: expiresAt,
    consented_at: new Date(now).toISOString(),
    consent_version: SMS_CONSENT_VERSION,
  })
  if (error) return { ok: false, reason: 'lookup_failed' }

  // From the agent's own number when it has one: the code and the welcome open the thread they'll text in.
  const sender = await agentSender(supabase, args.userId, now)
  const sent = sender ? await (deps.send ?? sendSms)(phone, verificationText(code), { sender }) : await (deps.send ?? sendSms)(phone, verificationText(code))
  if (!sent.ok) {
    if (sent.reason === 'not_configured') return { ok: false, reason: 'not_configured' }
    if (sent.reason === 'unsubscribed') return { ok: false, reason: 'unsubscribed' }
    return { ok: false, reason: 'send_failed' }
  }
  await recordOutbound(supabase, { phone, kind: 'verification', sid: sent.sid, userId: args.userId })
  return { ok: true, phone, expiresAt }
}

async function countCodes(supabase: SupabaseClient, match: { user_id?: string; phone_e164?: string }, sinceMs: number): Promise<number> {
  let query = supabase.from('phone_verification').select('id', { count: 'exact', head: true })
  for (const [column, value] of Object.entries(match)) query = query.eq(column, value)
  const { count, error } = await query.gte('created_at', new Date(sinceMs).toISOString())
  if (error) throw new Error(error.message)
  return count ?? 0
}

export type VerifyPhoneResult =
  | { ok: true; phone: string; welcomed: boolean; line: PhoneLine }
  | { ok: false; reason: 'invalid_code' | 'no_pending' | 'expired' | 'too_many_attempts' | 'not_configured' | 'lookup_failed' }

interface PendingRow {
  id: string
  workspace_id: string
  consented_at: string
  consent_version: string
  phone_e164: string
  code_hash: string
  attempts: number
  expires_at: string
}

/** Check a code and link the number. Never throws. */
export async function verifyPhoneCode(
  supabase: SupabaseClient,
  args: { userId: string; code: unknown },
  deps: PhoneVerificationDeps = {},
): Promise<VerifyPhoneResult> {
  const code = typeof args.code === 'string' ? args.code.replace(/\s+/g, '') : ''
  if (!/^\d{6}$/.test(code)) return { ok: false, reason: 'invalid_code' }
  const key = codeKey()
  if (!key) return { ok: false, reason: 'not_configured' }
  const now = (deps.now ?? Date.now)()

  const { data: pending, error } = await supabase
    .from('phone_verification')
    .select('id, workspace_id, phone_e164, code_hash, attempts, expires_at, consented_at, consent_version')
    .eq('user_id', args.userId)
    .is('consumed_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<PendingRow>()
  if (error) return { ok: false, reason: 'lookup_failed' }
  if (!pending) return { ok: false, reason: 'no_pending' }
  if (Date.parse(pending.expires_at) <= now) return { ok: false, reason: 'expired' }
  if (pending.attempts >= PHONE_CODE_MAX_ATTEMPTS) return { ok: false, reason: 'too_many_attempts' }

  // Count this attempt first (only if nobody counted another meanwhile).
  const { data: counted, error: countError } = await supabase
    .from('phone_verification')
    .update({ attempts: pending.attempts + 1 })
    .eq('id', pending.id)
    .eq('attempts', pending.attempts)
    .is('consumed_at', null)
    .select('id')
  if (countError) return { ok: false, reason: 'lookup_failed' }
  if (!Array.isArray(counted) || counted.length === 0) return { ok: false, reason: 'invalid_code' }

  if (!hashesMatch(hashPhoneCode(code, { userId: args.userId, phone: pending.phone_e164 }, key), pending.code_hash)) {
    return pending.attempts + 1 >= PHONE_CODE_MAX_ATTEMPTS ? { ok: false, reason: 'too_many_attempts' } : { ok: false, reason: 'invalid_code' }
  }

  // Which line (see the header): another account's Native Intelligence line stays when a
  // business's account adds the number and that account can be told.
  let line: PhoneLine = 'dial8'
  let noticeTo: string | null = null
  try {
    const niHolder: LinkedPhone | null = await findLinkedPhone(supabase, pending.phone_e164)
    if (niHolder && niHolder.userId !== args.userId && (await isBusinessWorkspace(supabase, pending.workspace_id))) {
      noticeTo = await (deps.niHolderEmail ?? ((userId) => accountEmail(supabase, userId)))(niHolder.userId)
      // No email (a phone-only account): it can't learn its number went elsewhere, so the number moves, as before.
      if (noticeTo) line = 'business'
    }
  } catch {
    return { ok: false, reason: 'lookup_failed' }
  }

  const at = new Date(now).toISOString()
  const { data: consumed } = await supabase.from('phone_verification').update({ consumed_at: at }).eq('id', pending.id).is('consumed_at', null).select('id')
  if (!Array.isArray(consumed) || consumed.length === 0) return { ok: false, reason: 'invalid_code' }

  // Was this number already this person's (re-verifying)? Then no second welcome.
  const { data: before } = await supabase
    .from('user_phone')
    .select('phone_e164, verified_at')
    .eq('user_id', args.userId)
    .maybeSingle<{ phone_e164: string; verified_at: string | null }>()
  const alreadyLinked = before?.phone_e164 === pending.phone_e164 && before.verified_at !== null

  if (line === 'dial8') {
    // One person per number on the Native Intelligence line: the code proved possession, so it moves here.
    const { error: releaseError } = await supabase.from('user_phone').delete().eq('phone_e164', pending.phone_e164).neq('user_id', args.userId)
    if (releaseError) return { ok: false, reason: 'lookup_failed' }
  }
  // One row per person (user_phone_user_key): this replaces any earlier one of theirs.
  const { error: linkError } = await supabase.from('user_phone').upsert(
    {
      user_id: args.userId,
      workspace_id: pending.workspace_id,
      phone_e164: pending.phone_e164,
      line,
      verified_at: at,
      opted_out_at: null,
      consented_at: pending.consented_at,
      consent_version: pending.consent_version,
      // Words that cover alert texts turn them on with the link (consent.ts);
      // otherwise alert texts were agreed for the old number, not this one (426).
      ...(consentCoversAlerts(pending.consent_version)
        ? { alerts_consented_at: pending.consented_at, alerts_consent_version: pending.consent_version }
        : alreadyLinked
          ? {}
          : { alerts_consented_at: null, alerts_consent_version: null }),
      updated_at: at,
    },
    { onConflict: 'user_id' },
  )
  if (linkError) return { ok: false, reason: 'lookup_failed' }

  if (line === 'business' && noticeTo && !alreadyLinked) {
    await (deps.notifyNiHolder ?? sendBusinessLineNotice)({ to: noticeTo, phone: pending.phone_e164 }).catch(() => false)
  }

  let welcomed = false
  if (!alreadyLinked) {
    const send = deps.send ?? sendSms
    let sent: SendSmsResult | null = null
    if (line === 'dial8') {
      // From their agent's own number when it has one, else the Native Intelligence one.
      const sender = await agentSender(supabase, args.userId)
      sent = sender ? await send(pending.phone_e164, WELCOME_TEXT, { sender }) : await send(pending.phone_e164, WELCOME_TEXT)
    } else {
      // Only from the business's own number: none yet, no welcome (its first text comes from there later).
      const from = await workspaceLine(supabase, pending.workspace_id, args.userId, pending.phone_e164)
      if (from) sent = await send(pending.phone_e164, businessLineWelcomeText(await businessName(supabase, pending.workspace_id)), { from })
    }
    if (sent?.ok) {
      welcomed = true
      await recordOutbound(supabase, { phone: pending.phone_e164, kind: 'welcome', sid: sent.sid, userId: args.userId })
    }
  }
  return { ok: true, phone: pending.phone_e164, welcomed, line }
}
