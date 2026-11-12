/**
 * The local rank scan's lane: one function, `seo-local-scan-run`, started by
 * `seo/local-scan.requested` and stopped by `seo/local-scan.cancel`. A scan
 * only ever starts because a person asked (src/lib/seo/local/scans.ts): there
 * is no schedule and no cron.
 *
 * The scan itself is src/lib/seo/local/scan-engine.ts; this file runs its
 * steps in order and makes sure a scan never stays "running" forever:
 *
 *   claim        queued -> running (a redelivered attempt finds its own row
 *                running and carries on).
 *   post-K       keyword K's searches, one queued Maps search per grid point,
 *                bought ONCE and recorded at what the provider charged. The
 *                engine writes a marker before it calls the provider, so a
 *                retried step never pays again.
 *   wait-R       a sleep between reads (SCAN_COLLECT_WAITS): the searches
 *                take seconds to minutes, and no request is held meanwhile.
 *   collect-R    one free read of every point still pending.
 *   finalize     whatever never came back is not collected; the summary
 *                numbers go on the scan.
 *
 * ONE SCAN PER WORKSPACE AT A TIME, a few at once overall: a scan is up to a
 * few hundred searches, and the provider's queue and our own lane both stay
 * calm. A second scan of the same workspace waits its turn.
 *
 * FAILURES. A refusal the engine names (the monthly spend limit, the
 * provider's key or balance) is final: written to the row with words for
 * the person, never retried. Anything else is retried by Inngest (the posts
 * are protected by their markers, the reads are free), and `onFailure`
 * writes the row failed once retries are spent.
 */
import { fetchLocalSerpTaskResult } from '@/lib/seo/dataforseo'
import { SCAN_COLLECT_WAITS } from '@/lib/seo/local/limits'
import { localScanClient } from '@/lib/seo/local/scan-client'
import {
  claimScan,
  collectRound,
  failScan,
  finalizeScan,
  isScanFailure,
  postKeyword,
} from '@/lib/seo/local/scan-engine'
import { createLocalScanStore } from '@/lib/seo/local/scan-store'
import { getServiceClient } from '@/lib/supabase/service'
import {
  inngest,
  SEO_LOCAL_SCAN_CANCEL,
  SEO_LOCAL_SCAN_REQUESTED,
  type SeoLocalScanRequestedEvent,
} from './client'

/**
 * The lane's two events, named here (not in ./client.ts) and imported by the
 * start and cancel core, so a rename breaks the build. The start
 * (src/lib/seo/local/scans.ts) creates the `seo_local_scan` row first and
 * sends its id; the lane never creates one.
 */
// The events are named in ./client.ts (the library that sends them must not import this module).
export {
  SEO_LOCAL_SCAN_CANCEL,
  SEO_LOCAL_SCAN_REQUESTED,
  type SeoLocalScanCancelEvent,
  type SeoLocalScanRequestedEvent,
} from './client'

type ScanStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  sleep: (id: string, duration: string) => Promise<void>
}

export const seoLocalScanRun = inngest.createFunction(
  {
    id: 'seo-local-scan-run',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }],
    // Stops the function between steps. The cancel itself (the status) is
    // written by cancelLocalScan before the event is sent, and a step that is
    // mid-flight sees the status when it next reads the scan.
    cancelOn: [{ event: SEO_LOCAL_SCAN_CANCEL, match: 'data.scanId' }],
    onFailure: (ctx: unknown) =>
      seoLocalScanOnFailure(ctx as Parameters<typeof seoLocalScanOnFailure>[0]),
    triggers: [{ event: SEO_LOCAL_SCAN_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: ScanStep }) => {
    const data = event.data as Partial<
      SeoLocalScanRequestedEvent['data']
    > | null
    if (!data?.scanId || !data?.workspaceId) return { skipped: 'missing_ids' }
    const { scanId, workspaceId } = data
    const supabase = getServiceClient()
    const store = createLocalScanStore(supabase)

    const claimed = await step.run('claim', async () => {
      const scan = await claimScan(store, scanId)
      if (!scan || scan.workspaceId !== workspaceId) return null
      return { keywords: scan.keywords.length, startedBy: scan.startedBy }
    })
    if (!claimed) return { skipped: 'not_claimable', scanId }

    for (let index = 0; index < claimed.keywords; index++) {
      const outcome = await step.run(`post-${index}`, () =>
        postKeyword(
          store,
          scanId,
          index,
          // Metered, and reporting what the provider charged: the scan records the real cost.
          localScanClient(supabase, { workspaceId, userId: claimed.startedBy }),
        ),
      )
      if (isScanFailure(outcome)) {
        return step.run('record-failure', async () => {
          await failScan(
            store,
            scanId,
            outcome.failure.code,
            outcome.failure.message,
          )
          return {
            status: 'failed' as const,
            code: outcome.failure.code,
            scanId,
          }
        })
      }
      if ('skipped' in outcome) return { skipped: 'inactive', scanId }
    }

    for (let round = 0; round < SCAN_COLLECT_WAITS.length; round++) {
      await step.sleep(`wait-${round}`, SCAN_COLLECT_WAITS[round])
      const read = await step.run(`collect-${round}`, () =>
        collectRound(store, scanId, { fetchResult: fetchLocalSerpTaskResult }),
      )
      if ('inactive' in read) return { skipped: 'inactive', scanId }
      if (read.pending === 0) break
    }

    const finished = await step.run('finalize', () =>
      finalizeScan(store, scanId),
    )
    return {
      status: finished.status,
      scanId,
      summary: finished.summary ?? null,
    }
  },
)

/** Runs once, after every retry is spent: the scan is written failed, so it never spins at "running". */
export async function seoLocalScanOnFailure({
  event,
  error,
}: {
  event: { data?: { event?: { data?: unknown } | null } | null }
  error: { message?: string } | null
}): Promise<{ skipped?: string; scanId?: string }> {
  const original = event?.data?.event?.data as Partial<
    SeoLocalScanRequestedEvent['data']
  > | null
  if (!original?.scanId) {
    // Nothing to write onto. Log, don't throw: throwing out of a failure hook only makes a second failure.
    console.error('[seo-local] onFailure: no scanId on the original event')
    return { skipped: 'missing_ids' }
  }
  // The raw error is for our logs; the person reads a plain sentence.
  console.error('[seo-local] scan failed', {
    scanId: original.scanId,
    error: error?.message,
  })
  await failScan(
    createLocalScanStore(getServiceClient()),
    original.scanId,
    'SCAN_FAILED',
    'The scan stopped unexpectedly. The points it read are kept; a new scan buys its searches again.',
  )
  return { scanId: original.scanId }
}

/** Every function of this lane, for the Inngest route's list. */
export const seoLocalFunctions = [seoLocalScanRun]
