/**
 * The SEO rank check's lane: one function, `seo-rank-check-run`, started by
 * `seo/rank-check.requested` and stopped by `seo/rank-check.cancel`.
 *
 * The check itself is src/lib/seo/rank/engine.ts (its header lists the
 * steps); this file only wires it to Inngest and makes sure a check never
 * stays "running" forever.
 *
 * MONEY. The post steps buy searches from the data provider, metered against
 * the workspace's monthly ceiling (src/lib/seo/spend.ts). They never throw
 * past their marker, so the function's retries never re-run a purchase, and
 * each writes a marker before it posts so a re-run after a crash doesn't
 * either. A scheduled check's post step asks the schedule's gate first and
 * may throw there, before its marker: a standing that can't be read is
 * retried, never bought on. Every
 * other step is free (our own rows, the provider's free task_get) and safe to
 * run twice, so those are what the retries are for.
 *
 * WAITS. The provider's queue takes minutes; the lane sleeps between reads
 * (step.sleep), so no request is held open and no concurrency slot is taken
 * while it waits.
 *
 * Concurrency: one step at a time per workspace, a few overall. Starting is
 * bounded elsewhere (one live check per tracker, the cron's per-tick budget).
 *
 * FAILURES. A failure the engine names (no keywords, the ceiling, a schedule
 * whose person may no longer spend) is final, written to the run in words.
 * Anything else is retried by Inngest, and `onFailure` writes the run failed
 * once retries are spent.
 */
import { rankDataPort } from '@/lib/seo/rank/data-port'
import {
  runRankCheck,
  type RankEngineDeps,
  type RankStep,
} from '@/lib/seo/rank/engine'
import { gateDeps } from '@/lib/seo/rank/gate'
import { createRankRunStore } from '@/lib/seo/rank/store'
import { nextMonthStart, SEO_MONTHLY_CAP_DOLLARS } from '@/lib/seo/spend'
import { getServiceClient } from '@/lib/supabase/service'
import {
  inngest,
  SEO_RANK_CHECK_CANCEL,
  SEO_RANK_CHECK_REQUESTED,
  type SeoRankCheckRequestedEvent,
} from './client'

function engineDeps(): RankEngineDeps {
  const svc = getServiceClient()
  return {
    store: createRankRunStore(svc),
    data: (who) => rankDataPort(svc, who),
    gate: gateDeps(svc),
    now: () => Date.now(),
    capDollars: SEO_MONTHLY_CAP_DOLLARS,
    resetsOn: (now) => nextMonthStart(new Date(now)).toISOString().slice(0, 10),
  }
}

export const seoRankCheckRun = inngest.createFunction(
  {
    id: 'seo-rank-check-run',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }],
    // Stops the function between steps. The cancel itself (the status) is
    // written by cancelRankCheck before the event is sent, and a post step in
    // flight reads that status before it buys anything.
    cancelOn: [{ event: SEO_RANK_CHECK_CANCEL, match: 'data.runId' }],
    onFailure: (ctx: unknown) =>
      seoRankCheckOnFailure(ctx as Parameters<typeof seoRankCheckOnFailure>[0]),
    triggers: [{ event: SEO_RANK_CHECK_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: RankStep }) => {
    const data = event.data as Partial<
      SeoRankCheckRequestedEvent['data']
    > | null
    if (!data?.runId || !data?.workspaceId) return { skipped: 'missing_ids' }
    return runRankCheck(step, engineDeps(), {
      runId: data.runId,
      workspaceId: data.workspaceId,
    })
  },
)

/** Runs once, after every retry is spent: the check is written failed, so it never spins at "running". */
export async function seoRankCheckOnFailure({
  event,
  error,
}: {
  event: { data?: { event?: { data?: unknown } | null } | null }
  error: { message?: string } | null
}): Promise<{ skipped?: string; runId?: string }> {
  const original = event?.data?.event?.data as Partial<
    SeoRankCheckRequestedEvent['data']
  > | null
  if (!original?.runId) {
    // Nothing to write onto. Log, don't throw: throwing out of a failure hook only makes a second failure.
    console.error('[seo-rank] onFailure: no runId on the original event')
    return { skipped: 'missing_ids' }
  }
  // The raw error is for our logs; the person reads a plain sentence.
  console.error('[seo-rank] check failed', {
    runId: original.runId,
    error: error?.message,
  })
  await createRankRunStore(getServiceClient()).failRun(
    original.runId,
    'CHECK_FAILED',
    'The check stopped unexpectedly. Run it again.',
  )
  return { runId: original.runId }
}
