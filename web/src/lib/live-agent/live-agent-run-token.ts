/**
 * Live-agent signed run token + internal-route trust boundary for the eve
 * `live-agent` mount (LIVE-AGENT-DESIGN §5.1).
 *
 * Twin of chat-run-token.ts / skill-run-token.ts / agent-run-token.ts — same
 * stateless HMAC shape, same two-gate discipline — with the live agent's OWN
 * claims (a skill/chat claims shape does not generalize).
 *
 * ── Why STATELESS ───────────────────────────────────────────────────────────
 * The eve runtime is a SEPARATE Nitro service, and on Vercel the cloud route,
 * the eve service, and /api/internal/live-agent/* are different function
 * instances with no sticky routing, so there is no shared in-process store to
 * look a turn up in. The cloud route instead mints a compact
 * HMAC-SHA256-signed token carrying only the DURABLE facts needed to rebuild
 * the turn's system prompt, tool ceiling and model from live DB state.
 *
 * ── What is (and is NOT) a claim ────────────────────────────────────────────
 * Claims: the capture + tenancy (captureId/workspaceId/userId), the member the
 * agent assists (pre-resolved once at mint time), the turn type (the mode ×
 * live_role cross product — the ceiling's key), the explicit recipe override,
 * the MODEL the turn runs, whether the capture is an EVAL capture, and the
 * batch auto-archive opt-in. Two OPTIONAL timing claims feed the tool route's
 * time guard: the turn's kind and the window's flush time on the SERVER clock (a token
 * without them still verifies; the guard then measures from the turn start).
 * One OPTIONAL flag, `mcpLookups`, says the route found read-only lookups in
 * the person's connected apps, so the spec/tool routes read the servers only
 * for those turns (mcp-lookups.ts). One OPTIONAL list, `omit`, names the prompt
 * riders the turn does without (riders.ts), so the spec rebuild composes the
 * same prompt the route chose. `isEvalCapture` is stamped HERE, at mint time,
 * from the capture row the route already read — the model can never influence
 * it.
 *
 * `model` is a claim (not re-resolved by the spec route) because the cloud
 * route bills the turn under it: re-resolving later, from a recipe or a
 * workspace default that can change between the route's read and eve's
 * session.started, would let the session run one model while the usage row is
 * priced at another. The route resolves it ONCE, over the same fenced recipe,
 * and both the session and the bill read that one value. The CEILING, by
 * contrast, is still re-derived from live recipe state on every internal call
 * (a recipe narrowed mid-turn narrows at once — the safe direction).
 *
 * NOT claims: `recent_chunks`, `corrections_log`, `prior_transcript`. Those are
 * per-turn CONTENT; they ride the task session's message, assembled by the
 * cloud route from the request body, and are never read back from the token.
 * The one exception is `recentTail`: the last ~600 characters of a talking
 * tick's window, for the tool route's shadow nudge.worth check only
 * (nudge-worth-shadow.ts), which has no other cheap way to see what was just
 * said (the tool route and the cloud route are different instances, so an
 * in-memory hand-off isn't guaranteed). It never builds a prompt or a ceiling.
 *
 * ── Lifetime ────────────────────────────────────────────────────────────────
 * Minted fresh PER TURN. 15 minutes comfortably covers a 10-minute batch turn
 * (the route's maxDuration is 600s) plus dispatch overhead — shorter than
 * chat's 60 minutes because this token covers one bounded call, not a
 * conversation.
 *
 * ── Trust model (two gates on every internal route) ─────────────────────────
 *   1. a shared secret (constant-time) proves the caller is our own eve runtime;
 *   2. the signed token proves the routing facts were minted by us and scopes
 *      the caller to ONE turn of ONE capture. Tenancy is READ FROM the verified
 *      token, never from the model, never from an untrusted header.
 *
 * ── Split secrets ───────────────────────────────────────────────────────────
 * The signing key is LIVE_AGENT_INTERNAL_SECRET, falling back to
 * RUN_SKILL_INTERNAL_SECRET (the root of the internal-secret chain) so one
 * secret bootstraps dev. Split them in prod so a leak of one runtime's secret
 * can't forge another runtime's tokens.
 */
import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveInternalSecret } from '@/lib/eve/internal-secret'
import { LIVE_AGENT_TURN_TYPES, type LiveAgentTurnType } from './ceiling'
import type { LiveTurnKind } from './turn-budget'
import { normalizeRiderOmissions, type RiderId } from './riders'

/** The turn kinds a token may carry (turn-budget.ts LiveTurnKind). */
const LIVE_TURN_KINDS: readonly LiveTurnKind[] = ['tick', 'record', 'batch']

/** Token lifetime — one turn (see the module doc). */
export const LIVE_AGENT_TOKEN_TTL_MS = 15 * 60 * 1000

/**
 * The most characters `recentTail` carries. ~600 ASCII characters add about
 * 800 bytes of base64url to a token that already runs ~450; multi-byte text at
 * most triples that, still far under any header limit.
 */
export const LIVE_RECENT_TAIL_MAX = 600

/**
 * The tail of a tick's window for `recentTail`: the chunks joined, whitespace
 * flattened, the newest LIVE_RECENT_TAIL_MAX characters kept. Undefined when
 * there is nothing said. Pure.
 */
export function liveRecentTail(chunks: readonly unknown[] | null | undefined): string | undefined {
  if (!Array.isArray(chunks)) return undefined
  const flat = chunks
    .filter((c): c is string => typeof c === 'string')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (!flat) return undefined
  return flat.length > LIVE_RECENT_TAIL_MAX ? flat.slice(flat.length - LIVE_RECENT_TAIL_MAX) : flat
}

export interface LiveAgentTokenClaims {
  captureId: string
  workspaceId: string
  userId: string
  /** The member the agent assists, resolved once at mint time. Null → none. */
  currentMemberId: string | null
  /** mode × live_role — the ceiling's key. */
  turnType: LiveAgentTurnType
  /** The explicit recipe override, when the caller sent one. */
  recipeId?: string
  /**
   * The app model id the turn runs AND is billed under — resolved once by the
   * cloud route (recipe override → workspace 'live_agent' default, over the
   * fenced recipe). The spec route serves it verbatim (see the module doc).
   */
  model: string
  /** captures.is_eval, stamped at mint time from the row the route read. */
  isEvalCapture: boolean
  /** Batch-only client opt-in, consumed pre-eve; carried for audit only. */
  allowAutoArchive: boolean
  /**
   * The turn's kind (turn-budget.ts): the tool route's time guard runs on a
   * copilot TICK only. Optional, so a token minted before it existed still
   * verifies; absent means unguarded.
   */
  turnKind?: LiveTurnKind
  /**
   * Epoch ms (SERVER clock) the window this tick answers for was flushed:
   * the route's start minus the age the client measured (the NEWEST window
   * when queued windows were coalesced; the age clamped to 10 minutes). Optional: absent, the window's age is
   * measured from the turn's start (liveWindowStartedAt).
   */
  windowFlushedAt?: number
  /**
   * The cloud route found read-only lookups for this copilot turn in the
   * person's connected apps (mcp-lookups.ts), from the read it already made
   * for the MCP block. Only then do the spec rebuild and the tool route read
   * the connected servers to RE-DERIVE the catalog, so a turn without lookups
   * costs them nothing. It can only narrow: the catalog itself always comes
   * from the live rows. Absent → no lookups.
   */
  mcpLookups?: true
  /**
   * The last LIVE_RECENT_TAIL_MAX characters of a talking tick's transcript
   * window (liveRecentTail), whitespace flattened. Read ONLY by the tool
   * route's shadow nudge.worth check, as untrusted evidence: never a prompt,
   * a ceiling or a tenancy input. Absent on batch, notes and record turns.
   */
  recentTail?: string
  /**
   * The prompt riders this turn does without (riders.ts selectRiderOmissions),
   * chosen by the cloud route from values it already held. Registered ids
   * only, in registry order, and present only when non-empty: absent → the
   * full prompt. Unknown values are dropped at mint and at verify.
   */
  omit?: RiderId[]
  /**
   * A server turn on a call's capture (src/lib/team-calls/live-turns.ts): its
   * lease's end, epoch ms. Past it the token verifies no more, so the turn's
   * tools stop writing even if its model is still running (the call's finish
   * may be running the end-of-meeting pass by then).
   */
  notAfter?: number
  /** Epoch ms expiry. Verified on every internal route. */
  exp: number
}

/** Header the eve runtime presents to the internal routes (shared secret). */
export const LIVE_AGENT_SECRET_HEADER = 'x-live-agent-secret'
/** Header carrying the signed run token. */
export const LIVE_AGENT_TOKEN_HEADER = 'x-live-agent-token'
/** Observability echoes on the session-create call (the token is authoritative). */
export const LIVE_AGENT_WORKSPACE_HEADER = 'x-live-agent-workspace'
export const LIVE_AGENT_USER_HEADER = 'x-live-agent-user'

/**
 * The configured internal shared secret, or null when unset. Prefers
 * LIVE_AGENT_INTERNAL_SECRET, falls back to RUN_SKILL_INTERNAL_SECRET.
 */
export function internalSecret(): string | null {
  return resolveInternalSecret('live-agent', 'LIVE_AGENT_INTERNAL_SECRET')
}

function signPayload(payloadB64: string, secret: string): string {
  return createHmac('sha256', secret).update(payloadB64).digest('base64url')
}

/**
 * Mint a signed token from the turn's durable claims (`exp` = now + TTL).
 * Throws when no secret is configured — a turn that cannot be authenticated
 * must not be dispatched.
 */
export function mintLiveAgentRunToken(claims: Omit<LiveAgentTokenClaims, 'exp'>): string {
  const secret = internalSecret()
  if (!secret) {
    throw new Error('[live-agent] LIVE_AGENT_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set — cannot mint token')
  }
  const { omit: rawOmit, ...rest } = claims
  const omit = normalizeRiderOmissions(rawOmit)
  const full: LiveAgentTokenClaims = {
    ...rest,
    ...(omit.length > 0 ? { omit } : {}),
    exp: Date.now() + LIVE_AGENT_TOKEN_TTL_MS,
  }
  const payloadB64 = Buffer.from(JSON.stringify(full), 'utf8').toString('base64url')
  return `${payloadB64}.${signPayload(payloadB64, secret)}`
}

/**
 * Verify a token's HMAC (constant-time) and expiry, returning its claims or
 * null. Rejects a tampered payload, an expired token, a malformed token, and a
 * claims object of the wrong shape. Fails closed when no secret is configured.
 */
export function verifyLiveAgentRunToken(token: string | null | undefined): LiveAgentTokenClaims | null {
  const secret = internalSecret()
  if (!secret) return null
  if (typeof token !== 'string' || token.length === 0) return null

  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payloadB64 = token.slice(0, dot)
  const presentedSig = token.slice(dot + 1)
  if (!constantTimeEqual(presentedSig, signPayload(payloadB64, secret))) return null

  let claims: LiveAgentTokenClaims
  try {
    claims = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8')) as LiveAgentTokenClaims
  } catch {
    return null
  }
  if (!claims || typeof claims !== 'object') return null
  if (typeof claims.exp !== 'number' || claims.exp <= Date.now()) return null
  // A call's server turn: nothing past its lease's end.
  if (claims.notAfter !== undefined && (typeof claims.notAfter !== 'number' || claims.notAfter <= Date.now())) return null
  // A valid HMAC already proves WE minted it; the shape guard is defensive.
  if (
    typeof claims.captureId !== 'string' ||
    typeof claims.workspaceId !== 'string' ||
    typeof claims.userId !== 'string' ||
    !(claims.currentMemberId === null || typeof claims.currentMemberId === 'string') ||
    !(LIVE_AGENT_TURN_TYPES as readonly unknown[]).includes(claims.turnType) ||
    (claims.recipeId !== undefined && typeof claims.recipeId !== 'string') ||
    typeof claims.model !== 'string' ||
    claims.model.length === 0 ||
    typeof claims.isEvalCapture !== 'boolean' ||
    typeof claims.allowAutoArchive !== 'boolean' ||
    (claims.turnKind !== undefined && !(LIVE_TURN_KINDS as readonly unknown[]).includes(claims.turnKind)) ||
    (claims.windowFlushedAt !== undefined &&
      (typeof claims.windowFlushedAt !== 'number' || !Number.isFinite(claims.windowFlushedAt))) ||
    (claims.mcpLookups !== undefined && claims.mcpLookups !== true) ||
    (claims.recentTail !== undefined &&
      (typeof claims.recentTail !== 'string' || claims.recentTail.length > LIVE_RECENT_TAIL_MAX))
  ) {
    return null
  }
  // `omit` only ever removes prompt sections, so a malformed list fails open
  // to the full prompt (the claim dropped) rather than refusing the turn.
  if (claims.omit !== undefined) {
    const { omit: rawOmit, ...rest } = claims
    const omit = normalizeRiderOmissions(rawOmit)
    return omit.length > 0 ? { ...rest, omit } : rest
  }
  return claims
}

/**
 * A per-token key for in-memory bookkeeping (mcp-lookups.ts's call cap): the
 * token's signature, unique per mint. Null for a malformed token.
 */
export function liveAgentRunTokenKey(token: string | null | undefined): string | null {
  if (typeof token !== 'string') return null
  const dot = token.indexOf('.')
  return dot > 0 && dot < token.length - 1 ? token.slice(dot + 1) : null
}

/** When the turn's token was minted (= the turn's start): `exp` is mint time + TTL. */
export function liveTurnStartedAt(claims: Pick<LiveAgentTokenClaims, 'exp'>): number {
  return claims.exp - LIVE_AGENT_TOKEN_TTL_MS
}

/**
 * Where a tick's window age is measured from: the window's server-clock flush
 * time when the token carries one, else the turn's start.
 */
export function liveWindowStartedAt(claims: Pick<LiveAgentTokenClaims, 'exp' | 'windowFlushedAt'>): number {
  return claims.windowFlushedAt ?? liveTurnStartedAt(claims)
}

/** Constant-time comparison of a presented secret against the configured one. */
export function verifyInternalSecret(presented: string | null | undefined): boolean {
  const expected = internalSecret()
  if (!expected) return false
  if (typeof presented !== 'string' || presented.length === 0) return false
  return constantTimeEqual(presented, expected)
}

/** Length-checked (a length difference is not secret), then timingSafeEqual. */
function constantTimeEqual(a: string, b: string): boolean {
  const ab = new Uint8Array(Buffer.from(a, 'utf8'))
  const bb = new Uint8Array(Buffer.from(b, 'utf8'))
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

/** The presented internal secret, from its header. */
export function extractInternalSecret(request: Request): string | null {
  return request.headers.get(LIVE_AGENT_SECRET_HEADER)
}

/**
 * The run token, from its header ONLY. Deliberately no `?token=` fallback: a
 * token in a URL lands in access logs, and the only caller (the eve mount's
 * spec-client) always sends the header.
 */
export function extractLiveAgentRunToken(request: Request): string | null {
  return request.headers.get(LIVE_AGENT_TOKEN_HEADER)
}
