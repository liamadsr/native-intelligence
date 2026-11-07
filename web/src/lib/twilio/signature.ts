/**
 * Twilio webhook signatures (X-Twilio-Signature), per Twilio's spec: take the
 * full URL Twilio requested (scheme, host, path and query, exactly as
 * configured in the console), append each POST parameter's name and value,
 * sorted by name, with no separators; HMAC-SHA1 that string with the account's
 * auth token; base64. Compared in constant time. Fails closed: no token, no
 * signature, or any mismatch is false.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { twilioWebhookUrlOverride } from './config'

/** The header Twilio signs every webhook with. */
export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature'

/** The expected signature for a request (exported for the tests). */
export function computeTwilioSignature(url: string, params: Record<string, string>, authToken: string): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url)
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64')
}

/** True when `signature` is Twilio's for this URL and these POST params. */
export function validateTwilioSignature(
  url: string,
  params: Record<string, string>,
  signature: string | null | undefined,
  authToken: string | null | undefined,
): boolean {
  if (!authToken || !signature || !url) return false
  const expected = new Uint8Array(Buffer.from(computeTwilioSignature(url, params, authToken), 'utf8'))
  const presented = new Uint8Array(Buffer.from(signature, 'utf8'))
  return expected.length === presented.length && timingSafeEqual(expected, presented)
}

/**
 * The public URL Twilio posted to: TWILIO_WEBHOOK_URL when set (a proxy or a
 * tunnel in front of the app), else the request's own URL with the forwarded
 * scheme and host (Vercel sets them to the public ones).
 */
export function twilioRequestUrl(request: Request, override: string | null = twilioWebhookUrlOverride()): string {
  if (override) return override
  const url = new URL(request.url)
  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim()
  const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim()
  if (proto === 'http' || proto === 'https') url.protocol = `${proto}:`
  if (host) {
    url.host = host
    // A forwarded host without a port is the scheme's default port.
    if (!host.includes(':')) url.port = ''
  }
  return url.toString()
}
