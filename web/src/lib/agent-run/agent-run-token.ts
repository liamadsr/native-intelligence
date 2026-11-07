/**
 * Agent-run signed token + internal-route trust boundary for the eve
 * `coding-agent` runtime (Phase 3).
 *
 * ── Why STATELESS (no in-process store) ─────────────────────────────────────
 * Same reasoning as the skill-run token (src/lib/flows/skill-run-token.ts): the
 * eve `coding-agent` runs in a SEPARATE Nitro service, and on Vercel the Inngest
 * dispatch, the eve service, and the /api/internal/agent-run/* invocations are
 * DIFFERENT function instances with NO sticky routing. An in-process Map written
 * by the dispatch would routinely NOT be visible to the internal route the eve
 * resolver calls, so every run would break in production while "working" in
 * single-process dev. So there is no cross-instance state here at all.
 *
 * Instead the watcher mints a compact HMAC-SHA256-signed token carrying only the
 * small routing facts needed to REBUILD the spec deterministically from live DB
 * state: { agentRunId, workspaceId, userId, exp }. No prompt text, no repo, no
 * token — those are re-derived on the internal spec route from the agent_run row
 * + its action/project/persona (the SAME loadAgentPersona/composeEveCodingSystemPrompt
 * spec-rebuild.ts). The GitHub OAuth token transits only the internal authed
 * spec channel, never the run token.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 * Two gates on every internal route (identical to skill-run):
 *   1. a shared bearer secret (AGENT_RUN_INTERNAL_SECRET, constant-time) proves
 *      the caller is our own eve runtime — belt to the OIDC/localDev suspenders;
 *   2. the signed token proves the routing facts were minted by us (HMAC over the
 *      same secret) and scopes the caller to ONE run — a tampered or expired token
 *      is rejected. Tenancy (workspaceId/userId/agentRunId) is READ FROM the
 *      verified token, never from the model, never from an untrusted header.
 *
 * ── Split secrets (hardening) ───────────────────────────────────────────────
 * The signing key is AGENT_RUN_INTERNAL_SECRET — its OWN env var, deliberately
 * NOT reusing RUN_SKILL_INTERNAL_SECRET, so a leak of one runtime's secret can't
 * forge tokens for the other. It FALLS BACK to RUN_SKILL_INTERNAL_SECRET when
 * unset so a single secret can bootstrap dev (the Phase 3 rollout sets its own
 * before prod use — see docs/plans/eve-phase3-coding-runs.md §Enable path).
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveInternalSecret } from '@/lib/eve/internal-secret'

/** Token lifetime — a coding run is long (minutes), but the token only needs to
 * cover the spec fetch + the run's log/outcome POSTs, all of which re-verify. A
 * generous 60-minute window comfortably outlasts a long run. */
const TOKEN_TTL_MS = 60 * 60 * 1000 // 60 min

/**
 * The routing facts a signed run token carries. Small by design — no prompt, no
 * repo, no GitHub token (all re-derived / brokered server-side on the internal
 * routes). `agentRunId` scopes every internal call to exactly one run.
 */
export interface AgentRunTokenClaims {
  agentRunId: string
  workspaceId: string
  userId: string
  /**
   * Bots v3 Phase 5: true on a token minted for ONE follow-up chat turn on a
   * settled work run's parked session (/api/account/agent-runs/[id]/chat). The
   * work-agent re-resolves its workspace tools per chat turn from it (so a
   * follow-up more than the TTL after the run still has working tools), and
   * its ceiling is the run's plus its bot's follow-through grants
   * (ceilingForWorkRunChat). Absent on the run's own token.
   */
  chat?: true
  /**
   * Trust layer P2: true on a `chat` token the main agent's relay minted
   * (src/lib/bots/bot-relay.ts): the turn's words are the main agent's, not
   * the person's, so its caller class is unattended (src/lib/safety/caller.ts)
   * and an attended-only tool runs only on the run's bot's follow-through
   * grant. Only with `chat`.
   */
  relay?: true
  /**
   * Bots v4: the skill the person picked in the run chat's composer for this
   * ONE follow-up turn (checked by the chat route: RLS-visible, the run's
   * workspace's own or a system skill, not feature-gated). Only read with
   * `chat`: the turn's ceiling adds the skill's tools within the run's own
   * classes and the bot's attended chat ceiling (ceilingForWorkRunTurn),
   * never more than the run itself may do. Absent otherwise.
   */
  skillId?: string
  /**
   * True on a token minted to RESUME a parked work run (an answer to its
   * question, or its teammates' handoffs coming back): the resumed turn
   * re-resolves its workspace tools from it, as a chat turn does, since the
   * answer can come hours after the session's tools were resolved. Same
   * ceiling as the run's own. Absent on the run's dispatch token.
   */
  resume?: true
  /** Epoch ms expiry. Verified on every internal route. */
  exp: number
}

// ── HMAC-signed token: base64url(payload).base64url(hmac) ─────────────────────

function b64url(buf: Buffer): string {
  return buf.toString('base64url')
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

/** Header the eve runtime presents to the internal routes (shared secret). */
export const AGENT_RUN_SECRET_HEADER = 'x-agent-run-secret'
/** Header carrying the signed run token (routing facts + HMAC). */
export const AGENT_RUN_TOKEN_HEADER = 'x-agent-run-token'
/** Header carrying the workspace id (observability echo; token is authoritative). */
export const AGENT_RUN_WORKSPACE_HEADER = 'x-agent-run-workspace'
/** Header carrying the run-as user id (observability echo; token is authoritative). */
export const AGENT_RUN_USER_HEADER = 'x-agent-run-user'

/**
 * The configured internal shared secret, or null when unset (cloud coding runs
 * then fail their precondition guard — there is no other runtime to fall back to).
 * Prefers AGENT_RUN_INTERNAL_SECRET, falls back to RUN_SKILL_INTERNAL_SECRET so a
 * single secret bootstraps dev (see the module doc's split-secrets note).
 */
export function internalSecret(): string | null {
  return resolveInternalSecret('agent-run', 'AGENT_RUN_INTERNAL_SECRET')
}

/**
 * Mint a signed run token from the routing claims. Sets `exp` to now + TTL.
 * Throws when the secret is unset — agentRunExecute checks internalSecret() in its
 * precondition guard (failing the run with a clear cause) before minting.
 */
export function mintAgentRunToken(claims: Omit<AgentRunTokenClaims, 'exp'>): string {
  const secret = internalSecret()
  if (!secret) throw new Error('[agent-run] AGENT_RUN_INTERNAL_SECRET is not set — cannot mint token')
  const full: AgentRunTokenClaims = { ...claims, exp: Date.now() + TOKEN_TTL_MS }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  const sig = signPayload(payloadB64, secret)
  return `${payloadB64}.${sig}`
}

/**
 * Verify a run token's HMAC (constant-time) and expiry, returning its claims or
 * null. Rejects a tampered payload (signature mismatch), an expired token, and
 * any malformed input. The secret must be set (else null — fail closed).
 */
export function verifyAgentRunToken(token: string | null | undefined): AgentRunTokenClaims | null {
  const secret = internalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presentedSig = token.slice(dot + 1)

  const expectedSig = signPayload(payloadB64, secret)
  if (!constantTimeEqual(presentedSig, expectedSig)) return null

  let claims: AgentRunTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as AgentRunTokenClaims
  } catch {
    return null
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null
  // Minimal shape guard — a valid HMAC already proves WE minted it, but be defensive.
  if (
    typeof claims.agentRunId !== 'string' ||
    typeof claims.workspaceId !== 'string' ||
    typeof claims.userId !== 'string'
  ) {
    return null
  }
  // Only a literal `true` makes a chat or resume token; anything else is dropped.
  const out: AgentRunTokenClaims = { agentRunId: claims.agentRunId, workspaceId: claims.workspaceId, userId: claims.userId, exp: claims.exp }
  if (claims.chat === true) out.chat = true
  // A relay mark is a chat turn's only.
  if (out.chat && claims.relay === true) out.relay = true
  if (claims.resume === true) out.resume = true
  // A picked skill is a chat turn's only: never kept on any other token.
  if (out.chat && typeof claims.skillId === 'string' && /^[\w-]{1,64}$/.test(claims.skillId)) out.skillId = claims.skillId
  return out
}

// ── Internal shared-secret auth (outer gate) ──────────────────────────────────

/**
 * Constant-time comparison of a presented secret against the configured one.
 * False when the env secret is unset or on any length/format mismatch.
 */
export function verifyInternalSecret(presented: string | null | undefined): boolean {
  const expected = internalSecret()
  if (!expected) return false
  if (typeof presented !== 'string' || presented.length === 0) return false
  return constantTimeEqual(presented, expected)
}

/**
 * Constant-time string comparison. Length-checks first (a length difference is
 * not itself secret) then compares bytes in constant time. Wraps the Buffers in
 * Uint8Array views so timingSafeEqual's ArrayBufferView typing is satisfied.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** Extract the presented internal secret from a request's header. */
export function extractInternalSecret(request: Request): string | null {
  return request.headers.get(AGENT_RUN_SECRET_HEADER)
}

/**
 * The run token, from its header ONLY. Deliberately no `?token=` fallback: a
 * token in a URL lands in access logs, and every caller (the coding and work
 * agents' spec-clients) sends the header.
 */
export function extractAgentRunToken(request: Request): string | null {
  return request.headers.get(AGENT_RUN_TOKEN_HEADER)
}
