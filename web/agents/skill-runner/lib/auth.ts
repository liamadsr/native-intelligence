/**
 * Internal-only route auth for the `skill-runner` eve agent (Phase 2).
 *
 * This agent is NEVER browser-driven. It runs headless `run_skill` flow jobs
 * dispatched server-to-server by the Next app (src/lib/flows/run-skill.ts, eve
 * branch). So the auth surface is deliberately narrow — no cookie/session path
 * at all:
 *
 *   1. sharedSecretAuth() — a constant-time bearer check of a dedicated internal
 *      shared secret (RUN_SKILL_INTERNAL_SECRET). The dispatch presents it on the
 *      Authorization header. This is the primary same-deployment trust proof: it
 *      does not depend on Vercel OIDC being enabled, works in dev, and pins the
 *      caller to our own runtime. After it verifies, the per-run token header
 *      (x-skill-run-token) is stamped onto the principal's attributes so the
 *      dynamic resolvers can forward it to the internal spec/tool routes.
 *   2. localDevOffVercel() — eve's dev fallback so `eve dev` / local smoke
 *      works, refused on any Vercel deployment.
 *
 * NO vercelOidc(): eve's accepts ANY token minted for this Vercel project,
 * preview and development ones included (its `subjects` only add callers, they
 * never narrow the same-project rule), and no caller of this agent uses one.
 *
 * WHY NO SESSION-OWNERSHIP ACL: there is no user-facing session access here.
 * The only callers are (a) the dispatch creating a session and (b) our eve
 * runtime streaming it back to the same dispatch. A run's tenancy
 * (workspaceId/runAsUserId) is carried inside the HMAC-SIGNED run token and
 * verified server-side on the internal routes — it is NEVER chosen by a caller
 * or the model, and the run token stamped here is untrusted-until-verified (the
 * internal routes re-verify its HMAC before rebuilding anything from it). No end
 * user can reach a session id here, so there is nothing to gate per-user.
 * (Contrast the onboarding-researcher, whose stream IS user-facing and therefore
 * carries an ownership ACL.)
 */
import { timingSafeEqual } from 'node:crypto'
import { localDev, type AuthFn } from 'eve/channels/auth'

/** Kept in sync with RUN_SKILL_*_HEADER in src/lib/flows/skill-run-token.ts. */
const RUN_SKILL_TOKEN_HEADER = 'x-skill-run-token'
const RUN_SKILL_WORKSPACE_HEADER = 'x-skill-run-workspace'
const RUN_SKILL_USER_HEADER = 'x-skill-run-user'

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

/**
 * Build the app-principal from the per-run headers. Trusted only AFTER the caller
 * is verified — and even then, the run token is re-verified (HMAC) on the internal
 * routes before it drives any DB read, so these attributes are a forwarding
 * convenience, not an authorization decision. The workspace/user echoes are for
 * observability only; the token is the authoritative tenancy source.
 *
 * Return type is inferred to eve's SessionAuthContext (not re-exported from
 * eve/channels/auth, so we let AuthFn<Request>'s return contract type it).
 */
function principalFromHeaders(request: Request) {
  const runToken = request.headers.get(RUN_SKILL_TOKEN_HEADER) ?? ''
  const workspaceId = request.headers.get(RUN_SKILL_WORKSPACE_HEADER) ?? ''
  const userId = request.headers.get(RUN_SKILL_USER_HEADER) ?? ''
  return {
    authenticator: 'skill-run-internal',
    principalId: userId || 'skill-runner',
    principalType: 'user',
    attributes: {
      runToken,
      workspaceId,
    },
  }
}

/**
 * Primary auth: a constant-time shared-secret bearer check. Returns the
 * per-run principal when the secret matches; skips (null) otherwise so the walk
 * falls through to localDevOffVercel().
 */
export function sharedSecretAuth(): AuthFn<Request> {
  return async (request) => {
    const presented = extractBearer(request)
    const expected = process.env.RUN_SKILL_INTERNAL_SECRET
    if (!secretMatches(presented, expected)) return null
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
