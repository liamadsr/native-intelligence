// The token a Studio job run on the person's own computer works with (job-contract.ts `local-export`): one job, one
// person, one workspace, a short life.
//
//   ls1.<base64url(JSON {jid, uid, wid, exp, w?})>.<base64url(HMAC-SHA256)>
//
// - jid: the job; uid: the person who queued it (only they are ever given one); wid: its workspace; exp: unix seconds.
// - w: the attempt it holds, once taken (the job's worker id, `local:<uid>:<nonce>`). A token without it can only
//   take the job; `take` answers one with it, and every progress answer a fresh one (LOCAL_TOKEN_SECONDS).
// - Keyed like the local agent's tokens (src/lib/local-agent/tokens.ts: LOCAL_AGENT_TOKEN_SECRET, falling back to the
//   root internal secret), so no new setting; its own MAC domain, so it never verifies as a model token or a run token
//   (the model token MACs another domain, run tokens the bare payload), nor they as this.
// - It grants nothing by itself: every call reads the job again and checks it is this person's, in this workspace,
//   still a local export, held by this attempt, and that the person is still a member who is not a guest. Never the
//   shared worker secret, never a storage key.
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { modelTokenSecret } from '@/lib/local-agent/tokens'
import { LOCAL_TOKEN_SECONDS } from './job-contract'

const PREFIX = 'ls1'
const MAC_DOMAIN = 'dial8.studio.local-export-token.v1:'
/** The longest token minted or read. */
export const LOCAL_TOKEN_MAX = 1024

export type LocalTokenClaims = { jid: string; uid: string; wid: string; exp: number; w?: string }
export type LocalTokenCheck = { ok: true; claims: LocalTokenClaims } | { ok: false; reason: 'malformed' | 'signature' | 'expired' | 'unconfigured' }

const mac = (secret: string, body: string) => createHmac('sha256', secret).update(MAC_DOMAIN).update(body).digest()

/** A worker id for one attempt of a person's local job. */
export const localWorkerId = (userId: string) => `local:${userId}:${randomUUID()}`

/** Mint a token for a person's local job. Throws when no secret is set. */
export function signLocalToken(claims: Omit<LocalTokenClaims, 'exp'>, opts: { now?: number; seconds?: number; secret?: string | null } = {}): { token: string; expiresAt: string } {
  const secret = opts.secret === undefined ? modelTokenSecret() : opts.secret
  if (!secret) throw new Error('Studio local job tokens are not configured')
  const exp = Math.floor((opts.now ?? Date.now()) / 1000) + (opts.seconds ?? LOCAL_TOKEN_SECONDS)
  const body = Buffer.from(JSON.stringify({ jid: claims.jid, uid: claims.uid, wid: claims.wid, exp, ...(claims.w ? { w: claims.w } : {}) }), 'utf8').toString('base64url')
  return { token: `${PREFIX}.${body}.${mac(secret, body).toString('base64url')}`, expiresAt: new Date(exp * 1000).toISOString() }
}

/** Check a token's MAC (constant time) and life. */
export function verifyLocalToken(token: unknown, opts: { now?: number; secret?: string | null } = {}): LocalTokenCheck {
  if (typeof token !== 'string' || token.length > LOCAL_TOKEN_MAX) return { ok: false, reason: 'malformed' }
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) return { ok: false, reason: 'malformed' }
  const secret = opts.secret === undefined ? modelTokenSecret() : opts.secret
  if (!secret) return { ok: false, reason: 'unconfigured' }
  const expected = mac(secret, parts[1])
  const given = Buffer.from(parts[2], 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(new Uint8Array(given), new Uint8Array(expected))) return { ok: false, reason: 'signature' }
  let claims: LocalTokenClaims
  try {
    const parsed = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>
    const uuid = (v: unknown) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v)
    if (!uuid(parsed.jid) || !uuid(parsed.uid) || !uuid(parsed.wid) || typeof parsed.exp !== 'number' || (parsed.w !== undefined && typeof parsed.w !== 'string')) return { ok: false, reason: 'malformed' }
    claims = { jid: parsed.jid as string, uid: parsed.uid as string, wid: parsed.wid as string, exp: parsed.exp, ...(typeof parsed.w === 'string' ? { w: parsed.w } : {}) }
  } catch {
    return { ok: false, reason: 'malformed' }
  }
  if (claims.exp <= Math.floor((opts.now ?? Date.now()) / 1000)) return { ok: false, reason: 'expired' }
  return { ok: true, claims }
}
