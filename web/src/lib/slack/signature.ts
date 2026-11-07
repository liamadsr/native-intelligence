/**
 * Slack's own request signature (X-Slack-Signature, v0), for the one path
 * that may reach this app straight from Slack instead of through Vercel
 * Connect: the Interactivity request URL, when Connect does not forward
 * button clicks (docs/plans/slack-connect.md §4 piece 6). HMAC-SHA256 over
 * `v0:<timestamp>:<raw body>` with the Slack app's signing secret, compared
 * in constant time, and the timestamp within five minutes (a replay is
 * refused). The secret lives only in SLACK_SIGNING_SECRET, set by Liam; this
 * module never logs it. Unset: nothing verifies (fails closed).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

const MAX_SKEW_SECONDS = 5 * 60

export function verifySlackSignature(
  headers: Headers,
  rawBody: string,
  opts: { secret?: string | null; now?: number } = {},
): boolean {
  const secret = opts.secret ?? process.env.SLACK_SIGNING_SECRET
  if (!secret) return false
  const timestamp = headers.get('x-slack-request-timestamp') ?? ''
  const signature = headers.get('x-slack-signature') ?? ''
  if (!/^[0-9]{1,12}$/.test(timestamp) || !signature.startsWith('v0=')) return false
  const nowSeconds = Math.floor((opts.now ?? Date.now()) / 1000)
  if (Math.abs(nowSeconds - Number(timestamp)) > MAX_SKEW_SECONDS) return false
  const expected = `v0=${createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex')}`
  const a = new Uint8Array(Buffer.from(signature, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}
