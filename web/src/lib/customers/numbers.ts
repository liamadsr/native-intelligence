/**
 * A business's own number (roadmap B2, migration 458 business_phone_number):
 * the Twilio number its customers text. The inbound webhook decides by the
 * number that was texted (`To`): a business's number is a customer's text
 * (./texting.ts), the Native Intelligence number is everyone else's (src/lib/sms/inbound.ts).
 *
 * Getting one (POST /api/admin/business-numbers, Native Intelligence's admins
 * only: a number costs Native Intelligence money and lives in Native Intelligence's Twilio account):
 *   - buy: a new US local number in an area code, through Twilio's REST API
 *     (AvailablePhoneNumbers, then IncomingPhoneNumbers), its SMS webhook set
 *     to Native Intelligence's. A number bought but not recorded is released again;
 *   - attach: a number already in Native Intelligence's Twilio account (bought or ported by
 *     hand), its SMS webhook pointed at Native Intelligence's.
 * A business number is NEVER added to Native Intelligence's messaging service: in its
 * sender pool Twilio could pick it for a Native Intelligence text (sticky sender, area-code
 * match), and a Native Intelligence user's reply would land on the business. It sends with
 * its own `From` (src/lib/twilio/client.ts); its 10DLC brand and campaign
 * are its own, registered apart (docs/plans/customer-front-door.md).
 * Its voice webhook is left alone: calls are the calling work's
 * (docs/plans/text-and-calling.md Phase 4).
 *
 * One live number per workspace, unique across Native Intelligence. Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { twilioConfig, twilioSmsWebhookUrl, type TwilioConfig } from '@/lib/twilio/config'
import { isE164, isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { TWILIO_API, twilioRest } from '@/lib/twilio/rest'

export interface BusinessNumber {
  id: string
  workspaceId: string
  ownerUserId: string
  phone: string
  twilioSid: string | null
}

interface NumberRow {
  id: string
  workspace_id: string
  owner_user_id: string
  phone_e164: string
  twilio_sid: string | null
}

const NUMBER_SELECT = 'id, workspace_id, owner_user_id, phone_e164, twilio_sid'

function toNumber(row: NumberRow): BusinessNumber {
  return { id: row.id, workspaceId: row.workspace_id, ownerUserId: row.owner_user_id, phone: row.phone_e164, twilioSid: row.twilio_sid }
}

/** The live business number that is `to`, or null (the Native Intelligence number, or nobody's). Throws on a failed read. */
export async function findBusinessNumber(supabase: SupabaseClient, to: string | null | undefined): Promise<BusinessNumber | null> {
  const phone = typeof to === 'string' ? to.trim() : ''
  if (!isE164(phone)) return null
  const { data, error } = await supabase.from('business_phone_number').select(NUMBER_SELECT).eq('phone_e164', phone).eq('state', 'active').maybeSingle<NumberRow>()
  if (error) throw new Error(`business_phone_number read failed: ${error.message}`)
  return data ? toNumber(data) : null
}

/** The workspace's live number, or null. Throws on a failed read. */
export async function activeBusinessNumber(supabase: SupabaseClient, workspaceId: string): Promise<BusinessNumber | null> {
  const { data, error } = await supabase.from('business_phone_number').select(NUMBER_SELECT).eq('workspace_id', workspaceId).eq('state', 'active').maybeSingle<NumberRow>()
  if (error) throw new Error(`business_phone_number read failed: ${error.message}`)
  return data ? toNumber(data) : null
}

/** A live number by its id (a customer's row names it), or null. Throws on a failed read. */
export async function businessNumberById(supabase: SupabaseClient, id: string): Promise<BusinessNumber | null> {
  const { data, error } = await supabase.from('business_phone_number').select(NUMBER_SELECT).eq('id', id).eq('state', 'active').maybeSingle<NumberRow>()
  if (error) throw new Error(`business_phone_number read failed: ${error.message}`)
  return data ? toNumber(data) : null
}

/** The SMS webhook a business number posts to: the same one as the Native Intelligence number. */
export function smsWebhookUrl(): string {
  return twilioSmsWebhookUrl()
}

export type ProvisionResult =
  | { ok: true; number: BusinessNumber }
  | { ok: false; reason: 'not_configured' | 'has_number' | 'none_available' | 'not_in_account' | 'taken' | 'bad_input' | 'twilio_refused' | 'failed'; error?: string }

export interface ProvisionDeps {
  fetch?: typeof fetch
  config?: TwilioConfig | null
  webhookUrl?: string
}

function twilio(deps: ProvisionDeps, config: TwilioConfig, url: string, init: { method: 'GET' | 'POST' | 'DELETE'; form?: Record<string, string> }) {
  return twilioRest(config, url, init, deps.fetch)
}

/** Point a Twilio number's SMS webhook at Native Intelligence's (never into Native Intelligence's messaging service: see the header). */
async function wireNumber(deps: ProvisionDeps, config: TwilioConfig, sid: string): Promise<{ ok: boolean; error?: string }> {
  const accountUrl = `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}`
  const set = await twilio(deps, config, `${accountUrl}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, {
    method: 'POST',
    form: { SmsUrl: deps.webhookUrl ?? smsWebhookUrl(), SmsMethod: 'POST' },
  })
  return set.ok ? { ok: true } : { ok: false, error: `webhook update refused (${set.status})` }
}

/** Give a bought number back to Twilio (its record could not be written). Best effort. */
async function releaseNumber(deps: ProvisionDeps, config: TwilioConfig, sid: string): Promise<void> {
  try {
    const res = await twilio(deps, config, `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`, { method: 'DELETE' })
    if (!res.ok) console.error(`[business-number] ALERT bought number ${sid} not released (${res.status}): release it in Twilio`)
  } catch {
    console.error(`[business-number] ALERT bought number ${sid} not released: release it in Twilio`)
  }
}

async function insertNumber(supabase: SupabaseClient, args: { workspaceId: string; ownerUserId: string; phone: string; sid: string }): Promise<ProvisionResult> {
  const { data, error } = await supabase
    .from('business_phone_number')
    .insert({ workspace_id: args.workspaceId, owner_user_id: args.ownerUserId, phone_e164: args.phone, twilio_sid: args.sid, state: 'active' })
    .select(NUMBER_SELECT)
    .single<NumberRow>()
  if (data) return { ok: true, number: toNumber(data) }
  if (error?.code === '23505') return { ok: false, reason: 'taken' }
  return { ok: false, reason: 'failed', error: error?.message }
}

/**
 * Buy a US local number in `areaCode` for the workspace and wire it (see
 * the header). Refuses when the workspace already has one. Never throws.
 */
export async function buyBusinessNumber(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; areaCode: string; businessName: string },
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const config = deps.config === undefined ? twilioConfig() : deps.config
  if (!config) return { ok: false, reason: 'not_configured' }
  if (!/^[2-9]\d{2}$/.test(args.areaCode)) return { ok: false, reason: 'bad_input', error: 'An area code is three digits, like 929.' }
  try {
    if (await activeBusinessNumber(supabase, args.workspaceId)) return { ok: false, reason: 'has_number' }
    const accountUrl = `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}`
    const search = await twilio(deps, config, `${accountUrl}/AvailablePhoneNumbers/US/Local.json?AreaCode=${args.areaCode}&SmsEnabled=true&VoiceEnabled=true&PageSize=1`, { method: 'GET' })
    const candidate = Array.isArray(search.json?.available_phone_numbers) ? (search.json.available_phone_numbers as Array<{ phone_number?: unknown }>)[0]?.phone_number : undefined
    if (!search.ok) return { ok: false, reason: 'twilio_refused', error: `search refused (${search.status})` }
    if (typeof candidate !== 'string' || !isNanpNumber(candidate)) return { ok: false, reason: 'none_available' }
    const bought = await twilio(deps, config, `${accountUrl}/IncomingPhoneNumbers.json`, {
      method: 'POST',
      form: { PhoneNumber: candidate, SmsUrl: deps.webhookUrl ?? smsWebhookUrl(), SmsMethod: 'POST', FriendlyName: `${args.businessName} (NI)`.slice(0, 64) },
    })
    const sid = typeof bought.json?.sid === 'string' ? bought.json.sid : null
    if (!bought.ok || !sid) return { ok: false, reason: 'twilio_refused', error: `purchase refused (${bought.status})` }
    // Its webhook was set when it was bought (SmsUrl above).
    const recorded = await insertNumber(supabase, { workspaceId: args.workspaceId, ownerUserId: args.ownerUserId, phone: candidate, sid })
    // Bought but not recorded (a double submit lost the race): give it back, never leave it orphaned in the account.
    if (!recorded.ok) await releaseNumber(deps, config, sid)
    return recorded
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Attach a number already in Native Intelligence's Twilio account to the workspace and
 * wire it (see the header). Never throws.
 */
export async function attachBusinessNumber(
  supabase: SupabaseClient,
  args: { workspaceId: string; ownerUserId: string; phone: string },
  deps: ProvisionDeps = {},
): Promise<ProvisionResult> {
  const config = deps.config === undefined ? twilioConfig() : deps.config
  if (!config) return { ok: false, reason: 'not_configured' }
  const phone = normalizeE164(args.phone)
  if (!phone || !isNanpNumber(phone)) return { ok: false, reason: 'bad_input', error: 'A US or Canadian number, like +16465550173.' }
  // Native Intelligence's own numbers (the agent's, and a sign-up number when there is one) are never a business's.
  const dial8 = [config.fromNumber, process.env.TWILIO_SIGNUP_NUMBER].map((n) => normalizeE164(n)).filter(Boolean)
  if (dial8.includes(phone)) return { ok: false, reason: 'bad_input', error: "That is a Native Intelligence number itself: it can't be a business's." }
  try {
    if (await activeBusinessNumber(supabase, args.workspaceId)) return { ok: false, reason: 'has_number' }
    const accountUrl = `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}`
    const found = await twilio(deps, config, `${accountUrl}/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}&PageSize=1`, { method: 'GET' })
    const sid = Array.isArray(found.json?.incoming_phone_numbers) ? (found.json.incoming_phone_numbers as Array<{ sid?: unknown }>)[0]?.sid : undefined
    if (!found.ok) return { ok: false, reason: 'twilio_refused', error: `lookup refused (${found.status})` }
    if (typeof sid !== 'string') return { ok: false, reason: 'not_in_account' }
    const wired = await wireNumber(deps, config, sid)
    if (!wired.ok) return { ok: false, reason: 'twilio_refused', error: wired.error }
    return insertNumber(supabase, { workspaceId: args.workspaceId, ownerUserId: args.ownerUserId, phone, sid })
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
