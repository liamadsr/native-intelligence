/**
 * Bearer auth for the local agent's eve channel: a constant-time check of
 * the per-launch LOCAL_AGENT_SECRET (pattern: agents/coding-agent/lib/auth.ts).
 * An unset or empty secret admits nobody.
 */
import { timingSafeEqual } from 'node:crypto'
import type { AuthFn } from 'eve/channels/auth'

function extractBearer(request: Request): string | null {
  const h = request.headers.get('authorization')
  if (!h || !h.startsWith('Bearer ')) return null
  const token = h.slice(7)
  return token.length > 0 ? token : null
}

/** Constant-time equality; false on any length mismatch or unset secret. */
export function secretMatches(presented: string | null, expected: string | undefined): boolean {
  if (!expected || !presented) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** The one principal: the desktop app that launched this job. */
export function localAgentSecretAuth(): AuthFn<Request> {
  return async (request) => {
    if (!secretMatches(extractBearer(request), process.env.LOCAL_AGENT_SECRET)) return null
    return {
      authenticator: 'local-agent-secret',
      principalId: 'dial8-desktop',
      principalType: 'service',
      attributes: { jobId: process.env.LOCAL_AGENT_JOB_ID ?? '' },
    }
  }
}
