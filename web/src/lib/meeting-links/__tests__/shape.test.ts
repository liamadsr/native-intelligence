/**
 * Meeting links' shared vocabulary (src/lib/meeting-links/shape.ts): finding our
 * own links in an event's text (only our origins), a guest's identity that
 * can never be a member id, the name rules, the link's window, the lobby's
 * words, and when an admitted guest's token waits for the notes notice.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cleanGuestName,
  cleanMeetingTitle,
  firstNameOf,
  guestIdentity,
  guestIdOfIdentity,
  guestJoinsListenOnly,
  guestLabel,
  isGuestMetadata,
  isMeetingToken,
  GUEST_METADATA,
  meetingLinkState,
  meetingTokenIn,
  meetingUrlIn,
  meetingUrlOf,
  meetingWindow,
  upsertGuest,
  waitingGuests,
  waitingLine,
  type MeetingGuest,
} from '../shape'

const TOKEN = 'Ab3_dEf-ghIJklMNopQRstUVwxYZ0123'
const MEMBER = '11111111-1111-4111-8111-111111111111'

afterEach(() => vi.unstubAllEnvs())

describe('a meeting link', () => {
  it('is 32 base64url characters', () => {
    expect(TOKEN).toHaveLength(32)
    expect(isMeetingToken(TOKEN)).toBe(true)
    for (const bad of ['', TOKEN.slice(1), `${TOKEN}x`, `${TOKEN.slice(0, 31)}=`, `${TOKEN.slice(0, 31)}/`, null, 42]) expect(isMeetingToken(bad)).toBe(false)
  })

  it('is found in an event’s location or description, on our origins only', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
    const url = meetingUrlOf(TOKEN)
    expect(url).toBe(`https://nativeintelligence.dev/m/${TOKEN}`)
    expect(meetingTokenIn(url)).toBe(TOKEN)
    expect(meetingTokenIn(`Join the meeting: ${url}\n\nAgenda`)).toBe(TOKEN)
    expect(meetingUrlIn(`Room 4, or ${url}.`)).toBe(url)
    expect(meetingUrlIn(`https://dial8.ai/m/${TOKEN}`)).toBe(`https://dial8.ai/m/${TOKEN}`)
    // Another site that copies the path, a longer token, a shorter one, nothing at all.
    expect(meetingTokenIn(`https://evil.example/m/${TOKEN}`)).toBeNull()
    expect(meetingTokenIn(`https://nativeintelligence.dev.evil.example/m/${TOKEN}`)).toBeNull()
    expect(meetingTokenIn(`${url}X`)).toBeNull()
    expect(meetingTokenIn(url.slice(0, -1))).toBeNull()
    expect(meetingTokenIn('https://meet.google.com/abc-defg-hij')).toBeNull()
    expect(meetingTokenIn(undefined)).toBeNull()
  })

  it('a developer’s own address counts too', () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3001')
    expect(meetingTokenIn(`http://localhost:3001/m/${TOKEN}`)).toBe(TOKEN)
  })
})

describe('a guest in a LiveKit room', () => {
  it('has an identity that is never a member id, and back', () => {
    const id = '22222222-2222-4222-8222-222222222222'
    const identity = guestIdentity(id.toUpperCase())
    expect(identity).toBe(`guest-${id}`)
    expect(guestIdOfIdentity(identity)).toBe(id)
    expect(identity).not.toMatch(/^[0-9a-f-]{36}$/)
    expect(guestIdOfIdentity(MEMBER)).toBeNull()
    expect(guestIdOfIdentity('guest-nope')).toBeNull()
    expect(guestIdOfIdentity(`guest-${MEMBER}x`)).toBeNull()
    expect(guestIdOfIdentity(null)).toBeNull()
  })

  it('is marked a guest by the server’s metadata', () => {
    expect(isGuestMetadata(GUEST_METADATA)).toBe(true)
    expect(isGuestMetadata('{"guest":"true"}')).toBe(false)
    expect(isGuestMetadata('not json')).toBe(false)
    expect(isGuestMetadata(undefined)).toBe(false)
  })

  it('is labelled with the name they typed, "(guest)"', () => {
    expect(guestLabel('Dana Lee')).toBe('Dana Lee (guest)')
    expect(guestLabel('  ')).toBe('Guest (guest)')
  })
})

describe('a guest’s name', () => {
  it('is 1 to 60 letters, digits, spaces and . ’ - ( ), with a letter, tidied', () => {
    expect(cleanGuestName('  Dana   Lee ')).toBe('Dana Lee')
    expect(cleanGuestName('Zoë O’Brien-Smith (PM)')).toBe('Zoë O’Brien-Smith (PM)')
    expect(cleanGuestName('李小龍')).toBe('李小龍')
    expect(cleanGuestName('a'.repeat(60))).toHaveLength(60)
    for (const bad of ['', '   ', 'a'.repeat(61), '1234', 'http://x.example', 'dana@example.com', '<b>Dana</b>', 'Dana; drop', 'Dana\u0000', null, 7]) {
      expect(cleanGuestName(bad), String(bad)).toBeNull()
    }
  })

  it('a title is 1 to 80 characters', () => {
    expect(cleanMeetingTitle('  Design   review ')).toBe('Design review')
    expect(cleanMeetingTitle('')).toBeNull()
    expect(cleanMeetingTitle('x'.repeat(81))).toBeNull()
  })

  it('a host is their first name only', () => {
    expect(firstNameOf('Rosa Lind')).toBe('Rosa')
    expect(firstNameOf('  ')).toBeNull()
    expect(firstNameOf(null)).toBeNull()
  })
})

describe('the link’s window (574’s rule)', () => {
  const now = new Date('2026-11-11T12:00:00.000Z')

  it('unscheduled: from now for 30 days', () => {
    const w = meetingWindow({ startsAt: null, now })
    expect(w.opensAt.toISOString()).toBe(now.toISOString())
    expect(w.closesAt.toISOString()).toBe('2026-12-11T12:00:00.000Z')
    expect(w.endsAt).toBeNull()
  })

  it('scheduled: 15 minutes before its start until 2 hours after its planned end (30 minutes by default)', () => {
    const w = meetingWindow({ startsAt: new Date('2026-11-12T15:00:00.000Z'), now })
    expect(w.opensAt.toISOString()).toBe('2026-11-12T14:45:00.000Z')
    expect(w.endsAt?.toISOString()).toBe('2026-11-12T15:30:00.000Z')
    expect(w.closesAt.toISOString()).toBe('2026-11-12T17:30:00.000Z')
    expect(meetingWindow({ startsAt: new Date('2026-11-12T15:00:00.000Z'), minutes: 90, now }).closesAt.toISOString()).toBe('2026-11-12T18:30:00.000Z')
  })

  it('a link is early, open, closed or revoked', () => {
    const m = { opens_at: '2026-11-11T12:00:00.000Z', closes_at: '2026-11-11T14:00:00.000Z', revoked_at: null }
    expect(meetingLinkState(m, Date.parse('2026-11-11T11:59:59.000Z'))).toBe('early')
    expect(meetingLinkState(m, Date.parse('2026-11-11T12:00:00.000Z'))).toBe('open')
    expect(meetingLinkState(m, Date.parse('2026-11-11T14:00:00.000Z'))).toBe('closed')
    expect(meetingLinkState({ ...m, revoked_at: '2026-11-11T12:30:00.000Z' }, Date.parse('2026-11-11T12:40:00.000Z'))).toBe('revoked')
  })
})

describe('the lobby', () => {
  const at = Date.parse('2026-11-11T12:00:00.000Z')
  const guest = (id: string, name: string, state: MeetingGuest['state'], seenAgoMs = 0): MeetingGuest => ({
    id,
    meeting_id: 'm',
    channel_id: 'c',
    name,
    state,
    call_id: null,
    in_call: false,
    requested_at: new Date(at - 60_000 + Number(id)).toISOString(),
    last_seen_at: new Date(at - seenAgoMs).toISOString(),
  })

  it('shows who waits now, first come first; a guest whose page stopped asking is gone', () => {
    let list: MeetingGuest[] = []
    list = upsertGuest(list, guest('2', 'Lee', 'waiting'))
    list = upsertGuest(list, guest('1', 'Dana', 'waiting'))
    list = upsertGuest(list, guest('3', 'Kai', 'waiting', 3 * 60_000))
    list = upsertGuest(list, { ...guest('2', 'Lee', 'declined') })
    expect(waitingGuests(list, at).map((g) => g.name)).toEqual(['Dana'])
  })

  it('says it plainly', () => {
    expect(waitingLine([])).toBeNull()
    expect(waitingLine(['Dana'])).toBe('Dana is waiting')
    expect(waitingLine(['Dana', 'Lee'])).toBe('Dana and Lee are waiting')
    expect(waitingLine(['Dana', 'Lee', 'Kai'])).toBe('3 people are waiting')
  })
})

describe('an admitted guest’s token waits for the notes notice', () => {
  it('while notes or a recording are on that their page did not show them before they said go', () => {
    expect(guestJoinsListenOnly({ notes: false, recording: 'off' }, undefined)).toBe(false)
    expect(guestJoinsListenOnly({ notes: true, recording: 'off' }, { notes: false, recording: false })).toBe(true)
    expect(guestJoinsListenOnly({ notes: true, recording: 'off' }, { notes: true, recording: false })).toBe(false)
    expect(guestJoinsListenOnly({ notes: false, recording: 'on' }, { notes: true, recording: false })).toBe(true)
    expect(guestJoinsListenOnly({ notes: false, recording: 'starting' }, { notes: true, recording: true })).toBe(false)
    expect(guestJoinsListenOnly({ notes: true, recording: 'saved' }, { notes: 'yes' })).toBe(true)
    expect(guestJoinsListenOnly({ notes: false, recording: 'saved' }, null)).toBe(false)
  })
})
