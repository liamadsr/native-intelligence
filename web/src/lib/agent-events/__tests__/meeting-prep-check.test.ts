/**
 * Meeting prep trusts the person's guests and asks Jev first (Liam,
 * 2026-10-31: a three-day trip of invites from his wife got ~30 preps).
 *
 * Pinned:
 *   • the rule: the person's guests (their People tab's calendar addresses)
 *     aren't "other people", so an event with only guests on it has no
 *     audience and gets no prep, and no Jev call; one with an outsider too
 *     counts the guest apart (outside / teammates / guests, domains only);
 *   • what Jev reads (prepNeedInput): the local weekday and times, length,
 *     place and words, the counts and domains, organized and recurring;
 *   • the check (prepNeeded): a trusted skip skips; anything else (a prep,
 *     unsure, refused, a throw) preps; one check line per answer, ids only;
 *   • the sweep: a skip starts nothing, takes no slot (the next meeting still
 *     starts its prep), and leaves the meeting its plain heads-up at once,
 *     never held for a prep that won't come; a deferred meeting isn't asked;
 *     the real decision (runDecision, its cache) is asked once per meeting
 *     and start;
 *   • a skip is sticky (review, 10-31): its heads-up row says `prepSkipped`,
 *     so a later pass whose check would fail or flip never asks and never
 *     preps; a new start is asked again; without the row, the answer cache;
 *   • a workspace member is never a guest (an agent-linked teammate keeps
 *     the prep), and the guest list is read only when someone else is
 *     invited to a meeting in the prep window.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import type { CalendarEvent } from '@/lib/integrations/calendar'
import type { Evaluation } from '@/lib/ai/decisions/contracts'
import { meetingPassFor, type MeetingPassDeps } from '../meeting-pass'
import { meetingsNeedingPrep, prepCheckLine, prepNeedInput, prepNeeded, type DecidePrepNeed, type PrepCandidate } from '../meeting-prep'
import { cleanFacts } from '../record'
import { agentEventKey } from '../types'
import { meetingAttendance, meetingKey, type AccountRead, type UpcomingMeeting } from '../upcoming-meetings'

// The real decision service, over a stand-in for its usage log (its answer cache) and Jev.
const jev = vi.hoisted(() => ({ evaluate: vi.fn(), logged: [] as Array<Record<string, unknown>> }))
vi.mock('@/lib/ai/decisions/providers/jev', () => ({ evaluateJev: jev.evaluate, JEV_MODEL: 'typesafe-ai/jev' }))
vi.mock('@/lib/ai/auth', () => ({
  logUsage: async (_userId: string, params: { metadata: Record<string, unknown> }) => {
    jev.logged.push(params.metadata)
    return 'logged'
  },
  checkUsageLimits: async () => ({ allowed: true }),
  extractGatewayCost: () => undefined,
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      let key: unknown = null
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        gte: () => chain,
        order: () => chain,
        limit: () => chain,
        abortSignal: () => chain,
        contains: (_column: string, value: { decision_cache_key?: unknown }) => {
          key = value.decision_cache_key
          return chain
        },
        maybeSingle: async () => {
          if (table === 'member') return { data: { id: 'member-1' }, error: null }
          const hit = [...jev.logged].reverse().find((m) => m.decision_cache_key === key)
          return { data: hit ? { metadata: hit } : null, error: null }
        },
      }
      return chain
    },
  }),
}))

const NOW = Date.parse('2026-10-31T16:00:00.000Z')
const inMin = (m: number) => new Date(NOW + m * 60_000).toISOString()
const person = { workspaceId: 'w1', userId: 'u1', conversationId: 'home' }
const ME = 'me@us.example'
const JESS = 'jess@gmail.com'

let db: FakeSupabase
const send = vi.fn(async () => ({}))

const evt = (id: string, startMin: number, over: Partial<CalendarEvent> = {}): CalendarEvent =>
  ({ id, title: `Meeting ${id}`, start: inMin(startMin), end: inMin(startMin + 30), attendees: [ME, `guest@${id}.example`], ...over }) as CalendarEvent
const reading = (events: CalendarEvent[]) => vi.fn(async (): Promise<AccountRead> => ({ events }))
const key = (id: string) => meetingKey('calendar_event', id)

const accepted = (value: 'prep' | 'skip', cached = false) => ({ status: 'accepted' as const, value, inferenceId: 'inf', version: 'meeting-needs-prep-v1', ...(cached ? { cached } : {}) })
const jevSays = (choice: 'prep' | 'skip', p = 0.97) =>
  ({
    answers: { need: { type: 'choice', choice, probabilities: { [choice]: p, [choice === 'prep' ? 'skip' : 'prep']: 1 - p } } },
    providerMetadata: { typesafe: { confidence: { need: 0.95 } } },
    usage: { inputTokens: 400, outputTokens: 1 },
    response: { id: 'resp-1', modelId: 'typesafe-ai/jev', timestamp: new Date(NOW) },
  }) as unknown as Evaluation

beforeEach(() => {
  db = makeFakeSupabase()
  db.seed('connected_account', [{ id: 'a1', user_id: 'u1', workspace_id: 'w1', provider: 'google', capability: 'calendar', is_enabled: true, account_email: ME }])
  send.mockClear()
  jev.evaluate.mockReset()
  jev.logged.length = 0
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('the rule: guests aren’t “other people”', () => {
  const m = (id: string, attendees: string[]): UpcomingMeeting => ({ ref: 'calendar_event', id, meetingKey: key(id), workspaceId: 'w1', userId: 'u1', title: id, startIso: inMin(20), attendees, calendarEventId: id, captureId: null })

  it('an event with only guests has no audience (no prep); one with an outsider counts the guest apart, by domain, never by name', async () => {
    const got = await meetingAttendance(db as never, person, [m('lunch', [ME, JESS]), m('mixed', [ME, JESS, 'dana@acme.example', 'teammate@us.example']), m('team', [ME, 'teammate@us.example'])], {
      memberEmails: async () => new Set(['teammate@us.example']),
      trusted: new Set([JESS]),
    })
    expect(got.has(key('lunch'))).toBe(false)
    expect(got.get(key('mixed'))).toEqual({ audience: 'external', outside: 1, teammates: 1, guests: 1, domains: ['gmail.com', 'acme.example', 'us.example'] })
    expect(got.get(key('team'))).toEqual({ audience: 'internal', outside: 0, teammates: 1, guests: 0, domains: ['us.example'] })
    // Without the guest list she is an outsider, as before.
    const before = await meetingAttendance(db as never, person, [m('lunch', [ME, JESS])], { memberEmails: async () => new Set() })
    expect(before.get(key('lunch'))?.audience).toBe('external')
  })

  it('a workspace member is never a guest, even on the guest list: the member lookup covers every invited address', async () => {
    const memberEmails = vi.fn(async () => new Set(['sam@us.example']))
    const got = await meetingAttendance(db as never, person, [m('weekly', [ME, 'sam@us.example']), m('mixed', [ME, JESS, 'sam@us.example'])], {
      memberEmails,
      trusted: new Set([JESS, 'sam@us.example']),
    })
    expect(memberEmails).toHaveBeenCalledWith('w1', ['sam@us.example', JESS])
    expect(got.get(key('weekly'))).toEqual({ audience: 'internal', outside: 0, teammates: 1, guests: 0, domains: ['us.example'] })
    expect(got.get(key('mixed'))).toEqual({ audience: 'internal', outside: 0, teammates: 1, guests: 1, domains: ['gmail.com', 'us.example'] })
    // A member read that fails counts everyone a member: no one is a guest, the meeting keeps a (lighter) prep.
    const down = await meetingAttendance(db as never, person, [m('lunch', [ME, JESS])], { memberEmails: async () => { throw new Error('down') }, trusted: new Set([JESS]) })
    expect(down.get(key('lunch'))?.audience).toBe('internal')
  })

  it('a guest-list loader is called only when someone besides the person is invited; one that fails is no guests', async () => {
    const loader = vi.fn(async () => new Set([JESS]))
    await meetingAttendance(db as never, person, [m('solo', [ME]), m('room', [ME, 'c_1@resource.calendar.google.com'])], { memberEmails: async () => new Set(), trusted: loader })
    expect(loader).not.toHaveBeenCalled()
    const got = await meetingAttendance(db as never, person, [m('lunch', [ME, JESS])], { memberEmails: async () => new Set(), trusted: loader })
    expect(loader).toHaveBeenCalledOnce()
    expect(got.has(key('lunch'))).toBe(false)
    const failed = await meetingAttendance(db as never, person, [m('lunch', [ME, JESS])], { memberEmails: async () => new Set(), trusted: async () => { throw new Error('down') } })
    expect(failed.get(key('lunch'))?.audience).toBe('external')
  })

  it('a guests-only event never becomes a prep candidate', async () => {
    const meetings = [m('lunch', [ME, JESS])]
    const attendance = await meetingAttendance(db as never, person, meetings, { memberEmails: async () => new Set(), trusted: new Set([JESS]) })
    const audiences = new Map([...attendance].map(([k, a]) => [k, a.audience]))
    expect(meetingsNeedingPrep(person, meetings, audiences, new Map(), NOW)).toEqual([])
  })
})

describe('what Jev reads, and how its answer is taken', () => {
  const candidate = (over: Partial<PrepCandidate> = {}): PrepCandidate => ({
    ref: 'calendar_event',
    meetingKey: key('lunch'),
    workspaceId: 'w1',
    userId: 'u1',
    conversationId: 'home',
    title: 'Lunch',
    startIso: '2026-10-31T16:30:00.000Z',
    endIso: '2026-10-31T17:45:00.000Z',
    calendarEventId: 'lunch',
    captureId: null,
    audience: 'external',
    seriesKey: null,
    icalUid: null,
    location: 'Le Perche, 230 Warren St, Hudson, NY',
    description: 'Table for two',
    recurring: false,
    mine: false,
    ...over,
  })
  const attendance = { audience: 'external' as const, outside: 1, teammates: 0, guests: 1, domains: ['gmail.com', 'example.org'] }

  it('prepNeedInput: the local weekday, times and length in the person’s zone, the place and words, counts and domains', () => {
    expect(prepNeedInput(candidate(), attendance, 'America/New_York')).toEqual({
      title: 'Lunch',
      weekday: 'Saturday',
      start: '12:30',
      end: '13:45',
      durationMinutes: 75,
      location: 'Le Perche, 230 Warren St, Hudson, NY',
      description: 'Table for two',
      outsideAttendees: 1,
      teammates: 0,
      guests: 1,
      organizedByPerson: false,
      recurring: false,
      attendeeDomains: ['gmail.com', 'example.org'],
    })
    // No end, an unknown organizer, a series: said so; no zone: UTC.
    expect(prepNeedInput(candidate({ endIso: null, mine: undefined, recurring: undefined, seriesKey: 's-1' }), undefined, 'Nowhere/Else')).toMatchObject({
      start: '16:30',
      end: null,
      durationMinutes: null,
      organizedByPerson: null,
      recurring: true,
      outsideAttendees: 0,
      attendeeDomains: [],
    })
  })

  it('prepNeeded: a trusted skip skips; a prep, an unsure answer, a refusal or a throw preps; one check line each, ids only', async () => {
    const decide = (result: Awaited<ReturnType<DecidePrepNeed>> | Error): DecidePrepNeed => async () => {
      if (result instanceof Error) throw result
      return result
    }
    expect(await prepNeeded(candidate(), attendance, 'UTC', decide(accepted('skip')))).toBe('skip')
    expect(await prepNeeded(candidate(), attendance, 'UTC', decide(accepted('prep')))).toBe('prep')
    expect(await prepNeeded(candidate(), attendance, 'UTC', decide({ status: 'escalate', reason: 'uncertain' }))).toBe('prep')
    expect(await prepNeeded(candidate(), attendance, 'UTC', decide({ status: 'escalate', reason: 'budget_unavailable' }))).toBe('prep')
    expect(await prepNeeded(candidate(), attendance, 'UTC', decide(new Error('jev down')))).toBe('prep')
    const lines = vi.mocked(console.info).mock.calls.map((c) => String(c[0]))
    expect(lines).toEqual([
      prepCheckLine(candidate(), 'skip', 'jev'),
      prepCheckLine(candidate(), 'prep', 'jev'),
      prepCheckLine(candidate(), 'prep', 'escalate:uncertain'),
      prepCheckLine(candidate(), 'prep', 'escalate:budget_unavailable'),
      prepCheckLine(candidate(), 'prep', 'unavailable'),
    ])
    expect(lines[0]).toBe(`[meeting-prep] check workspace=w1 user=u1 meeting=${key('lunch')} start=${Date.parse('2026-10-31T16:30:00.000Z')} need=skip by=jev`)
    for (const line of lines) expect(line).not.toMatch(/Lunch|Perche|Table/)
  })

  it('asks with the person, the workspace and the meeting and start as the decision’s subject', async () => {
    const decide = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    await prepNeeded(candidate(), attendance, 'UTC', decide)
    expect(decide).toHaveBeenCalledWith(expect.objectContaining({ title: 'Lunch' }), { userId: 'u1', workspaceId: 'w1', messageId: `meeting:${key('lunch')}:${Date.parse('2026-10-31T16:30:00.000Z')}` })
  })
})

describe('the sweep', () => {
  const rpc = vi.fn()
  const deps = (over: Partial<MeetingPassDeps> = {}): MeetingPassDeps => ({
    pausedState: async () => 'active',
    isDormant: async () => false,
    startHelper: async (_db, start) => {
      rpc(start)
      return { status: 'started', run_id: `run-${rpc.mock.calls.length}`, work_item_id: 'item', reused: false }
    },
    memberEmails: async () => new Set(['teammate@us.example']),
    trustedGuests: async () => new Set([JESS]),
    personTimeZone: async () => 'America/New_York',
    record: { send },
    ...over,
  })
  const plainRow = (id: string, startMin: number) => agentEventKey.meetingSoon(key(id), inMin(startMin))
  beforeEach(() => rpc.mockClear())

  it('an event with only the person’s guests: no prep, no Jev call, and its plain heads-up at once', async () => {
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    const out = await meetingPassFor(db as never, person, deps({ decidePrep, listAccount: reading([evt('lunch', 20, { title: 'Lunch', attendees: [ME, JESS], organizer: JESS })]) }), NOW)
    expect(decidePrep).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(out.preps).toEqual([])
    expect(db.rows('agent_event').map((r) => r.dedupe_key)).toEqual([plainRow('lunch', 20)])
  })

  it('a skip starts nothing and takes no slot: the next meeting still gets its prep; the skipped one gets its plain heads-up now, not held', async () => {
    const decidePrep = vi.fn<DecidePrepNeed>(async (input) => accepted(input.title === 'Happy Hour' ? 'skip' : 'prep'))
    const out = await meetingPassFor(
      db as never,
      person,
      deps({ decidePrep, listAccount: reading([evt('happy', 20, { title: 'Happy Hour', location: 'The Half Moon tavern' }), evt('catchup', 25, { title: 'Catch up', attendees: [ME, 'partner@a16z.example'] })]) }),
      NOW,
    )
    expect(decidePrep).toHaveBeenCalledTimes(2)
    expect(decidePrep.mock.calls[0][0]).toMatchObject({ title: 'Happy Hour', location: 'The Half Moon tavern', outsideAttendees: 1, weekday: 'Saturday', start: '12:20' })
    expect(out.preps).toEqual([{ status: 'skipped', reason: 'not_needed' }, { status: 'started', runId: 'run-1', workItemId: 'item' }])
    expect(rpc).toHaveBeenCalledOnce()
    expect(rpc.mock.calls[0][0]).toMatchObject({ subject: key('catchup') })
    // The skipped one's heads-up goes out plain now, marked skipped; the other waits for its prep.
    expect(db.rows('agent_event').map((r) => [r.dedupe_key, (r.facts as { prepSkipped?: boolean }).prepSkipped])).toEqual([[plainRow('happy', 20), true]])
  })

  it('the skip mark is a flag the recorder keeps, and only a boolean', () => {
    expect(cleanFacts({ title: 'Lunch', prepSkipped: true })).toEqual({ title: 'Lunch', prepSkipped: true })
    expect(cleanFacts({ title: 'Lunch', prepSkipped: 'yes' as unknown as boolean })).toEqual({ title: 'Lunch' })
  })

  it('a skipped meeting whose own address isn’t listed still gets its plain heads-up (the prep’s audience check saw someone else)', async () => {
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('skip'))
    await meetingPassFor(db as never, person, deps({ decidePrep, listAccount: reading([evt('drinks', 20, { title: 'Drinks', attendees: ['friend@icloud.example'] })]) }), NOW)
    expect(db.rows('agent_event').map((r) => r.dedupe_key)).toEqual([plainRow('drinks', 20)])
  })

  it('the guest list is read only when a meeting in the prep window invites someone besides the person', async () => {
    const trustedGuests = vi.fn(async () => new Set([JESS]))
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    await meetingPassFor(db as never, person, deps({ trustedGuests, decidePrep, listAccount: reading([evt('focus', 20, { title: 'Focus', attendees: [ME] }), evt('soon', 3, { title: 'Too close' })]) }), NOW)
    expect(trustedGuests).not.toHaveBeenCalled()
    await meetingPassFor(db as never, person, deps({ trustedGuests, decidePrep, listAccount: reading([evt('focus', 20, { title: 'Focus', attendees: [ME] }), evt('sync', 25)]) }), NOW)
    expect(trustedGuests).toHaveBeenCalledOnce()
  })

  it('an agent-linked teammate (a workspace member on the guest list) keeps the meeting its prep', async () => {
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    await meetingPassFor(
      db as never,
      person,
      deps({ decidePrep, trustedGuests: async () => new Set(['teammate@us.example', JESS]), listAccount: reading([evt('weekly', 20, { title: 'Liam / Sam weekly', attendees: [ME, 'teammate@us.example'] })]) }),
      NOW,
    )
    expect(decidePrep.mock.calls[0][0]).toMatchObject({ teammates: 1, guests: 0, outsideAttendees: 0 })
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('unsure or failed: the prep starts, as before', async () => {
    for (const decidePrep of [async () => ({ status: 'escalate' as const, reason: 'uncertain' }), async () => { throw new Error('down') }] as DecidePrepNeed[]) {
      rpc.mockClear()
      await meetingPassFor(db as never, person, deps({ decidePrep, listAccount: reading([evt('sync', 20, { title: 'Acme sync' })]) }), NOW)
      expect(rpc).toHaveBeenCalledOnce()
    }
  })

  it('a meeting deferred behind a started prep isn’t asked this pass', async () => {
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    const out = await meetingPassFor(db as never, person, deps({ decidePrep, listAccount: reading([evt('a', 20), evt('b', 25)]) }), NOW)
    expect(decidePrep).toHaveBeenCalledOnce()
    expect(out.preps.map((p) => (p.status === 'skipped' ? p.reason : p.status))).toEqual(['started', 'deferred'])
  })

  it('the real decision: asked once per meeting and start; the next pass keeps the recorded skip (no model call), never a prep', async () => {
    jev.evaluate.mockResolvedValue(jevSays('skip'))
    const listAccount = reading([evt('corn', 25, { title: 'Corn Maze', location: 'Golden Harvest Farms, Valatie, NY', attendees: [ME, 'friend@icloud.example'] })])
    const first = await meetingPassFor(db as never, person, deps({ listAccount }), NOW)
    const second = await meetingPassFor(db as never, person, deps({ listAccount }), NOW + 5 * 60_000)
    expect(jev.evaluate).toHaveBeenCalledOnce()
    expect(first.preps).toEqual([{ status: 'skipped', reason: 'not_needed' }])
    expect(second.preps).toEqual([{ status: 'skipped', reason: 'not_needed' }])
    expect(rpc).not.toHaveBeenCalled()
    const checks = vi.mocked(console.info).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[meeting-prep] check'))
    expect(checks.map((l) => l.split(' by=')[1])).toEqual(['jev', 'recorded'])
    // One heads-up, plain, written once, saying the prep was skipped.
    expect(db.rows('agent_event').map((r) => [r.dedupe_key, (r.facts as { prepSkipped?: boolean }).prepSkipped])).toEqual([[plainRow('corn', 25), true]])
    // The state Jev read held no attendee name and no address.
    const [state] = jev.evaluate.mock.calls[0] as [string]
    expect(state).toContain('Corn Maze')
    expect(state).not.toContain('friend@')
  })

  it('the real decision with no recorded row (its heads-up not written): the next pass is served from the answer cache', async () => {
    jev.evaluate.mockResolvedValue(jevSays('skip'))
    const listAccount = reading([evt('corn', 25, { title: 'Corn Maze', attendees: [ME, 'friend@icloud.example'] })])
    await meetingPassFor(db as never, person, deps({ listAccount }), NOW)
    db.rows('agent_event').length = 0
    await meetingPassFor(db as never, person, deps({ listAccount }), NOW + 5 * 60_000)
    expect(jev.evaluate).toHaveBeenCalledOnce()
    const checks = vi.mocked(console.info).mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('[meeting-prep] check'))
    expect(checks.map((l) => l.split(' by=')[1])).toEqual(['jev', 'cache'])
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a skip is sticky per meeting and start: a later check that would fail or say prep is never asked, and no prep starts; a new start is asked again', async () => {
    const lunch = (startMin: number) => reading([evt('lunch', startMin, { title: 'Lunch', attendees: [ME, 'friend@icloud.example'] })])
    const decidePrep = vi.fn<DecidePrepNeed>(async () => accepted('skip'))
    await meetingPassFor(db as never, person, deps({ decidePrep, listAccount: lunch(25) }), NOW)
    expect(decidePrep).toHaveBeenCalledOnce()
    // T−10: the check would now fail (or say prep): it isn't asked, and nothing starts.
    for (const later of [async () => { throw new Error('deadline') }, async () => accepted('prep')] as DecidePrepNeed[]) {
      const fn = vi.fn(later)
      const out = await meetingPassFor(db as never, person, deps({ decidePrep: fn, listAccount: lunch(25) }), NOW + 15 * 60_000)
      expect(fn).not.toHaveBeenCalled()
      expect(out.preps).toEqual([{ status: 'skipped', reason: 'not_needed' }])
    }
    expect(rpc).not.toHaveBeenCalled()
    // Moved to a new start: a new meeting occurrence, asked again (and here it preps).
    const moved = vi.fn<DecidePrepNeed>(async () => accepted('prep'))
    await meetingPassFor(db as never, person, deps({ decidePrep: moved, listAccount: lunch(40) }), NOW + 15 * 60_000)
    expect(moved).toHaveBeenCalledOnce()
    expect(rpc).toHaveBeenCalledOnce()
  })

  it('the real decision, unsure: prep (fail open)', async () => {
    jev.evaluate.mockResolvedValue(jevSays('skip', 0.6))
    await meetingPassFor(db as never, person, deps({ listAccount: reading([evt('maybe', 20, { title: 'Coffee' })]) }), NOW)
    expect(rpc).toHaveBeenCalledOnce()
  })
})
