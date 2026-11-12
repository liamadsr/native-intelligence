/**
 * One tracker with everything its page (and get_ai_visibility_tracker) opens
 * on: the settings, the prompts, the recent checks, the live one, what a
 * check and a month cost, and the latest completed check's headline. Free.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { estimateAiCost } from './cost'
import {
  getRunResults,
  getTracker,
  latestCompletedRun,
  listPrompts,
  listRuns,
} from './queries'
import { isLiveRun, type AiTrackerSummary } from './view'

export async function getTrackerSummary(
  svc: SupabaseClient,
  workspaceId: string,
  trackerId: string,
): Promise<AiTrackerSummary | null> {
  const tracker = await getTracker(svc, workspaceId, trackerId)
  if (!tracker) return null
  const [prompts, runs, latest] = await Promise.all([
    listPrompts(svc, workspaceId, trackerId),
    listRuns(svc, workspaceId, trackerId, 0, 10),
    latestCompletedRun(svc, workspaceId, trackerId),
  ])
  const results = latest
    ? await getRunResults(svc, workspaceId, latest.id, { scope: 'neutral' })
    : null
  const active = prompts.filter((p) => p.active).length
  return {
    tracker,
    prompts,
    recent_runs: runs.rows,
    live_run: runs.rows.find((r) => isLiveRun(r.status)) ?? null,
    estimate: estimateAiCost({
      promptCount: active,
      engines: tracker.engines,
      scheduleInterval: tracker.paused ? 'off' : tracker.schedule_interval,
      locationCode: tracker.location_code,
    }),
    latest_results: results
      ? {
          run: results.run,
          scope: results.scope,
          coverage: results.coverage,
          by_engine: results.by_engine,
          brands: results.brands,
          gaps: results.gaps,
        }
      : null,
  }
}
