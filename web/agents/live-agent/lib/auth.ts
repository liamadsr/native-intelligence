/**
 * Internal-only route auth for the `live-agent` eve agent (LIVE-AGENT-DESIGN §3.1).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SIBLING of agents/work-agent/lib/auth.ts and agents/skill-runner/lib/     │
 * │ auth.ts (eve roots cannot share imports). Same walk, own secret + headers.│
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * This agent is NEVER browser-driven. Each live-meeting turn is one one-shot session
 * the cloud route (`POST /api/ai/live-agent`) creates server-to-server. So the
 * auth surface is deliberately narrow — no cookie/session path at all:
 *
 *   1. sharedSecretAuth() — a constant-time bearer check of
 *      LIVE_AGENT_INTERNAL_SECRET (falling back to RUN_SKILL_INTERNAL_SECRET, the
 *      root of the internal-secret chain, so one secret bootstraps dev). After it
 *      verifies, the per-turn run token header (x-live-agent-token) is stamped
 *      onto the principal's attributes so the dynamic resolvers can forward it
 *      to the internal spec/tool routes.
 *   2. localDevOffVercel() — eve's dev fallback so `eve dev` / local smoke
 *      works, refused on any Vercel deployment.
 *
 * NO vercelOidc(): eve's accepts ANY token minted for this Vercel project,
 * preview and development ones included (its `subjects` only add callers, they
 * never narrow the same-project rule), and no caller of this agent uses one.
 *
 * WHY NO SESSION-OWNERSHIP ACL: no end user can reach a session id here. A
 * turn's tenancy (capture/workspace/user) and its turn type are carried inside
 * the HMAC-SIGNED run token and re-verified server-side on the internal routes
 * — never chosen by a caller or the model. The token stamped here is
 * untrusted-until-verified; these attributes are a forwarding convenience, not
 * an authorization decision.
 */
import { timingSafeEqual } from 'node:crypto'
import { localDev, type AuthFn } from 'eve/channels/auth'

/** Kept in sync with src/lib/live-agent/live-agent-run-token.ts. */
const LIVE_AGENT_TOKEN_HEADER = 'x-live-agent-token'
const LIVE_AGENT_WORKSPACE_HEADER = 'x-live-agent-workspace'
const LIVE_AGENT_USER_HEADER = 'x-live-agent-user'

function extractBearer(request: Request): string | null {
  const h = request.headers.get('authorization')
  if (!h || !h.startsWith('Bearer ')) return null
  const token = h.slice(7)
  return token.length > 0 ? token : null
}

/**
 * The dedicated internal secret, falling back to RUN_SKILL_INTERNAL_SECRET
 * (mirrors the Next side's internalSecret() in live-agent-run-token.ts).
 */
function internalSecret(): string | undefined {
  return process.env.LIVE_AGENT_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
}

/** Constant-time equality; false on any length/format mismatch or unset secret. */
function secretMatches(presented: string | null, expected: string | undefined): boolean {
  if (!expected || expected.length === 0) return false
  if (!presented || presented.length === 0) return false
  const a = new Uint8Array(Buffer.from(presented, 'utf8'))
  const b = new Uint8Array(Buffer.from(expected, 'utf8'))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/**
 * Build the app-principal from the per-turn headers. Trusted only AFTER the
 * caller is verified — and even then the run token is re-verified (HMAC) on the
 * internal routes before it drives any DB read. The workspace/user echoes are
 * for observability only.
 */
function principalFromHeaders(request: Request) {
  const runToken = request.headers.get(LIVE_AGENT_TOKEN_HEADER) ?? ''
  const workspaceId = request.headers.get(LIVE_AGENT_WORKSPACE_HEADER) ?? ''
  const userId = request.headers.get(LIVE_AGENT_USER_HEADER) ?? ''
  return {
    authenticator: 'live-agent-internal',
    principalId: userId || 'live-agent',
    principalType: 'user',
    attributes: {
      runToken,
      workspaceId,
    },
  }
}

/**
 * Primary auth: a constant-time shared-secret bearer check. Returns the
 * per-turn principal when the secret matches; skips (null) otherwise so the
 * walk falls through to localDevOffVercel().
 */
export function sharedSecretAuth(): AuthFn<Request> {
  return async (request) => {
    const presented = extractBearer(request)
    if (!secretMatches(presented, internalSecret())) return null
    return principalFromHeaders(request)
  }
}

/**
 * eve's localDev(), never on Vercel. eve admits its synthetic `local-dev`
 * principal on an environment flag alone (EVE_DEV=1, which `eve dev` sets, or
 * VERCEL=1 with VERCEL_ENV=development), not on anything about the caller, so
 * one stray variable on a deployment would open every route here to anyone.
 * Local dev sets neither Vercel variable (`next dev` boots `eve dev`), so
 * either one, with any value and whatever NODE_ENV says, means a deployment:
 * skip. Copied in every cloud agent's lib/auth.ts.
 */
export function localDevOffVercel(): AuthFn<Request> {
  const local = localDev()
  return (request) => (process.env.VERCEL !== undefined || process.env.VERCEL_ENV !== undefined ? null : local(request))
}
