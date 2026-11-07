/**
 * A text's outcome from Twilio (POST /api/twilio/sms/status): only texts
 * sent from an agent number ask for one (src/lib/twilio/client.ts). When
 * carriers refuse one as from a number not yet registered to the campaign
 * (30034 / 30035: a number joins it within a day, sometimes days), the
 * number's texts go from the Dial8 number for a while
 * (src/lib/sms/agent-number.ts, holdAgentNumber), and this text is resent
 * from it, once: the ledger row's `resend_of` key is the claim (migration
 * 465), taken before the send. At most once, as every reply: a resend that
 * fails is not tried again. Every other outcome is ignored.
 *
 * The words are read back from Twilio (the ledger keeps none). Logs ids and
 * outcomes only, never a number or a word.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { holdAgentNumber } from './agent-number'
import type { SmsOutboundKind } from './store'
import { TWILIO_UNREGISTERED_SENDER, sendSms } from '@/lib/twilio/client'
import { twilioConfig, type TwilioConfig } from '@/lib/twilio/config'
import { isE164 } from '@/lib/twilio/phone'
import { accountUrl, twilioRest } from '@/lib/twilio/rest'

export interface SmsStatusInput {
  sid: string
  status: string
  errorCode: number | null
  from: string
  to: string
}

export type SmsStatusOutcome = 'ignored' | 'not_agent_number' | 'already_resent' | 'resent' | 'resend_failed'

/** Seams for the tests. */
export interface SmsStatusDeps {
  fetch?: typeof fetch
  config?: TwilioConfig | null
  send?: typeof sendSms
  now?: () => number
}

const FAILED = new Set(['failed', 'undelivered'])

/** Act on one status callback. Throws on a failed read or write (the route answers 500, and Twilio's own retry is welcome). */
export async function handleSmsStatus(supabase: SupabaseClient, input: SmsStatusInput, deps: SmsStatusDeps = {}): Promise<SmsStatusOutcome> {
  if (!FAILED.has(input.status) || input.errorCode === null || !TWILIO_UNREGISTERED_SENDER.includes(input.errorCode)) return 'ignored'
  if (!input.sid || !isE164(input.from) || !isE164(input.to)) return 'ignored'
  if (!(await holdAgentNumber(supabase, input.from, (deps.now ?? Date.now)()))) return 'not_agent_number'

  // The text as the ledger has it (its kind, whose), when it was written before this callback came.
  const { data: original, error: readError } = await supabase
    .from('sms_message')
    .select('kind, user_id')
    .eq('direction', 'out')
    .eq('twilio_sid', input.sid)
    .maybeSingle<{ kind: SmsOutboundKind; user_id: string | null }>()
  if (readError) throw new Error(`sms_message read failed: ${readError.message}`)
  const { data: claim, error: claimError } = await supabase
    .from('sms_message')
    .insert({ direction: 'out', kind: original?.kind ?? 'notice', phone_e164: input.to, user_id: original?.user_id ?? null, resend_of: input.sid })
    .select('id')
    .single<{ id: string }>()
  if (claimError?.code === '23505') return 'already_resent'
  if (claimError || !claim) throw new Error(`sms_message claim failed: ${claimError?.message ?? 'no row'}`)

  const config = deps.config === undefined ? twilioConfig() : deps.config
  if (!config) return 'resend_failed'
  const message = await twilioRest(config, accountUrl(config, `/Messages/${encodeURIComponent(input.sid)}.json`), { method: 'GET' }, deps.fetch).catch(() => null)
  const body = typeof message?.json?.body === 'string' ? message.json.body : ''
  if (!message?.ok || !body) return 'resend_failed'
  // From the Dial8 number (no sender: client.ts pins it).
  const sent = await (deps.send ?? sendSms)(input.to, body, { config, ...(deps.fetch ? { fetch: deps.fetch } : {}) })
  if (!sent.ok) return 'resend_failed'
  await supabase.from('sms_message').update({ twilio_sid: sent.sid }).eq('id', claim.id)
  return 'resent'
}
