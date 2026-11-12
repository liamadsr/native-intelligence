/**
 * The tracker core's rules: keyword normalising, the schedule's first due
 * time, the caps (held in the core, whatever calls it), the duplicate
 * tracker, the access check and the person's yes for anything that turns on
 * or raises what a tracker spends on its own (held here, so the routes and
 * the tools share it), pausing stopping a scheduled check, a time change
 * that never adds a check, and the free maths. Supabase is a per-table stub
 * that records what was asked (and, for the update rules, one that answers
 * by the query chain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_KEYWORDS_PER_TRACKER, MAX_TRACKERS_PER_WORKSPACE } from '../limits'
import {
  addRankKeywords,
  createRankTracker,
  estimateDraft,
  normalizeKeywords,
  previewTrackerChange,
  resolveNextCheckAt,
  updateRankTracker,
} from '../trackers'

const WS = '00000000-0000-4000-8000-000000000001'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const TRACKER = '00000000-0000-4000-8000-000000000002'

type Result = { data?: unknown; error?: null; count?: number }

/** A Supabase stand-in: each table (and each rpc) answers with its own result, and every call is recorded. */
function stubSupabase(
  results: Record<
    string,
    Result | ((calls: Array<[string, unknown[]]>) => Result)
  >,
) {
  const calls: Array<[string, unknown[]]> = []
  const answer = (key: string) => {
    const r = results[key]
    const value = typeof r === 'function' ? r(calls) : r
    return { data: null, error: null, ...(value ?? {}) }
  }
  const builder = (key: string): Record<string, unknown> =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then')
            return (resolve: (v: unknown) => void) => resolve(answer(key))
          return (...args: unknown[]) => {
            calls.push([`${key}.${prop}`, args])
            return builder(key)
          }
        },
      },
    )
  const client = {
    from: (table: string) => (calls.push(['from', [table]]), builder(table)),
    rpc: (name: string, args: unknown) => (
      calls.push(['rpc', [name, args]]),
      builder(`rpc:${name}`)
    ),
  }
  return { client: client as never, calls }
}

const trackerRow = {
  id: TRACKER,
  workspace_id: WS,
  created_by: PERSON,
  domain: 'example.com',
  location_code: 2840,
  language_code: 'en',
  location_name: null,
  devices: 'mobile',
  serp_depth: 20,
  schedule_interval: 'weekly',
  schedule_weekday: null,
  schedule_hour: null,
  schedule_minute: null,
  schedule_time_zone: null,
  next_check_at: '2026-11-15T05:00:00.000Z',
  last_checked_at: null,
  last_skip_reason: null,
  paused: false,
  created_at: '2026-11-01T00:00:00.000Z',
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-11-12T10:00:00.000Z'))
})
afterEach(() => vi.useRealTimers())

describe('normalizeKeywords', () => {
  it('trims, collapses spaces, lowercases in the tracker’s language and drops repeats', () => {
    expect(
      normalizeKeywords(
        [
          '  Plumber   Austin ',
          'plumber austin',
          'Drain Repair',
          '',
          42,
          'x'.repeat(201),
        ],
        'en',
      ),
    ).toEqual({
      keywords: ['plumber austin', 'drain repair'],
      rejected: 3,
    })
  })

  it('lowercases Turkish the Turkish way', () => {
    expect(normalizeKeywords(['İSTANBUL'], 'tr').keywords).toEqual(['istanbul'])
  })
})

describe('resolveNextCheckAt', () => {
  it('a schedule that is off has no due time; a time needs a schedule', () => {
    expect(resolveNextCheckAt('manual', undefined)).toEqual({
      ok: true,
      next: null,
    })
    expect(resolveNextCheckAt('manual', { hour: 9, minute: 0 })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    })
  })

  it('a weekly time needs its weekday', () => {
    expect(resolveNextCheckAt('weekly', { hour: 9, minute: 0 })).toMatchObject({
      ok: false,
    })
    // Monday 9:00 in New York (EST, UTC-5) is Monday 14:00 UTC: the 16th.
    expect(
      resolveNextCheckAt('weekly', {
        weekday: 1,
        hour: 9,
        minute: 0,
        timeZone: 'America/New_York',
      }),
    ).toEqual({
      ok: true,
      next: '2026-11-16T14:00:00.000Z',
    })
  })

  it('a daily time later today runs today', () => {
    expect(resolveNextCheckAt('daily', { hour: 18, minute: 30 })).toEqual({
      ok: true,
      next: '2026-11-12T18:30:00.000Z',
    })
  })
})

describe('createRankTracker', () => {
  const who = { workspaceId: WS, userId: PERSON }
  const access = vi.fn(async () => ({ ok: true as const }))

  it('refuses past the per-workspace cap, in the core', async () => {
    const { client } = stubSupabase({
      seo_rank_tracker: { count: MAX_TRACKERS_PER_WORKSPACE, data: [] },
    })
    const out = await createRankTracker(
      client,
      who,
      { domain: 'example.com' },
      { access },
    )
    expect(out).toMatchObject({ ok: false, code: 'TOO_MANY_TRACKERS' })
  })

  it('refuses a second tracker for the same site and market, naming the first', async () => {
    const { client } = stubSupabase({
      seo_rank_tracker: { count: 1, data: [{ id: TRACKER }] },
    })
    const out = await createRankTracker(
      client,
      who,
      { domain: 'https://www.Example.com/pricing' },
      { access },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'DUPLICATE_TRACKER',
      tracker_id: TRACKER,
    })
  })

  it('checks its input before touching the database', async () => {
    const { client, calls } = stubSupabase({})
    expect(
      await createRankTracker(client, who, { domain: 'not a domain' }),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      await createRankTracker(client, who, {
        domain: 'example.com',
        serp_depth: 25,
      }),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      await createRankTracker(client, who, {
        domain: 'example.com',
        devices: 'tablet',
      }),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      await createRankTracker(client, who, {
        domain: 'example.com',
        location_code: 1,
      }),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(
      await createRankTracker(client, who, {
        domain: 'example.com',
        schedule_interval: 'hourly',
      }),
    ).toMatchObject({ code: 'INVALID_INPUT' })
    expect(calls).toEqual([])
  })

  it('turning a schedule on asks the access check; its refusal is returned as one', async () => {
    const { client, calls } = stubSupabase({})
    const refuse = vi.fn(async () => ({
      ok: false as const,
      code: 'FREE_PLAN' as const,
      message: 'Paid plan only.',
    }))
    const out = await createRankTracker(
      client,
      { ...who, unattended: false },
      { domain: 'example.com', schedule_interval: 'daily' },
      { access: refuse },
    )
    expect(out).toEqual({
      ok: false,
      code: 'FREE_PLAN',
      message: 'Paid plan only.',
      refusal: true,
    })
    expect(refuse).toHaveBeenCalledWith({
      userId: PERSON,
      workspaceId: WS,
      unattended: false,
    })
    expect(calls).toEqual([])
  })

  it('a schedule with keywords needs the yes: refused with its monthly estimate, nothing saved', async () => {
    const { client, calls } = stubSupabase({
      seo_rank_tracker: { count: 1, data: [] },
    })
    const out = await createRankTracker(
      client,
      who,
      {
        domain: 'example.com',
        schedule_interval: 'daily',
        keywords: ['Plumber Austin', 'drain repair'],
      },
      { access },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'NEEDS_GO_AHEAD',
      estimate: { keyword_count: 2, schedule: 'daily', checks_per_month: 30 },
    })
    expect(out.ok === false && out.message).toMatch(/a month/)
    expect(calls.some(([m]) => m === 'seo_rank_tracker.insert')).toBe(false)
  })

  it('with the yes, the scheduled tracker is saved', async () => {
    const { client, calls } = stubSupabase({
      seo_rank_tracker: { count: 1, data: [] },
    })
    await createRankTracker(
      client,
      who,
      {
        domain: 'example.com',
        schedule_interval: 'daily',
        keywords: ['plumber austin'],
        confirmed: true,
      },
      { access },
    ).catch(() => null)
    expect(calls.some(([m]) => m === 'seo_rank_tracker.insert')).toBe(true)
  })

  it('only `true` counts as the yes', async () => {
    const { client, calls } = stubSupabase({
      seo_rank_tracker: { count: 1, data: [] },
    })
    const out = await createRankTracker(
      client,
      who,
      {
        domain: 'example.com',
        schedule_interval: 'weekly',
        keywords: ['plumber austin'],
        confirmed: 'yes',
      },
      { access },
    )
    expect(out).toMatchObject({ ok: false, code: 'NEEDS_GO_AHEAD' })
    expect(calls.some(([m]) => m === 'seo_rank_tracker.insert')).toBe(false)
  })

  it('a manual tracker doesn’t ask the access check', async () => {
    const refuse = vi.fn(async () => ({
      ok: false as const,
      code: 'FREE_PLAN' as const,
      message: 'no',
    }))
    const { client } = stubSupabase({
      seo_rank_tracker: { count: MAX_TRACKERS_PER_WORKSPACE, data: [] },
    })
    await createRankTracker(
      client,
      who,
      { domain: 'example.com' },
      { access: refuse },
    )
    expect(refuse).not.toHaveBeenCalled()
  })
})

describe('addRankKeywords', () => {
  const who = { workspaceId: WS, userId: PERSON }
  const access = vi.fn(async () => ({ ok: true as const }))

  it('sends only the new keywords, with the per-tracker cap, and counts what was left out and why', async () => {
    const { client, calls } = stubSupabase({
      seo_rank_tracker: { data: trackerRow },
      seo_rank_keyword: { data: [{ id: 'k0', keyword: 'plumber austin' }] },
      'rpc:seo_rank_add_keywords': {
        data: [{ id: 'k1', keyword: 'drain repair' }],
      },
    })
    const out = await addRankKeywords(
      client,
      who,
      TRACKER,
      ['Plumber Austin', 'drain repair', 'water heater', ''],
      { confirmed: true },
      { access },
    )
    expect(out).toEqual({
      ok: true,
      tracker_id: TRACKER,
      added: [{ id: 'k1', keyword: 'drain repair' }],
      already_tracked: 1,
      over_cap: 1,
      rejected: 1,
    })
    const rpc = calls.find(([m]) => m === 'rpc')!
    expect(rpc[1]).toEqual([
      'seo_rank_add_keywords',
      {
        p_tracker: TRACKER,
        p_keywords: ['drain repair', 'water heater'],
        p_cap: MAX_KEYWORDS_PER_TRACKER,
      },
    ])
  })

  it('on a scheduled tracker the add raises its cost: the access check, then the yes', async () => {
    const results = {
      seo_rank_tracker: { data: trackerRow },
      seo_rank_keyword: { data: [{ id: 'k0', keyword: 'plumber austin' }] },
      'rpc:seo_rank_add_keywords': { data: [] },
    }
    const asked = vi.fn(async () => ({ ok: true as const }))
    const first = stubSupabase(results)
    const out = await addRankKeywords(
      first.client,
      who,
      TRACKER,
      ['drain repair'],
      {},
      { access: asked },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'NEEDS_GO_AHEAD',
      estimate: { keyword_count: 2, schedule: 'weekly' },
      previous_estimate: { keyword_count: 1 },
    })
    expect(asked).toHaveBeenCalledWith({
      userId: PERSON,
      workspaceId: WS,
      unattended: undefined,
    })
    expect(first.calls.some(([m]) => m === 'rpc')).toBe(false)

    // A guest can't raise a schedule that spends on the creator's standing.
    const guest = stubSupabase(results)
    const refused = await addRankKeywords(
      guest.client,
      who,
      TRACKER,
      ['drain repair'],
      { confirmed: true },
      {
        access: async () => ({
          ok: false as const,
          code: 'NOT_A_MEMBER' as const,
          message: 'Members only.',
        }),
      },
    )
    expect(refused).toEqual({
      ok: false,
      code: 'NOT_A_MEMBER',
      message: 'Members only.',
      refusal: true,
    })
    expect(guest.calls.some(([m]) => m === 'rpc')).toBe(false)
  })

  it('on a tracker checked by hand the add needs neither', async () => {
    const asked = vi.fn(async () => ({ ok: true as const }))
    const { client, calls } = stubSupabase({
      seo_rank_tracker: {
        data: { ...trackerRow, schedule_interval: 'manual' },
      },
      seo_rank_keyword: { data: [] },
      'rpc:seo_rank_add_keywords': { data: [{ id: 'k1', keyword: 'a' }] },
    })
    const out = await addRankKeywords(
      client,
      who,
      TRACKER,
      ['a'],
      {},
      { access: asked },
    )
    expect(out).toMatchObject({ ok: true })
    expect(asked).not.toHaveBeenCalled()
    expect(calls.some(([m]) => m === 'rpc')).toBe(true)
  })

  it('an unknown tracker is not found', async () => {
    const { client } = stubSupabase({ seo_rank_tracker: { data: null } })
    expect(
      await addRankKeywords(client, who, TRACKER, ['a']),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' })
  })

  it('refuses more than one add’s worth of keywords', async () => {
    const { client } = stubSupabase({})
    const out = await addRankKeywords(
      client,
      who,
      TRACKER,
      Array.from({ length: 201 }, (_, i) => `k${i}`),
    )
    expect(out).toMatchObject({ ok: false, code: 'INVALID_INPUT' })
  })
})

type Chain = Array<[string, unknown[]]>

/** A stand-in that answers by table and query chain (an update, a live-run read), recording each query. */
function chainStub(
  answer: (table: string, chain: Chain) => Result,
): { client: never; log: Array<{ table: string; chain: Chain }> } {
  const log: Array<{ table: string; chain: Chain }> = []
  const builder = (table: string, chain: Chain): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            log.push({ table, chain })
            return (resolve: (v: unknown) => void) =>
              resolve({ data: null, error: null, ...answer(table, chain) })
          }
          return (...args: unknown[]) =>
            builder(table, [...chain, [prop, args]])
        },
      },
    )
  return { client: { from: (t: string) => builder(t, []) } as never, log }
}

const has = (chain: Chain, method: string) => chain.some(([m]) => m === method)

const liveRun = (trigger: 'manual' | 'scheduled') => ({
  id: '00000000-0000-4000-8000-000000000003',
  tracker_id: TRACKER,
  workspace_id: WS,
  trigger,
  status: 'running',
  scheduled_for: trigger === 'scheduled' ? '2026-11-12T09:00:00.000Z' : null,
  keywords_total: 1,
  keywords_checked: 0,
  checks_total: 1,
  checks_collected: 0,
  estimate_usd: '0.0063',
  cost_usd: '0',
  error_code: null,
  error_detail: null,
  started_by: trigger === 'manual' ? PERSON : null,
  created_at: '2026-11-12T09:55:00.000Z',
  started_at: '2026-11-12T09:55:00.000Z',
  completed_at: null,
})

function trackerDb(
  row: Record<string, unknown>,
  opts: { live?: ReturnType<typeof liveRun> | null } = {},
) {
  return chainStub((table, chain) => {
    if (table === 'seo_rank_tracker') return { data: row }
    if (table === 'seo_rank_keyword')
      return { data: [{ id: 'k0', keyword: 'plumber austin' }] }
    if (table === 'seo_rank_run') {
      if (has(chain, 'update')) return { data: [{ id: opts.live?.id }] }
      if (has(chain, 'maybeSingle')) return { data: opts.live ?? null }
      return { data: opts.live ? [opts.live] : [] }
    }
    return {}
  })
}

const trackerUpdate = (log: Array<{ table: string; chain: Chain }>) =>
  log.find((q) => q.table === 'seo_rank_tracker' && has(q.chain, 'update'))
    ?.chain[0][1][0] as Record<string, unknown> | undefined

describe('updateRankTracker', () => {
  const who = { workspaceId: WS, userId: PERSON }
  const access = vi.fn(async () => ({ ok: true as const }))

  it('more devices on a scheduled tracker needs the yes, with both estimates; nothing is written', async () => {
    const { client, log } = trackerDb(trackerRow)
    const out = await updateRankTracker(
      client,
      who,
      TRACKER,
      { devices: 'both' },
      { access },
    )
    expect(out).toMatchObject({
      ok: false,
      code: 'NEEDS_GO_AHEAD',
      estimate: { devices: 'both', schedule: 'weekly' },
      previous_estimate: { devices: 'mobile' },
    })
    expect(trackerUpdate(log)).toBeUndefined()
  })

  it('a rise on a schedule already on asks the access check too (a free-plan member, a guest)', async () => {
    const { client, log } = trackerDb(trackerRow)
    const out = await updateRankTracker(
      client,
      who,
      TRACKER,
      { serp_depth: 100, confirmed: true },
      {
        access: async () => ({
          ok: false as const,
          code: 'FREE_PLAN' as const,
          message: 'Paid plan only.',
        }),
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'FREE_PLAN', refusal: true })
    expect(trackerUpdate(log)).toBeUndefined()
  })

  it('resuming a paused schedule is a rise: refused without the yes, written with it', async () => {
    const paused = { ...trackerRow, paused: true }
    const first = trackerDb(paused)
    expect(
      await updateRankTracker(
        first.client,
        who,
        TRACKER,
        { paused: false },
        { access },
      ),
    ).toMatchObject({ ok: false, code: 'NEEDS_GO_AHEAD' })
    expect(trackerUpdate(first.log)).toBeUndefined()

    const second = trackerDb(paused)
    expect(
      await updateRankTracker(
        second.client,
        who,
        TRACKER,
        { paused: false, confirmed: true },
        { access },
      ),
    ).toMatchObject({ ok: true })
    expect(trackerUpdate(second.log)).toMatchObject({ paused: false })
  })

  it('lowering the cost or pausing needs neither the yes nor the access check', async () => {
    const refuse = vi.fn(async () => ({
      ok: false as const,
      code: 'UNATTENDED' as const,
      message: 'no',
    }))
    const { client, log } = trackerDb({ ...trackerRow, devices: 'both' })
    expect(
      await updateRankTracker(
        client,
        { ...who, unattended: true },
        TRACKER,
        { devices: 'mobile' },
        { access: refuse },
      ),
    ).toMatchObject({ ok: true })
    expect(refuse).not.toHaveBeenCalled()
    expect(trackerUpdate(log)).toMatchObject({ devices: 'mobile' })
  })

  it('pausing stops the scheduled check that is running', async () => {
    const live = liveRun('scheduled')
    const { client, log } = trackerDb(trackerRow, { live })
    const send = vi.fn(async () => undefined)
    expect(
      await updateRankTracker(
        client,
        who,
        TRACKER,
        { paused: true },
        { access, send },
      ),
    ).toMatchObject({ ok: true })
    const canceled = log.find(
      (q) => q.table === 'seo_rank_run' && has(q.chain, 'update'),
    )
    expect(canceled?.chain[0][1][0]).toMatchObject({ status: 'canceled' })
    expect(send).toHaveBeenCalledWith({
      name: 'seo/rank-check.cancel',
      data: { runId: live.id },
    })
  })

  it('turning the schedule off stops it too; a check a person started is left alone', async () => {
    const scheduled = trackerDb(trackerRow, { live: liveRun('scheduled') })
    const send = vi.fn(async () => undefined)
    await updateRankTracker(
      scheduled.client,
      who,
      TRACKER,
      { schedule_interval: 'manual' },
      { access, send },
    )
    expect(send).toHaveBeenCalledTimes(1)

    const manual = trackerDb(trackerRow, { live: liveRun('manual') })
    const untouched = vi.fn(async () => undefined)
    await updateRankTracker(
      manual.client,
      who,
      TRACKER,
      { paused: true },
      { access, send: untouched },
    )
    expect(untouched).not.toHaveBeenCalled()
    expect(
      manual.log.some(
        (q) => q.table === 'seo_rank_run' && has(q.chain, 'update'),
      ),
    ).toBe(false)
  })

  it('moving only the time never adds a check: a daily check done at 9:00 moved to 17:00 runs tomorrow', async () => {
    // Now is 10:00 UTC on the 12th; today's 9:00 check ran, the next is due tomorrow 9:00.
    const daily = {
      ...trackerRow,
      schedule_interval: 'daily',
      schedule_hour: 9,
      schedule_minute: 0,
      next_check_at: '2026-11-13T09:00:00.000Z',
    }
    const later = trackerDb(daily)
    expect(
      await updateRankTracker(
        later.client,
        who,
        TRACKER,
        { schedule_time: { hour: 17, minute: 0 } },
        { access },
      ),
    ).toMatchObject({ ok: true })
    expect(trackerUpdate(later.log)).toMatchObject({
      next_check_at: '2026-11-13T17:00:00.000Z',
      schedule_hour: 17,
    })

    // Earlier in the day: the next one is still after tomorrow's 9:00.
    const earlier = trackerDb(daily)
    await updateRankTracker(
      earlier.client,
      who,
      TRACKER,
      { schedule_time: { hour: 8, minute: 0 } },
      { access },
    )
    expect(trackerUpdate(earlier.log)).toMatchObject({
      next_check_at: '2026-11-14T08:00:00.000Z',
    })
  })

  it('whoever turns the schedule on (a resume too) or sets its interval owns it, after passing the access check', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000bb'
    const b = { workspaceId: WS, userId: OTHER }
    // A manual tracker set up by PERSON; OTHER turns its schedule on.
    const manual = trackerDb({
      ...trackerRow,
      schedule_interval: 'manual',
      next_check_at: null,
      last_skip_reason: 'free_plan',
    })
    const asked = vi.fn(async () => ({ ok: true as const }))
    await updateRankTracker(
      manual.client,
      b,
      TRACKER,
      { schedule_interval: 'daily', confirmed: true },
      { access: asked },
    )
    expect(asked).toHaveBeenCalledWith({
      userId: OTHER,
      workspaceId: WS,
      unattended: undefined,
    })
    expect(trackerUpdate(manual.log)).toMatchObject({
      schedule_interval: 'daily',
      created_by: OTHER,
      last_skip_reason: null,
    })

    // A resume from paused.
    const paused = trackerDb({ ...trackerRow, paused: true })
    await updateRankTracker(
      paused.client,
      b,
      TRACKER,
      { paused: false, confirmed: true },
      { access },
    )
    expect(trackerUpdate(paused.log)).toMatchObject({
      paused: false,
      created_by: OTHER,
    })

    // A slower interval costs less, needs no yes, but still asks the access check and takes ownership.
    const slower = trackerDb(trackerRow)
    const slowerAsked = vi.fn(async () => ({ ok: true as const }))
    await updateRankTracker(
      slower.client,
      b,
      TRACKER,
      { schedule_interval: 'monthly' },
      { access: slowerAsked },
    )
    expect(slowerAsked).toHaveBeenCalled()
    expect(trackerUpdate(slower.log)).toMatchObject({
      schedule_interval: 'monthly',
      created_by: OTHER,
      last_skip_reason: null,
    })
  })

  it('a person refused by the access check never takes a schedule over', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000bb'
    const { client, log } = trackerDb(trackerRow)
    const out = await updateRankTracker(
      client,
      { workspaceId: WS, userId: OTHER },
      TRACKER,
      { schedule_interval: 'monthly' },
      {
        access: async () => ({
          ok: false as const,
          code: 'NOT_A_MEMBER' as const,
          message: 'Members only.',
        }),
      },
    )
    expect(out).toMatchObject({ ok: false, code: 'NOT_A_MEMBER' })
    expect(trackerUpdate(log)).toBeUndefined()
  })

  it('changes that don’t turn the schedule on or set its interval leave its owner alone', async () => {
    const OTHER = '00000000-0000-4000-8000-0000000000bb'
    const b = { workspaceId: WS, userId: OTHER }
    const fewer = trackerDb({ ...trackerRow, devices: 'both' })
    await updateRankTracker(
      fewer.client,
      b,
      TRACKER,
      { devices: 'mobile' },
      { access },
    )
    expect(trackerUpdate(fewer.log)).not.toHaveProperty('created_by')
    // More depth on a running schedule is a confirmed rise, not a new owner.
    const deeper = trackerDb(trackerRow)
    await updateRankTracker(
      deeper.client,
      b,
      TRACKER,
      { serp_depth: 100, confirmed: true },
      { access },
    )
    expect(trackerUpdate(deeper.log)).toMatchObject({ serp_depth: 100 })
    expect(trackerUpdate(deeper.log)).not.toHaveProperty('created_by')
    // Pausing.
    const pause = trackerDb(trackerRow)
    await updateRankTracker(
      pause.client,
      b,
      TRACKER,
      { paused: true },
      { access },
    )
    expect(trackerUpdate(pause.log)).not.toHaveProperty('created_by')
  })

  it('a new schedule still starts at its chosen time', async () => {
    const { client, log } = trackerDb({
      ...trackerRow,
      schedule_interval: 'manual',
      next_check_at: null,
    })
    await updateRankTracker(
      client,
      who,
      TRACKER,
      {
        schedule_interval: 'daily',
        schedule_time: { hour: 17, minute: 0 },
        confirmed: true,
      },
      { access },
    )
    expect(trackerUpdate(log)).toMatchObject({
      next_check_at: '2026-11-12T17:00:00.000Z',
    })
  })
})

describe('previewTrackerChange', () => {
  it('adding keywords to a weekly tracker raises its monthly cost; pausing it doesn’t', async () => {
    const { client } = stubSupabase({
      seo_rank_tracker: { data: trackerRow },
      seo_rank_keyword: { data: [{ id: 'k0', keyword: 'plumber austin' }] },
    })
    const more = await previewTrackerChange(
      client,
      { workspaceId: WS },
      TRACKER,
      { addKeywords: ['drain repair'] },
    )
    expect(more).toMatchObject({ ok: true, raises_cost: true })
    if (more.ok) {
      expect(more.before.keyword_count).toBe(1)
      expect(more.after.keyword_count).toBe(2)
      expect(more.after.checks_per_month).toBe(4)
    }
    const paused = await previewTrackerChange(
      client,
      { workspaceId: WS },
      TRACKER,
      { input: { paused: true } },
    )
    expect(paused).toMatchObject({ ok: true, raises_cost: false })
    if (paused.ok) expect(paused.after.monthly_usd).toBe(0)
    const faster = await previewTrackerChange(
      client,
      { workspaceId: WS },
      TRACKER,
      { input: { schedule_interval: 'daily' } },
    )
    expect(faster).toMatchObject({ ok: true, raises_cost: true })
  })
})

describe('estimateDraft', () => {
  it('prices a tracker not yet saved, with the defaults filled in', () => {
    const out = estimateDraft({
      keywords: ['Plumber Austin', 'plumber austin', 'drain repair'],
      schedule_interval: 'daily',
    })
    expect(out).toMatchObject({
      ok: true,
      estimate: {
        keyword_count: 2,
        devices: 'mobile',
        serp_depth: 20,
        checks_per_month: 30,
      },
    })
  })

  it('refuses settings it can’t price', () => {
    expect(estimateDraft({ serp_depth: 15 })).toMatchObject({
      ok: false,
      code: 'INVALID_INPUT',
    })
  })
})
