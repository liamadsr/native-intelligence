/**
 * createSeoRankTools: the rank tracking tools.
 *
 *   1. Refusals. Turning on or raising a schedule, and a paid check above the
 *      confirmation line, are refused by the cores without `confirmed`
 *      (src/lib/seo/rank/__tests__ holds that nothing is written); here, the
 *      tool passes `confirmed_with_user` on as that flag and turns the
 *      core's NEEDS_GO_AHEAD into the cost in words. A turn nobody is in
 *      never sets up spending, starts a check or moves a schedule's time:
 *      where the tool refuses on its own, the core is never called.
 *   2. One happy path per tool: the right core call with the constructor's
 *      workspace and person, and a result the model can read.
 *   3. A tool never throws.
 */
import type { RankRunView, RankTrackerView } from '@/lib/seo/rank/view'
import type { SupabaseClient } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  listRankTrackers: vi.fn(),
  getRankTracker: vi.fn(),
  getRankTrackerDetail: vi.fn(),
  listRankKeywordRows: vi.fn(),
  getRankKeywordHistory: vi.fn(),
  getRankTrackerTrend: vi.fn(),
  getLiveRankRun: vi.fn(),
  readTrackerKeywords: vi.fn(),
  startRankCheck: vi.fn(),
  cancelRankCheck: vi.fn(),
  createRankTracker: vi.fn(),
  updateRankTracker: vi.fn(),
  deleteRankTracker: vi.fn(),
  addRankKeywords: vi.fn(),
  removeRankKeywords: vi.fn(),
  previewTrackerChange: vi.fn(),
}))

vi.mock('@/lib/seo/rank/queries', () => ({
  listRankTrackers: h.listRankTrackers,
  getRankTracker: h.getRankTracker,
  getRankTrackerDetail: h.getRankTrackerDetail,
  listRankKeywordRows: h.listRankKeywordRows,
  getRankKeywordHistory: h.getRankKeywordHistory,
  getRankTrackerTrend: h.getRankTrackerTrend,
  getLiveRankRun: h.getLiveRankRun,
  readTrackerKeywords: h.readTrackerKeywords,
}))
vi.mock('@/lib/seo/rank/runs', () => ({
  startRankCheck: h.startRankCheck,
  cancelRankCheck: h.cancelRankCheck,
}))
vi.mock('@/lib/seo/rank/trackers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/seo/rank/trackers')>()),
  createRankTracker: h.createRankTracker,
  updateRankTracker: h.updateRankTracker,
  deleteRankTracker: h.deleteRankTracker,
  addRankKeywords: h.addRankKeywords,
  removeRankKeywords: h.removeRankKeywords,
  previewTrackerChange: h.previewTrackerChange,
}))

import { estimateView, goAheadRefusal } from '@/lib/seo/rank/view'
import { createSeoRankTools } from '../seo-rank'

const WS = '00000000-0000-4000-8000-000000000001'
const PERSON = '00000000-0000-4000-8000-0000000000aa'
const TRACKER = '00000000-0000-4000-8000-000000000002'
const RUN = '00000000-0000-4000-8000-000000000003'
const K1 = '00000000-0000-4000-8000-0000000000b1'
const svc = {} as SupabaseClient

type ToolResult = Record<string, unknown> & { success: boolean }
async function call(
  tools: ReturnType<typeof createSeoRankTools>,
  name: keyof ReturnType<typeof createSeoRankTools>,
  input: unknown,
): Promise<ToolResult> {
  return (
    tools[name] as unknown as {
      execute: (i: unknown, o: unknown) => Promise<ToolResult>
    }
  ).execute(input, undefined)
}

const run: RankRunView = {
  id: RUN,
  tracker_id: TRACKER,
  trigger: 'manual',
  status: 'queued',
  keywords_total: 2,
  keywords_checked: 0,
  checks_total: 2,
  checks_collected: 0,
  estimate_usd: 0.0126,
  cost_usd: 0,
  error: null,
  note: null,
  started_by: PERSON,
  scheduled_for: null,
  created_at: '2026-11-12T10:00:00Z',
  started_at: null,
  completed_at: null,
}

const tracker: RankTrackerView = {
  id: TRACKER,
  domain: 'example.com',
  location_code: 2840,
  language_code: 'en',
  location_name: null,
  devices: 'mobile',
  serp_depth: 20,
  schedule: {
    interval: 'weekly',
    weekday: null,
    hour: null,
    minute: null,
    time_zone: null,
  },
  next_check_at: '2026-11-15T05:00:00Z',
  last_checked_at: null,
  paused: false,
  skip_reason: null,
  skip_message: null,
  keyword_count: 2,
  created_by: PERSON,
  created_at: '2026-11-01T00:00:00Z',
  latest_run: run,
}

const cheap = estimateView({
  keywords: ['a', 'b'],
  devices: 'mobile',
  serp_depth: 20,
  schedule: 'weekly',
})
const dear = estimateView({
  keywords: Array.from({ length: 300 }, (_, i) => `k${i}`),
  devices: 'both',
  serp_depth: 100,
  schedule: 'daily',
})

beforeEach(() => {
  for (const fn of Object.values(h)) fn.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('refusals', () => {
  it('create_rank_tracker refuses an unattended turn and saves nothing', async () => {
    const tools = createSeoRankTools(PERSON, svc, WS, { unattended: true })
    const out = await call(tools, 'create_rank_tracker', {
      domain: 'example.com',
    })
    expect(out).toMatchObject({ success: false, code: 'UNATTENDED' })
    expect(h.createRankTracker).not.toHaveBeenCalled()
  })

  it('create_rank_tracker: the core’s go-ahead refusal becomes the monthly cost in words, and the flag is passed on', async () => {
    h.createRankTracker.mockResolvedValue(
      goAheadRefusal(
        'schedule',
        estimateView({
          keywords: ['plumber austin', 'drain repair'],
          devices: 'mobile',
          serp_depth: 20,
          schedule: 'daily',
        }),
      ),
    )
    const tools = createSeoRankTools(PERSON, svc, WS)
    const out = await call(tools, 'create_rank_tracker', {
      domain: 'example.com',
      schedule: 'daily',
      keywords: ['plumber austin', 'drain repair'],
    })
    expect(out).toMatchObject({
      success: false,
      code: 'NEEDS_GO_AHEAD',
      needs_go_ahead: true,
    })
    expect(out.error).toMatch(/a daily schedule needs the person’s yes/)
    expect(out.error).toMatch(/a month/)
    expect(out.estimate).toMatchObject({ keywords: 2, checks_per_month: 30 })
    expect(h.createRankTracker).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: false },
      expect.objectContaining({ confirmed: false }),
    )
  })

  it('update_rank_tracker: the yes is the core’s to ask; a loop’s raise comes back in the tools’ words', async () => {
    h.updateRankTracker.mockResolvedValue(
      goAheadRefusal('schedule', dear, cheap),
    )
    const attended = createSeoRankTools(PERSON, svc, WS)
    expect(
      await call(attended, 'update_rank_tracker', {
        tracker_id: TRACKER,
        schedule: 'daily',
      }),
    ).toMatchObject({
      success: false,
      code: 'NEEDS_GO_AHEAD',
      estimate: { checks_per_month: 30 },
    })
    expect(h.updateRankTracker).toHaveBeenLastCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: false },
      TRACKER,
      expect.objectContaining({ schedule_interval: 'daily', confirmed: false }),
    )
    h.updateRankTracker.mockResolvedValue({
      ok: false,
      code: 'UNATTENDED',
      message: 'Search data is looked up only when the person asks.',
      refusal: true,
    })
    const loop = createSeoRankTools(PERSON, svc, WS, { unattended: true })
    const out = await call(loop, 'update_rank_tracker', {
      tracker_id: TRACKER,
      schedule: 'daily',
      confirmed_with_user: true,
    })
    expect(out).toMatchObject({ success: false, code: 'UNATTENDED' })
    expect(out.error).toMatch(/person’s own turn/)
  })

  it('update_rank_tracker: a loop never moves a schedule’s time', async () => {
    const loop = createSeoRankTools(PERSON, svc, WS, { unattended: true })
    expect(
      await call(loop, 'update_rank_tracker', {
        tracker_id: TRACKER,
        schedule_time: { hour: 17, minute: 0 },
      }),
    ).toMatchObject({ success: false, code: 'UNATTENDED' })
    expect(h.updateRankTracker).not.toHaveBeenCalled()
  })

  it('add_rank_tracking_keywords on a scheduled tracker: the core’s refusal, said with the new monthly cost', async () => {
    h.addRankKeywords.mockResolvedValue(goAheadRefusal('schedule', dear, cheap))
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'add_rank_tracking_keywords',
      { tracker_id: TRACKER, keywords: ['drain repair'] },
    )
    expect(out).toMatchObject({ success: false, code: 'NEEDS_GO_AHEAD' })
    expect(out.error).toMatch(/adding these keywords/)
    expect(h.addRankKeywords).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: false },
      TRACKER,
      ['drain repair'],
      { confirmed: false },
    )
  })

  it('start_rank_check refuses an unattended turn; an expensive check comes back with its cost', async () => {
    const loop = createSeoRankTools(PERSON, svc, WS, { unattended: true })
    expect(
      await call(loop, 'start_rank_check', {
        tracker_id: TRACKER,
        confirmed_with_user: true,
      }),
    ).toMatchObject({ success: false, code: 'UNATTENDED' })
    expect(h.startRankCheck).not.toHaveBeenCalled()
    h.startRankCheck.mockResolvedValue(
      goAheadRefusal('check', {
        ...dear,
        schedule: 'manual',
        checks_per_month: 0,
        monthly_usd: 0,
      }),
    )
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'start_rank_check',
      { tracker_id: TRACKER },
    )
    expect(out).toMatchObject({
      success: false,
      code: 'NEEDS_GO_AHEAD',
      needs_go_ahead: true,
    })
    expect(out.error).toMatch(/this check needs the person’s yes/)
    expect(out.error).not.toMatch(/a month/)
    expect(h.startRankCheck).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      { unattended: false, confirmed: false },
    )
  })

  it('passes a spend-limit or plan refusal through in its own words', async () => {
    h.startRankCheck.mockResolvedValue({
      ok: false,
      code: 'FREE_PLAN',
      message: 'Keyword, ranking and backlink data is part of the paid plan.',
      refusal: true,
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'start_rank_check',
      { tracker_id: TRACKER },
    )
    expect(out).toEqual({
      success: false,
      code: 'FREE_PLAN',
      error: 'Keyword, ranking and backlink data is part of the paid plan.',
    })
  })
})

describe('happy paths', () => {
  it('list_rank_trackers', async () => {
    h.listRankTrackers.mockResolvedValue({ rows: [tracker], next_offset: null })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'list_rank_trackers',
      {},
    )
    expect(h.listRankTrackers).toHaveBeenCalledWith(svc, WS, {
      offset: undefined,
      limit: 25,
    })
    expect(out).toMatchObject({
      success: true,
      next_offset: null,
      trackers: [
        {
          tracker_id: TRACKER,
          site: 'example.com',
          keywords: 2,
          latest_check: { check_id: RUN, status: 'queued' },
        },
      ],
    })
    // No money in what the model reads about a check.
    expect(JSON.stringify(out)).not.toMatch(/usd|cost/i)
  })

  it('get_rank_tracker', async () => {
    h.getRankTrackerDetail.mockResolvedValue({
      tracker,
      summaries: [
        {
          device: 'mobile',
          tracked: 2,
          checked: 1,
          ranking: 1,
          not_found: 0,
          top3: 1,
          top10: 1,
          top100: 1,
          average_position: 2,
          improved: 1,
          declined: 0,
          unchanged: 0,
          new_rankings: 0,
          lost_rankings: 0,
          movers: {
            up: [
              {
                keyword_id: K1,
                keyword: 'plumber austin',
                position: 2,
                previous_position: 5,
                change: 3,
              },
            ],
            down: [],
          },
        },
      ],
    })
    h.listRankKeywordRows.mockResolvedValue({
      rows: [
        {
          id: K1,
          keyword: 'plumber austin',
          pinned: true,
          created_at: '',
          desktop: null,
          mobile: {
            device: 'mobile',
            status: 'ranked',
            position: 2,
            previous_position: 5,
            change: 3,
            movement: 'up',
            ranking_url: 'https://example.com/plumbing',
            serp_features: [],
            checked_at: '',
          },
          google_serp_url: '',
        },
      ],
      next_offset: 50,
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'get_rank_tracker',
      { tracker_id: TRACKER },
    )
    expect(h.getRankTrackerDetail).toHaveBeenCalledWith(svc, WS, TRACKER)
    expect(out).toMatchObject({
      success: true,
      next_offset: 50,
      summaries: [
        { top3: 1, biggest_gains: [{ keyword: 'plumber austin', change: 3 }] },
      ],
      keywords: [
        {
          keyword_id: K1,
          pinned: true,
          desktop: null,
          mobile: { position: 2, previous: 5, change: 3, movement: 'up' },
        },
      ],
    })
  })

  it('get_rank_tracker: an unknown tracker', async () => {
    h.getRankTrackerDetail.mockResolvedValue(null)
    expect(
      await call(createSeoRankTools(PERSON, svc, WS), 'get_rank_tracker', {
        tracker_id: TRACKER,
      }),
    ).toMatchObject({ success: false, code: 'NOT_FOUND' })
  })

  it('get_rank_history: a keyword’s series, or the tracker’s totals', async () => {
    h.getRankTracker.mockResolvedValue(tracker)
    h.getRankKeywordHistory.mockResolvedValue({
      keyword_id: K1,
      keyword: 'plumber austin',
      series: {
        desktop: null,
        mobile: [
          { run_id: RUN, checked_at: 'x', position: 4, ranking_url: null },
        ],
      },
    })
    h.getRankTrackerTrend.mockResolvedValue([{ device: 'mobile', points: [] }])
    const tools = createSeoRankTools(PERSON, svc, WS)
    expect(
      await call(tools, 'get_rank_history', {
        tracker_id: TRACKER,
        keyword_id: K1,
        days: 30,
      }),
    ).toMatchObject({ success: true, history: { keyword_id: K1 } })
    expect(h.getRankKeywordHistory).toHaveBeenCalledWith(svc, WS, tracker, K1, {
      days: 30,
    })
    expect(
      await call(tools, 'get_rank_history', { tracker_id: TRACKER }),
    ).toMatchObject({ success: true, trend: [{ device: 'mobile' }] })
  })

  it('get_rank_tracker_cost_estimate: a draft is free maths; a saved tracker compares before and after', async () => {
    const tools = createSeoRankTools(PERSON, svc, WS)
    const draft = await call(tools, 'get_rank_tracker_cost_estimate', {
      keywords: ['a', 'b'],
      schedule: 'weekly',
    })
    expect(draft).toMatchObject({
      success: true,
      estimate: {
        keywords: 2,
        checks_per_month: 4,
        reads_per_keyword: '3 to 6',
      },
    })
    h.previewTrackerChange.mockResolvedValue({
      ok: true,
      before: cheap,
      after: dear,
      raises_cost: true,
    })
    const saved = await call(tools, 'get_rank_tracker_cost_estimate', {
      tracker_id: TRACKER,
      keywords: ['c'],
    })
    expect(saved).toMatchObject({
      success: true,
      raises_cost: true,
      now: { keywords: 2 },
      with_change: { keywords: 300 },
    })
    expect(h.previewTrackerChange).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS },
      TRACKER,
      expect.objectContaining({ addKeywords: ['c'] }),
    )
  })

  it('create_rank_tracker: confirmed, it sets the tracker up in the person’s name', async () => {
    h.createRankTracker.mockResolvedValue({
      ok: true,
      tracker,
      keywords: {
        added: [{ id: K1, keyword: 'plumber austin' }],
        already_tracked: 0,
        over_cap: 0,
        rejected: 0,
      },
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'create_rank_tracker',
      {
        domain: 'example.com',
        schedule: 'weekly',
        schedule_time: {
          weekday: 1,
          hour: 9,
          minute: 0,
          time_zone: 'America/New_York',
        },
        keywords: ['plumber austin'],
        confirmed_with_user: true,
      },
    )
    expect(out).toMatchObject({
      success: true,
      keywords_added: 1,
      tracker: { tracker_id: TRACKER },
    })
    expect(h.createRankTracker).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: false },
      expect.objectContaining({
        domain: 'example.com',
        schedule_interval: 'weekly',
        schedule_time: {
          weekday: 1,
          hour: 9,
          minute: 0,
          time_zone: 'America/New_York',
        },
        confirmed: true,
      }),
    )
  })

  it('create_rank_tracker: a manual tracker needs no yes', async () => {
    h.createRankTracker.mockResolvedValue({
      ok: true,
      tracker: {
        ...tracker,
        schedule: { ...tracker.schedule, interval: 'manual' },
      },
      keywords: { added: [], already_tracked: 0, over_cap: 0, rejected: 0 },
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'create_rank_tracker',
      { domain: 'example.com', keywords: ['a'] },
    )
    expect(out).toMatchObject({ success: true })
    expect(out.message).toMatch(/start_rank_check/)
  })

  it('update_rank_tracker: lowering the cost (pausing) needs no yes, even in a loop', async () => {
    h.updateRankTracker.mockResolvedValue({
      ok: true,
      tracker: { ...tracker, paused: true },
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS, { unattended: true }),
      'update_rank_tracker',
      { tracker_id: TRACKER, paused: true },
    )
    expect(out).toMatchObject({ success: true, tracker: { paused: true } })
    expect(h.updateRankTracker).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: true },
      TRACKER,
      expect.objectContaining({ paused: true }),
    )
  })

  it('add_rank_tracking_keywords: confirmed', async () => {
    h.addRankKeywords.mockResolvedValue({
      ok: true,
      tracker_id: TRACKER,
      added: [{ id: K1, keyword: 'drain repair' }],
      already_tracked: 1,
      over_cap: 0,
      rejected: 0,
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'add_rank_tracking_keywords',
      {
        tracker_id: TRACKER,
        keywords: ['drain repair', 'plumber austin'],
        confirmed_with_user: true,
      },
    )
    expect(out).toMatchObject({
      success: true,
      added: [{ keyword_id: K1, keyword: 'drain repair' }],
      already_tracked: 1,
    })
    expect(h.addRankKeywords).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON, unattended: false },
      TRACKER,
      ['drain repair', 'plumber austin'],
      { confirmed: true },
    )
  })

  it('remove_rank_tracking_keywords', async () => {
    h.removeRankKeywords.mockResolvedValue({ ok: true, removed: 1 })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS, { unattended: true }),
      'remove_rank_tracking_keywords',
      { tracker_id: TRACKER, keyword_ids: [K1] },
    )
    expect(out).toEqual({ success: true, removed: 1 })
  })

  it('start_rank_check: a cheap check starts without asking, in the person’s name', async () => {
    h.startRankCheck.mockResolvedValue({ ok: true, run })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'start_rank_check',
      { tracker_id: TRACKER },
    )
    expect(out).toMatchObject({
      success: true,
      check: { check_id: RUN, status: 'queued' },
    })
    expect(h.startRankCheck).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS, userId: PERSON },
      TRACKER,
      { unattended: false, confirmed: false },
    )
  })

  it('start_rank_check: one already running is reported, nothing new charged', async () => {
    h.startRankCheck.mockResolvedValue({
      ok: false,
      code: 'ALREADY_RUNNING',
      message: 'A check of this tracker is already running.',
      run,
    })
    expect(
      await call(createSeoRankTools(PERSON, svc, WS), 'start_rank_check', {
        tracker_id: TRACKER,
      }),
    ).toMatchObject({
      success: false,
      code: 'ALREADY_RUNNING',
      running: { check_id: RUN },
    })
  })

  it('cancel_rank_check: by tracker, its live check', async () => {
    h.getLiveRankRun.mockResolvedValue({ id: RUN })
    h.cancelRankCheck.mockResolvedValue({
      ok: true,
      run: { ...run, status: 'canceled' },
    })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'cancel_rank_check',
      { tracker_id: TRACKER },
    )
    expect(out).toMatchObject({ success: true, check: { status: 'canceled' } })
    expect(h.cancelRankCheck).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS },
      RUN,
    )
  })

  it('delete_rank_tracker', async () => {
    h.deleteRankTracker.mockResolvedValue({ ok: true, tracker })
    const out = await call(
      createSeoRankTools(PERSON, svc, WS),
      'delete_rank_tracker',
      { tracker_id: TRACKER },
    )
    expect(out).toMatchObject({
      success: true,
      deleted: { tracker_id: TRACKER },
    })
    expect(h.deleteRankTracker).toHaveBeenCalledWith(
      svc,
      { workspaceId: WS },
      TRACKER,
    )
  })
})

describe('never throws', () => {
  it('a failure becomes words', async () => {
    h.listRankTrackers.mockRejectedValue(new Error('db down'))
    expect(
      await call(createSeoRankTools(PERSON, svc, WS), 'list_rank_trackers', {}),
    ).toMatchObject({
      success: false,
      error: expect.stringMatching(/Try again/),
    })
  })
})
