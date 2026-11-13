/**
 * The key that says a live turn on a call's capture is the server's own
 * (src/lib/team-calls/live-turns.ts), server only. A call's capture is filled
 * by the call recorder and its live notes are written by the server's turns;
 * no person's app may drive a second agent on it (POST /api/ai/live-agent
 * refuses a live turn on a call's capture without this key). An HMAC of the
 * capture's id AND the running turn's lease under the live agent's internal
 * secret: only a process that holds that secret can make it, one capture's
 * key opens no other, and one turn's key opens no later turn. The route also
 * checks that the lease is the one running now (655's
 * team_call_live_turn_lease_until), so a replayed or late turn is refused, and
 * it stops the turn's tools at the lease's end.
 */
import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { internalSecret } from './live-agent-run-token'

function keyFor(captureId: string, lease: string, secret: string): string {
  return createHmac('sha256', secret).update(`call-live-turn:${captureId.toLowerCase()}:${lease.toLowerCase()}`).digest('base64url')
}

/** The key for one server turn on a capture; null when no internal secret is set (no turn may be signed). */
export function callTurnKey(captureId: string, lease: string): string | null {
  const secret = internalSecret()
  return secret ? keyFor(captureId, lease, secret) : null
}

/** Is `presented` the key of this capture's turn holding `lease`? */
export function verifyCallTurnKey(captureId: string, lease: unknown, presented: unknown): boolean {
  const secret = internalSecret()
  if (!secret || typeof lease !== 'string' || lease.length === 0 || typeof presented !== 'string' || presented.length === 0) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(keyFor(captureId, lease, secret), 'utf8'))
  return a.length === b.length && timingSafeEqual(a, b)
}
