import { createHmac, timingSafeEqual } from 'node:crypto'
import { resolveInternalSecret } from '@/lib/eve/internal-secret'

/**
 * The cloud browser relay's run token (docs/plans/cloud-browser.md, C2).
 *
 * The relay is the process in a person's sandbox that claims their browser
 * commands and runs them on the sandbox's Chrome. It holds no secret: the host
 * mints this token at every start and the sandbox firewall adds it to the
 * relay's own requests to the relay host (`setRelayNetworkPolicy` in host.ts),
 * only when they carry RELAY_MARK_HEADER. Chrome never sends that header (a
 * page that tried would need a CORS preflight the relay routes never grant), so
 * page traffic never carries the token, and nothing in the VM can read it.
 *
 * Claims: { aud: 'browser-relay', userId, workspaceId, sandbox, exp }. Every
 * relay route scopes itself to the token's user and workspace, and takes the
 * claiming device from the sandbox name (`cloud:<sandbox>`), never from a body.
 *
 * Key: BROWSER_INTERNAL_SECRET, falling back to RUN_SKILL_INTERNAL_SECRET (the
 * internal-secret chain). The signature covers a `browser-relay.v1.` prefix, so
 * no other family's token verifies here even when the keys are shared.
 */

const SIGNING_DOMAIN = 'browser-relay.v1.'

/** Added by the sandbox firewall: the token. */
export const RELAY_TOKEN_HEADER = 'x-dial8-relay-token'
/** Sent by the relay itself: the firewall injects the token only into requests carrying it. */
export const RELAY_MARK_HEADER = 'x-dial8-relay'

export interface BrowserRelayClaims {
  aud: 'browser-relay'
  userId: string
  workspaceId: string
  /** The sandbox the relay runs in; the claiming device is `cloud:<sandbox>`. */
  sandbox: string
  exp: number
}

export function browserRelaySecret(): string | null {
  return resolveInternalSecret('browser', 'BROWSER_INTERNAL_SECRET')
}

function sign(payload: string, secret: string) {
  return createHmac('sha256', secret).update(SIGNING_DOMAIN + payload).digest('base64url')
}

/** A token for one sandbox session; it lives as long as the session may. */
export function mintBrowserRelayToken(claims: Omit<BrowserRelayClaims, 'aud' | 'exp'>, ttlMs: number): string {
  const secret = browserRelaySecret()
  if (!secret) throw new Error('[cloud-browser] BROWSER_INTERNAL_SECRET / RUN_SKILL_INTERNAL_SECRET is not set')
  const payload = Buffer.from(JSON.stringify({ aud: 'browser-relay', ...claims, exp: Date.now() + ttlMs }), 'utf8').toString('base64url')
  return `${payload}.${sign(payload, secret)}`
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/** The claims, or null: a bad signature, an expired token, another audience or shape (fail closed, also with no secret). */
export function verifyBrowserRelayToken(token: string | null | undefined): BrowserRelayClaims | null {
  const secret = browserRelaySecret()
  if (!secret || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  const presented = new Uint8Array(Buffer.from(token.slice(dot + 1), 'utf8'))
  const expected = new Uint8Array(Buffer.from(sign(payload, secret), 'utf8'))
  if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) return null
  let claims: BrowserRelayClaims
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!claims || typeof claims !== 'object' || claims.aud !== 'browser-relay' || typeof claims.exp !== 'number' ||
      claims.exp <= Date.now() || !text(claims.userId, 64) || !text(claims.workspaceId, 64) || !text(claims.sandbox, 128)) return null
  return claims
}

/** The relay's claiming device id: its sandbox, never anything a request says. */
export const relayDeviceId = (claims: BrowserRelayClaims) => `cloud:${claims.sandbox}`

/**
 * The relay behind this request, or a 401. Both headers are required: the
 * token (added by the firewall) and the relay's own mark, which no page can
 * send without a CORS preflight these routes never answer.
 */
export function requireBrowserRelay(request: Request): BrowserRelayClaims | Response {
  const claims = request.headers.get(RELAY_MARK_HEADER) === '1' ? verifyBrowserRelayToken(request.headers.get(RELAY_TOKEN_HEADER)) : null
  return claims ?? Response.json({ error: 'Unauthorized' }, { status: 401 })
}
