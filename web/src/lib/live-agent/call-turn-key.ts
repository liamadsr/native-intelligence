/**
 * The key that says a live turn on a call's capture is the server's own
 * (src/lib/team-calls/live-turns.ts), server only. A call's capture is filled
 * by the call recorder and its live notes are written by the server's turns;
 * no person's app may drive a second agent on it (POST /api/ai/live-agent
 * refuses a live turn on a call's capture without this key). An HMAC of the
 * capture's id under the live agent's internal secret, so only a process that
 * holds that secret can make it, and one capture's key opens no other.
 */
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { internalSecret } from './live-agent-run-token'

function keyFor(captureId: string, secret: string): string {
  return createHmac('sha256', secret).update(`call-live-turn:${captureId.toLowerCase()}`).digest('base64url')
}

/** The key for a capture's server turns; null when no internal secret is set (no turn may be signed). */
export function callTurnKey(captureId: string): string | null {
  const secret = internalSecret()
  return secret ? keyFor(captureId, secret) : null
}

/** Is `presented` this capture's key? */
export function verifyCallTurnKey(captureId: string, presented: unknown): boolean {
  const secret = internalSecret()
  if (!secret || typeof presented !== 'string' || presented.length === 0) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(keyFor(captureId, secret), 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}
