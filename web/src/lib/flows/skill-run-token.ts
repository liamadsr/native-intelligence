/**
 * Skill-run signed token + deterministic spec rebuild for the eve `run_skill`
 * runtime (Phase 2).
 *
 * ── Why STATELESS (no in-process store) ─────────────────────────────────────
 * The eve `skill-runner` agent runs in a SEPARATE Nitro service from the Next
 * app, and — critically — on Vercel the Inngest dispatch invocation, the eve
 * service, and the /api/internal/skill-run/* invocations are DIFFERENT function
 * instances with NO sticky routing. An in-process Map written by the dispatch
 * would routinely NOT be visible to the internal route the eve resolver calls,
 * so every eve run would break in production while "working" in single-process
 * dev. So there is no cross-instance state here at all.
 *
 * Instead the dispatch mints a compact HMAC-SHA256-signed token carrying only
 * the small routing facts needed to REBUILD the spec deterministically from DB
 * state: { workspaceId, runAsUserId, skillId, mode, hasCapture, outputContract,
 * exp }. No prompt text, no ceiling — those are re-derived on the internal spec
 * route from the skill row + the SAME prompt-layering/ceiling helpers
 * assembleSkillRun uses (buildSkillSystemPrompt / computeSkillCeiling), so the
 * rebuild is byte-identical to dispatch-time assembly (asserted in a parity test).
 * The fire-ephemeral userMessage is NOT rebuilt — it rides as the eve task
 * MESSAGE (its natural role), delivered directly in the session POST body.
 *
 * ── Trust model ─────────────────────────────────────────────────────────────
 * Two gates on every internal route:
 *   1. a shared bearer secret (RUN_SKILL_INTERNAL_SECRET, constant-time) proves
 *      the caller is our own eve runtime — belt to the OIDC/localDev suspenders;
 *   2. the signed token proves the routing facts were minted by us (HMAC over the
 *      same secret) and scopes the caller to ONE run — a tampered or expired token
 *      is rejected. Tenancy (workspaceId/runAsUserId) is READ FROM the verified
 *      token, never from the model, never from an untrusted header.
 * No per-user session-ownership ACL: there is no user-facing session access here.
 *
 * ── The one honest drift window ─────────────────────────────────────────────
 * Because the spec is REBUILT from live DB state, a skill whose config is edited
 * mid-run could produce a rebuild that differs from dispatch-time assembly. This
 * is a small, bounded, documented window (the run's own duration, ~8 min max).
 * Acceptable for Phase 2.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'

/** Maximum token lifetime — past the 480s verdict wall + runViaEve's 60s
 *  margin. runViaEve mints shorter tokens (its wall + a margin). */
const TOKEN_TTL_MS = 10 * 60 * 1000 // 10 min

/**
 * The routing facts a signed run token carries. Small by design — no prompt, no
 * ceiling (both re-derived server-side). `hasCapture` is the ONLY fire-specific
 * input the ceiling rebuild needs (capture-read tools are force-added when the
 * fire has a triggering capture).
 */
export interface RunTokenClaims {
  workspaceId: string
  runAsUserId: string
  skillId: string
  mode: 'report' | 'act'
  hasCapture: boolean
  outputContract: 'verdict' | 'prose'
  model: string
  /**
   * Automation depth of THIS run's writes (the dispatching fire's depth + 1).
   * The internal tool route stamps it on every status change the run makes so
   * the flow dispatcher's loop guard can cap re-triggering. Absent on tokens
   * minted before the guard → the route treats the run as depth 1.
   */
  originDepth?: number
  /**
   * The fire's work-ledger row (tracked_job.id), when the caller had one, so the
   * internal tool route can record what the run touched (work_touch, Sequence
   * step 2). Absent on tokens minted without a ledger row → nothing recorded.
   */
  workItemId?: string
  /**
   * Bots v3 Phase 4: this token drives ONE follow-up chat turn on a run's parked
   * session (/api/account/activity/[id]/chat mints it fresh per call), not the
   * run. Its tools are the fronting bot's ATTENDED chat ceiling
   * (skill-run-chat-ceiling.ts), never the run's unattended one, and the turn
   * gets the chat instructions instead of the headless contract. `teammateId`
   * is the bot the run's ledger row names. Absent on every run token.
   */
  chat?: {
    teammateId: string
    /**
     * A turn the main agent RELAYED into the run's chat (bots-v4 A3,
     * src/lib/bots/bot-relay.ts), not one the person typed: its message is
     * never the person's words for the reviewer (A5).
     */
    relay?: true
  }
  /**
   * F1: a test_flow DRY run (src/lib/flows/test-fire.ts). The skill-run tool
   * route answers every non-read call with an echo of what it would have
   * written (dry-run-tools.ts) and runs nothing. Absent on every real run.
   */
  dryRun?: true
  /**
   * F4: the flow owner's connected apps (connected_mcp_server ids) this run
   * may use (the run_skill step's `connections`). The spec and tool routes
   * build those apps' tools from it, for runAsUserId only. Absent: none.
   */
  connections?: string[]
  /**
   * F4: the flow step this run is (absent on a test run, a chat turn and an
   * eval). An outward call it makes is held as the owner's card instead of
   * refused (caller.ts decideAction `flowStep`), and the card names its run.
   */
  flowStep?: { flowId: string; actionId: string; flowRunId?: string | null; manual?: true }
  /**
   * F4 review R2: this run's id for its outside-read record (skill-run-reads.ts),
   * on a run given connections. Absent: the run counts as having read outside text.
   */
  runId?: string
  /** F4 review R2: an earlier step of the fire brought outside text in. */
  readOutsideBefore?: true
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
export const RUN_SKILL_SECRET_HEADER = 'x-skill-run-secret'
/** Header carrying the signed run token (routing facts + HMAC). */
export const RUN_SKILL_TOKEN_HEADER = 'x-skill-run-token'

/** The configured internal shared secret, or null when unset (eve path disabled). */
export function internalSecret(): string | null {
  const s = process.env.RUN_SKILL_INTERNAL_SECRET
  return s && s.length > 0 ? s : null
}

/**
 * Mint a signed run token from the routing claims. Sets `exp` to now + TTL.
 * `opts.ttlMs` can only SHORTEN the lifetime (capped at TOKEN_TTL_MS). runViaEve
 * mints with the run's wall plus a margin, so a session that outlives its wall
 * (a failed cancel, a caller killed mid-run) loses the internal routes soon
 * after the wall instead of up to 10 minutes later.
 * Throws when the secret is unset — the server skill runtime cannot sign its
 * run token, so the run fails closed (runViaEve surfaces it as a failed run).
 */
export function mintRunToken(
  claims: Omit<RunTokenClaims, 'exp'>,
  opts: { ttlMs?: number } = {},
): string {
  const secret = internalSecret()
  if (!secret) throw new Error('[skill-run] RUN_SKILL_INTERNAL_SECRET is not set — cannot mint token')
  const ttlMs =
    typeof opts.ttlMs === 'number' && opts.ttlMs > 0 ? Math.min(opts.ttlMs, TOKEN_TTL_MS) : TOKEN_TTL_MS
  const full: RunTokenClaims = { ...claims, exp: Date.now() + ttlMs }
  const payloadB64 = b64url(Buffer.from(JSON.stringify(full), 'utf8'))
  const sig = signPayload(payloadB64, secret)
  return `${payloadB64}.${sig}`
}

/**
 * Verify a run token's HMAC (constant-time) and expiry, returning its claims or
 * null. Rejects a tampered payload (signature mismatch), an expired token, and
 * any malformed input. The secret must be set (else null — fail closed).
 */
export function verifyRunToken(token: string | null | undefined): RunTokenClaims | null {
  const secret = internalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presentedSig = token.slice(dot + 1)

  const expectedSig = signPayload(payloadB64, secret)
  if (!constantTimeEqual(presentedSig, expectedSig)) return null

  let claims: RunTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as RunTokenClaims
  } catch {
    return null
  }
  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null
  // Minimal shape guard — a valid HMAC already proves WE minted it, but be defensive.
  if (
    typeof claims.workspaceId !== 'string' ||
    typeof claims.runAsUserId !== 'string' ||
    typeof claims.skillId !== 'string' ||
    (claims.mode !== 'report' && claims.mode !== 'act')
  ) {
    return null
  }
  // A chat claim must name its teammate: a malformed one is never read as a run.
  if (claims.chat !== undefined) {
    const chat = claims.chat as { teammateId?: unknown; relay?: unknown } | null
    const teammateId = chat?.teammateId
    if (typeof teammateId !== 'string' || teammateId.length === 0) return null
    if (chat?.relay !== undefined && chat.relay !== true) return null
  }
  // A dry-run claim is exactly `true` (never a string that could read truthy elsewhere).
  if (claims.dryRun !== undefined && claims.dryRun !== true) return null
  // F4: connections are uuids; a flow step names its flow and step.
  if (claims.connections !== undefined) {
    const ids = claims.connections as unknown
    if (!Array.isArray(ids) || ids.length > 5 || ids.some((id) => typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id))) return null
  }
  if (claims.runId !== undefined && (typeof claims.runId !== 'string' || !/^[0-9a-f-]{36}$/i.test(claims.runId))) return null
  if (claims.readOutsideBefore !== undefined && claims.readOutsideBefore !== true) return null
  if (claims.flowStep !== undefined) {
    const step = claims.flowStep as { flowId?: unknown; actionId?: unknown; flowRunId?: unknown } | null
    if (!step || typeof step.flowId !== 'string' || typeof step.actionId !== 'string') return null
    if (step.flowRunId !== undefined && step.flowRunId !== null && typeof step.flowRunId !== 'string') return null
    if (claims.chat !== undefined || claims.dryRun !== undefined) return null
    if ((step as { manual?: unknown }).manual !== undefined && (step as { manual?: unknown }).manual !== true) return null
  }
  return claims
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
  return request.headers.get(RUN_SKILL_SECRET_HEADER)
}

/**
 * The run token, from its header ONLY. Deliberately no `?token=` fallback: a
 * token in a URL lands in access logs, and the only caller (the skill-runner's
 * spec-client) sends the header.
 */
export function extractRunToken(request: Request): string | null {
  return request.headers.get(RUN_SKILL_TOKEN_HEADER)
}
