/**
 * The SEO site audit's lane: one function, `seo-audit-run`, started by
 * `seo/audit.requested` and stopped by `seo/audit.cancel`.
 *
 * The audit itself is src/lib/seo/audit/engine.ts; this file only runs its
 * three kinds of step in order and makes sure an audit never stays "running"
 * forever:
 *
 *   claim        queued -> running (a redelivered attempt finds its own row
 *                running and carries on).
 *   discover     the site's real start, robots.txt, sitemaps, the first URLs.
 *   crawl-N      one bounded slice of the crawl per step (about a minute),
 *                until the page budget is spent or the queue is empty. When
 *                the site asks for a pause (a 429's Retry-After) the function
 *                sleeps through it instead of holding a request open.
 *   finalize     the cross-page checks, the tally, the cleanup.
 *
 * ONE AUDIT PER WORKSPACE AT A TIME, a few at once overall. The crawl is
 * polite to the site it reads (about a request a second), and this bounds
 * what it asks of our own server.
 *
 * NOTHING HERE COSTS MONEY: the crawl is our own requests to a public site.
 * No model call, no paid API.
 *
 * FAILURES. A failure the engine names (AuditFailure: nothing to crawl,
 * robots.txt refuses us, the site never answered) is final: it is written to
 * the row with words for the person and never retried. Anything else is
 * retried by Inngest, and `onFailure` writes the row once retries are spent.
 */
import {
  AuditFailure,
  failAudit,
  finalizeAudit,
  runCrawlChunk,
  runDiscovery,
  stopCrawl,
} from '@/lib/seo/audit/engine'
import { createAuditStore } from '@/lib/seo/audit/store'
import { getServiceClient } from '@/lib/supabase/service'
import {
  inngest,
  SEO_AUDIT_CANCEL,
  SEO_AUDIT_REQUESTED,
  type SeoAuditRequestedEvent,
} from './client'

/** A ceiling on crawl steps: far above what the page budget and the time limit allow, so a bug can't loop forever. */
const MAX_CRAWL_CHUNKS = 400

type AuditStep = {
  run: <T>(id: string, fn: () => Promise<T>) => Promise<T>
  sleepUntil: (id: string, time: Date) => Promise<void>
}

type Named = { failure: { code: string; message: string } }

/** Run an engine step; a failure the engine named comes back as data, so Inngest does not retry what a retry can't fix. */
async function named<T>(fn: () => Promise<T>): Promise<T | Named> {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof AuditFailure)
      return { failure: { code: err.code, message: err.message } }
    throw err
  }
}

function isNamed(value: unknown): value is Named {
  return !!value && typeof value === 'object' && 'failure' in value
}

export const seoAuditRun = inngest.createFunction(
  {
    id: 'seo-audit-run',
    retries: 2,
    concurrency: [{ limit: 1, key: 'event.data.workspaceId' }, { limit: 4 }],
    // Stops the function between steps. The cancel itself (status, cleanup)
    // is written by cancelSiteAudit before the event is sent, and a chunk
    // that is mid-flight sees the status when it ends.
    cancelOn: [{ event: SEO_AUDIT_CANCEL, match: 'data.auditId' }],
    onFailure: (ctx: unknown) =>
      seoAuditOnFailure(ctx as Parameters<typeof seoAuditOnFailure>[0]),
    triggers: [{ event: SEO_AUDIT_REQUESTED }],
  },
  async ({ event, step }: { event: { data: unknown }; step: AuditStep }) => {
    const data = event.data as Partial<SeoAuditRequestedEvent['data']> | null
    if (!data?.auditId || !data?.workspaceId) return { skipped: 'missing_ids' }
    const { auditId, workspaceId } = data
    const supabase = getServiceClient()
    const store = createAuditStore(supabase)

    // A compare-and-set: the status filter is the condition, and the rows
    // returned say whether this attempt owns the audit. `running` is accepted
    // so a redelivered attempt carries on with its own row.
    const claimed = await step.run('claim', async () => {
      const { data: rows, error } = await supabase
        .from('seo_audit')
        .update({
          status: 'running',
          started_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq('id', auditId)
        .eq('workspace_id', workspaceId)
        .in('status', ['queued', 'running'])
        .select('id')
      if (error) throw new Error(`seo_audit claim failed: ${error.message}`)
      return (rows ?? []).length > 0
    })
    if (!claimed) return { skipped: 'not_claimable', auditId }

    const fail = (failure: Named['failure']) =>
      step.run('record-failure', async () => {
        await failAudit(store, auditId, failure.code, failure.message)
        return { status: 'failed' as const, code: failure.code, auditId }
      })

    const discovered = await step.run('discover', () =>
      named(() => runDiscovery(store, auditId)),
    )
    if (isNamed(discovered)) return fail(discovered.failure)

    let crawlEnded = false
    for (let chunk = 0; chunk < MAX_CRAWL_CHUNKS; chunk++) {
      const outcome = await step.run(`crawl-${chunk}`, () =>
        named(() => runCrawlChunk(store, auditId, chunk)),
      )
      if (isNamed(outcome)) return fail(outcome.failure)
      if (outcome.done) {
        crawlEnded = true
        break
      }
      if (outcome.resumeAt)
        await step.sleepUntil(`pause-${chunk}`, new Date(outcome.resumeAt))
    }
    // The ceiling, not the crawl, ended it: say so in the report, so what is
    // left unvisited is not blamed on the page budget.
    if (!crawlEnded) {
      await step.run('crawl-ceiling', async () => {
        await stopCrawl(store, auditId, 'crawl-time-limit')
        return { stopped: true }
      })
    }

    const finished = await step.run('finalize', () =>
      named(() => finalizeAudit(store, auditId)),
    )
    if (isNamed(finished)) return fail(finished.failure)
    return { status: 'completed', auditId, issues: finished.issues }
  },
)

/** Runs once, after every retry is spent: the audit is written failed, so it never spins at "running". */
export async function seoAuditOnFailure({
  event,
  error,
}: {
  event: { data?: { event?: { data?: unknown } | null } | null }
  error: { message?: string } | null
}): Promise<{ skipped?: string; auditId?: string }> {
  const original = event?.data?.event?.data as Partial<
    SeoAuditRequestedEvent['data']
  > | null
  if (!original?.auditId) {
    // Nothing to write onto. Log, don't throw: throwing out of a failure hook only makes a second failure.
    console.error('[seo-audit] onFailure: no auditId on the original event')
    return { skipped: 'missing_ids' }
  }
  // The raw error is for our logs; the person reads a plain sentence.
  console.error('[seo-audit] audit failed', {
    auditId: original.auditId,
    error: error?.message,
  })
  await failAudit(
    createAuditStore(getServiceClient()),
    original.auditId,
    'CRAWL_FAILED',
    'The audit stopped unexpectedly. Run it again.',
  )
  return { auditId: original.auditId }
}
