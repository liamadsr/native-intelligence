/**
 * CRM web-enrichment jobs: one record per run, only when a person asks.
 *
 * The work itself lives in src/lib/crm/enrichment.ts; these are the durable
 * wrappers:
 *
 *   crm/enrich-contact.manual { contactId, workspaceId, userId, allowSelf, workRunKey }
 *   crm/enrich-company.manual { companyId, workspaceId, userId, workRunKey }
 *
 * Senders: the Enrich button (/api/account/{contacts,companies}/[id]/enrich),
 * the chat's enrich_contact tool, and Prospecting establishing a sourced
 * company. Each one is a person asking for that record.
 *
 * NOTHING ENRICHES ON ITS OWN ANY MORE (2026-10-27). There used to be a
 * background lane (crm/enrich-contact, crm/enrich-company) fed by a half-hourly
 * cron sweep over every un-enriched row and by a hook on contact creation.
 * Calendar sync turned thousands of meeting attendees into contacts, the sweep
 * paid for three Exa deep searches on each, and it drained the Exa account
 * more than once (PROD, Sep 16 to Oct 25: 3,851 contacts left failed on Exa's
 * out-of-credits 402). The founder's call: enrich when someone asks, and have
 * the meeting prep offer it before a call. The `.manual` names are kept so the
 * senders and the registered function ids stay as they were.
 *
 * All senders mark the row `enrichment_status = 'pending'` before sending.
 *
 * Concurrency is keyed on workspaceId at limit 2: enrichment is a paid Exa deep
 * search per entity, and one workspace must not monopolize the fleet's Exa
 * rate budget (5 QPS for deep search per team, exa.ai/docs/reference/
 * rate-limits). Runs are human-paced, so there is no global throttle.
 *
 * Spend is gated BEFORE any search with `guardBackgroundUsageOnPlan`, matching
 * claim-extraction: a person on their own ChatGPT plan (the free tier) passes,
 * and the lib runs their cards on their plan instead of Exa
 * (deepSearchForUser); a user over their AI limit raises NonRetriable, so Inngest
 * stops immediately instead of burning retries on work that will always be
 * blocked. The row goes back to its last outcome (it was marked pending for
 * a run that won't happen), and the click's Activity row says why.
 *
 * The lib function owns its own terminal write (status + enriched_at +
 * metadata blob), so a run that returns has already persisted its outcome. A
 * run that THROWS is transient by construction (the lib returns permanent
 * failures and Exa's out-of-credits refusal as a recorded 'failed'), so
 * Inngest's retries are always retrying something that might actually succeed.
 */

import { inngest } from './client'
import { guardBackgroundUsageOnPlan } from './usage-guard'
import {
  enrichContact,
  enrichCompany,
  ENRICHMENT_INNGEST_RETRIES,
} from '@/lib/crm/enrichment'
import { getServiceClient } from '@/lib/admin'
import { settleManualEnrichment, stepManualEnrichment } from '@/lib/work/enrichment-mirror'
import { releasePendingEnrichment } from '@/lib/crm/manual-enrichment'

interface EnrichContactEventData {
  contactId: string
  workspaceId: string
  userId?: string | null
  /**
   * Enrich a workspace member's own self-contact, which the lib otherwise
   * skips. Set by the Enrich button — a person clicking Enrich on their own
   * card is explicitly asking for it.
   */
  allowSelf?: boolean
  /** The click's Activity row (enrichment-mirror.ts); absent when the sender opened none. */
  workRunKey?: string | null
}

interface EnrichCompanyEventData {
  companyId: string
  workspaceId: string
  userId?: string | null
  /** The click's Activity row (enrichment-mirror.ts); absent when the sender opened none. */
  workRunKey?: string | null
}

// NOTE: the concurrency literal is repeated at each createFunction call below
// rather than hoisted into a shared object. The SDK types `concurrency` as a
// 1- or 2-tuple, and a hoisted object infers either a widened array or a
// readonly tuple — neither is assignable. The two configs must stay identical
// apart from id and trigger; the registration test in
// __tests__/crm-enrichment.test.ts asserts exactly that.

type EnrichHandlerArgs = {
  event: { data: unknown }
  step: { run: <T>(id: string, fn: () => Promise<T>) => Promise<T> }
}

/**
 * The usage guard. A click it blocks is skipped with the reason rather than
 * left queued for the ledger reaper (a sender with no Activity row carries no
 * run key).
 */
async function guardUsage(
  step: EnrichHandlerArgs['step'],
  data: { userId?: string | null; workspaceId: string; workRunKey?: string | null },
  record: { table: 'contact' | 'company'; recordId: string },
) {
  try {
    await guardBackgroundUsageOnPlan(data.userId)
  } catch (err) {
    // The row was marked pending for this run, which won't happen: back to its
    // last outcome, so the button (disabled while pending) and the chat can ask
    // again once the limit allows.
    await step.run('release-blocked', () =>
      releasePendingEnrichment(getServiceClient(), { table: record.table, id: record.recordId, workspaceId: data.workspaceId }),
    )
    if (data.workRunKey) {
      await step.run('ledger-blocked', () =>
        settleManualEnrichment(
          getServiceClient(),
          data.workRunKey,
          { status: 'skipped', reason: 'usage_limit_reached' },
          { workspaceId: data.workspaceId, ...record },
        ),
      )
    }
    throw err
  }
}

/**
 * The contact handler.
 */
async function runEnrichContact({ event, step }: EnrichHandlerArgs) {
  const data = event.data as EnrichContactEventData
  if (!data?.contactId || !data?.workspaceId) {
    return { skipped: 'missing_ids' }
  }

  await guardUsage(step, data, { table: 'contact', recordId: data.contactId })

  if (data.workRunKey) {
    await step.run('ledger-start', () => stepManualEnrichment(getServiceClient(), data.workRunKey))
  }

  // One step for the whole unit of work: the lib call is one paid Exa deep
  // search followed by a single terminal write, and splitting it would let a
  // retry re-bill the search against a memoized-but-unwritten result.
  const outcome = await step.run('enrich-contact', () =>
    enrichContact({
      contactId: data.contactId,
      workspaceId: data.workspaceId,
      userId: data.userId ?? null,
      allowSelf: data.allowSelf === true,
    }),
  )

  if (data.workRunKey) {
    await step.run('ledger-settle', () =>
      settleManualEnrichment(getServiceClient(), data.workRunKey, outcome, {
        workspaceId: data.workspaceId,
        table: 'contact',
        recordId: data.contactId,
      }),
    )
  }

  return outcome
}

/** The company handler. */
async function runEnrichCompany({ event, step }: EnrichHandlerArgs) {
  const data = event.data as EnrichCompanyEventData
  if (!data?.companyId || !data?.workspaceId) {
    return { skipped: 'missing_ids' }
  }

  await guardUsage(step, data, { table: 'company', recordId: data.companyId })

  if (data.workRunKey) {
    await step.run('ledger-start', () => stepManualEnrichment(getServiceClient(), data.workRunKey))
  }

  const outcome = await step.run('enrich-company', () =>
    enrichCompany({
      companyId: data.companyId,
      workspaceId: data.workspaceId,
      userId: data.userId ?? null,
    }),
  )

  if (data.workRunKey) {
    await step.run('ledger-settle', () =>
      settleManualEnrichment(getServiceClient(), data.workRunKey, outcome, {
        workspaceId: data.workspaceId,
        table: 'company',
        recordId: data.companyId,
      }),
    )
  }

  return outcome
}

export const crmEnrichContactManual = inngest.createFunction(
  {
    id: 'crm-enrich-contact-manual',
    retries: ENRICHMENT_INNGEST_RETRIES,
    concurrency: [{ limit: 2, key: 'event.data.workspaceId' }],
    triggers: [{ event: 'crm/enrich-contact.manual' }],
  },
  runEnrichContact,
)

export const crmEnrichCompanyManual = inngest.createFunction(
  {
    id: 'crm-enrich-company-manual',
    retries: ENRICHMENT_INNGEST_RETRIES,
    concurrency: [{ limit: 2, key: 'event.data.workspaceId' }],
    triggers: [{ event: 'crm/enrich-company.manual' }],
  },
  runEnrichCompany,
)
