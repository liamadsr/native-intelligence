/**
 * Who is calling the Native Intelligence number (the spike): the person whose verified
 * phone (user_phone, migration 411) the call's From number is, or nobody. Owner
 * calls only: a guest or a business's customer is not a caller yet.
 *
 * OpenAI says to treat the webhook's SIP headers as untrusted, and a caller ID
 * can be spoofed. Unlike a text (whose answer goes to the real phone), a
 * call's answer is spoken to whoever is on the line, so a call is answered
 * only when the carrier vouches for the number: STIR/SHAKEN full attestation
 * ('A'), which Twilio passes on as `X-Twilio-VerStat: TN-Validation-Passed-A`
 * ({@link callerIdAttested}). Anything less is declined; a spoken code texted
 * to the verified phone is the fallback still to build. The header is only as
 * trustworthy as the route the call took, and OpenAI takes a SIP call from
 * anyone who knows the project id (its docs name no allowlist or SIP auth:
 * "Treat data.sip_headers as untrusted"), so a call must also carry our trunk's
 * secret ({@link trunkSecretCheck}): Twilio adds it to every call it sends
 * (an `X-` header on the origination URI), and nobody else knows it. Even attested, a call
 * is the person REMOTE (caller.ts channelCaller: person_remote) and every
 * risky call it makes waits for their yes in the app
 * (src/lib/chat/call-turn.ts CALL_TURN_HOLD), as a text's does.
 *
 * In local development only, GPT_LIVE_DEV_CALLER_PHONE with
 * GPT_LIVE_DEV_USER_ID and GPT_LIVE_DEV_WORKSPACE_ID maps one number to one
 * member, for testing against a database where that phone isn't verified, and
 * GPT_LIVE_DEV_SKIP_ATTESTATION=1 answers an unattested call (for a trunk that
 * doesn't pass the verification status on). Neither works on any deployment.
 */
import { timingSafeEqual } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { findLinkedPhone, isWorkspaceMember } from '@/lib/sms/store'
import { normalizeE164 } from '@/lib/twilio/phone'
import type { SipHeader } from './live-webhook'

/** The person a call is from. */
export interface CallCaller {
  userId: string
  workspaceId: string
  /** How the number was matched: their verified phone, or the local-dev mapping. */
  via: 'verified_phone' | 'dev_mapping'
}

/**
 * The caller's E.164 number from the From header (`"Name" <sip:+14155550100@host>;tag=…`
 * or a `tel:` URI), or null.
 */
export function callerNumberOfSipHeaders(headers: readonly SipHeader[]): string | null {
  const from = headers.find((h) => h.name.toLowerCase() === 'from' || h.name.toLowerCase() === 'f')?.value
  if (!from) return null
  const user = /(?:sips?|tel):([^@;>\s]+)/i.exec(from)?.[1]
  if (!user) return null
  try {
    return normalizeE164(decodeURIComponent(user))
  } catch {
    return null
  }
}

/** The caller's display name in the workspace, for the greeting; null when there is none (or the read fails). */
export async function callerDisplayName(supabase: SupabaseClient, caller: Pick<CallCaller, 'userId' | 'workspaceId'>): Promise<string | null> {
  try {
    const { data } = await supabase.from('member').select('display_name').eq('user_id', caller.userId).eq('workspace_id', caller.workspaceId).limit(1).maybeSingle<{ display_name: string | null }>()
    const name = typeof data?.display_name === 'string' ? data.display_name.replace(/\s+/g, ' ').trim() : ''
    return name || null
  } catch {
    return null
  }
}

/** The value of a SIP header (case-insensitive name), or null. */
function headerValue(headers: readonly SipHeader[], name: string): string | null {
  return headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
}

/**
 * True when the carrier gave the caller ID STIR/SHAKEN full attestation: it
 * knows the caller and that they may use this number. Twilio's
 * `X-Twilio-VerStat` header, or a `verstat` parameter on the From or
 * P-Asserted-Identity URI, must be exactly `TN-Validation-Passed-A`. B, C, a
 * failed check, no check, or no header at all are not.
 */
export function callerIdAttested(headers: readonly SipHeader[]): boolean {
  const passedA = (value: string | null | undefined) => /^\s*TN-Validation-Passed-A\s*$/i.test(value ?? '')
  if (passedA(headerValue(headers, 'X-Twilio-VerStat'))) return true
  for (const name of ['From', 'P-Asserted-Identity']) {
    // Inside the URI only: a display name is the caller's own words.
    const value = headerValue(headers, name) ?? ''
    const uri = /<([^>]*)>/.exec(value)?.[1] ?? value.replace(/^\s*"[^"]*"\s*/, '')
    const param = /[;?&]verstat=([^;>&@\s]+)/i.exec(uri)?.[1]
    if (passedA(param)) return true
  }
  return false
}

/** The header our Twilio trunk adds to every call (`?X-Dial8-Trunk=<secret>` on its origination URI). */
export const TRUNK_SECRET_HEADER = 'X-Dial8-Trunk' // gitleaks:allow (a header name, not a secret)

/**
 * Whether a call came through our own trunk: its {@link TRUNK_SECRET_HEADER}
 * equals GPT_LIVE_TRUNK_SECRET (constant-time). Without the secret set, every
 * call is refused ('not_configured'), local dev included: a dev box whose
 * webhook sits on the same OpenAI project would otherwise answer forged calls.
 * Hex (`openssl rand -hex 32`), so it rides the origination URI unescaped.
 */
export function trunkSecretCheck(headers: readonly SipHeader[], env: Record<string, string | undefined> = process.env): 'ok' | 'not_configured' | 'mismatch' {
  const secret = env.GPT_LIVE_TRUNK_SECRET?.trim()
  if (!secret) return 'not_configured'
  const given = headerValue(headers, TRUNK_SECRET_HEADER)?.trim()
  if (!given) return 'mismatch'
  const a = new Uint8Array(Buffer.from(given, 'utf8'))
  const b = new Uint8Array(Buffer.from(secret, 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b) ? 'ok' : 'mismatch'
}

/** The SIP header names a call carried (for the log when it's declined: names only, never values). */
export function sipHeaderNames(headers: readonly SipHeader[]): string {
  return [...new Set(headers.map((h) => h.name.toLowerCase()))].sort().join(',').slice(0, 300)
}

/** True only under `next dev` on a machine, never on any Vercel deployment. */
export function isLocalDev(env: Record<string, string | undefined>): boolean {
  return env.NODE_ENV === 'development' && !env.VERCEL_ENV
}

/** Whether an unattested call may still be answered: only in local dev, and only when asked. */
export function devSkipsAttestation(env: Record<string, string | undefined> = process.env): boolean {
  return isLocalDev(env) && env.GPT_LIVE_DEV_SKIP_ATTESTATION === '1'
}

/** The person calling from `phone`, or null. Throws on a failed read. */
export async function resolveCallCaller(
  supabase: SupabaseClient,
  phone: string,
  env: Record<string, string | undefined> = process.env,
): Promise<CallCaller | null> {
  const linked = await findLinkedPhone(supabase, phone)
  if (linked) return { userId: linked.userId, workspaceId: linked.workspaceId, via: 'verified_phone' }
  if (!isLocalDev(env)) return null
  const devPhone = normalizeE164(env.GPT_LIVE_DEV_CALLER_PHONE)
  const userId = env.GPT_LIVE_DEV_USER_ID?.trim()
  const workspaceId = env.GPT_LIVE_DEV_WORKSPACE_ID?.trim()
  if (!devPhone || devPhone !== phone || !userId || !workspaceId) return null
  if (!(await isWorkspaceMember(supabase, userId, workspaceId))) return null
  return { userId, workspaceId, via: 'dev_mapping' }
}
