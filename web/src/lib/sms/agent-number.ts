/**
 * A person's agent's own number (migration 465 agent_phone_number): a Twilio
 * number in Native Intelligence's messaging service (the sender pool of the approved 10DLC
 * campaign: docs/plans/text-and-calling-10dlc.md), theirs alone. Their agent
 * texts them from it, and they text it to reach their agent. Got on a button
 * in the agent panel's Phone tab, never on sign-up (Liam, 2026-11-02).
 * Production only: the Twilio account is shared, and another environment's
 * database would read PROD's numbers as free.
 *
 * The pool is the messaging service's numbers that carry one of Native Intelligence's
 * names; nothing else in the service is ever handed out or released:
 *   {@link SPARE_NAME}           bought by Native Intelligence, never held by anyone;
 *   {@link HELD_NAME}            handed out (renamed so when it is);
 *   "{@link FREE_PREFIX}<date>"  held once, free since that day.
 * A spare is one nobody holds now. Carriers register a number added to the
 * campaign before it can send (Twilio: allow up to a day, sometimes days), so:
 *   - getting one ({@link getAgentNumber}) takes the spare that joined the
 *     service longest ago, the likeliest registered. It never buys: every
 *     purchase and release is {@link balanceSpares}, run one at a time
 *     (src/lib/inngest/agent-numbers.ts), so no run of clicks buys a burst.
 *     With no spare it asks for one and says so (`none_ready`), and the
 *     Phone tab asks again shortly;
 *   - a text from it carries a status callback: one carriers refuse as not yet
 *     registered (30034 / 30035) is resent from the Native Intelligence number, and its
 *     texts go from there for {@link NI_FALLBACK_MS} (./status.ts).
 *
 * A number costs Native Intelligence every month it is held (a US local one is about $1.15),
 * so daily:
 *   - a number whose person hasn't texted in {@link IDLE_RECLAIM_MS} goes back
 *     to the pool ({@link reclaimIdleAgentNumbers}), still registered, and they
 *     are told; they get a new one from the Phone tab if they come back;
 *   - spares past {@link SPARE_TARGET} are released, the newest first: a
 *     never-held one at once, a once-held one only {@link RELEASE_QUARANTINE_MS}
 *     after it was freed. A released number is Twilio's to sell on, and its
 *     old holder's phone may still text it.
 * A number handed on inside Native Intelligence is safe: a text to any Native Intelligence number is
 * routed by who sent it (src/lib/sms/inbound.ts), never by the number texted,
 * so its old holder still reaches their own agent and never the new holder's.
 *
 * Inbound needs nothing of this. Business numbers (src/lib/customers/numbers.ts)
 * are never in the service, so never in this pool. Server only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { twilioConfig, twilioSmsWebhookUrl, type TwilioConfig } from '@/lib/twilio/config'
import { isE164, isNanpNumber, normalizeE164 } from '@/lib/twilio/phone'
import { TWILIO_MESSAGING_API, accountUrl, twilioRest } from '@/lib/twilio/rest'

/** A number Native Intelligence bought for the pool that nobody has held: the only kind released at once. */
export const SPARE_NAME = 'Dial8 spare number'
/** A number handed out to someone. */
export const HELD_NAME = 'Dial8 agent number'
/** A number held once and free since the date that follows (YYYY-MM-DD). */
export const FREE_PREFIX = 'Dial8 agent number, free since '
/** Spares kept ready in the pool. */
export const SPARE_TARGET = 2
/** Numbers people may hold at once; the pool never grows past this and the spares. */
export const MAX_AGENT_NUMBERS = 100
/** A number its person hasn't texted in this long goes back to the pool. */
export const IDLE_RECLAIM_MS = 30 * 24 * 60 * 60_000
/** A once-held spare is kept this long after it was freed before it may be released. */
export const RELEASE_QUARANTINE_MS = 90 * 24 * 60 * 60_000
/** After carriers refuse a text from a number as not yet registered, its texts go from the Native Intelligence number for this long. */
export const NI_FALLBACK_MS = 60 * 60_000
/** The event that runs {@link balanceSpares}, one at a time. */
export const AGENT_NUMBERS_BALANCE_EVENT = 'agent-numbers/pool.balance'
/** The text a person gets when their number goes back to the pool (from the Native Intelligence number). */
export const RECLAIMED_TEXT =
  "Dial8: You haven't texted your agent's own number in 30 days, so it has gone back to Dial8. Texting this number still reaches your agent, and you can get it a new number in the Dial8 app."

export interface AgentNumber {
  userId: string
  phone: string
  twilioSid: string
  createdAt: string
}

interface AgentNumberRow {
  user_id: string
  phone_e164: string
  twilio_sid: string
  dial8_until: string | null
  created_at: string
}

const NUMBER_SELECT = 'user_id, phone_e164, twilio_sid, dial8_until, created_at'

function toNumber(row: AgentNumberRow): AgentNumber {
  return { userId: row.user_id, phone: row.phone_e164, twilioSid: row.twilio_sid, createdAt: row.created_at }
}

/** Seams for the tests. */
export interface AgentNumberDeps {
  fetch?: typeof fetch
  config?: TwilioConfig | null
  now?: () => number
  webhookUrl?: string
  /** Whether this is Native Intelligence's production deployment (VERCEL_ENV). */
  production?: boolean
  /** Ask for {@link balanceSpares} (an Inngest event). */
  requestBalance?: () => Promise<unknown>
}

type PoolConfig = TwilioConfig & { messagingServiceSid: string; fromNumber: string }

/** The config with a messaging service and the Native Intelligence number, on production; else null: no pool here. */
function poolConfig(deps: AgentNumberDeps): PoolConfig | null {
  if (!(deps.production ?? process.env.VERCEL_ENV === 'production')) return null
  const config = deps.config === undefined ? twilioConfig() : deps.config
  return config?.messagingServiceSid && config.fromNumber ? (config as PoolConfig) : null
}

/** Whether people can get a number here (production, with a messaging service and the Native Intelligence number). */
export function agentNumbersAvailable(deps: AgentNumberDeps = {}): boolean {
  return poolConfig(deps) !== null
}

function requestBalance(deps: AgentNumberDeps): Promise<unknown> {
  return (deps.requestBalance ?? (() => inngest.send({ name: AGENT_NUMBERS_BALANCE_EVENT, data: { release: false } })))().catch((err) => {
    console.warn('[agent-number] balance not requested:', err instanceof Error ? err.message : String(err))
  })
}

const isOurs = (name: string | null) => name === SPARE_NAME || name === HELD_NAME || (name?.startsWith(FREE_PREFIX) ?? false)
const freeSince = (name: string | null): number | null => (name?.startsWith(FREE_PREFIX) ? Date.parse(`${name.slice(FREE_PREFIX.length)}T00:00:00Z`) : null)

// ── Reading ────────────────────────────────────────────────────────────────

/** The person's number, or null. Throws on a failed read. */
export async function agentNumberForUser(supabase: SupabaseClient, userId: string): Promise<AgentNumber | null> {
  const { data, error } = await supabase.from('agent_phone_number').select(NUMBER_SELECT).eq('user_id', userId).maybeSingle<AgentNumberRow>()
  if (error) throw new Error(`agent_phone_number read failed: ${error.message}`)
  return data ? toNumber(data) : null
}

/**
 * The number to text the person from: their agent's, unless carriers lately
 * refused it as not yet registered; null for the Native Intelligence number. Never throws (a
 * failed read is the Native Intelligence number: a text is never lost to it).
 */
export async function agentSender(supabase: SupabaseClient, userId: string, now: number = Date.now()): Promise<string | null> {
  try {
    const { data, error } = await supabase.from('agent_phone_number').select(NUMBER_SELECT).eq('user_id', userId).maybeSingle<AgentNumberRow>()
    if (error || !data || !isE164(data.phone_e164)) return null
    if (data.dial8_until && Date.parse(data.dial8_until) > now) return null
    return data.phone_e164
  } catch {
    return null
  }
}

// ── Twilio ─────────────────────────────────────────────────────────────────

interface PoolNumber {
  sid: string
  phone: string
  /** When it joined the messaging service. */
  addedAt: string
  /** Its friendly name in the account. */
  name: string | null
}

interface Pool {
  /** Every number of Native Intelligence's names in the service, held or not. */
  ours: PoolNumber[]
  /** Those people hold. */
  held: PoolNumber[]
  /** Those nobody holds, the longest in the service first. */
  spares: PoolNumber[]
}

/**
 * The pool, read from Twilio (the service's numbers, named from the account's)
 * and the holders' rows. Null when Twilio refused, or the Native Intelligence number isn't in
 * the service: every other Native Intelligence text is pinned to it (src/lib/twilio/client.ts),
 * so a service without it is not one to hand numbers out of. Throws on a
 * failed read of the rows.
 */
async function readPool(supabase: SupabaseClient, deps: AgentNumberDeps, config: PoolConfig): Promise<Pool | null> {
  const [service, account] = await Promise.all([
    twilioRest(config, `${TWILIO_MESSAGING_API}/Services/${encodeURIComponent(config.messagingServiceSid)}/PhoneNumbers?PageSize=1000`, { method: 'GET' }, deps.fetch),
    twilioRest(config, accountUrl(config, '/IncomingPhoneNumbers.json?PageSize=1000'), { method: 'GET' }, deps.fetch),
  ])
  if (!service.ok || !account.ok) return null
  const names = new Map<string, string>()
  for (const n of Array.isArray(account.json?.incoming_phone_numbers) ? (account.json.incoming_phone_numbers as Array<{ sid?: unknown; friendly_name?: unknown }>) : []) {
    if (typeof n.sid === 'string' && typeof n.friendly_name === 'string') names.set(n.sid, n.friendly_name)
  }
  const inService = (Array.isArray(service.json?.phone_numbers) ? (service.json.phone_numbers as Array<{ sid?: unknown; phone_number?: unknown; date_created?: unknown }>) : []).flatMap((r) =>
    typeof r.sid === 'string' && typeof r.phone_number === 'string' && isNanpNumber(r.phone_number)
      ? [{ sid: r.sid, phone: r.phone_number, addedAt: typeof r.date_created === 'string' ? r.date_created : '', name: names.get(r.sid) ?? null }]
      : [],
  )
  if (!inService.some((n) => n.phone === config.fromNumber)) {
    console.error('[agent-number] ALERT the Native Intelligence number is not in the messaging service: no agent numbers handed out or bought')
    return null
  }
  const own = new Set([config.fromNumber, process.env.TWILIO_SIGNUP_NUMBER].map((n) => normalizeE164(n)).filter(Boolean))
  const ours = inService.filter((n) => isOurs(n.name) && !own.has(n.phone))
  if (ours.length === 0) return { ours, held: [], spares: [] }
  const phones = ours.map((n) => n.phone)
  const [held, business] = await Promise.all([
    supabase.from('agent_phone_number').select('phone_e164').in('phone_e164', phones),
    // Never in the service by design (numbers.ts): kept out here all the same.
    supabase.from('business_phone_number').select('phone_e164').in('phone_e164', phones).eq('state', 'active'),
  ])
  if (held.error) throw new Error(`agent_phone_number read failed: ${held.error.message}`)
  if (business.error) throw new Error(`business_phone_number read failed: ${business.error.message}`)
  const holders = new Set((held.data ?? []).map((r) => (r as { phone_e164: string }).phone_e164))
  const taken = new Set([...holders, ...(business.data ?? []).map((r) => (r as { phone_e164: string }).phone_e164)])
  return {
    ours,
    held: ours.filter((n) => holders.has(n.phone)),
    spares: ours.filter((n) => !taken.has(n.phone)).sort((a, b) => a.addedAt.localeCompare(b.addedAt)),
  }
}

/**
 * The Native Intelligence number's voice setup (its SIP trunk, application or URL), to copy
 * onto an agent number: a call to it then reaches the agent as one to the
 * Native Intelligence number does (calls are routed by the caller: src/lib/calls/caller.ts).
 * Empty when it has none, or Twilio didn't say.
 */
async function niVoice(deps: AgentNumberDeps, config: PoolConfig): Promise<Record<string, string>> {
  try {
    const res = await twilioRest(config, accountUrl(config, `/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(config.fromNumber)}&PageSize=1`), { method: 'GET' }, deps.fetch)
    const n = Array.isArray(res.json?.incoming_phone_numbers) ? (res.json.incoming_phone_numbers as Array<Record<string, unknown>>)[0] : undefined
    if (!res.ok || !n) return {}
    if (typeof n.trunk_sid === 'string' && n.trunk_sid) return { TrunkSid: n.trunk_sid }
    if (typeof n.voice_application_sid === 'string' && n.voice_application_sid) return { VoiceApplicationSid: n.voice_application_sid }
    if (typeof n.voice_url === 'string' && n.voice_url) return { VoiceUrl: n.voice_url, VoiceMethod: typeof n.voice_method === 'string' ? n.voice_method : 'POST' }
    return {}
  } catch {
    return {}
  }
}

/** Update a number's settings. True when Twilio took it. */
async function updateNumber(deps: AgentNumberDeps, config: PoolConfig, sid: string, form: Record<string, string>): Promise<boolean> {
  try {
    const res = await twilioRest(config, accountUrl(config, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`), { method: 'POST', form }, deps.fetch)
    return res.ok
  } catch {
    return false
  }
}

/** Give a number back to Twilio. True when it went. */
async function releaseNumber(deps: AgentNumberDeps, config: PoolConfig, sid: string): Promise<boolean> {
  try {
    const res = await twilioRest(config, accountUrl(config, `/IncomingPhoneNumbers/${encodeURIComponent(sid)}.json`), { method: 'DELETE' }, deps.fetch)
    return res.ok
  } catch {
    return false
  }
}

/**
 * Buy a US local number as a spare, wired as Native Intelligence's, and add it to the
 * messaging service (the campaign registers it from there). A number bought
 * but not added is released again: one outside the pool can't send.
 */
async function buySpare(deps: AgentNumberDeps, config: PoolConfig, voice: Record<string, string>): Promise<boolean> {
  const search = await twilioRest(config, accountUrl(config, '/AvailablePhoneNumbers/US/Local.json?SmsEnabled=true&VoiceEnabled=true&PageSize=1'), { method: 'GET' }, deps.fetch)
  const candidate = search.ok && Array.isArray(search.json?.available_phone_numbers) ? (search.json.available_phone_numbers as Array<{ phone_number?: unknown }>)[0]?.phone_number : undefined
  if (typeof candidate !== 'string' || !isNanpNumber(candidate)) {
    console.warn(`[agent-number] no number to buy (${search.status})`)
    return false
  }
  const bought = await twilioRest(
    config,
    accountUrl(config, '/IncomingPhoneNumbers.json'),
    { method: 'POST', form: { PhoneNumber: candidate, FriendlyName: SPARE_NAME, SmsUrl: deps.webhookUrl ?? twilioSmsWebhookUrl(), SmsMethod: 'POST', ...voice } },
    deps.fetch,
  )
  const sid = typeof bought.json?.sid === 'string' ? bought.json.sid : null
  if (!bought.ok || !sid) {
    console.warn(`[agent-number] purchase refused (${bought.status})`)
    return false
  }
  let added = false
  try {
    const res = await twilioRest(config, `${TWILIO_MESSAGING_API}/Services/${encodeURIComponent(config.messagingServiceSid)}/PhoneNumbers`, { method: 'POST', form: { PhoneNumberSid: sid } }, deps.fetch)
    added = res.ok
  } catch {
    added = false
  }
  if (!added) {
    console.error(`[agent-number] ALERT bought number ${sid} refused by the messaging service: released, so it was paid for unused`)
    if (!(await releaseNumber(deps, config, sid))) console.error(`[agent-number] ALERT bought number ${sid} is outside the messaging service and not released: add or release it in Twilio`)
    return false
  }
  return true
}

// ── Getting one ────────────────────────────────────────────────────────────

export type GetAgentNumberResult =
  | { ok: true; number: AgentNumber; fresh: boolean }
  | { ok: false; reason: 'not_configured' | 'limit' | 'none_ready' | 'twilio_refused' | 'failed'; error?: string }

type Claim = { kind: 'ok'; number: AgentNumber } | { kind: 'held'; number: AgentNumber } | { kind: 'taken' } | { kind: 'failed'; error?: string }

/** Write the person's row for `spare`: a unique key lost means they already have one (a double click), or someone took the spare first. */
async function claim(supabase: SupabaseClient, userId: string, spare: PoolNumber): Promise<Claim> {
  const { data, error } = await supabase
    .from('agent_phone_number')
    .insert({ user_id: userId, phone_e164: spare.phone, twilio_sid: spare.sid })
    .select(NUMBER_SELECT)
    .single<AgentNumberRow>()
  if (data) return { kind: 'ok', number: toNumber(data) }
  if (error?.code !== '23505') return { kind: 'failed', error: error?.message }
  const mine = await agentNumberForUser(supabase, userId)
  return mine ? { kind: 'held', number: mine } : { kind: 'taken' }
}

/**
 * Give the person's agent its own number: the one it has, else the spare
 * longest in the pool, named as held and given the Native Intelligence number's webhooks.
 * Asks for a replacement spare after taking one, and for a spare when there
 * is none (`none_ready`: ask again shortly). Refuses past {@link MAX_AGENT_NUMBERS}.
 * `fresh` when the number is new to them. Never buys, never throws.
 */
export async function getAgentNumber(supabase: SupabaseClient, args: { userId: string }, deps: AgentNumberDeps = {}): Promise<GetAgentNumberResult> {
  const config = poolConfig(deps)
  if (!config) return { ok: false, reason: 'not_configured' }
  try {
    const existing = await agentNumberForUser(supabase, args.userId)
    if (existing) return { ok: true, number: existing, fresh: false }
    const { count, error } = await supabase.from('agent_phone_number').select('user_id', { count: 'exact', head: true })
    if (error) return { ok: false, reason: 'failed', error: error.message }
    if ((count ?? 0) >= MAX_AGENT_NUMBERS) return { ok: false, reason: 'limit' }
    const pool = await readPool(supabase, deps, config)
    if (!pool) return { ok: false, reason: 'twilio_refused' }
    for (const spare of pool.spares) {
      const claimed = await claim(supabase, args.userId, spare)
      if (claimed.kind === 'ok') {
        const voice = await niVoice(deps, config)
        if (!(await updateNumber(deps, config, spare.sid, { FriendlyName: HELD_NAME, SmsUrl: deps.webhookUrl ?? twilioSmsWebhookUrl(), SmsMethod: 'POST', ...voice }))) {
          console.warn(`[agent-number] number ${spare.sid} not renamed as held`)
        }
        await requestBalance(deps)
        return { ok: true, number: claimed.number, fresh: true }
      }
      if (claimed.kind === 'held') return { ok: true, number: claimed.number, fresh: false }
      if (claimed.kind === 'failed') return { ok: false, reason: 'failed', error: claimed.error }
    }
    await requestBalance(deps)
    return { ok: false, reason: 'none_ready' }
  } catch (err) {
    return { ok: false, reason: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}

// ── Keeping the pool ───────────────────────────────────────────────────────

/** Carriers refused a text from `phone` as not yet registered: its texts go from the Native Intelligence number for a while. Throws on a failed write. */
export async function holdAgentNumber(supabase: SupabaseClient, phone: string, now: number = Date.now()): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_phone_number')
    .update({ dial8_until: new Date(now + NI_FALLBACK_MS).toISOString() })
    .eq('phone_e164', phone)
    .select('user_id')
  if (error) throw new Error(`agent_phone_number update failed: ${error.message}`)
  return (data ?? []).length > 0
}

/**
 * Take back every number whose person hasn't texted a Native Intelligence number in
 * {@link IDLE_RECLAIM_MS} (counted from when they got it, so a number never
 * texted goes too): its row goes, and it is a spare again ({@link balanceSpares}
 * dates it). Returns whose were taken (to tell them). Throws on a failed read.
 */
export async function reclaimIdleAgentNumbers(supabase: SupabaseClient, deps: { now?: () => number } = {}): Promise<string[]> {
  const cutoff = new Date((deps.now ?? Date.now)() - IDLE_RECLAIM_MS).toISOString()
  const { data, error } = await supabase.from('agent_phone_number').select(NUMBER_SELECT).lt('created_at', cutoff).limit(500)
  if (error) throw new Error(`agent_phone_number read failed: ${error.message}`)
  const reclaimed: string[] = []
  for (const row of (data ?? []) as AgentNumberRow[]) {
    const { data: linked, error: phoneError } = await supabase.from('user_phone').select('phone_e164').eq('user_id', row.user_id).not('verified_at', 'is', null).maybeSingle<{ phone_e164: string }>()
    if (phoneError) throw new Error(`user_phone read failed: ${phoneError.message}`)
    if (linked) {
      const { data: last, error: lastError } = await supabase
        .from('sms_message')
        .select('created_at')
        .eq('phone_e164', linked.phone_e164)
        .eq('direction', 'in')
        .gte('created_at', cutoff)
        .limit(1)
      if (lastError) throw new Error(`sms_message read failed: ${lastError.message}`)
      if ((last ?? []).length > 0) continue
    }
    // Only the row as read: a number got again in between is the person's new one.
    const { error: deleteError } = await supabase.from('agent_phone_number').delete().eq('user_id', row.user_id).eq('phone_e164', row.phone_e164)
    if (deleteError) throw new Error(`agent_phone_number delete failed: ${deleteError.message}`)
    reclaimed.push(row.user_id)
  }
  return reclaimed
}

/** Whether someone holds `phone` now; true on a failed read (nothing is done to a number that might be someone's). */
async function heldNow(supabase: SupabaseClient, phone: string): Promise<boolean> {
  const { data, error } = await supabase.from('agent_phone_number').select('user_id').eq('phone_e164', phone).maybeSingle()
  return Boolean(error || data)
}

/**
 * Keep the pool: name every held number as held (a rename that failed at
 * hand-out, or a number dated while it was being claimed, must never read as
 * releasable), date the spares freed since the last pass ({@link FREE_PREFIX}),
 * buy spares up to {@link SPARE_TARGET} (never past {@link MAX_AGENT_NUMBERS}
 * and the target in all), and with `release`, give back those past the target,
 * the newest first: a never-held one, or a once-held one freed more than
 * {@link RELEASE_QUARANTINE_MS} ago, and only while nobody holds it. Run one
 * at a time (its Inngest function's concurrency). Never throws.
 */
export async function balanceSpares(supabase: SupabaseClient, opts: { release: boolean }, deps: AgentNumberDeps = {}): Promise<{ spares: number; bought: number; released: number }> {
  const config = poolConfig(deps)
  const none = { spares: 0, bought: 0, released: 0 }
  if (!config) return none
  const now = (deps.now ?? Date.now)()
  try {
    const pool = await readPool(supabase, deps, config)
    if (!pool) return none
    for (const held of pool.held) {
      if (held.name !== HELD_NAME && !(await updateNumber(deps, config, held.sid, { FriendlyName: HELD_NAME }))) console.warn(`[agent-number] held number ${held.sid} not renamed as held`)
    }
    const today = new Date(now).toISOString().slice(0, 10)
    for (const spare of pool.spares) {
      if (spare.name !== HELD_NAME || (await heldNow(supabase, spare.phone))) continue
      if (await updateNumber(deps, config, spare.sid, { FriendlyName: `${FREE_PREFIX}${today}` })) spare.name = `${FREE_PREFIX}${today}`
    }

    let bought = 0
    const short = Math.min(SPARE_TARGET - pool.spares.length, MAX_AGENT_NUMBERS + SPARE_TARGET - pool.ours.length)
    if (short > 0) {
      const voice = await niVoice(deps, config)
      for (let i = 0; i < short; i++) {
        if (!(await buySpare(deps, config, voice))) break
        bought++
      }
    }

    let released = 0
    if (opts.release) {
      for (const spare of pool.spares.slice(SPARE_TARGET).reverse()) {
        const freed = freeSince(spare.name)
        const releasable = spare.name === SPARE_NAME || (freed !== null && Number.isFinite(freed) && now - freed > RELEASE_QUARANTINE_MS)
        if (!releasable) continue
        // Taken since the pool was read: it is someone's now.
        if (await heldNow(supabase, spare.phone)) continue
        if (await releaseNumber(deps, config, spare.sid)) released++
        else console.warn(`[agent-number] spare ${spare.sid} not released`)
      }
    }
    return { spares: pool.spares.length + bought - released, bought, released }
  } catch (err) {
    console.warn('[agent-number] pool not balanced:', err instanceof Error ? err.message : String(err))
    return none
  }
}
