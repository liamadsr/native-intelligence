/**
 * A meeting link's token, and the guest's cookie (server only).
 *
 * The token: 24 bytes (192 bits) of an HMAC of the meeting's id and a random
 * nonce (24 bytes, per link) under a key kept for this one purpose, as 32
 * base64url characters. Only its sha256 is stored (573's meeting.token_hash),
 * with the nonce (server only), and lookups go by that hash. So the host's
 * link can be shown again without the token ever being stored, and "New
 * link" (a new nonce) replaces a leaked one: the old token stops working.
 * Unguessable without the key: neither the id nor a stolen nonce gives it.
 *
 * The key: MEETING_LINK_SECRET when set, else one derived from the OAuth
 * state secret (which production requires) for this purpose. Changing it
 * turns every existing link off, as revoking them would.
 *
 * The guest's cookie: `<guest id>.<expiry ms>.<mac>`, an HMAC over the
 * link's token, the guest and the expiry under another derived key (so it
 * is checked before any read: a forged one never reaches the database). http-only,
 * SameSite strict, Secure in production, its path the meeting's own
 * (`/m/<token>`), so it goes to that meeting's routes and nowhere else. It
 * names a guest row; the row's state says what they may do.
 */
import 'server-only'
import crypto from 'node:crypto'
import { oauthStateSecret, secretsEqual } from '@/lib/oauth/state'
import { appUrl } from '@/lib/app-url'
import { MEETING_PATH_PREFIX, isMeetingToken, meetingUrlOf } from './shape'

function baseKey(): string {
  const dedicated = process.env.MEETING_LINK_SECRET?.trim()
  return dedicated || crypto.createHmac('sha256', oauthStateSecret()).update('ni-meeting-links-v1').digest('base64url')
}

function keyFor(purpose: string): string {
  return crypto.createHmac('sha256', baseKey()).update(purpose).digest('base64url')
}

/** A new link's random nonce (24 bytes, base64url). */
export function newTokenNonce(): string {
  return crypto.randomBytes(24).toString('base64url')
}

/** The token of a meeting's link (the same for one meeting and nonce). */
export function meetingToken(meetingId: string, nonce: string): string {
  return crypto.createHmac('sha256', keyFor('token')).update(`${meetingId.toLowerCase()}:${nonce}`).digest().subarray(0, 24).toString('base64url')
}

/** What is stored of a token, and looked up by: its sha256, hex. */
export function tokenDigest(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/** A meeting's link, on the app's address. */
export function meetingLink(meetingId: string, nonce: string, origin: string = appUrl()): string {
  return meetingUrlOf(meetingToken(meetingId, nonce), origin)
}

/** True when this token is the one the server made for this meeting's current link (never a token a caller chose). */
export function tokenIsMeetings(token: string, meetingId: string, nonce: string | null | undefined): boolean {
  return !!nonce && isMeetingToken(token) && secretsEqual(token, meetingToken(meetingId, nonce))
}

// ── The guest's cookie ──────────────────────────────────────────────────────

export const MEETING_GUEST_COOKIE = 'ni_meeting_guest'
/** The longest a guest's cookie lasts (a meeting's link may last longer: they knock again). */
export const MEETING_GUEST_COOKIE_MAX_MS = 12 * 60 * 60_000

function guestMac(token: string, guestId: string, exp: number): string {
  return crypto.createHmac('sha256', keyFor('guest-cookie')).update(`${token}.${guestId.toLowerCase()}.${exp}`).digest('base64url')
}

/** The cookie's value for a guest of the meeting this token opens, and when it expires. */
export function signGuestCookie(token: string, guestId: string, closesAt: Date, now: number = Date.now()): { value: string; expires: Date } {
  const exp = Math.min(closesAt.getTime(), now + MEETING_GUEST_COOKIE_MAX_MS)
  return { value: `${guestId.toLowerCase()}.${exp}.${guestMac(token, guestId, exp)}`, expires: new Date(exp) }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The guest a cookie names for this link, or null (tampered, another link's, expired, malformed). Never throws. */
export function verifyGuestCookie(token: string, value: string | null | undefined, now: number = Date.now()): string | null {
  if (typeof value !== 'string' || value.length > 200) return null
  const parts = value.split('.')
  if (parts.length !== 3) return null
  const [guestId, expRaw, mac] = parts
  if (!UUID.test(guestId)) return null
  const exp = Number(expRaw)
  if (!Number.isSafeInteger(exp) || exp <= now) return null
  return secretsEqual(mac, guestMac(token, guestId, exp)) ? guestId : null
}

/** The cookie's options: this meeting's path only. */
export function guestCookieOptions(token: string, expires: Date) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict' as const,
    path: `${MEETING_PATH_PREFIX}${token}`,
    expires,
  }
}

/** The same cookie, gone (its own name and path). */
export function clearedGuestCookieOptions(token: string) {
  return { ...guestCookieOptions(token, new Date(0)), maxAge: 0 }
}

// ── The key requests are limited by ─────────────────────────────────────────

/**
 * The address a request came from. On the server the chain is: the edge
 * Caddy (deploy/edge/Caddyfile: it drops any X-Forwarded-For a client sent,
 * sets it to the client's address, and sets X-Real-IP to the same), then the
 * app's own Caddy (deploy/app/proxy/Caddyfile: it trusts private ranges and
 * appends its peer, the edge container), then web. So X-Real-IP is the
 * client; failing that, the FIRST X-Forwarded-For entry (the last is the
 * edge's own address, the same for everyone). On a host that sets neither,
 * 'unknown'.
 */
export function clientAddress(headers: Headers): string {
  const real = headers.get('x-real-ip')?.trim()
  if (real) return real.slice(0, 64)
  const first = headers.get('x-forwarded-for')?.split(',').map((s) => s.trim()).find(Boolean)
  return (first || 'unknown').slice(0, 64)
}

/** The key a request is limited by: an HMAC of its address (never the address). */
export function rateKeyOf(headers: Headers): string {
  return crypto.createHmac('sha256', keyFor('rate-key')).update(clientAddress(headers)).digest('base64url').slice(0, 32)
}
