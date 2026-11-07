/**
 * Internal-only route auth for the `coding-agent` eve agent (Phase 3).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ TWIN FILE of agents/skill-runner/lib/auth.ts. Eve compiles each agent    │
 * │ root INDEPENDENTLY, so the two cannot share an import — a cross-root      │
 * │ relative import couples two independently-built bundles. Each root keeps  │
 * │ its own copy; keep this in sync with the skill-runner twin. The only      │
 * │ deltas from the twin: the header names (x-agent-run-*) and the secret     │
 * │ env var (AGENT_RUN_INTERNAL_SECRET, with a RUN_SKILL_INTERNAL_SECRET      │
 * │ fallback so one secret can bootstrap dev — see the design doc).           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * This agent is NEVER browser-driven. It runs headless coding runs dispatched
 * server-to-server by the Next app (src/lib/inngest/agent-run-functions.ts, eve
 * branch). So the auth surface is deliberately narrow — no cookie/session path
 * at all:
 *
 *   1. sharedSecretAuth() — a constant-time bearer check of a dedicated internal
 *      shared secret (AGENT_RUN_INTERNAL_SECRET, falling back to
 *      RUN_SKILL_INTERNAL_SECRET). The dispatch presents it on the Authorization
 *      header. This is the primary same-deployment trust proof: it does not
 *      depend on Vercel OIDC being enabled, works in dev, and pins the caller to
 *      our own runtime. After it verifies, the per-run token header
 *      (x-agent-run-token) is stamped onto the principal's attributes so the
 *      dynamic resolvers can forward it to the internal spec/event/outcome routes.
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
 * (workspaceId/userId) is carried inside the HMAC-SIGNED run token and verified
 * server-side on the internal routes — it is NEVER chosen by a caller or the
 * model, and the run token stamped here is untrusted-until-verified (the
 * internal routes re-verify its HMAC before rebuilding anything from it). No end
 * user can reach a session id here, so there is nothing to gate per-user.
 * (Contrast the onboarding-researcher, whose stream IS user-facing and therefore
 * carries an ownership ACL.)
 */
import { timingSafeEqual } from 'node:crypto'
import { localDev, type AuthFn } from 'eve/channels/auth'

/** Kept in sync with the header names in agents/coding-agent/lib/spec-client.ts. */
const AGENT_RUN_TOKEN_HEADER = 'x-agent-run-token'
const AGENT_RUN_WORKSPACE_HEADER = 'x-agent-run-workspace'
const AGENT_RUN_USER_HEADER = 'x-agent-run-user'

function extractBearer(request: Request): string | null {
  const h = request.headers.get('authorization')
  if (!h || !h.startsWith('Bearer ')) return null
  const token = h.slice(7)
  return token.length > 0 ? token : null
}

/**
 * The configured internal shared secret. AGENT_RUN_INTERNAL_SECRET is the
 * dedicated secret (per the design's split-the-secrets note); it falls back to
 * RUN_SKILL_INTERNAL_SECRET so a single secret can bootstrap dev. Undefined when
 * neither is set (eve path disabled → auth fails closed).
 */
function internalSecret(): string | undefined {
  return process.env.AGENT_RUN_INTERNAL_SECRET || process.env.RUN_SKILL_INTERNAL_SECRET
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
 * routes before it drives any DB read/write, so these attributes are a forwarding
 * convenience, not an authorization decision. The workspace/user echoes are for
 * observability only; the token is the authoritative tenancy source.
 *
 * Return type is inferred to eve's SessionAuthContext (not re-exported from
 * eve/channels/auth, so we let AuthFn<Request>'s return contract type it).
 */
function principalFromHeaders(request: Request) {
  const runToken = request.headers.get(AGENT_RUN_TOKEN_HEADER) ?? ''
  const workspaceId = request.headers.get(AGENT_RUN_WORKSPACE_HEADER) ?? ''
  const userId = request.headers.get(AGENT_RUN_USER_HEADER) ?? ''
  return {
    authenticator: 'agent-run-internal',
    principalId: userId || 'coding-agent',
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
