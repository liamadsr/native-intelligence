/**
 * Internal-only route auth for the `utility` eve agent (WS-4).
 *
 * This agent is NEVER browser-driven. Every session is one one-shot generation
 * dispatched server-to-server by the Next app (src/lib/eve/utility/
 * run-utility.ts). The auth surface is the skill-runner's, verbatim in shape:
 *
 *   1. sharedSecretAuth() — a constant-time bearer check of
 *      UTILITY_INTERNAL_SECRET (falling back to RUN_SKILL_INTERNAL_SECRET, the
 *      same chain agent-run and chat use). After it verifies, the per-call
 *      token header is stamped onto the principal's attributes so the dynamic
 *      resolvers can forward it to the internal spec route.
 *   2. localDevOffVercel() — eve's dev fallback, refused on any Vercel
 *      deployment.
 *
 * NO vercelOidc(): eve's accepts ANY token minted for this Vercel project,
 * preview and development ones included (its `subjects` only add callers, they
 * never narrow the same-project rule), and no caller of this agent uses one.
 *
 * WHY NO SESSION-OWNERSHIP ACL: no user ever reaches a session id here. The
 * token's tenancy is re-verified (HMAC) on the internal route before anything
 * is built from it, so the attributes stamped below are a forwarding
 * convenience, not an authorization decision.
 */
import { timingSafeEqual } from 'node:crypto'
import { localDev, type AuthFn } from 'eve/channels/auth'

/** Kept in sync with UTILITY_*_HEADER in src/lib/eve/utility-run-token.ts. */
const UTILITY_TOKEN_HEADER = 'x-utility-run-token'
const UTILITY_WORKSPACE_HEADER = 'x-utility-run-workspace'
const UTILITY_USER_HEADER = 'x-utility-run-user'
const UTILITY_KIND_HEADER = 'x-utility-run-kind'

/**
 * The configured internal secret. UTILITY_INTERNAL_SECRET is the dedicated
 * one; RUN_SKILL_INTERNAL_SECRET bootstraps dev. Undefined when neither is set
 * (the shared-secret auth then never admits anyone — fail closed).
 */
export function utilitySecret(): string | undefined {
  return process.env.UTILITY_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET || undefined
}

function extractBearer(request: Request): string | null {
  const h = request.headers.get('authorization')
  if (!h || !h.startsWith('Bearer ')) return null
  const token = h.slice(7)
  return token.length > 0 ? token : null
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

function principalFromHeaders(request: Request) {
  const runToken = request.headers.get(UTILITY_TOKEN_HEADER) ?? ''
  const workspaceId = request.headers.get(UTILITY_WORKSPACE_HEADER) ?? ''
  const userId = request.headers.get(UTILITY_USER_HEADER) ?? ''
  const kind = request.headers.get(UTILITY_KIND_HEADER) ?? ''
  return {
    authenticator: 'utility-internal',
    principalId: userId || 'utility',
    principalType: 'user',
    attributes: {
      runToken,
      workspaceId,
      kind,
    },
  }
}

/**
 * Primary auth: constant-time shared-secret bearer check. Returns the per-call
 * principal on a match; skips (null) otherwise so the walk falls through.
 */
export function sharedSecretAuth(): AuthFn<Request> {
  return async (request) => {
    if (!secretMatches(extractBearer(request), utilitySecret())) return null
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
