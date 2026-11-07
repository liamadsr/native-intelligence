/**
 * The local agent's model token: a short-lived HMAC credential the Mac's
 * local eve presents to the model relay (/api/local-agent/model/*) instead of
 * any gateway key (docs/plans/local-agents.md "The model relay").
 *
 *   la1.<base64url(JSON {sid, uid, wid, exp, cp?})>.<base64url(HMAC-SHA256)>
 *
 * - sid: the local_agent_session id; uid: its owner; wid: its workspace;
 *   exp: unix seconds. Valid 2 h; the relay refreshes it at 75% of its life
 *   (POST /sessions/[id]/model-token) while the session is live.
 * - cp: true when the person ran on their own ChatGPT plan at mint (the free
 *   tier): the local agent then runs its model through the relay's plan path
 *   (`plan/responses`), never the Gateway one. A routing hint the Mac reads
 *   without the key; the relay decides every call from live state, and its
 *   Gateway path refuses a free user whatever the token says.
 * - Keyed by LOCAL_AGENT_TOKEN_SECRET, falling back to RUN_SKILL_INTERNAL_SECRET
 *   the way src/lib/eve/internal-secret.ts resolves every family (an empty
 *   value counts as unset; the source is logged once, never the value).
 * - The MAC covers a domain prefix as well as the payload, so even on the
 *   fallback key a model token can never verify as another family's run token
 *   (those MAC the bare payload) and theirs never verify here.
 * - The token grants nothing by itself: the relay also checks that the session
 *   is live and owned by `uid`, and the person's usage limit, on every call.
 */

import { createHmac, timingSafeEqual } from 'crypto'
import { resolveInternalSecret } from '@/lib/eve/internal-secret'

export const LOCAL_AGENT_TOKEN_SECRET_ENV = 'LOCAL_AGENT_TOKEN_SECRET'
export const MODEL_TOKEN_TTL_SECONDS = 2 * 60 * 60
const PREFIX = 'la1'
const MAC_DOMAIN = 'dial8.local-agent.model-token.v1:'
/** The longest token we mint or accept (contract C3: at most 2 KB). */
export const MODEL_TOKEN_MAX = 2048

export interface ModelTokenClaims {
  sid: string
  uid: string
  wid: string
  /** Unix seconds. */
  exp: number
  /** The person ran on their own ChatGPT plan at mint (the `cp` claim). */
  plan?: true
}

/**
 * The signing key (dedicated, else the root internal secret), or null when
 * neither is set. Resolved and logged like every other family's
 * (src/lib/eve/internal-secret.ts, which compares the others against it too).
 */
export function modelTokenSecret(): string | null {
  return resolveInternalSecret('local-agent', LOCAL_AGENT_TOKEN_SECRET_ENV)
}

function b64url(buf: Buffer | string): string {
  return (typeof buf === 'string' ? Buffer.from(buf, 'utf8') : buf).toString('base64url')
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(MAC_DOMAIN).update(body).digest()
}

/** Mint a token for a session. Throws when no secret is configured. */
export function signModelToken(
  claims: { sid: string; uid: string; wid: string; plan?: boolean },
  opts: { now?: number; ttlSeconds?: number } = {},
): { token: string; expiresAt: string } {
  const secret = modelTokenSecret()
  if (!secret) throw new Error('local agent model tokens are not configured')
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000)
  const exp = nowS + (opts.ttlSeconds ?? MODEL_TOKEN_TTL_SECONDS)
  const body = b64url(JSON.stringify({ sid: claims.sid, uid: claims.uid, wid: claims.wid, exp, ...(claims.plan ? { cp: true } : {}) }))
  const token = `${PREFIX}.${body}.${b64url(mac(secret, body))}`
  return { token, expiresAt: new Date(exp * 1000).toISOString() }
}

export type VerifyResult = { ok: true; claims: ModelTokenClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'unconfigured' }

/** Verify a token's MAC and expiry (constant-time compare). */
export function verifyModelToken(token: unknown, opts: { now?: number } = {}): VerifyResult {
  if (typeof token !== 'string' || token.length > MODEL_TOKEN_MAX) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' }
  const secret = modelTokenSecret()
  if (!secret) return { ok: false, reason: 'unconfigured' }
  const expected = mac(secret, parts[1])
  let given: Buffer
  try {
    given = Buffer.from(parts[2], 'base64url')
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (given.length !== expected.length || !timingSafeEqual(new Uint8Array(given), new Uint8Array(expected))) {
    return { ok: false, reason: 'signature' }
  }
  let claims: ModelTokenClaims
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    if (
      typeof parsed.sid !== 'string' ||
      typeof parsed.uid !== 'string' ||
      typeof parsed.wid !== 'string' ||
      typeof parsed.exp !== 'number'
    ) {
      return { ok: false, reason: 'malformed' }
    }
    claims = { sid: parsed.sid, uid: parsed.uid, wid: parsed.wid, exp: parsed.exp, ...(parsed.cp === true ? { plan: true as const } : {}) }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  const nowS = Math.floor((opts.now ?? Date.now()) / 1000)
  if (claims.exp <= nowS) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
