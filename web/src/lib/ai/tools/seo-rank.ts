import { isSeoError } from '@/lib/seo/errors'
import { seoToolError } from '@/lib/seo/http'
import {
  MAX_KEYWORDS_PER_ADD,
  MAX_SERP_DEPTH,
  MIN_SERP_DEPTH,
} from '@/lib/seo/rank/limits'
import {
  getLiveRankRun,
  getRankKeywordHistory,
  getRankTracker,
  getRankTrackerDetail,
  getRankTrackerTrend,
  listRankKeywordRows,
  listRankTrackers,
} from '@/lib/seo/rank/queries'
import { cancelRankCheck, startRankCheck } from '@/lib/seo/rank/runs'
import {
  addRankKeywords,
  createRankTracker,
  deleteRankTracker,
  estimateDraft,
  previewTrackerChange,
  removeRankKeywords,
  updateRankTracker,
  type ScheduleTimeInput,
} from '@/lib/seo/rank/trackers'
import {
  type RankEstimateView,
  type RankKeywordRow,
  type RankPositionView,
  type RankRunView,
  type RankTrackerSummary,
  type RankTrackerView,
} from '@/lib/seo/rank/view'
import type { SupabaseClient } from '@supabase/supabase-js'
import { tool } from 'ai'
import { z } from 'zod'

/**
 * SEO: rank tracking (src/lib/seo/rank). Where a site shows up on Google for
 * its keywords, in one market, on desktop and/or mobile, checked on request
 * or on a schedule.
 *
 *   list_rank_trackers              the workspace's trackers.
 *   get_rank_tracker                one tracker: its summary (top 3 / 10 /
 *                                   100, average position, movers since the
 *                                   previous check) and its keywords' latest
 *                                   positions, a page at a time.
 *   get_rank_history                a keyword's positions over time, or the
 *                                   tracker's totals per check.
 *   get_rank_tracker_cost_estimate  what a check costs at most, and per month
 *                                   on a schedule. Free maths.
 *   create_rank_tracker             set one up (optionally with keywords).
 *   update_rank_tracker             devices, depth, schedule, pause.
 *   add_rank_tracking_keywords      more keywords.
 *   remove_rank_tracking_keywords   fewer keywords (their history stays).
 *   start_rank_check                a check now. Paid.
 *   cancel_rank_check               stop a check.
 *   delete_rank_tracker             delete a tracker and its history.
 *
 * MONEY. A check buys Google results pages from the search data provider,
 * metered against the workspace's monthly ceiling. Unlike the rest of the SEO
 * tools, this family talks about cost, because a schedule spends every period
 * on its own: turning one on, or making it spend more (more keywords, a
 * faster schedule, more depth or devices, resuming it), takes
 * `confirmed_with_user: true`, given only after the person heard the
 * estimated monthly cost in the agent's own words and said yes. A manual
 * check estimated above CONFIRM_ABOVE_USD takes it too. The rule itself lives
 * in the cores (src/lib/seo/rank/trackers.ts, runs.ts), shared with the
 * routes: a tool passes the flag on and turns the core's NEEDS_GO_AHEAD into
 * words for the agent. A turn nobody is in (a loop, a scheduled run) never
 * sets up spending, starts a check or moves a schedule's time; it may read,
 * remove keywords, pause, cancel and delete.
 *
 * Results come from Google's pages, but what reaches the model here is
 * numbers, URLs, the person's own keywords and the kinds of result on the
 * page (provider type names): nothing of a page's own text, so nothing is
 * fenced.
 */

const confirmedSchema = z
  .boolean()
  .describe(
    'Set true ONLY after the person heard what this will cost (the estimate, in your own words: per check and per month on a schedule) and said yes to it in their last message. False, or omitted, refuses and changes nothing.',
  )

const scheduleTimeSchema = z
  .object({
    weekday: z
      .number()
      .int()
      .min(0)
      .max(6)
      .optional()
      .describe('Day of week for a weekly schedule, 0 = Sunday'),
    hour: z.number().int().min(0).max(23),
    minute: z.number().int().min(0).max(59),
    time_zone: z
      .string()
      .max(64)
      .optional()
      .describe(
        'The person’s IANA time zone, e.g. "America/New_York". Default UTC',
      ),
  })
  .describe(
    'When scheduled checks run, in the person’s time zone. Omit unless they ask for a time: the default spreads checks across quiet hours. Checks start within about 15 minutes of it.',
  )

const devicesSchema = z.enum(['desktop', 'mobile', 'both'])
const intervalSchema = z.enum(['manual', 'daily', 'weekly', 'monthly'])
const depthSchema = z
  .number()
  .int()
  .min(MIN_SERP_DEPTH)
  .max(MAX_SERP_DEPTH)
  .multipleOf(10)
  .describe(
    `How many Google results to read per search, ${MIN_SERP_DEPTH}-${MAX_SERP_DEPTH} in tens. Deeper costs more`,
  )

function runForModel(run: RankRunView | null) {
  if (!run) return null
  return {
    check_id: run.id,
    status: run.status,
    trigger: run.trigger,
    keywords_checked: run.keywords_checked,
    keywords_total: run.keywords_total,
    error: run.error,
    note: run.note,
    started_at: run.started_at ?? run.created_at,
    completed_at: run.completed_at,
  }
}

function trackerForModel(t: RankTrackerView) {
  return {
    tracker_id: t.id,
    site: t.domain,
    location_code: t.location_code,
    location_name: t.location_name,
    language_code: t.language_code,
    devices: t.devices,
    depth: t.serp_depth,
    schedule: t.schedule.interval,
    schedule_time:
      t.schedule.hour === null
        ? null
        : {
            weekday: t.schedule.weekday,
            hour: t.schedule.hour,
            minute: t.schedule.minute,
            time_zone: t.schedule.time_zone ?? 'UTC',
          },
    next_check_at: t.next_check_at,
    paused: t.paused,
    scheduled_checks_skipped: t.skip_message,
    keywords: t.keyword_count,
    last_checked_at: t.last_checked_at,
    latest_check: runForModel(t.latest_run),
  }
}

function positionForModel(p: RankPositionView | null) {
  if (!p) return null
  return {
    status: p.status,
    position: p.position,
    previous: p.previous_position,
    change: p.change,
    movement: p.movement,
    ranking_url: p.ranking_url,
  }
}

function keywordForModel(row: RankKeywordRow) {
  return {
    keyword_id: row.id,
    keyword: row.keyword,
    pinned: row.pinned,
    desktop: positionForModel(row.desktop),
    mobile: positionForModel(row.mobile),
  }
}

function summaryForModel(s: RankTrackerSummary) {
  return {
    device: s.device,
    tracked: s.tracked,
    checked: s.checked,
    ranking: s.ranking,
    not_found: s.not_found,
    top3: s.top3,
    top10: s.top10,
    top100: s.top100,
    average_position: s.average_position,
    improved: s.improved,
    declined: s.declined,
    new_rankings: s.new_rankings,
    lost_rankings: s.lost_rankings,
    biggest_gains: s.movers.up,
    biggest_drops: s.movers.down,
  }
}

function estimateForModel(e: RankEstimateView) {
  return {
    keywords: e.keyword_count,
    devices: e.devices,
    depth: e.serp_depth,
    searches_per_read: e.searches_per_read,
    reads_per_keyword: `${e.reads_per_check.min} to ${e.reads_per_check.max}`,
    max_usd_per_check: e.per_check_usd,
    schedule: e.schedule,
    checks_per_month: e.checks_per_month,
    max_usd_per_month: e.monthly_usd,
  }
}

function usd(n: number): string {
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

function goAheadRefusal(what: string, estimate: RankEstimateView) {
  const monthly =
    estimate.checks_per_month > 0
      ? `, about ${estimate.checks_per_month} checks a month, so up to ${usd(estimate.monthly_usd)} a month`
      : ''
  return {
    success: false as const,
    code: 'NEEDS_GO_AHEAD',
    needs_go_ahead: true,
    error: `Refused, nothing changed: ${what} needs the person’s yes. Each check costs up to ${usd(estimate.per_check_usd)}${monthly}, from the workspace’s search data budget. Tell them that in your own words, wait for a yes, then call again with confirmed_with_user: true.`,
    estimate: estimateForModel(estimate),
  }
}

const UNATTENDED = {
  success: false as const,
  code: 'UNATTENDED',
  error:
    'Only on the person’s own turn: they set up and start paid rank checks themselves. Tell them what you would change.',
}

/**
 * A core's failure as the tool's answer: its NEEDS_GO_AHEAD becomes the
 * go-ahead refusal (the cost, and how to ask), a turn nobody is in gets the
 * tools' own words, everything else its own words.
 */
function coreFailure(
  out: { code: string; message: string } & Record<string, unknown>,
  what: string,
) {
  if (out.code === 'NEEDS_GO_AHEAD' && out.estimate)
    return goAheadRefusal(what, out.estimate as RankEstimateView)
  if (out.code === 'UNATTENDED') return UNATTENDED
  return failure(out)
}

/** A tool never throws: a failure becomes words the agent can relay. */
async function guarded<T>(where: string, fn: () => Promise<T>) {
  try {
    return await fn()
  } catch (err) {
    if (isSeoError(err)) return seoToolError(err, where)
    console.error(`[seo-rank] ${where} failed`, err)
    return {
      success: false as const,
      error: 'Could not do that just now. Try again in a moment.',
    }
  }
}

function failure(out: { code: string; message: string }) {
  return { success: false as const, code: out.code, error: out.message }
}

function scheduleTimeInput(
  value: z.infer<typeof scheduleTimeSchema> | undefined,
): ScheduleTimeInput | undefined {
  return value
    ? {
        weekday: value.weekday,
        hour: value.hour,
        minute: value.minute,
        time_zone: value.time_zone,
      }
    : undefined
}

export function createSeoRankTools(
  userId: string,
  supabase: SupabaseClient,
  workspaceId: string,
  opts: { unattended?: boolean } = {},
) {
  const unattended = opts.unattended === true
  const actor = { workspaceId, userId, unattended }
  return {
    list_rank_trackers: tool({
      description:
        'The workspace’s rank trackers: which site, which market and devices, the schedule, how many keywords, and the newest check. Free. To see positions, call get_rank_tracker with a tracker_id; with none yet, offer to set one up (create_rank_tracker).',
      inputSchema: z.object({
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('next_offset from the previous call'),
      }),
      execute: async ({ offset }) =>
        guarded('list_rank_trackers', async () => {
          const page = await listRankTrackers(supabase, workspaceId, {
            offset,
            limit: 25,
          })
          return {
            success: true,
            trackers: page.rows.map(trackerForModel),
            next_offset: page.next_offset,
          }
        }),
    }),

    get_rank_tracker: tool({
      description:
        'One rank tracker: its settings, its newest check, a summary per device (keywords found, in the top 3 / 10 / 100, average position, gains and drops since the previous check, the biggest movers), and a page of keywords with their latest position and change. Pinned keywords first. Free (stored results). ' +
        'A null position means the site was not in the results read (up to the tracker’s depth); "not_checked" means no completed check has a result for it yet. Positions come from the last COMPLETED check, so they don’t change while a check runs (about an hour, up to two). Report the movement in plain words; for a keyword’s trend use get_rank_history.',
      inputSchema: z.object({
        tracker_id: z.string().uuid().describe('From list_rank_trackers'),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('next_offset from the previous call, for more keywords'),
      }),
      execute: async ({ tracker_id, offset }) =>
        guarded('get_rank_tracker', async () => {
          const detail = await getRankTrackerDetail(
            supabase,
            workspaceId,
            tracker_id,
          )
          if (!detail)
            return {
              success: false,
              code: 'NOT_FOUND',
              error: 'That rank tracker doesn’t exist.',
            }
          const page = await listRankKeywordRows(
            supabase,
            detail.tracker,
            workspaceId,
            { offset, limit: 50 },
          )
          return {
            success: true,
            tracker: trackerForModel(detail.tracker),
            summaries: detail.summaries.map(summaryForModel),
            keywords: page.rows.map(keywordForModel),
            next_offset: page.next_offset,
          }
        }),
    }),

    get_rank_history: tool({
      description:
        'Positions over time from a tracker’s completed checks, oldest first. With keyword_id: that keyword’s position per device at each check (null = checked, not found; a check with no result for it has no point). Without: the tracker’s totals per check (found, top 3 / 10 / 100, average position). Free. keyword_id comes from get_rank_tracker.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
        keyword_id: z
          .string()
          .uuid()
          .optional()
          .describe('One keyword’s series; omit for the tracker’s totals'),
        days: z
          .number()
          .int()
          .min(1)
          .max(400)
          .optional()
          .describe('How far back (default 90)'),
      }),
      execute: async ({ tracker_id, keyword_id, days }) =>
        guarded('get_rank_history', async () => {
          const tracker = await getRankTracker(
            supabase,
            workspaceId,
            tracker_id,
          )
          if (!tracker)
            return {
              success: false,
              code: 'NOT_FOUND',
              error: 'That rank tracker doesn’t exist.',
            }
          if (keyword_id) {
            const history = await getRankKeywordHistory(
              supabase,
              workspaceId,
              tracker,
              keyword_id,
              { days },
            )
            if (!history)
              return {
                success: false,
                code: 'NOT_FOUND',
                error: 'That keyword isn’t on this tracker.',
              }
            return { success: true, history }
          }
          return {
            success: true,
            trend: await getRankTrackerTrend(supabase, tracker, { days }),
          }
        }),
    }),

    get_rank_tracker_cost_estimate: tool({
      description:
        'What rank checks cost, without spending anything: the most one check costs (every keyword and device is read 3 to 6 times, and most checks use nearly all of them) and, on a schedule, per month. ' +
        'With tracker_id: the tracker as it is and with a change (keywords to add, other devices, depth or schedule), and whether the change raises what it spends. Without: a tracker not yet saved (keywords, devices, depth, schedule). ' +
        'Call it before create_rank_tracker with a schedule, before raising a scheduled tracker’s cost, and before start_rank_check; tell the person the cost in plain words and get their yes.',
      inputSchema: z.object({
        tracker_id: z.string().uuid().optional(),
        keywords: z
          .array(z.string().max(200))
          .max(MAX_KEYWORDS_PER_ADD)
          .optional()
          .describe(
            'With tracker_id: keywords to add. Without: the new tracker’s keywords',
          ),
        devices: devicesSchema.optional(),
        depth: depthSchema.optional(),
        schedule: intervalSchema.optional(),
        paused: z
          .boolean()
          .optional()
          .describe(
            'With tracker_id: pause (true) or resume (false) the schedule',
          ),
      }),
      execute: async ({
        tracker_id,
        keywords,
        devices,
        depth,
        schedule,
        paused,
      }) =>
        guarded('get_rank_tracker_cost_estimate', async () => {
          if (tracker_id) {
            const out = await previewTrackerChange(
              supabase,
              { workspaceId },
              tracker_id,
              {
                input: {
                  devices,
                  serp_depth: depth,
                  schedule_interval: schedule,
                  paused,
                },
                addKeywords: keywords ?? [],
              },
            )
            if (!out.ok) return failure(out)
            return {
              success: true,
              now: estimateForModel(out.before),
              with_change: estimateForModel(out.after),
              raises_cost: out.raises_cost,
            }
          }
          const out = estimateDraft({
            keywords: keywords ?? [],
            devices,
            serp_depth: depth,
            schedule_interval: schedule,
          })
          if (!out.ok) return failure(out)
          return { success: true, estimate: estimateForModel(out.estimate) }
        }),
    }),

    create_rank_tracker: tool({
      description:
        'Set up a rank tracker: a site (default the workspace’s own), a market (country, or a city with location_name, and a language), devices (default mobile), depth (default 20 results) and a schedule (default manual: checks only when asked). Optionally its first keywords. Setting it up starts no check. ' +
        'A daily, weekly or monthly schedule with keywords spends every period on its own: first get_rank_tracker_cost_estimate, tell the person the estimated cost per month, and call with confirmed_with_user: true only after they say yes. Only on the person’s own turn. One tracker per site and market; check list_rank_trackers first.',
      inputSchema: z.object({
        domain: z
          .string()
          .trim()
          .min(1)
          .max(253)
          .optional()
          .describe(
            'The site, e.g. "example.com". Default: the workspace’s own website',
          ),
        location_code: z
          .number()
          .int()
          .optional()
          .describe(
            'The country’s location code (2840 United States, 2826 United Kingdom, 2124 Canada, 2036 Australia). Default 2840',
          ),
        language_code: z
          .string()
          .max(10)
          .optional()
          .describe('Search language, e.g. "en". Default the country’s'),
        location_name: z
          .string()
          .trim()
          .max(200)
          .optional()
          .describe(
            'A city-level tracker’s exact Google location name, e.g. "Austin,Texas,United States"',
          ),
        devices: devicesSchema.optional(),
        depth: depthSchema.optional(),
        schedule: intervalSchema
          .optional()
          .describe(
            'manual (default: only when asked), daily, weekly, monthly',
          ),
        schedule_time: scheduleTimeSchema.optional(),
        keywords: z
          .array(z.string().max(200))
          .max(MAX_KEYWORDS_PER_ADD)
          .optional()
          .describe('The keywords to follow'),
        confirmed_with_user: confirmedSchema.optional(),
      }),
      execute: async (input) =>
        guarded('create_rank_tracker', async () => {
          if (unattended) return UNATTENDED
          const schedule = input.schedule ?? 'manual'
          // The core asks for the yes: a schedule with keywords spends from
          // its first due time on.
          const out = await createRankTracker(supabase, actor, {
            domain: input.domain,
            location_code: input.location_code,
            language_code: input.language_code,
            location_name: input.location_name,
            devices: input.devices,
            serp_depth: input.depth,
            schedule_interval: schedule,
            schedule_time: scheduleTimeInput(input.schedule_time),
            keywords: input.keywords,
            confirmed: input.confirmed_with_user === true,
          })
          if (!out.ok) {
            if (out.code === 'NEEDS_GO_AHEAD')
              return coreFailure(out, `a ${schedule} schedule`)
            return {
              ...coreFailure(out, 'this tracker'),
              ...('tracker_id' in out && out.tracker_id
                ? { tracker_id: out.tracker_id }
                : {}),
            }
          }
          return {
            success: true,
            tracker: trackerForModel(out.tracker),
            keywords_added: out.keywords.added.length,
            already_tracked: out.keywords.already_tracked,
            over_limit: out.keywords.over_cap,
            message:
              out.tracker.schedule.interval === 'manual'
                ? 'Set up. No check has run: positions fill in after start_rank_check (ask first: it is paid).'
                : `Set up. The first scheduled check is due ${out.tracker.next_check_at}.`,
          }
        }),
    }),

    update_rank_tracker: tool({
      description:
        'Change a rank tracker’s devices, depth or schedule, or pause / resume its schedule. Its site and market stay (a new market is a new tracker). ' +
        'A change that makes it spend more on its own (a faster schedule, more devices or depth on a schedule, resuming it) needs the person’s yes: get_rank_tracker_cost_estimate first, tell them the new monthly cost, then call with confirmed_with_user: true. Lowering the cost or pausing needs no yes. Moving the schedule’s time never adds a check, and is only on the person’s own turn.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
        devices: devicesSchema.optional(),
        depth: depthSchema.optional(),
        schedule: intervalSchema.optional(),
        schedule_time: scheduleTimeSchema.optional(),
        paused: z.boolean().optional(),
        confirmed_with_user: confirmedSchema.optional(),
      }),
      execute: async (input) =>
        guarded('update_rank_tracker', async () => {
          // When the checks run is the person's own choice.
          if (unattended && input.schedule_time !== undefined)
            return UNATTENDED
          // The core decides whether the change raises the cost, and then
          // asks the access check and for the yes.
          const out = await updateRankTracker(
            supabase,
            actor,
            input.tracker_id,
            {
              devices: input.devices,
              serp_depth: input.depth,
              schedule_interval: input.schedule,
              schedule_time: scheduleTimeInput(input.schedule_time),
              paused: input.paused,
              confirmed: input.confirmed_with_user === true,
            },
          )
          if (!out.ok) return coreFailure(out, 'this change')
          return { success: true, tracker: trackerForModel(out.tracker) }
        }),
    }),

    add_rank_tracking_keywords: tool({
      description:
        'Add keywords to a rank tracker (lowercased; ones it already follows are skipped). Starts no check. On a scheduled tracker every keyword is checked every period, so adding them raises its cost: get_rank_tracker_cost_estimate with the keywords first, tell the person the new monthly cost, and call with confirmed_with_user: true after their yes. To check them now, start_rank_check.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
        keywords: z.array(z.string().max(200)).min(1).max(MAX_KEYWORDS_PER_ADD),
        confirmed_with_user: confirmedSchema.optional(),
      }),
      execute: async ({ tracker_id, keywords, confirmed_with_user }) =>
        guarded('add_rank_tracking_keywords', async () => {
          const out = await addRankKeywords(
            supabase,
            actor,
            tracker_id,
            keywords,
            { confirmed: confirmed_with_user === true },
          )
          if (!out.ok)
            return coreFailure(
              out,
              'adding these keywords to a scheduled tracker',
            )
          return {
            success: true,
            added: out.added.map((k) => ({
              keyword_id: k.id,
              keyword: k.keyword,
            })),
            already_tracked: out.already_tracked,
            over_limit: out.over_cap,
            rejected: out.rejected,
          }
        }),
    }),

    remove_rank_tracking_keywords: tool({
      description:
        'Stop following keywords on a rank tracker, by keyword_id from get_rank_tracker. Their history stays readable in past checks. Unknown ids are ignored. Free.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
        keyword_ids: z.array(z.string().uuid()).min(1).max(500),
      }),
      execute: async ({ tracker_id, keyword_ids }) =>
        guarded('remove_rank_tracking_keywords', async () => {
          const out = await removeRankKeywords(
            supabase,
            { workspaceId },
            tracker_id,
            keyword_ids,
          )
          return out.ok ? { success: true, removed: out.removed } : failure(out)
        }),
    }),

    start_rank_check: tool({
      description:
        'Check every keyword of a rank tracker now. PAID: it buys Google results from the search data provider, from the workspace’s monthly budget. When get_rank_tracker_cost_estimate says it costs more than a quarter, tell the person and call with confirmed_with_user: true after their yes. ' +
        'Runs in the background for about an hour, up to two: tell them it started, and read the result later with get_rank_tracker. One check per tracker at a time; the schedule is unchanged.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
        confirmed_with_user: confirmedSchema.optional(),
      }),
      execute: async ({ tracker_id, confirmed_with_user }) =>
        guarded('start_rank_check', async () => {
          if (unattended) return UNATTENDED
          const out = await startRankCheck(
            supabase,
            { workspaceId, userId },
            tracker_id,
            { unattended, confirmed: confirmed_with_user === true },
          )
          if (out.ok)
            return {
              success: true,
              check: runForModel(out.run),
              message:
                'The check started. It reads every keyword several times, so it takes about an hour, up to two. Read the result with get_rank_tracker.',
            }
          if (out.code === 'ALREADY_RUNNING')
            return { ...failure(out), running: runForModel(out.run) }
          return coreFailure(out, 'this check')
        }),
    }),

    cancel_rank_check: tool({
      description:
        'Stop a rank check that is queued or running: by check_id, or the tracker’s live check by tracker_id. Searches already bought stay paid for, and a stopped check’s partial results don’t count as a check.',
      inputSchema: z.object({
        check_id: z.string().uuid().optional(),
        tracker_id: z.string().uuid().optional(),
      }),
      execute: async ({ check_id, tracker_id }) =>
        guarded('cancel_rank_check', async () => {
          let runId = check_id
          if (!runId && tracker_id)
            runId = (await getLiveRankRun(supabase, workspaceId, tracker_id))
              ?.id
          if (!runId)
            return {
              success: false,
              code: 'NOT_RUNNING',
              error: tracker_id
                ? 'That tracker has no check running.'
                : 'Which check? Give check_id or tracker_id.',
            }
          const out = await cancelRankCheck(supabase, { workspaceId }, runId)
          return out.ok
            ? { success: true, check: runForModel(out.run) }
            : failure(out)
        }),
    }),

    delete_rank_tracker: tool({
      description:
        'Delete a rank tracker with its keywords, its checks and all its position history, for everyone in the workspace. A check still running is stopped first. This can’t be undone: to stop it spending but keep the history, pause it with update_rank_tracker instead.',
      inputSchema: z.object({
        tracker_id: z.string().uuid(),
      }),
      execute: async ({ tracker_id }) =>
        guarded('delete_rank_tracker', async () => {
          const out = await deleteRankTracker(
            supabase,
            { workspaceId },
            tracker_id,
          )
          return out.ok
            ? { success: true, deleted: trackerForModel(out.tracker) }
            : failure(out)
        }),
    }),
  }
}
