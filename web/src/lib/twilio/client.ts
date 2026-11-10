/**
 * Outbound SMS over Twilio's REST API (plain fetch: no SDK in this app).
 * POST /2010-04-01/Accounts/{sid}/Messages.json with Basic auth and a form
 * body (To, From and/or MessagingServiceSid, Body). Never throws: every
 * outcome is a {@link SendSmsResult} the caller logs or records.
 *
 * Through Native Intelligence's messaging service, a text is pinned to its sender: the
 * person's agent number when the caller names one (`sender`), else the Native Intelligence
 * number. The service's pool holds every agent number too
 * (src/lib/sms/agent-number.ts), and left to itself Twilio would pick any of
 * them. A sender the service doesn't hold (21711) falls back to the Native Intelligence
 * number, then to the service's own pick; an agent number carriers refuse
 * outright as not yet registered (30034 / 30035) falls back the same way.
 */
import { twilioConfig, twilioStatusCallbackUrl, type TwilioConfig } from './config'

const TWILIO_API = 'https://api.twilio.com/2010-04-01'
/** How long one send may take. */
const SEND_TIMEOUT_MS = 10_000

/** Twilio's error for a number that texted STOP: it will not deliver to it. */
export const TWILIO_UNSUBSCRIBED = 21610
/** The `From` is not a sender in the messaging service named. */
export const TWILIO_SENDER_NOT_IN_SERVICE = 21711
/** Carriers' refusals of a 10DLC number that is not registered to a campaign yet (unregistered; registration pending). */
export const TWILIO_UNREGISTERED_SENDER: readonly number[] = [30034, 30035]

export type SendSmsResult =
  | { ok: true; sid: string }
  | {
      ok: false
      /** 'not_configured': no Twilio env; 'unsubscribed': the number opted out (21610); 'refused': Twilio said no; 'network': no answer. */
      reason: 'not_configured' | 'unsubscribed' | 'refused' | 'network'
      code?: number
      status?: number
    }

/** Seams for the tests, and the sender. */
export interface SendSmsDeps {
  fetch?: typeof fetch
  config?: TwilioConfig | null
  /**
   * Send from this number instead of the Native Intelligence one: a business's own number,
   * to its customer (roadmap B2, src/lib/customers/numbers.ts). It goes as a
   * plain `From`, never through Native Intelligence's messaging service: a business number
   * is never in Native Intelligence's sender pool, so Twilio can never pick it for a Native Intelligence
   * text (and a Native Intelligence number for a business's).
   */
  from?: string | null
  /**
   * Send from this number in Native Intelligence's own messaging service: the person's
   * agent number (src/lib/sms/agent-number.ts). Through the service as ever
   * (its campaign, its opt-outs), From it, with a status callback: a text
   * carriers refuse later as not yet registered is resent from the Native Intelligence
   * number (src/lib/sms/status.ts).
   */
  sender?: string | null
}

/** Send one SMS. `body` is sent as is (format it first: ./sms-format.ts). */
export async function sendSms(to: string, body: string, deps: SendSmsDeps = {}): Promise<SendSmsResult> {
  const config = deps.config === undefined ? twilioConfig() : deps.config
  if (!config) return { ok: false, reason: 'not_configured' }
  const post = (from: string | null, service: boolean, callback: boolean) => {
    const form = new URLSearchParams({ To: to, Body: body })
    if (service && config.messagingServiceSid) form.set('MessagingServiceSid', config.messagingServiceSid)
    if (from) form.set('From', from)
    if (callback) form.set('StatusCallback', twilioStatusCallbackUrl())
    return postMessage(config, form, deps.fetch ?? fetch)
  }
  if (deps.from) return post(deps.from, false, false)
  if (!config.messagingServiceSid) return post(config.fromNumber, false, false)
  // The agent number, the Native Intelligence number, then the service's own pick (null).
  const senders = [...new Set([deps.sender, config.fromNumber].filter((n): n is string => Boolean(n))), null]
  let result: SendSmsResult = { ok: false, reason: 'network' }
  for (const [i, from] of senders.entries()) {
    const agent = from !== null && from === deps.sender
    result = await post(from, true, agent)
    const code = result.ok ? undefined : result.code
    const next = code === TWILIO_SENDER_NOT_IN_SERVICE || (agent && code !== undefined && TWILIO_UNREGISTERED_SENDER.includes(code))
    if (!next || i === senders.length - 1) return result
  }
  return result
}

async function postMessage(config: TwilioConfig, form: URLSearchParams, fetchImpl: typeof fetch): Promise<SendSmsResult> {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`, 'utf8').toString('base64')
  let res: Response
  try {
    res = await fetchImpl(`${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    })
  } catch {
    return { ok: false, reason: 'network' }
  }
  const json = (await res.json().catch(() => null)) as { sid?: unknown; code?: unknown } | null
  if (res.ok && typeof json?.sid === 'string') return { ok: true, sid: json.sid }
  const code = typeof json?.code === 'number' ? json.code : undefined
  if (code === TWILIO_UNSUBSCRIBED) return { ok: false, reason: 'unsubscribed', code, status: res.status }
  return { ok: false, reason: 'refused', ...(code !== undefined ? { code } : {}), status: res.status }
}
