/**
 * findTimesTogether (../team.ts): several members' free time, each in their
 * own working hours and zone, intersected. Common times only when everyone's
 * time is known; otherwise who and why, and no times. A teammate who doesn't
 * share is never read; a teammate's read error never reaches the answer in
 * the provider's words; nothing of a teammate's events crosses over.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import { DEFAULT_WEEKLY, type AvailabilitySchedule } from '../engine'
import type { WorkspacePerson } from '../people'
import { findTimesTogether, NOT_SHARING_REASON, teammateReason, ZONE_UNKNOWN_REASON, type FindTimesTogetherDeps, type FindTimesTogetherInput } from '../team'

const at = (value: string) => Date.parse(value)
const iso = (ms: number) => new Date(ms).toISOString()
const NY = 'America/New_York'
const CHI = 'America/Chicago'
const LON = 'Europe/London'
// Monday Nov 2 2026, 7:00 in New York (EST); London is on GMT by then.
const NOW = at('2026-11-02T12:00:00.000Z')

const ADA: AvailabilitySchedule = { timeZone: NY, weekly: DEFAULT_WEEKLY }
const person = (userId: string, name: string, extra: Partial<WorkspacePerson> = {}): WorkspacePerson => ({ memberId: `m-${userId}`, userId, name, role: 'member', sharing: 'busy_only', ...extra })
const DANA = person('user-dana', 'Dana Whitfield')
const LEE = person('user-lee', 'Lee Okafor')
const SAM = person('user-sam', 'Sam Ortiz', { sharing: 'none' })

const HOURS: Record<string, AvailabilitySchedule> = {
  'user-dana': { timeZone: CHI, weekly: DEFAULT_WEEKLY },
  'user-lee': { timeZone: LON, weekly: DEFAULT_WEEKLY },
  'user-sam': { timeZone: NY, weekly: DEFAULT_WEEKLY },
}

const event = (start: string, end: string, extra: Partial<CalendarEvent> = {}): CalendarEvent => ({ id: `e-${start}`, title: 'Private: dentist', location: '12 Elm St', start, end, attendees: ['someone@example.com'], ...extra })

function input(others: WorkspacePerson[], extra: Partial<FindTimesTogetherInput> = {}): FindTimesTogetherInput {
  // Monday only: the range ends at midnight New York.
  return { workspaceId: 'ws-fernhill', requester: { userId: 'user-ada', name: 'Ada Finch', schedule: ADA }, others, from: NOW, to: at('2026-11-03T05:00:00.000Z'), durationMinutes: 30, bufferMinutes: 0, now: NOW, ...extra }
}

function deps(events: Record<string, CalendarEvent[] | Error> = {}, extra: Partial<FindTimesTogetherDeps> = {}) {
  const listEvents = vi.fn(async (userId: string) => {
    const got = events[userId] ?? []
    if (got instanceof Error) throw got
    return got
  })
  const readHours = vi.fn(async (userId: string) => HOURS[userId])
  const hasCalendar = vi.fn(async () => true)
  return { listEvents, readHours, hasCalendar, supabase: {} as never, ...extra } as FindTimesTogetherDeps & { listEvents: typeof listEvents; readHours: typeof readHours; hasCalendar: typeof hasCalendar }
}

describe('findTimesTogether', () => {
  it("the times inside everyone's own working hours, in their own zones", async () => {
    // Ada 9-6 New York (14:00-23:00Z), Dana 9-6 Chicago (15:00-24:00Z), Lee 9-6 London (09:00-18:00Z): 15:00-18:00Z.
    const d = deps()
    const out = await findTimesTogether(input([DANA, LEE]), d)
    expect(out.known).toBe(true)
    if (!out.known) return
    expect(out.free.map((s) => [iso(s.start), iso(s.end)])).toEqual([['2026-11-02T15:00:00.000Z', '2026-11-02T18:00:00.000Z']])
    // Suggested in the requester's zone: 10:00 New York.
    expect(out.suggested.map((s) => iso(s.start))).toEqual(['2026-11-02T15:00:00.000Z'])
    expect(out.people).toEqual([
      { userId: 'user-ada', name: 'Ada Finch', isRequester: true, coverage: 'complete', timeZone: NY },
      { userId: 'user-dana', name: 'Dana Whitfield', isRequester: false, coverage: 'complete', timeZone: CHI },
      { userId: 'user-lee', name: 'Lee Okafor', isRequester: false, coverage: 'complete', timeZone: LON },
    ])
    // The requester's hours are the ones given (this turn's zone); only the teammates' are read.
    expect(d.readHours.mock.calls.map((c) => c[0])).toEqual(['user-dana', 'user-lee'])
    // Each person's own calendars, scoped to the workspace, read strictly.
    expect(d.listEvents.mock.calls.map((c) => [c[0], (c as unknown[])[1]])).toEqual(
      ['user-ada', 'user-dana', 'user-lee'].map((id) => [id, expect.objectContaining({ workspaceId: 'ws-fernhill', strict: true })]),
    )
  })

  it("each person's busy time comes out of the common time; the answer carries only time", async () => {
    // Dana busy 15:00-16:30Z, Lee busy 17:30-18:00Z: common 16:30-17:30Z.
    const out = await findTimesTogether(input([DANA, LEE]), deps({ 'user-dana': [event('2026-11-02T15:00:00.000Z', '2026-11-02T16:30:00.000Z')], 'user-lee': [event('2026-11-02T17:30:00.000Z', '2026-11-02T18:00:00.000Z')] }))
    expect(out.known && out.free.map((s) => [iso(s.start), iso(s.end)])).toEqual([['2026-11-02T16:30:00.000Z', '2026-11-02T17:30:00.000Z']])
    const text = JSON.stringify(out)
    for (const leak of ['dentist', 'Elm', 'someone@example.com', 'e-2026']) expect(text, leak).not.toContain(leak)
  })

  it('a stretch shorter than the meeting is not offered', async () => {
    // Common 16:30-16:50Z only: shorter than 30 minutes.
    const out = await findTimesTogether(
      input([DANA, LEE]),
      deps({ 'user-dana': [event('2026-11-02T15:00:00.000Z', '2026-11-02T16:30:00.000Z')], 'user-lee': [event('2026-11-02T16:50:00.000Z', '2026-11-02T18:00:00.000Z')] }),
    )
    expect(out).toMatchObject({ known: true, free: [], suggested: [] })
  })

  it("someone who doesn't share: unknown for them, never read, and no common times", async () => {
    const d = deps()
    const out = await findTimesTogether(input([DANA, SAM]), d)
    expect(out.known).toBe(false)
    expect('free' in out).toBe(false)
    expect(out.people.find((p) => p.userId === 'user-sam')).toEqual({ userId: 'user-sam', name: 'Sam Ortiz', isRequester: false, coverage: 'unknown', reason: NOT_SHARING_REASON, timeZone: null })
    expect(out.people.find((p) => p.userId === 'user-dana')?.coverage).toBe('complete')
    expect(d.readHours).not.toHaveBeenCalledWith('user-sam')
    expect(d.hasCalendar).not.toHaveBeenCalledWith('user-sam')
    expect(d.listEvents.mock.calls.map((c) => c[0])).not.toContain('user-sam')
  })

  it('no calendar connected: unknown, never free', async () => {
    const out = await findTimesTogether(input([DANA]), deps({}, { hasCalendar: vi.fn(async (id: string) => id !== 'user-dana') }))
    expect(out.known).toBe(false)
    expect(out.people[1]).toMatchObject({ coverage: 'unknown', reason: 'they have no calendar connected', timeZone: CHI })
  })

  it("a teammate's calendar that cannot be read: unknown, in a fixed reason, never the provider's words", async () => {
    const out = await findTimesTogether(input([DANA, LEE]), deps({ 'user-dana': new Error('A calendar account needs signing in again'), 'user-lee': new Error('Google 403 for calendar lee.secret@example.com') }))
    expect(out.known).toBe(false)
    expect(out.people.map((p) => p.reason ?? null)).toEqual([null, 'a calendar of theirs needs signing in again', 'a calendar of theirs could not be read'])
    expect(JSON.stringify(out)).not.toContain('lee.secret')
  })

  it("the requester's own read error is theirs to see, in its own words", async () => {
    const out = await findTimesTogether(input([DANA]), deps({ 'user-ada': new Error('Exchange calendar could not be read: timeout') }))
    expect(out.people[0]).toMatchObject({ isRequester: true, coverage: 'unknown', reason: 'Exchange calendar could not be read: timeout' })
  })

  it('working hours that cannot be read: unknown for that person', async () => {
    const out = await findTimesTogether(input([DANA]), deps({}, { readHours: vi.fn(async () => Promise.reject(new Error('statement timeout'))) }))
    expect(out.people[1]).toMatchObject({ coverage: 'unknown', reason: 'their working hours could not be read', timeZone: null })
  })

  it('reads everyone at once', async () => {
    let inFlight = 0
    let most = 0
    const listEvents = vi.fn(async () => {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight--
      return []
    })
    await findTimesTogether(input([DANA, LEE]), deps({}, { listEvents }))
    expect(most).toBe(3)
  })

  it('the requester named among the others is read once', async () => {
    const d = deps()
    const out = await findTimesTogether(input([person('user-ada', 'Ada Finch'), DANA]), d)
    expect(out.people.map((p) => p.userId)).toEqual(['user-ada', 'user-dana'])
  })
})

describe('teammateReason', () => {
  it('says signing in again, or could not be read; nothing else', () => {
    expect(teammateReason('A calendar account needs signing in again')).toBe('a calendar of theirs needs signing in again')
    expect(teammateReason('Please reconnect')).toBe('a calendar of theirs needs signing in again')
    expect(teammateReason('anything at all')).toBe('a calendar of theirs could not be read')
  })

  it('a teammate whose time zone is nowhere known is unknown, never their hours read in UTC', async () => {
    const d = deps({}, { readHours: vi.fn(async (userId: string) => (userId === 'user-dana' ? { timeZone: 'UTC', weekly: DEFAULT_WEEKLY, zoneKnown: false } : HOURS[userId])) })
    const out = await findTimesTogether(input([DANA, LEE]), d)
    expect(out.known).toBe(false)
    expect(out.people.find((p) => p.userId === 'user-dana')).toMatchObject({ coverage: 'unknown', reason: ZONE_UNKNOWN_REASON, timeZone: null })
    // Their calendar is never read for nothing.
    expect(d.listEvents.mock.calls.map((c) => c[0])).not.toContain('user-dana')
  })
})
