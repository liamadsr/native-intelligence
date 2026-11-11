/**
 * A meeting link's token, the guest's cookie, the key requests are limited
 * by (src/lib/meeting-links/link.ts), and a guest's LiveKit token
 * (src/lib/team-calls/livekit.ts meetingGuestToken): its identity, metadata
 * and grants.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TokenVerifier } from 'livekit-server-sdk'

vi.mock('server-only', () => ({}))

import {
  clearedGuestCookieOptions,
  clientAddress,
  guestCookieOptions,
  meetingLink,
  meetingToken,
  newTokenNonce,
  rateKeyOf,
  signGuestCookie,
  tokenDigest,
  tokenIsMeetings,
  verifyGuestCookie,
} from '../link'
import { isMeetingToken } from '../shape'
import { meetingGuestGrant, meetingGuestToken, teamCallGrant } from '@/lib/team-calls/livekit'

const MEETING = '33333333-3333-4333-8333-333333333333'
const OTHER = '44444444-4444-4444-8444-444444444444'
const GUEST = '55555555-5555-4555-8555-555555555555'
const NONCE = 'nonce-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const NONCE2 = 'nonce-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

beforeEach(() => {
  vi.stubEnv('MEETING_LINK_SECRET', 'test-meeting-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
})
afterEach(() => vi.unstubAllEnvs())

describe('the token', () => {
  it('is 192 bits as 32 base64url characters, the same for one meeting and nonce, another for another', () => {
    const t = meetingToken(MEETING, NONCE)
    expect(isMeetingToken(t)).toBe(true)
    expect(Buffer.from(t, 'base64url')).toHaveLength(24)
    expect(meetingToken(MEETING.toUpperCase(), NONCE)).toBe(t)
    expect(meetingToken(OTHER, NONCE)).not.toBe(t)
    expect(tokenIsMeetings(t, MEETING, NONCE)).toBe(true)
    expect(tokenIsMeetings(t, OTHER, NONCE)).toBe(false)
  })

  it('a new nonce (New link) is a new token: the old one is no longer the meeting’s', () => {
    const old = meetingToken(MEETING, NONCE)
    const fresh = meetingToken(MEETING, NONCE2)
    expect(fresh).not.toBe(old)
    expect(tokenIsMeetings(old, MEETING, NONCE2)).toBe(false)
    expect(tokenIsMeetings(fresh, MEETING, NONCE2)).toBe(true)
    // No nonce stored: no token is the meeting's.
    expect(tokenIsMeetings(old, MEETING, null)).toBe(false)
    expect(tokenIsMeetings(old, MEETING, '')).toBe(false)
  })

  it('each link’s nonce is random, 24 bytes', () => {
    const a = newTokenNonce()
    expect(Buffer.from(a, 'base64url')).toHaveLength(24)
    expect(a).toMatch(/^[A-Za-z0-9_-]{32}$/)
    expect(newTokenNonce()).not.toBe(a)
  })

  it('depends on the key: another key, another token (turning every link off)', () => {
    const t = meetingToken(MEETING, NONCE)
    vi.stubEnv('MEETING_LINK_SECRET', 'another-secret')
    expect(meetingToken(MEETING, NONCE)).not.toBe(t)
  })

  it('falls back to a key derived from the OAuth state secret', () => {
    vi.stubEnv('MEETING_LINK_SECRET', '')
    vi.stubEnv('OAUTH_STATE_SECRET', 'oauth-secret')
    const t = meetingToken(MEETING, NONCE)
    expect(isMeetingToken(t)).toBe(true)
    vi.stubEnv('OAUTH_STATE_SECRET', 'oauth-secret-2')
    expect(meetingToken(MEETING, NONCE)).not.toBe(t)
  })

  it('is stored as its sha256 only, and the link is on the app’s address', () => {
    const t = meetingToken(MEETING, NONCE)
    expect(tokenDigest(t)).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenDigest(t)).not.toContain(t)
    expect(meetingLink(MEETING, NONCE)).toBe(`https://nativeintelligence.dev/m/${t}`)
  })
})

describe('the guest’s cookie', () => {
  const token = () => meetingToken(MEETING, NONCE)
  const now = Date.parse('2026-11-11T12:00:00.000Z')
  const closes = new Date('2026-11-12T12:00:00.000Z')

  it('names its guest for this link until it expires (12 hours at most, never past the link)', () => {
    const c = signGuestCookie(token(), GUEST, closes, now)
    expect(c.expires.toISOString()).toBe('2026-11-12T00:00:00.000Z')
    expect(verifyGuestCookie(token(), c.value, now + 1000)).toBe(GUEST)
    expect(signGuestCookie(token(), GUEST, new Date(now + 60_000), now).expires.getTime()).toBe(now + 60_000)
  })

  it('a tampered, another link’s, an expired or a malformed one names nobody', () => {
    const c = signGuestCookie(token(), GUEST, closes, now)
    const [id, exp, mac] = c.value.split('.')
    expect(verifyGuestCookie(token(), `${OTHER}.${exp}.${mac}`, now)).toBeNull()
    expect(verifyGuestCookie(token(), `${id}.${Number(exp) + 1}.${mac}`, now)).toBeNull()
    expect(verifyGuestCookie(token(), `${id}.${exp}.${mac.slice(0, -2)}xx`, now)).toBeNull()
    expect(verifyGuestCookie(meetingToken(OTHER, NONCE), c.value, now)).toBeNull()
    expect(verifyGuestCookie(token(), c.value, c.expires.getTime())).toBeNull()
    for (const bad of [null, '', 'x', 'a.b', `${id}.${exp}`, 'x'.repeat(300)]) expect(verifyGuestCookie(token(), bad, now)).toBeNull()
  })

  it('is http-only, same-site strict, and scoped to this meeting’s path', () => {
    const opts = guestCookieOptions(token(), new Date(now))
    expect(opts).toMatchObject({ httpOnly: true, sameSite: 'strict', path: `/m/${token()}` })
    expect(clearedGuestCookieOptions(token())).toMatchObject({ path: `/m/${token()}`, maxAge: 0 })
  })
})

describe('the key requests are limited by', () => {
  // On the server: the edge Caddy sets X-Forwarded-For to the client and X-Real-IP to the same; the app's Caddy
  // trusts private ranges and appends the edge's address. So web sees "client, edge" and X-Real-IP: client.
  it('takes X-Real-IP (the edge sets it to the client) before anything else', () => {
    const h = new Headers({ 'x-real-ip': '198.51.100.8', 'x-forwarded-for': '198.51.100.8, 172.18.0.5' })
    expect(clientAddress(h)).toBe('198.51.100.8')
    expect(clientAddress(new Headers({ 'x-real-ip': ' 198.51.100.8 ', 'x-forwarded-for': '203.0.113.1' }))).toBe('198.51.100.8')
  })

  it('without it, the FIRST X-Forwarded-For entry (the last is the edge, the same for everyone)', () => {
    expect(clientAddress(new Headers({ 'x-forwarded-for': '198.51.100.7, 172.18.0.5' }))).toBe('198.51.100.7')
    expect(clientAddress(new Headers({ 'x-forwarded-for': ' , 198.51.100.7, 172.18.0.5' }))).toBe('198.51.100.7')
    expect(clientAddress(new Headers({ 'x-forwarded-for': '198.51.100.7' }))).toBe('198.51.100.7')
    expect(clientAddress(new Headers({ 'x-real-ip': '  ' }))).toBe('unknown')
    expect(clientAddress(new Headers())).toBe('unknown')
  })

  it('two clients behind the same edge are two keys; one client is one key; never the address itself', () => {
    const a = rateKeyOf(new Headers({ 'x-real-ip': '198.51.100.7', 'x-forwarded-for': '198.51.100.7, 172.18.0.5' }))
    const b = rateKeyOf(new Headers({ 'x-real-ip': '198.51.100.70', 'x-forwarded-for': '198.51.100.70, 172.18.0.5' }))
    expect(a).toHaveLength(32)
    expect(a).not.toContain('198')
    expect(b).not.toBe(a)
    expect(rateKeyOf(new Headers({ 'x-forwarded-for': '198.51.100.7, 172.18.0.5' }))).toBe(a)
  })
})

describe('a guest’s LiveKit token', () => {
  const config = { url: 'ws://127.0.0.1:7880', apiUrl: 'http://127.0.0.1:7880', apiKey: 'APIkey', apiSecret: 'a-secret-of-at-least-32-characters!!' }

  it('is for a guest identity, their typed name, marked a guest, ten minutes, one room', async () => {
    const jwt = await meetingGuestToken(config, { room: 'tc-room', guestId: GUEST, name: '  Dana Lee ' })
    const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(jwt)
    expect(claims.sub).toBe(`guest-${GUEST}`)
    expect(claims.name).toBe('Dana Lee')
    expect(JSON.parse(String(claims.metadata))).toEqual({ guest: true })
    expect(Number(claims.exp) - Number(claims.nbf ?? claims.iat ?? 0)).toBeLessThanOrEqual(10 * 60 + 5)
    expect(claims.video?.room).toBe('tc-room')
    expect(claims.video?.roomJoin).toBe(true)
  })

  it('publishes the microphone, camera and screen and subscribes; nothing else', () => {
    const g = meetingGuestGrant('tc-room')
    expect(g).toMatchObject({ canSubscribe: true, canPublish: true, canPublishData: false, canUpdateOwnMetadata: false, roomAdmin: false, roomCreate: false, roomList: false, roomRecord: false, hidden: false })
    // TrackSource MICROPHONE 2, CAMERA 1, SCREEN_SHARE 3 (no screen-share audio, which a member's has).
    expect([...(g.canPublishSources ?? [])].sort()).toEqual([1, 2, 3])
    expect(teamCallGrant('tc-room').canPublishSources).toHaveLength(4)
  })

  it('listen-only (the notes notice not yet answered): publishes nothing', async () => {
    expect(meetingGuestGrant('tc-room', { listenOnly: true })).toMatchObject({ canPublish: false, canPublishSources: [], canSubscribe: true })
    const jwt = await meetingGuestToken(config, { room: 'tc-room', guestId: GUEST, name: 'Dana', listenOnly: true })
    const claims = await new TokenVerifier(config.apiKey, config.apiSecret).verify(jwt)
    expect(claims.video?.canPublish).toBe(false)
  })
})
