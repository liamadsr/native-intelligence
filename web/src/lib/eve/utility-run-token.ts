/**
 * Utility-run signed token + internal-route trust boundary for the eve
 * `utility` agent (WS-4: one-shot generators).
 *
 * The utility agent hosts every one-shot model call the app used to make with
 * a direct `generateText` / `generateObject` (capture titles, chat titles, skill
 * descriptions, email drafts, knowledge briefs, claim extraction, the weaver's
 * judges, the reference-ingest PDF classify/structure calls, note continuation).
 * Each call is ONE one-shot eve session (src/lib/eve/task-session.ts); a `kind`
 * discriminant in this token
 * selects what the session is for.
 *
 * ── Why STATELESS (no in-process store) ─────────────────────────────────────
 * Same reasoning as skill-run-token.ts: the eve runtime is a SEPARATE service,
 * and on Vercel the dispatching function, the eve service and the
 * /api/internal/utility/* invocations are different instances with no sticky
 * routing. So the dispatcher signs the small routing facts and the internal
 * spec route rebuilds everything else from them.
 *
 * What rides the token: { kind, workspaceId, userId, model, params, exp }.
 *   - `model` is the BARE app model id the dispatcher resolved for the kind's
 *     surface (resolveUtilityModel). The spec route turns it into the Gateway
 *     slug. Carrying it (rather than re-resolving on the spec route) is what
 *     guarantees the model the session runs on is the model logUsage records —
 *     the same reason RunTokenClaims.model exists for skill runs.
 *   - `params` are the few small, per-call facts a kind's SYSTEM prompt is
 *     templated on (a tone, a sign-off name). Never the user prompt: that rides
 *     as the eve task MESSAGE, exactly like run_skill's userMessage.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 * Two gates on the internal route:
 *   1. a shared bearer secret (constant-time) proves the caller is our own eve
 *      runtime;
 *   2. the signed token proves the routing facts were minted by us and scopes
 *      the caller to one call. Tenancy (workspaceId/userId) is READ FROM the
 *      verified token, never from the model or an untrusted header.
 *
 * ── Split secret + domain separation ────────────────────────────────────────
 * The key is UTILITY_INTERNAL_SECRET, falling back to RUN_SKILL_INTERNAL_SECRET
 * so one secret bootstraps dev (the same chain agent-run and chat use). Because
 * the fallback can make this key EQUAL to the skill-run / agent-run / chat keys,
 * the signature covers a fixed `utility.v1.` prefix: a token minted by another
 * family (HMAC over the bare payload) never verifies here, and a utility token
 * never verifies there. The verifier also requires `aud: 'utility'` and a known
 * kind.
 *
 * ── Adding a kind ───────────────────────────────────────────────────────────
 * Add the literal to UTILITY_KINDS, then a branch in
 * src/lib/eve/utility/spec.ts (surface, feature, system prompt). The token
 * shape does not change: per-kind facts go in `params`.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveInternalSecret } from './internal-secret'

/** Token lifetime — covers the longest per-kind timeout plus dispatch overhead. */
const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 min

/** HMAC domain-separation prefix (see the module doc). */
const SIGNING_DOMAIN = 'utility.v1.'

/**
 * Every one-shot generator the utility agent hosts. The string is the eve
 * `kind`; it is NOT the usage feature key (those stay at each call site's
 * logUsage, byte-for-byte what they were).
 */
export const UTILITY_KINDS = [
  'generate_title',
  'skill_draft',
  'browser_field_text',
  'claim_extraction',
  'draft_followup',
  'email_draft_reply',
  'outreach_draft',
  'knowledge_brief',
  'knowledge_weaver_judge',
  'knowledge_weaver_anchor_link',
  'reference_ingest_outline',
  'reference_ingest_segment',
  'note_continuation',
  'agent_memory_summary',
  'memory_learn_mail_tone',
  'memory_capture',
  'draft_review',
  'coding_precheck',
  'code_review',
  'plan_decision',
  'eval_judge',
  'plan_web_search',
  'look_ahead_extract',
] as const

export type UtilityKind = (typeof UTILITY_KINDS)[number]

export function isUtilityKind(value: unknown): value is UtilityKind {
  return typeof value === 'string' && (UTILITY_KINDS as readonly string[]).includes(value)
}

/** Small per-call facts a kind's system prompt is templated on. */
export type UtilityParams = Record<string, string>

export interface UtilityTokenClaims {
  /** Audience — always 'utility'. Rejects any other token family. */
  aud: 'utility'
  kind: UtilityKind
  /** Null when the caller has no workspace in scope (chat/skill-draft fallback). */
  workspaceId: string | null
  /**
   * The user the call is attributed to (Gateway telemetry). Null for
   * workspace-scoped background work with no resolvable owner (briefs, a weaver
   * workspace with no owner) — a real, expected case, not an edge case.
   */
  userId: string | null
  /** Bare app model id (see the module doc). */
  model: string
  params: UtilityParams
  /** Epoch ms expiry. */
  exp: number
}

/** Header the eve runtime presents to the internal route (shared secret). */
export const UTILITY_SECRET_HEADER = 'x-utility-run-secret'
/** Header carrying the signed token. */
export const UTILITY_TOKEN_HEADER = 'x-utility-run-token'
/** Observability echoes (the token is authoritative). */
export const UTILITY_WORKSPACE_HEADER = 'x-utility-run-workspace'
export const UTILITY_USER_HEADER = 'x-utility-run-user'
export const UTILITY_KIND_HEADER = 'x-utility-run-kind'

/**
 * The configured internal secret, or null when unset. Prefers
 * UTILITY_INTERNAL_SECRET, falls back to RUN_SKILL_INTERNAL_SECRET.
 */
export function utilityInternalSecret(): string | null {
  return resolveInternalSecret('utility', 'UTILITY_INTERNAL_SECRET')
}

function sign(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(SIGNING_DOMAIN + payloadB64).digest('base64url')
}

/**
 * Mint a signed token. Throws when no secret is configured — there is no
 * non-eve path to fall back to, so a missing secret is a deployment error the
 * caller surfaces like any other generation failure.
 */
export function mintUtilityToken(claims: Omit<UtilityTokenClaims, 'aud' | 'exp'>): string {
  const secret = utilityInternalSecret()
  if (!secret) {
    throw new Error('[utility] UTILITY_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set — cannot mint token')
  }
  const full: UtilityTokenClaims = { aud: 'utility', ...claims, exp: Date.now() + TOKEN_TTL_MS }
  const payloadB64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${payloadB64}.${sign(payloadB64, secret)}`
}

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

function isParams(v: unknown): v is UtilityParams {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === 'string')
}

/**
 * Verify a token's HMAC (constant-time), expiry, audience and shape. Returns
 * the claims or null (fail closed on anything unexpected, including an unset
 * secret).
 */
export function verifyUtilityToken(token: string | null | undefined): UtilityTokenClaims | null {
  const secret = utilityInternalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presentedSig = token.slice(dot + 1)
  if (!constantTimeEqual(presentedSig, sign(payloadB64, secret))) return null

  let claims: UtilityTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as UtilityTokenClaims
  } catch {
    return null
  }
  if (!claims || typeof claims !== 'object') return null
  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null
  if (
    claims.aud !== 'utility' ||
    !isUtilityKind(claims.kind) ||
    !isNullableString(claims.workspaceId) ||
    !isNullableString(claims.userId) ||
    typeof claims.model !== 'string' ||
    claims.model.length === 0 ||
    !isParams(claims.params)
  ) {
    return null
  }
  return claims
}

/** Constant-time check of a presented internal secret. */
export function verifyUtilityInternalSecret(presented: string | null | undefined): boolean {
  const expected = utilityInternalSecret()
  if (!expected) return false
  if (typeof presented !== 'string' || presented.length === 0) return false
  return constantTimeEqual(presented, expected)
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

export function extractUtilityInternalSecret(request: Request): string | null {
  return request.headers.get(UTILITY_SECRET_HEADER)
}

/** The token from its header. No query-string fallback: nothing here needs one. */
export function extractUtilityToken(request: Request): string | null {
  return request.headers.get(UTILITY_TOKEN_HEADER)
}
