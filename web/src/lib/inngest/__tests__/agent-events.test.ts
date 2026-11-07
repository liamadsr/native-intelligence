/**
 * The agent's inbox on Inngest (src/lib/inngest/agent-events.ts, A6).
 *
 * Pinned: flow/capture.processed records one `capture.processed` event for
 * the capture's OWNER only, read in the event's workspace, with the agent
 * log consumer's skips, carrying what the live agent left open; the meeting
 * cron runs every 15 minutes over everyone with a home thread (one calendar
 * pass each, in chunks, with gates read once per workspace); the router is debounced 60 s and serialized per
 * person, and routes the person the event names.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

type Handler = (ctx: { event?: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  fns: new Map<string, { config: Record<string, unknown>; handler: Handler }>(),
  captures: [] as Array<Record<string, unknown>>,
  recordAgentEvents: vi.fn(async (inputs: unknown[]) => inputs.length),
  findMeetingPeople: vi.fn(async (): Promise<unknown[]> => []),
  meetingPassFor: vi.fn(async (): Promise<Record<string, unknown>> => ({ meetings: 0, soon: 0, recorded: 0, preps: [] })),
  liveFollowups: vi.fn(async (): Promise<Record<string, number>> => ({})),
  firstRunCapture: vi.fn(async () => false),
  routeAgentEvents: vi.fn(async () => ({ read: 1, routed: 1, outcomes: { ignore: 0, quiet: 1, turn: 0, notify: 0 }, gates: { paused: false, dormant: false, overUsage: false }, shadowed: 1 })),
  findDigestCandidates: vi.fn(async (): Promise<unknown[]> => []),
  findUnroutedPeople: vi.fn(async (): Promise<unknown[]> => []),
  planDigestFor: vi.fn(),
  startServerHelper: vi.fn(),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, handler: Handler) => {
      hoisted.fns.set(config.id as string, { config, handler })
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: () => {
      const eqs: Array<[string, unknown]> = []
      const q = {
        select: () => q,
        eq: (k: string, v: unknown) => (eqs.push([k, v]), q),
        maybeSingle: async () => ({ data: hoisted.captures.find((r) => eqs.every(([k, v]) => r[k] === v)) ?? null, error: null }),
      }
      return q
    },
  }),
}))
vi.mock('@/lib/agent-events/record', () => ({ recordAgentEvents: hoisted.recordAgentEvents, findUnroutedPeople: hoisted.findUnroutedPeople }))
vi.mock('@/lib/agent-events/upcoming-meetings', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-events/upcoming-meetings')>()),
  findMeetingPeople: hoisted.findMeetingPeople,
}))
vi.mock('@/lib/agent-events/meeting-pass', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-events/meeting-pass')>()),
  meetingPassFor: hoisted.meetingPassFor,
}))
vi.mock('@/lib/agent-events/live-followups', () => ({ captureLiveFollowups: hoisted.liveFollowups }))
vi.mock('@/lib/onboarding/getting-started', () => ({ isFirstRunCapture: hoisted.firstRunCapture }))
vi.mock('@/lib/agent-events/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-events/router')>()),
  routeAgentEvents: hoisted.routeAgentEvents,
}))
vi.mock('@/lib/agent-events/router-deps', () => ({ defaultRouterDeps: () => ({ marker: 'deps' }) }))
vi.mock('@/lib/agent-events/digest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/agent-events/digest')>()),
  findDigestCandidates: hoisted.findDigestCandidates,
  planDigestFor: hoisted.planDigestFor,
}))
vi.mock('@/lib/chat/start-helper', () => ({ startServerHelper: hoisted.startServerHelper }))
// The Now file's check-in rides the digest's scan (src/lib/now/check-in.ts).
const checkIn = vi.hoisted(() => ({ planCheckInFor: vi.fn() }))
vi.mock('@/lib/now/check-in', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/now/check-in')>()),
  planCheckInFor: checkIn.planCheckInFor,
}))
// The look-ahead rides it too, at 8 (later today) and 19 (tomorrow morning): src/lib/look-ahead/run.ts.
const lookAhead = vi.hoisted(() => ({ planLookAheadFor: vi.fn() }))
vi.mock('@/lib/look-ahead/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/look-ahead/run')>()),
  planLookAheadFor: lookAhead.planLookAheadFor,
}))
vi.mock('@/lib/inngest/flow-functions', () => ({ workspaceIsDormant: vi.fn(async () => false) }))

await import('@/lib/inngest/agent-events')

const fn = (id: string) => hoisted.fns.get(id)!

beforeEach(() => {
  hoisted.captures = []
  hoisted.recordAgentEvents.mockClear()
  hoisted.findMeetingPeople.mockClear()
  hoisted.meetingPassFor.mockClear()
  hoisted.liveFollowups.mockClear()
  hoisted.firstRunCapture.mockClear()
  hoisted.routeAgentEvents.mockClear()
})

describe('agentEventCaptureProcessed', () => {
  const run = (data: Record<string, unknown>) => fn('agent-event-capture-processed').handler({ event: { data }, step: createStepMock() })

  it('records one event for the capture’s owner, in its own workspace', async () => {
    hoisted.captures = [{ id: 'cap-1', workspace_id: 'w1', title: 'Acme sync', user_id: 'owner', batch_processed_at: '2026-10-14T10:00:00.000Z', metadata: {}, status: 'completed' }]
    expect(fn('agent-event-capture-processed').config.triggers).toEqual([{ event: 'flow/capture.processed' }])
    expect(await run({ workspace_id: 'w1', capture_id: 'cap-1' })).toEqual({ status: 'recorded', captureId: 'cap-1' })
    expect(hoisted.recordAgentEvents).toHaveBeenCalledWith([
      {
        workspaceId: 'w1',
        userId: 'owner',
        kind: 'capture.processed',
        priority: 1,
        occursAt: '2026-10-14T10:00:00.000Z',
        refType: 'capture',
        refId: 'cap-1',
        facts: { title: 'Acme sync' },
        dedupeKey: 'capture:cap-1:processed',
      },
    ])
  })

  it('the live chat → main agent bridge: what the live agent left open rides the event as counts', async () => {
    hoisted.captures = [{ id: 'cap-2', workspace_id: 'w1', title: 'Acme live', user_id: 'owner', batch_processed_at: '2026-10-14T10:00:00.000Z', metadata: {}, status: 'completed' }]
    hoisted.liveFollowups.mockResolvedValueOnce({ openAsks: 1, pendingProposals: 3 })
    await run({ workspace_id: 'w1', capture_id: 'cap-2' })
    expect(hoisted.liveFollowups).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w1', captureId: 'cap-2' })
    expect(hoisted.recordAgentEvents.mock.calls[0][0]).toMatchObject([{ kind: 'capture.processed', refId: 'cap-2', facts: { title: 'Acme live', openAsks: 1, pendingProposals: 3 } }])
  })

  it('the owner’s first capture while getting started is marked firstRun (docs/plans/getting-started-skill.md), read for the owner in its workspace', async () => {
    hoisted.captures = [{ id: 'cap-3', workspace_id: 'w1', title: 'Talking to myself', user_id: 'owner', batch_processed_at: '2026-10-27T10:00:00.000Z', metadata: {}, status: 'completed' }]
    hoisted.firstRunCapture.mockResolvedValueOnce(true)
    await run({ workspace_id: 'w1', capture_id: 'cap-3' })
    expect(hoisted.firstRunCapture).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w1', userId: 'owner', captureId: 'cap-3' })
    expect(hoisted.recordAgentEvents.mock.calls[0][0]).toMatchObject([{ kind: 'capture.processed', refId: 'cap-3', facts: { title: 'Talking to myself', firstRun: true } }])
  })

  it('skips a re-fire, a demo, an archived or ownerless capture, and one in another workspace', async () => {
    hoisted.captures = [
      { id: 'demo', workspace_id: 'w1', user_id: 'o', metadata: { demo: true } },
      { id: 'arch', workspace_id: 'w1', user_id: 'o', metadata: {}, status: 'archived' },
      { id: 'none', workspace_id: 'w1', user_id: null, metadata: {} },
    ]
    expect(await run({ workspace_id: 'w1', capture_id: 'x', reconciled: true })).toMatchObject({ reason: 'reconciled_refire' })
    expect(await run({ workspace_id: 'w1', capture_id: 'demo' })).toMatchObject({ reason: 'demo_capture' })
    expect(await run({ workspace_id: 'w1', capture_id: 'arch' })).toMatchObject({ reason: 'archived_capture' })
    expect(await run({ workspace_id: 'w1', capture_id: 'none' })).toMatchObject({ reason: 'no_owner' })
    // Eval fixtures never reach the inbox.
    hoisted.captures.push({ id: 'evalfix', workspace_id: 'w1', user_id: 'o', metadata: {}, is_eval: true })
    expect(await run({ workspace_id: 'w1', capture_id: 'evalfix' })).toMatchObject({ reason: 'eval_capture' })
    expect(await run({ workspace_id: 'w2', capture_id: 'demo' })).toMatchObject({ reason: 'missing_capture' })
    expect(hoisted.recordAgentEvents).not.toHaveBeenCalled()
  })
})

describe('agentEventMeetingSoon (meeting-soon and prep, one calendar pass per person)', () => {
  const person = (n: number) => ({ workspaceId: n % 2 ? 'w1' : 'w2', userId: `u${n}`, conversationId: `home-${n}` })

  it('runs every 5 minutes (prep lands about 30 minutes before each meeting): everyone with a home thread, in chunks, through the server helper door, gates read once per workspace', async () => {
    const { config, handler } = fn('agent-event-meeting-soon')
    expect(config.triggers).toEqual([{ cron: '*/5 * * * *' }])
    // Never two passes at once: a slow one makes the next tick skip.
    expect(config.singleton).toEqual({ mode: 'skip' })
    expect(await handler({ step: createStepMock() })).toEqual({ status: 'done', people: 0, meetings: 0, recorded: 0, preps: 0 })
    hoisted.findMeetingPeople.mockResolvedValueOnce(Array.from({ length: 30 }, (_, i) => person(i)))
    hoisted.meetingPassFor.mockImplementation(async () => ({ meetings: 2, soon: 1, recorded: 1, preps: [{ status: 'started', runId: 'r', workItemId: 'w' }] }))
    vi.spyOn(console, 'info').mockImplementation(() => {})
    const step = createStepMock()
    expect(await handler({ step })).toEqual({ status: 'done', people: 30, meetings: 60, recorded: 30, preps: 30 })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['find-people-0', 'meetings-0-0', 'meetings-0-1', 'find-unrouted'])
    const deps = (hoisted.meetingPassFor.mock.calls[0] as unknown[])[2] as { startHelper: unknown }
    expect(deps.startHelper).toBe(hoisted.startServerHelper)
    hoisted.meetingPassFor.mockReset().mockResolvedValue({ meetings: 0, soon: 0, recorded: 0, preps: [] })
  })

  it('also wakes the router for people with rows left unrouted (outside the steps)', async () => {
    const { handler } = fn('agent-event-meeting-soon')
    const people = [{ workspaceId: 'w1', userId: 'u1', personKey: 'w1:u1' }, { workspaceId: 'w2', userId: 'u2', personKey: 'w2:u2' }]
    hoisted.findUnroutedPeople.mockResolvedValueOnce(people)
    const step = createStepMock()
    expect(await handler({ step })).toEqual({ status: 'done', people: 0, meetings: 0, recorded: 0, preps: 0, woken: 2 })
    expect(step.sendEvent).toHaveBeenCalledWith('wake-router', people.map((data) => ({ name: 'agent/event.created', data })))
  })

  it('pages through everyone (a full page reads the next), never silently cut at a cap', async () => {
    const { handler } = fn('agent-event-meeting-soon')
    hoisted.findMeetingPeople
      .mockResolvedValueOnce(Array.from({ length: 500 }, (_, i) => person(i)))
      .mockResolvedValueOnce([person(900)])
    const step = createStepMock()
    const out = (await handler({ step })) as { people: number }
    expect(out.people).toBe(501)
    expect(hoisted.findMeetingPeople.mock.calls.map((c) => (c as unknown[])[1])).toEqual([0, 1])
    expect(hoisted.meetingPassFor).toHaveBeenCalledTimes(501)
  })

  it('there is no separate prep cron any more', () => {
    expect(hoisted.fns.has('agent-event-meeting-prep')).toBe(false)
  })
})

describe('agentEventRoute', () => {
  it('is debounced 60 s and serialized per person, and routes the person the event names', async () => {
    const { config, handler } = fn('agent-event-route')
    expect(config.triggers).toEqual([{ event: 'agent/event.created' }])
    expect(config.debounce).toEqual({ key: 'event.data.personKey', period: '60s', timeout: '5m' })
    expect(config.concurrency).toEqual([{ limit: 1, key: 'event.data.personKey' }])
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const out = await handler({ event: { data: { workspaceId: 'w1', userId: 'u1', personKey: 'w1:u1' } }, step: createStepMock() })
    expect(out).toMatchObject({ status: 'done', routed: 1 })
    expect(hoisted.routeAgentEvents).toHaveBeenCalledWith(expect.anything(), { workspaceId: 'w1', userId: 'u1' }, { marker: 'deps' })
    expect(info.mock.calls[0][0]).toContain('[agent-router] ws=w1 user=u1')
    info.mockRestore()
    expect(await handler({ event: { data: {} }, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'bad_event' })
  })
})

describe('agentEventDigest (A6 slice 4)', () => {
  const c = (n: number) => ({ memberId: `m${n}`, userId: `u${n}`, workspaceId: 'w1', timeZone: 'Europe/London', date: '2026-10-14' })
  const req = (n: number) => ({ id: `home-turn-digest:conv-${n}:2026-10-14`, name: 'home/turn.requested', data: { conversationId: `conv-${n}`, reason: 'digest' } })

  it('runs hourly', () => {
    expect(fn('agent-event-digest').config).toMatchObject({ triggers: [{ cron: '0 * * * *' }] })
  })

  it('plans everyone at their 8 o’clock in chunks, then sends one event per planned person (outside the steps)', async () => {
    hoisted.findDigestCandidates.mockResolvedValueOnce(Array.from({ length: 52 }, (_, i) => c(i)))
    hoisted.planDigestFor.mockImplementation(async (_db: unknown, cand: { userId: string }) => {
      const n = Number(cand.userId.slice(1))
      return n % 2 === 0 ? { ok: true, request: req(n) } : { ok: false, reason: n === 1 ? 'nothing_new' : 'paused' }
    })
    const step = createStepMock()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const out = (await fn('agent-event-digest').handler({ step })) as { sent: number; skips: Record<string, number> }
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['find-candidates', 'plan-0', 'plan-1'])
    expect(step.sendEvent).toHaveBeenCalledTimes(2)
    const [id, events] = step.sendEvent.mock.calls[0] as [string, Array<{ id: string }>]
    expect(id).toBe('request-digests')
    expect(events).toHaveLength(26)
    expect(events[0]).toEqual(req(0))
    // The morning tidy beside them: everyone but the paused (nothing new to say still tidies).
    const [tidyId, tidies] = step.sendEvent.mock.calls[1] as [string, Array<{ id: string; name: string; data: unknown }>]
    expect(tidyId).toBe('request-auto-archive')
    expect(tidies).toHaveLength(27)
    expect(tidies[1]).toEqual({ id: 'email-auto-archive:w1:u1:2026-10-14', name: 'email/auto-archive.requested', data: { workspaceId: 'w1', userId: 'u1', date: '2026-10-14' } })
    expect(out.sent).toBe(26)
    expect(out.skips).toEqual({ nothing_new: 1, paused: 25 })
    expect(info.mock.calls.map(([l]) => String(l))).toEqual([expect.stringContaining('[agent-digest] candidates=52 sent=26 tidies=27')])
    info.mockRestore()
  })

  it('no tidy where the digest found no home thread, autonomy off or a dormant workspace', async () => {
    hoisted.findDigestCandidates.mockResolvedValueOnce([c(1), c(2), c(3), c(4), c(5)])
    hoisted.planDigestFor
      .mockResolvedValueOnce({ ok: false, reason: 'no_home_thread' })
      .mockResolvedValueOnce({ ok: false, reason: 'paused' })
      .mockResolvedValueOnce({ ok: false, reason: 'dormant' })
      .mockResolvedValueOnce({ ok: false, reason: 'already_sent' })
      .mockResolvedValueOnce({ ok: false, reason: 'lookup_failed' })
    const step = createStepMock()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await fn('agent-event-digest').handler({ step })
    expect(step.sendEvent).toHaveBeenCalledOnce()
    const [tidyId, tidies] = step.sendEvent.mock.calls[0] as [string, Array<{ data: { userId: string } }>]
    expect(tidyId).toBe('request-auto-archive')
    expect(tidies.map((t) => t.data.userId)).toEqual(['u4', 'u5'])
  })

  it('nobody planned: no event', async () => {
    hoisted.findDigestCandidates.mockResolvedValueOnce([c(1)])
    hoisted.planDigestFor.mockResolvedValueOnce({ ok: false, reason: 'no_home_thread' })
    const step = createStepMock()
    vi.spyOn(console, 'info').mockImplementation(() => {})
    await fn('agent-event-digest').handler({ step })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('the Now file’s check-ins ride the same one member scan: 8 for the digest, 10/12/14/16 planned as check-ins, each skip in code', async () => {
    checkIn.planCheckInFor.mockReset()
    hoisted.planDigestFor.mockReset()
    hoisted.findDigestCandidates.mockClear()
    hoisted.findDigestCandidates.mockResolvedValueOnce([{ ...c(1), hour: 8 }, { ...c(2), hour: 12 }, { ...c(3), hour: 14 }, { ...c(4), hour: 17 }])
    hoisted.planDigestFor.mockResolvedValue({ ok: false, reason: 'nothing_new' })
    const request = { id: 'home-turn-check-in:conv-2:2026-10-14:12', name: 'home/turn.requested', data: { conversationId: 'conv-2', reason: 'check_in', checkInSlot: { date: '2026-10-14', hour: 12 } } }
    checkIn.planCheckInFor.mockImplementation(async (_db: unknown, cand: { userId: string }) => (cand.userId === 'u2' ? { ok: true, request } : { ok: false, reason: 'nothing_to_start' }))
    lookAhead.planLookAheadFor.mockReset()
    lookAhead.planLookAheadFor.mockResolvedValue({ ok: false, reason: 'no_zone' })
    const step = createStepMock()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const out = (await fn('agent-event-digest').handler({ step })) as { candidates: number; checkIn: { candidates: number; sent: number; skips: Record<string, number> } }
    // One scan, asked for every hour at once.
    expect(hoisted.findDigestCandidates).toHaveBeenCalledOnce()
    expect((hoisted.findDigestCandidates.mock.calls[0] as unknown[])[2]).toEqual([8, 10, 12, 14, 16, 19])
    expect(hoisted.planDigestFor.mock.calls.map(([, cand]) => (cand as { userId: string }).userId)).toEqual(['u1'])
    expect(checkIn.planCheckInFor.mock.calls.map(([, cand]) => (cand as { userId: string }).userId)).toEqual(['u2', 'u3'])
    // 8 is also the look-ahead's morning slot.
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['find-candidates', 'plan-0', 'check-in-0', 'look-ahead-0'])
    expect(step.sendEvent).toHaveBeenCalledWith('request-check-ins', [request])
    expect(out.candidates).toBe(1)
    expect(out.checkIn).toEqual({ candidates: 2, sent: 1, skips: { nothing_to_start: 1 } })
    expect(info.mock.calls.map(([l]) => String(l))).toContain('[now-check-in] candidates=2 sent=1 nothing_to_start=1')
    info.mockRestore()
  })

  it('the look-ahead rides it too: 19 plans tomorrow morning, 8 later today, each skip in code', async () => {
    hoisted.planDigestFor.mockReset()
    hoisted.planDigestFor.mockResolvedValue({ ok: false, reason: 'nothing_new' })
    checkIn.planCheckInFor.mockReset()
    lookAhead.planLookAheadFor.mockReset()
    hoisted.findDigestCandidates.mockResolvedValueOnce([{ ...c(1), hour: 8 }, { ...c(2), hour: 19 }, { ...c(3), hour: 19 }])
    const request = { id: 'look-ahead:conv-2:2026-10-14:evening', name: 'look-ahead/requested', data: { conversationId: 'conv-2', slot: 'evening' } }
    lookAhead.planLookAheadFor.mockImplementation(async (_db: unknown, cand: { userId: string }) => (cand.userId === 'u2' ? { ok: true, request } : { ok: false, reason: 'no_zone' }))
    const step = createStepMock()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const out = (await fn('agent-event-digest').handler({ step })) as { lookAhead: { candidates: number; sent: number; skips: Record<string, number> } }
    expect(lookAhead.planLookAheadFor.mock.calls.map(([, cand, slot]) => [(cand as { userId: string }).userId, slot])).toEqual([
      ['u1', 'morning'],
      ['u2', 'evening'],
      ['u3', 'evening'],
    ])
    expect(step.sendEvent).toHaveBeenCalledWith('request-look-aheads', [request])
    expect(out.lookAhead).toEqual({ candidates: 3, sent: 1, skips: { no_zone: 2 } })
    expect(info.mock.calls.map(([l]) => String(l))).toContain('[look-ahead] candidates=3 sent=1 no_zone=2')
    info.mockRestore()
  })
})
