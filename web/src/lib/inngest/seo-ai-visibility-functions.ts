/**
 * The AI visibility check's lane: one function, `seo-ai-visibility-run`,
 * started by `seo/ai-visibility.run.requested` and stopped by
 * `seo/ai-visibility.run.cancel`.
 *
 * The check itself is src/lib/seo/ai-visibility/engine.ts; this file runs
 * its steps in order and makes sure a check never stays "running" forever:
 *
 *   prepare      claim (queued -> running, compare-and-set), who pays, the
 *                batches.
 *   post-N       one paid task post per batch of queued answers (ChatGPT,
 *                Gemini, AI Overviews), made ONCE.
 *   model-N      the answers of engines only reachable live (Claude,
 *                Perplexity), a few per step, each asked ONCE (one by one
 *                when the workspace's month is close to its ceiling).
 *   wait-N /     free reads of the queued answers between sleeps, on the
 *   collect-N    source's backoff (2, 4, 7, 10, 14, 18, 22, 26, 30 minutes).
 *   finalize     what never came is settled, the counts written, the check
 *                ended. Answers a paid step sent but could not record (its
 *                `untracked`, kept here in the step's memoized output) end
 *                NOT_TRACKED with their cost, never "not sent".
 *   late-wait-N  free reads every half hour, for six hours, of answers that
 *   / late-N     had not arrived; one that has fills in, marked late.
 *
 * MONEY. Every paid call is made once: the answers are claimed before the
 * call (pending -> asking), and a retried step finds them claimed. The
 * monthly ceiling refuses a call the workspace can't afford; the check then
 * ends failed with the ceiling's own words. A manual check spends as the
 * person who asked; a scheduled one as the workspace (userId null), after
 * the schedule gate (src/lib/seo/ai-visibility/gate.ts), asked at prepare
 * and again before every paid step: a refusal partway (paused, schedule off,
 * owner gone or on the free plan) buys nothing more and ends the check in
 * the gate's words. A manual check is held to the estimate it started with.
 *
 * ONE CHECK PER WORKSPACE AT A TIME, a few at once overall. A sleeping
 * check (waiting for answers, or for late ones) holds no slot.
 *
 * The event names are here, not in client.ts: the start
 * (src/lib/seo/ai-visibility/runs.ts) and this lane import them from this
 * file, so a rename breaks the build.
 */
import { checkSeoDataAccess } from '@/lib/seo/access'
import {
  askModelBatch,
  collectLate,
  collectRound,
  failRunFromLane,
  finalizeRun,
  postQueueBatch,
  prepareRun,
  type EngineDeps,
  type UntrackedAnswer,
} from '@/lib/seo/ai-visibility/engine'
import { scheduledRunGate } from '@/lib/seo/ai-visibility/gate'
import {
  LATE_READ_INTERVAL,
  LATE_READ_ROUNDS,
  POLL_INTERVALS,
} from '@/lib/seo/ai-visibility/limits'
import { createAiRunStore } from '@/lib/seo/ai-visibility/store'
import { seoDataClient } from '@/lib/seo/data-client'
import {
  fetchAiTrackingTaskResult,
  resolveLatestLlmModelName,
} from '@/lib/seo/dataforseo'
import { readMonthlySeoSpend, SEO_MONTHLY_CAP_DOLLARS } from '@/lib/seo/spend'
import { getServiceClient } from '@/lib/supabase/service'
import {
  inngest,
  SEO_AI_VISIBILITY_RUN_CANCEL,
  SEO_AI_VISIBILITY_RUN_REQUESTED,
  type SeoAiVisibilityRunRequestedEvent,
} from './client'

// The events are named in ./client.ts (the library that sends them must not import this module).
export {
  SEO_AI_VISIBILITY_RUN_CANCEL,
  SEO_AI_VISIBILITY_RUN_REQUESTED,
  type SeoAiVisibilityRunCancelEvent,
  type SeoAiVisibilityRunRequestedEvent,
} from './client'

type RunStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  sleep: (id: string, duration: string) => Promise<void>
}

/** The production wiring of the engine's dependencies. */
export function laneDeps(): EngineDeps {
  const svc = getServiceClient()
  return {
    client: (run) =>
      seoDataClient(svc, {
        workspaceId: run.workspace_id,
        userId: run.trigger === 'manual' ? run.started_by : null,
      }),
    fetchTaskResult: fetchAiTrackingTaskResult,
    resolveModelName: resolveLatestLlmModelName,
    checkAccess: checkSeoDataAccess,
    scheduledGate: (tracker) => scheduledRunGate(svc, tracker),
    // The meter's own ceiling and ledger (src/lib/seo/spend.ts).
    remainingBudgetUsd: async (run) =>
      SEO_MONTHLY_CAP_DOLLARS -
      (await readMonthlySeoSpend(svc, run.workspace_id)),
  }
}

/**
 * The lane's body, separate from Inngest's wrapper so a test can drive it
 * with a recording step and an in-memory store.
 */
export async function runAiVisibilityCheck(
  runId: string,
  step: RunStep,
  store = createAiRunStore(getServiceClient()),
  deps: EngineDeps = laneDeps(),
) {
  const plan = await step.run('prepare', () => prepareRun(store, runId, deps))
  if (plan.kind !== 'ok') return { status: plan.kind, runId }

  let spendLimit: string | null = null
  let posted = 0
  const untracked: UntrackedAnswer[] = []
  // A scheduled check's gate, asked again at each paid step, refused: buy no more.
  let stopped: { code: string; message: string } | null = null
  for (const [i, batch] of plan.queue.entries()) {
    // A refused ceiling stops further spending: the rest are never sent.
    if (spendLimit || stopped) break
    const out = await step.run(`post-${i}`, () =>
      postQueueBatch(store, runId, batch, deps),
    )
    posted += out.sent
    spendLimit = spendLimit ?? out.spend_limit
    untracked.push(...(out.untracked ?? []))
    stopped = stopped ?? out.stopped ?? null
  }
  for (const [i, batch] of plan.model.entries()) {
    if (spendLimit || stopped) break
    const out = await step.run(`model-${i}`, () =>
      askModelBatch(store, runId, batch, deps),
    )
    spendLimit = spendLimit ?? out.spend_limit
    untracked.push(...(out.untracked ?? []))
    stopped = stopped ?? out.stopped ?? null
  }

  if (posted > 0) {
    for (const [round, wait] of POLL_INTERVALS.entries()) {
      await step.sleep(`wait-${round}`, wait)
      const out = await step.run(`collect-${round}`, () =>
        collectRound(store, runId, deps),
      )
      if (out.pending === 0) break
    }
  }

  const finished = await step.run('finalize', () =>
    finalizeRun(store, runId, { spendLimit, untracked, stopped }),
  )
  let missing = finished.late_pending
  for (let round = 1; round <= LATE_READ_ROUNDS && missing > 0; round++) {
    await step.sleep(`late-wait-${round}`, LATE_READ_INTERVAL)
    const out = await step.run(`late-${round}`, () =>
      collectLate(store, runId, deps),
    )
    missing = out.pending
  }
  return { status: finished.status, runId, counts: finished.counts }
}

export const seoAiVisibilityRun = inngest.createFunction(
  {
    id: 'seo-ai-visibility-run',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }],
    // Stops the function between steps. The cancel itself (status, open
    // answers) is written by cancelRun before the event is sent, and a step
    // in flight finds the check no longer running.
    cancelOn: [{ event: SEO_AI_VISIBILITY_RUN_CANCEL, match: 'data.runId' }],
    onFailure: (ctx: unknown) =>
      seoAiVisibilityOnFailure(
        ctx as Parameters<typeof seoAiVisibilityOnFailure>[0],
      ),
    triggers: [{ event: SEO_AI_VISIBILITY_RUN_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: RunStep }) => {
    const data = event.data as Partial<
      SeoAiVisibilityRunRequestedEvent['data']
    > | null
    if (!data?.runId || !data?.workspaceId) return { skipped: 'missing_ids' }
    return runAiVisibilityCheck(data.runId, step)
  },
)

/** Runs once, after every retry is spent: the check is written failed, so it never spins at "running". */
export async function seoAiVisibilityOnFailure({
  event,
  error,
}: {
  event: { data?: { event?: { data?: unknown } | null } | null }
  error: { message?: string } | null
}): Promise<{ skipped?: string; runId?: string }> {
  const original = event?.data?.event?.data as Partial<
    SeoAiVisibilityRunRequestedEvent['data']
  > | null
  if (!original?.runId) {
    // Nothing to write onto. Log, don't throw: throwing out of a failure hook only makes a second failure.
    console.error('[seo-ai] onFailure: no runId on the original event')
    return { skipped: 'missing_ids' }
  }
  // The raw error is for our logs; the person reads a plain sentence.
  console.error('[seo-ai] check failed', {
    runId: original.runId,
    error: error?.message,
  })
  await failRunFromLane(
    createAiRunStore(getServiceClient()),
    original.runId,
    'The check stopped unexpectedly. Answers already collected stay; run it again for the rest.',
  )
  return { runId: original.runId }
}

/** What src/app/api/inngest/route.ts registers. */
export const seoAiVisibilityFunctions = [seoAiVisibilityRun]
