/**
 * Twilio's REST API for the number work (plain fetch: no SDK in this app),
 * shared by a business's number (src/lib/customers/numbers.ts) and a
 * person's agent number (src/lib/sms/agent-number.ts). Basic auth with the
 * account's SID and token, a form body on a write. Throws on a network
 * failure or a timeout; a refusal is `ok: false` with its status.
 */
import type { TwilioConfig } from './config'

export const TWILIO_API = 'https://api.twilio.com/2010-04-01'
/** Messaging services (their sender pools) live on their own host. */
export const TWILIO_MESSAGING_API = 'https://messaging.twilio.com/v1'
const TIMEOUT_MS = 15_000

export interface TwilioRestResult {
  ok: boolean
  status: number
  json: Record<string, unknown> | null
}

export async function twilioRest(
  config: Pick<TwilioConfig, 'accountSid' | 'authToken'>,
  url: string,
  init: { method: 'GET' | 'POST' | 'DELETE'; form?: Record<string, string> },
  fetchImpl: typeof fetch = fetch,
): Promise<TwilioRestResult> {
  const auth = Buffer.from(`${config.accountSid}:${config.authToken}`, 'utf8').toString('base64')
  const res = await fetchImpl(url, {
    method: init.method,
    headers: { Authorization: `Basic ${auth}`, ...(init.form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
    ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
    redirect: 'error',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: res.ok, status: res.status, json }
}

/** An account's own resource URL: `/Accounts/{sid}` plus `path`. */
export function accountUrl(config: Pick<TwilioConfig, 'accountSid'>, path: string): string {
  return `${TWILIO_API}/Accounts/${encodeURIComponent(config.accountSid)}${path}`
}
