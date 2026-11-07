/**
 * The signed `s` on the URLs Stripe sends the owner back to (roadmap C1): the
 * return page (/payments/setup/done) and the refresh route. Both are public
 * (Stripe's redirect carries no session), so without it anyone holding a
 * workspace id could read that workspace's payment status, spend the
 * platform key's Stripe rate limit, or have the owner texted setup links.
 *
 * An HMAC of the workspace id and an expiry, with a key derived for this one
 * purpose from the OAuth state secret. Lives a day: Stripe's redirects happen
 * while the owner is onboarding.
 *
 * Server only. Pure apart from the key.
 */
import crypto from 'node:crypto'
import { oauthStateSecret, secretsEqual } from '@/lib/oauth/state'

export const SETUP_RETURN_TTL_MS = 24 * 60 * 60_000

function key(): string {
  return crypto.createHmac('sha256', oauthStateSecret()).update('dial8-stripe-connect-return-v1').digest('base64url')
}

function mac(workspaceId: string, exp: number): string {
  return crypto.createHmac('sha256', key()).update(`${workspaceId}.${exp}`).digest('base64url')
}

/** `<expiry>.<mac>` for this workspace. */
export function signSetupReturn(workspaceId: string, now = Date.now()): string {
  const exp = now + SETUP_RETURN_TTL_MS
  return `${exp}.${mac(workspaceId, exp)}`
}

/** True when `token` was signed for this workspace and hasn't expired. Never throws. */
export function verifySetupReturn(workspaceId: string, token: unknown, now = Date.now()): boolean {
  if (typeof token !== 'string' || token.length > 200) return false
  const dot = token.indexOf('.')
  const exp = Number(token.slice(0, dot))
  if (dot <= 0 || !Number.isSafeInteger(exp) || exp < now) return false
  try {
    return secretsEqual(token.slice(dot + 1), mac(workspaceId, exp))
  } catch {
    return false
  }
}

/** The query string the return page and the refresh route take. */
export function setupReturnQuery(workspaceId: string, now = Date.now()): string {
  return new URLSearchParams({ w: workspaceId, s: signSetupReturn(workspaceId, now) }).toString()
}
