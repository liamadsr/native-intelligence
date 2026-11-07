import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto'

/**
 * Tokens the sandbox checks without any secret (docs/plans/cloud-browser.md,
 * C3, C4): the server signs with an Ed25519 private key
 * (CLOUD_BROWSER_SIGNING_KEY); the sandbox holds only the public key, so even a
 * compromised VM can't mint a token for another person's browser.
 *
 * - `browser-viewer`: open the live view of one sandbox's browser, view-only,
 *   or with control while the person has taken it over. Short-lived; sent as
 *   the WebSocket's first message, never in a URL.
 * - `browser-exit`: (C4) the Mac exit tunnel for one sandbox. It names the hub
 *   it opens (`hub`): the desktop checks that before connecting anywhere, so a
 *   page can't point the Mac at another hub.
 *
 * Format: base64url(JSON claims) + "." + base64url(signature over
 * "<aud>.v1." + payload), so a token of one audience never verifies as another.
 * Shared by the server and the sandbox's hub (no Next imports).
 */

export type SandboxTokenAudience = 'browser-viewer' | 'browser-exit'

export interface SandboxTokenClaims {
  aud: SandboxTokenAudience
  userId: string
  workspaceId: string
  /** The sandbox it opens, and only that one. */
  sandbox: string
  /** Viewer: input reaches the browser (the person took it over); otherwise view-only. */
  control?: boolean
  /** Exit (C4): the desktop that carries the traffic. */
  deviceId?: string
  /** Exit (C4): the hub's host (`<id>.vercel.run`), the only one the token opens. */
  hub?: string
  exp: number
}

export const SIGNING_KEY_ENV = 'CLOUD_BROWSER_SIGNING_KEY'

const domain = (aud: SandboxTokenAudience) => `${aud}.v1.`
const bytes = (b: Buffer) => new Uint8Array(b.buffer, b.byteOffset, b.byteLength)

/** The server's signing key (base64 PKCS#8 DER), or null when the live view isn't set up. */
export function sandboxSigningKey(env: Record<string, string | undefined> = process.env): KeyObject | null {
  const raw = env[SIGNING_KEY_ENV]?.trim()
  if (!raw) return null
  try {
    const key = createPrivateKey({ key: Buffer.from(raw, 'base64'), format: 'der', type: 'pkcs8' })
    return key.asymmetricKeyType === 'ed25519' ? key : null
  } catch {
    return null
  }
}

/** The public half, as the hub takes it (base64 SPKI DER): not a secret. */
export function sandboxVerifyKey(privateKey: KeyObject): string {
  return createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).toString('base64')
}

export function signSandboxToken(claims: Omit<SandboxTokenClaims, 'exp'>, ttlMs: number, privateKey: KeyObject): string {
  const payload = Buffer.from(JSON.stringify({ ...claims, exp: Date.now() + ttlMs }), 'utf8').toString('base64url')
  const signature = sign(null, bytes(Buffer.from(domain(claims.aud) + payload, 'utf8')), privateKey).toString('base64url')
  return `${payload}.${signature}`
}

const text = (value: unknown, max: number): value is string => typeof value === 'string' && value.length > 0 && value.length <= max

/**
 * The claims, or null: a bad signature, another audience or sandbox, an
 * expired token or another shape. `verifyKey` is the base64 SPKI the hub was given.
 */
export function verifySandboxToken(token: unknown, aud: SandboxTokenAudience, sandbox: string, verifyKey: string, now = Date.now()): SandboxTokenClaims | null {
  if (!text(token, 4096)) return null
  const dot = token.indexOf('.')
  if (dot <= 0 || dot === token.length - 1) return null
  const payload = token.slice(0, dot)
  let key: KeyObject
  try { key = createPublicKey({ key: Buffer.from(verifyKey, 'base64'), format: 'der', type: 'spki' }) } catch { return null }
  let ok = false
  try { ok = verify(null, bytes(Buffer.from(domain(aud) + payload, 'utf8')), key, bytes(Buffer.from(token.slice(dot + 1), 'base64url'))) } catch { return null }
  if (!ok) return null
  let claims: SandboxTokenClaims
  try { claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) } catch { return null }
  if (!claims || typeof claims !== 'object' || claims.aud !== aud || claims.sandbox !== sandbox || typeof claims.exp !== 'number' ||
      claims.exp <= now || !text(claims.userId, 64) || !text(claims.workspaceId, 64)) return null
  if (claims.control !== undefined && typeof claims.control !== 'boolean') return null
  if (claims.hub !== undefined && !text(claims.hub, 255)) return null
  if (claims.deviceId !== undefined && !text(claims.deviceId, 128)) return null
  return claims
}
