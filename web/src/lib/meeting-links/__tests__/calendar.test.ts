/**
 * Meeting links and the calendar (phase 7): an event the app makes with "Add
 * a meeting link" carries ours in its location (or the top of its
 * description when it has a location of its own), timed as the event; and an
 * event whose location or description holds one of our links reads it as
 * its video call (Join), while a provider's own call always comes first.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('server-only', () => ({}))

import { conferenceUrlOf } from '@/lib/integrations/calendar'
import { eventFieldsWithLink, meetingLinkForNewEvent, meetingMinutesOf } from '../calendar'
import { LIVEKIT_ENV } from '@/lib/team-calls/__tests__/signing'

const TOKEN = 'Ab3_dEf-ghIJklMNopQRstUVwxYZ0123'
const URL_ = `https://nativeintelligence.dev/m/${TOKEN}`

beforeEach(() => vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev'))
afterEach(() => vi.unstubAllEnvs())

describe('reading an event', () => {
  it('our link in its location or description is its video call', () => {
    expect(conferenceUrlOf(undefined, URL_, undefined)).toBe(URL_)
    expect(conferenceUrlOf(undefined, 'Room 4', `Join the meeting: ${URL_}\n\nAgenda`)).toBe(URL_)
    expect(conferenceUrlOf('https://meet.google.com/abc-defg-hij', URL_, undefined)).toBe('https://meet.google.com/abc-defg-hij')
    expect(conferenceUrlOf(undefined, `https://evil.example/m/${TOKEN}`, undefined)).toBeUndefined()
    expect(conferenceUrlOf(undefined, undefined, undefined)).toBeUndefined()
  })
})

describe('making an event with a meeting link', () => {
  it('the link is its location; with a location of its own, the top of its description', () => {
    expect(eventFieldsWithLink({}, URL_)).toEqual({ location: URL_, description: `Join the meeting: ${URL_}` })
    expect(eventFieldsWithLink({ location: 'Room 4', description: 'Agenda' }, URL_)).toEqual({ location: 'Room 4', description: `Join the meeting: ${URL_}\n\nAgenda` })
  })

  it('the meeting is timed as the event, within a meeting’s bounds', () => {
    expect(meetingMinutesOf('2026-11-12T15:00:00Z', '2026-11-12T15:45:00Z')).toBe(45)
    expect(meetingMinutesOf('2026-11-12T15:00:00Z', '2026-11-12T15:01:00Z')).toBe(5)
    expect(meetingMinutesOf('2026-11-12T15:00:00Z', '2026-11-13T15:00:00Z')).toBe(480)
    expect(meetingMinutesOf('bad', 'bad')).toBe(30)
  })

  it('never while calling is off, never on an all-day event', async () => {
    const supabase = { rpc: vi.fn() } as never
    expect(await meetingLinkForNewEvent(supabase, { workspaceId: 'w', title: 'x', start: '2026-11-12T15:00:00Z', end: '2026-11-12T16:00:00Z' })).toEqual({ ok: false, error: 'Meeting links aren’t available here.' })
    for (const [k, v] of Object.entries(LIVEKIT_ENV)) vi.stubEnv(k, v)
    expect(await meetingLinkForNewEvent(supabase, { workspaceId: 'w', title: 'x', start: '2026-11-12', end: '2026-11-13', isAllDay: true })).toEqual({ ok: false, error: 'An all-day event can’t have a meeting link.' })
  })

  it('as the host the server knows (the agent’s tool): meeting_create_for, the event’s title and length', async () => {
    for (const [k, v] of Object.entries(LIVEKIT_ENV)) vi.stubEnv(k, v)
    vi.stubEnv('MEETING_LINK_SECRET', 'cal-secret')
    const rpc = vi.fn(async () => ({ data: [{ meeting_id: 'm', channel_id: 'c', opens_at: 'o', closes_at: 'z' }], error: null }))
    const made = await meetingLinkForNewEvent({ rpc } as never, { workspaceId: 'w', title: 'Intro call', start: '2026-11-12T15:00:00Z', end: '2026-11-12T15:30:00Z', hostMemberId: 'host' })
    expect(made.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('meeting_create_for', expect.objectContaining({ host_member: 'host', ws: 'w', meeting_title: 'Intro call', starts: '2026-11-12T15:00:00.000Z', minutes: 30 }))
    if (made.ok) expect(made.location).toBe(made.link.url)
  })
})
