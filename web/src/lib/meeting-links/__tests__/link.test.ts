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

beforeEach(() => {
  vi.stubEnv('MEETING_LINK_SECRET', 'test-meeting-secret')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
})
afterEach(() => vi.unstubAllEnvs())

describe('the token', () => {
  it('is 192 bits as 32 base64url characters, the same for one meeting, another for another', () => {
    const t = meetingToken(MEETING)
    expect(isMeetingToken(t)).toBe(true)
    expect(Buffer.from(t, 'base64url')).toHaveLength(24)
    expect(meetingToken(MEETING.toUpperCase())).toBe(t)
    expect(meetingToken(OTHER)).not.toBe(t)
    expect(tokenIsMeetings(t, MEETING)).toBe(true)
    expect(tokenIsMeetings(t, OTHER)).toBe(false)
  })

  it('depends on the key: another key, another token (turning every link off)', () => {
    const t = meetingToken(MEETING)
    vi.stubEnv('MEETING_LINK_SECRET', 'another-secret')
    expect(meetingToken(MEETING)).not.toBe(t)
  })

  it('falls back to a key derived from the OAuth state secret', () => {
    vi.stubEnv('MEETING_LINK_SECRET', '')
    vi.stubEnv('OAUTH_STATE_SECRET', 'oauth-secret')
    const t = meetingToken(MEETING)
    expect(isMeetingToken(t)).toBe(true)
    vi.stubEnv('OAUTH_STATE_SECRET', 'oauth-secret-2')
    expect(meetingToken(MEETING)).not.toBe(t)
  })

  it('is stored as its sha256 only, and the link is on the app’s address', () => {
    const t = meetingToken(MEETING)
    expect(tokenDigest(t)).toMatch(/^[0-9a-f]{64}$/)
    expect(tokenDigest(t)).not.toContain(t)
    expect(meetingLink(MEETING)).toBe(`https://nativeintelligence.dev/m/${t}`)
  })
})

describe('the guest’s cookie', () => {
  const token = () => meetingToken(MEETING)
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
    expect(verifyGuestCookie(meetingToken(OTHER), c.value, now)).toBeNull()
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
  it('is the address our proxy added (the last X-Forwarded-For entry), never the address itself', () => {
    const h = new Headers({ 'x-forwarded-for': '203.0.113.9, 198.51.100.7' })
    expect(clientAddress(h)).toBe('198.51.100.7')
    expect(clientAddress(new Headers({ 'x-real-ip': '198.51.100.8' }))).toBe('198.51.100.8')
    expect(clientAddress(new Headers())).toBe('unknown')
    const key = rateKeyOf(h)
    expect(key).toHaveLength(32)
    expect(key).not.toContain('198')
    expect(rateKeyOf(new Headers({ 'x-forwarded-for': 'spoofed, 198.51.100.7' }))).toBe(key)
    expect(rateKeyOf(new Headers({ 'x-forwarded-for': '198.51.100.70' }))).not.toBe(key)
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
