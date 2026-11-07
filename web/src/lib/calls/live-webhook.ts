/**
 * OpenAI's webhooks for GPT-Live calls (the spike; docs/plans/text-and-calling.md
 * Phase 4). OpenAI signs every delivery "following the Standard Webhooks
 * specification" (developers.openai.com/api/docs/guides/webhooks): an
 * HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<raw body>` keyed with the
 * project's `whsec_` secret (base64 after the prefix), sent as one or more
 * space-separated `v1,<base64>` entries in `webhook-signature`. We verify the
 * raw body, and refuse a timestamp more than five minutes off (a replay).
 *
 * Pure: the route passes the body, the headers and the secret.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** How far a delivery's timestamp may be from now, either way. */
export const LIVE_WEBHOOK_TOLERANCE_S = 5 * 60

export type LiveWebhookVerdict = { ok: true } | { ok: false; reason: 'no_secret' | 'missing_headers' | 'stale' | 'bad_signature' }

/**
 * The secret's key bytes: base64 after `whsec_` (a secret without the prefix
 * is taken as base64 too). Uint8Array views throughout, for node:crypto's
 * typing (as chat-run-token.ts does).
 */
function secretKey(secret: string): Uint8Array | null {
  const raw = secret.startsWith('whsec_') ? secret.slice('whsec_'.length) : secret
  const key = new Uint8Array(Buffer.from(raw, 'base64'))
  return key.length > 0 ? key : null
}

/** True when `signature` carries a `v1` entry equal to the expected one. */
function signatureMatches(expected: Uint8Array, header: string): boolean {
  for (const entry of header.split(' ')) {
    const [version, value] = entry.split(',', 2)
    if (version !== 'v1' || !value) continue
    const given = new Uint8Array(Buffer.from(value, 'base64'))
    if (given.length === expected.length && timingSafeEqual(given, expected)) return true
  }
  return false
}

/** Verify one delivery. `nowS` is a seam for the tests. */
export function verifyLiveWebhook(args: {
  body: string
  id: string | null
  timestamp: string | null
  signature: string | null
  secret: string | undefined
  nowS?: number
}): LiveWebhookVerdict {
  const key = args.secret ? secretKey(args.secret) : null
  if (!key) return { ok: false, reason: 'no_secret' }
  if (!args.id || !args.timestamp || !args.signature) return { ok: false, reason: 'missing_headers' }
  const ts = Number(args.timestamp)
  const now = args.nowS ?? Math.floor(Date.now() / 1000)
  if (!Number.isFinite(ts) || Math.abs(now - ts) > LIVE_WEBHOOK_TOLERANCE_S) return { ok: false, reason: 'stale' }
  const expected = new Uint8Array(createHmac('sha256', key).update(`${args.id}.${args.timestamp}.${args.body}`).digest())
  return signatureMatches(expected, args.signature) ? { ok: true } : { ok: false, reason: 'bad_signature' }
}

/** One SIP header as the webhook lists it. */
export interface SipHeader {
  name: string
  value: string
}

/** The `live.transport.incoming` event's fields we read; null for anything else. */
export interface LiveIncomingCall {
  sessionId: string
  sipHeaders: SipHeader[]
}

/** The incoming SIP call a delivery announces, or null (another event type, or a malformed one). */
export function parseLiveIncomingCall(event: unknown): LiveIncomingCall | null {
  if (!event || typeof event !== 'object') return null
  const e = event as { type?: unknown; data?: unknown }
  if (e.type !== 'live.transport.incoming' || !e.data || typeof e.data !== 'object') return null
  const data = e.data as { type?: unknown; session_id?: unknown; sip_headers?: unknown }
  if (data.type !== 'sip' || typeof data.session_id !== 'string' || !data.session_id) return null
  const sipHeaders = Array.isArray(data.sip_headers)
    ? data.sip_headers.flatMap((h) => {
        const header = h as { name?: unknown; value?: unknown } | null
        return header && typeof header.name === 'string' && typeof header.value === 'string' ? [{ name: header.name, value: header.value }] : []
      })
    : []
  return { sessionId: data.session_id, sipHeaders }
}
