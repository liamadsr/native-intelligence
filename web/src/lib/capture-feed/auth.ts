/**
 * Who may speak on the capture feed: a producer holding CAPTURE_FEED_SECRET,
 * sent as `Authorization: Bearer <secret>`, compared in constant time.
 *
 * The secret is its own, with no fallback (src/lib/eve/internal-secret.ts,
 * family 'capture-feed'): its holder runs outside the app's containers (the
 * call recorder, in LiveKit's stack), so an unset secret turns the feed off
 * rather than hand that service the skill-runner's key, and so does one
 * equal to any other internal secret (whoever holds the feed's would hold
 * that one too). Server only.
 */
import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { internalSecretStatus, resolveInternalSecret } from '@/lib/eve/internal-secret'

export const CAPTURE_FEED_SECRET_ENV = 'CAPTURE_FEED_SECRET'

/** The feed's secret, or null when the feed is off (unset, empty, or shared with another internal secret). */
export function captureFeedSecret(): string | null {
  const secret = resolveInternalSecret('capture-feed', CAPTURE_FEED_SECRET_ENV, { fallback: false })
  if (!secret) return null
  return internalSecretStatus(CAPTURE_FEED_SECRET_ENV, { fallback: false }).source === 'dedicated' ? secret : null
}

function sameSecret(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** 'off': the feed is off here (answer 404); 'refused': a request without the secret (401); 'ok'. */
export function checkCaptureFeedAuth(request: Request): 'off' | 'refused' | 'ok' {
  const expected = captureFeedSecret()
  if (!expected) return 'off'
  const header = request.headers.get('authorization') ?? ''
  const presented = header.startsWith('Bearer ') ? header.slice(7) : ''
  if (!presented || !sameSecret(presented, expected)) return 'refused'
  return 'ok'
}
