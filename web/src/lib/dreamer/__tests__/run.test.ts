/**
 * The Dreamer's schedule and start (docs/plans/dreamer.md "Schedule and
 * gates", src/lib/dreamer/run.ts): its hours, the reflection's skip on the
 * UTC fallback, the event's id and payload, each gate's skip in order, and the
 * start: kind 'dreamer', quiet, its key for the slot and its task (the role and
 * the run's instructions). Made-up ids.
 */
import { describe, expect, it, vi } from 'vitest'
import type { DigestCandidate } from '@/lib/agent-events/digest'
import {
  DREAMER_HOURS,
  DREAMER_JITTER_MAX_MS,
  DREAMER_REQUESTED_EVENT,
  dreamerJitterMs,
  dreamerLogLine,
  dreamerRequestFor,
  dreamerRequestsFor,
  dreamerScanLogLine,
  parseDreamerRequest,
  runDreamerFor,
  type DreamerRequestData,
  type DreamerRunDeps,
} from '../run'
import { DREAMER_PART_SEPARATOR, DREAMER_ROLE } from '../prompt'

const USER = '1a1a1a1a-0000-4000-8000-000000000001'
const WS = '1a1a1a1a-0000-4000-8000-000000000002'
const HOME = '1a1a1a1a-0000-4000-8000-000000000003'

/** The hour the scan ran in, and a scan 5 minutes into it. */
const HOUR = Date.parse('2026-11-24T13:00:00.000Z')
const SCAN = HOUR + 5 * 60_000

const candidate = (hour: number, source: DigestCandidate['timeZoneSource'] = 'member'): DigestCandidate => ({
  memberId: 'm1',
  userId: USER,
  workspaceId: WS,
  timeZone: source === 'utc' ? 'UTC' : 'America/Chicago',
  timeZoneSource: source,
  date: '2026-11-24',
  hour,
})

describe('the schedule', () => {
  it('heartbeats at 07, 11, 15 and 19 local, the reflection at 03', () => {
    expect([...DREAMER_HOURS].sort((a, b) => a - b)).toEqual([3, 7, 11, 15, 19])
    for (const hour of [0, 8, 10, 12, 23]) expect(dreamerRequestFor(candidate(hour), SCAN)).toBeNull()
  })

  it('one request per person and slot, keyed on the person, workspace, local date and hour, delivered at the hour plus its jitter', () => {
    const r = dreamerRequestFor(candidate(7), SCAN)
    expect(r).toEqual({
      ok: true,
      request: {
        id: `dreamer:${USER}:${WS}:2026-11-24:7`,
        name: DREAMER_REQUESTED_EVENT,
        ts: HOUR + dreamerJitterMs(USER, WS),
        data: { userId: USER, workspaceId: WS, timeZone: 'America/Chicago', localDate: '2026-11-24', hour: 7 },
      },
    })
    // A scan later in the same hour (a replay) sends the same request.
    expect(dreamerRequestFor(candidate(7), SCAN + 40 * 60_000)).toEqual(r)
  })

  it('the jitter is the same for the same person every time, within the first 30 minutes, and spreads people out', () => {
    expect(dreamerJitterMs(USER, WS)).toBe(dreamerJitterMs(USER, WS))
    const spread = new Set<number>()
    for (let i = 0; i < 500; i++) {
      const j = dreamerJitterMs(`1a1a1a1a-0000-4000-8000-${String(i).padStart(12, '0')}`, WS)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(DREAMER_JITTER_MAX_MS)
      expect(j % 1000).toBe(0)
      spread.add(Math.floor(j / 60_000))
    }
    expect(DREAMER_JITTER_MAX_MS).toBe(30 * 60_000)
    // Most of the half hour's minutes are used.
    expect(spread.size).toBeGreaterThan(25)
  })

  it("skips the reflection when the person's zone is only the UTC fallback; heartbeats still run there", () => {
    expect(dreamerRequestFor(candidate(3, 'utc'), SCAN)).toEqual({ ok: false, reason: 'no_zone' })
    expect(dreamerRequestFor({ ...candidate(3), timeZoneSource: undefined }, SCAN)).toEqual({ ok: false, reason: 'no_zone' })
    expect(dreamerRequestFor(candidate(3, 'profile'), SCAN)?.ok).toBe(true)
    expect(dreamerRequestFor(candidate(7, 'utc'), SCAN)?.ok).toBe(true)
    const out = dreamerRequestsFor([candidate(3, 'utc'), candidate(7), candidate(8), candidate(19, 'other_workspace')], SCAN)
    expect(out.requests.map((r) => r.data.hour)).toEqual([7, 19])
    expect(out.skips).toEqual({ no_zone: 1 })
    expect(dreamerScanLogLine({ candidates: 4, sent: 2, skips: out.skips })).toBe('[dreamer] scan candidates=4 sent=2 no_zone=1')
  })

  it('parses only a well-formed event', () => {
    const data = { userId: USER, workspaceId: WS, timeZone: 'America/Chicago', localDate: '2026-11-24', hour: 15 }
    expect(parseDreamerRequest(data)).toEqual(data)
    expect(parseDreamerRequest({ ...data, hour: 9 })).toBeNull()
    expect(parseDreamerRequest({ ...data, userId: 'nope' })).toBeNull()
    expect(parseDreamerRequest({ ...data, localDate: '24/11/2026' })).toBeNull()
    expect(parseDreamerRequest(null)).toBeNull()
  })
})

/** A client whose home-thread read answers `home` (a conversation id, null for none, or an error). */
function client(home: string | null | 'error') {
  const result = home === 'error' ? { data: null, error: { message: 'down' } } : { data: home ? [{ id: home }] : [], error: null }
  const chain: Record<string, unknown> = {}
  for (const k of ['select', 'eq']) chain[k] = () => chain
  chain.limit = async () => result
  return { from: vi.fn(() => chain) } as never
}

function deps(over: Partial<DreamerRunDeps> = {}): DreamerRunDeps & { startHelper: ReturnType<typeof vi.fn> } {
  return {
    pausedState: vi.fn(async () => 'active' as const),
    isDormant: vi.fn(async () => false),
    checkUsage: vi.fn(async () => ({ allowed: true })),
    startHelper: vi.fn(async () => ({ status: 'started', run_id: 'run-1', reused: false })),
    ...over,
  } as DreamerRunDeps & { startHelper: ReturnType<typeof vi.fn> }
}

const DATA: DreamerRequestData = { userId: USER, workspaceId: WS, timeZone: 'America/Chicago', localDate: '2026-11-24', hour: 7 }

describe('the run', () => {
  it('starts the helper: kind dreamer, quiet, keyed on the slot, its task the role and the instructions', async () => {
    const d = deps()
    expect(await runDreamerFor(client(HOME), DATA, d)).toEqual({ status: 'started', runId: 'run-1' })
    const [, start, input] = d.startHelper.mock.calls[0]
    expect(start).toMatchObject({ kind: 'dreamer', quiet: true, workspaceId: WS, userId: USER, conversationId: HOME, scope: 'dreamer', subject: '2026-11-24T07', callId: 'heartbeat' })
    expect(start.taskPrompt.startsWith(`${DREAMER_ROLE}${DREAMER_PART_SEPARATOR}# This run`)).toBe(true)
    // The slot's own instant, whatever the jitter delays the start by.
    expect(start.taskPrompt).toContain('- Started: 2026-11-24T13:00:00.000Z (UTC)')
    expect(start.taskPrompt).toContain('- Their local time: 2026-11-24 07:00 (America/Chicago)')
    expect(start.taskPrompt).toContain('- Kind: a regular run')
    expect(input).toMatchObject({ expects: [] })
    // The same slot gives the same task (the admission fingerprints it: a retry is the same run).
    await runDreamerFor(client(HOME), DATA, d)
    expect(d.startHelper.mock.calls[1][1].taskPrompt).toBe(start.taskPrompt)
  })

  it('names the reflection run by its call part', async () => {
    const d = deps()
    await runDreamerFor(client(HOME), { ...DATA, hour: 3 }, d)
    expect(d.startHelper.mock.calls[0][1]).toMatchObject({ subject: '2026-11-24T03', callId: 'reflection' })
  })

  it('skips at each gate, in order, before any start', async () => {
    const cases: Array<[string, Parameters<typeof runDreamerFor>[0], Partial<DreamerRunDeps>]> = [
      ['no_home_thread', client(null), {}],
      ['lookup_failed', client('error'), {}],
      ['paused', client(HOME), { pausedState: vi.fn(async () => 'paused' as const) }],
      // Fails closed: a switch that can't be read is off.
      ['paused', client(HOME), { pausedState: vi.fn(async () => 'unknown' as const) }],
      ['paused', client(HOME), { pausedState: vi.fn(async () => { throw new Error('down') }) }],
      ['dormant', client(HOME), { isDormant: vi.fn(async () => true) }],
      // Fails closed too: a dormancy that can't be read starts nothing.
      ['lookup_failed', client(HOME), { isDormant: vi.fn(async () => { throw new Error('captures read failed') }) }],
      ['usage_limited', client(HOME), { checkUsage: vi.fn(async () => { throw new Response('limit', { status: 429 }) }) }],
      ['usage_check_failed', client(HOME), { checkUsage: vi.fn(async () => { throw new Error('billing down') }) }],
    ]
    for (const [reason, c, over] of cases) {
      const d = deps(over)
      expect(await runDreamerFor(c, DATA, d), reason).toEqual({ status: 'skipped', reason })
      expect(d.startHelper, reason).not.toHaveBeenCalled()
    }
  })

  it("the admission's caps: a refusal is a skip with its code; a replay is the same run", async () => {
    const refused = deps({ startHelper: vi.fn(async () => ({ status: 'refused', code: 'SERVER_LIVE' })) })
    const out = await runDreamerFor(client(HOME), DATA, refused)
    expect(out).toEqual({ status: 'skipped', reason: 'refused', code: 'SERVER_LIVE' })
    expect(dreamerLogLine(DATA, out)).toBe(`[dreamer] user=${USER} workspace=${WS} slot=2026-11-24T07 skip_refused_SERVER_LIVE`)
    const replay = deps({ startHelper: vi.fn(async () => ({ status: 'completed', run_id: 'run-1', reused: true })) })
    expect(await runDreamerFor(client(HOME), DATA, replay)).toEqual({ status: 'reused', runId: 'run-1' })
    const day = deps({ startHelper: vi.fn(async () => ({ status: 'refused', code: 'SERVER_DAY_BUDGET' })) })
    expect(await runDreamerFor(client(HOME), DATA, day)).toEqual({ status: 'skipped', reason: 'refused', code: 'SERVER_DAY_BUDGET' })
  })
})
