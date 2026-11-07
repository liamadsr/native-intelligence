import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import {
  failHubspotImport,
  finishHubspotImport,
  openHubspotImport,
  stepHubspotImport,
} from '@/lib/work/import-mirror'
import {
  listObjects,
  advanceSearchWatermark,
  CONTACT_PROPERTIES,
  COMPANY_PROPERTIES,
  type HubspotObject,
} from '@/lib/integrations/hubspot-api'
import {
  upsertHubspotCompany,
  upsertHubspotContact,
} from '@/lib/crm/hubspot-sync'
import { createImportBatch, loadImportBatch, stageRecords, stagingBatchForAccount } from '@/lib/crm/import/batch'
import { CONTACT_IMPORT_APPLY } from '@/lib/crm/import/run'
import { hubspotPageToRecords } from '@/lib/crm/import/sources/hubspot'

// =====================================================================
// HubSpot CRM sync — initial backfill + incremental (mirrors email-functions)
// =====================================================================
//
// The initial backfill is the portal's first full import (roadmap track G3):
// its pages are staged into one import batch (src/lib/crm/import/), and once
// the last page is in, the importer applies them: deduped against the CRM,
// never over the owner's own edits, undoable as a whole, and the owner gets a
// text with the summary. The incremental sync after it keeps the upsert path
// (hubspot-sync.ts), which finds each contact by the HubSpot id the import
// left on it.

interface HubspotEventData {
  userId: string
  workspaceId: string
  accountId: string
}

// Self-chaining bound: how many list PAGES a single initial-import invocation
// will fetch per object type before re-firing itself. Keeps each Inngest
// invocation bounded for huge portals (huge = many thousands of records).
const MAX_PAGES_PER_RUN = 50

/**
 * Load the crm_sync_state row for an account. Returns null when absent (the
 * incremental function treats that as a no-op; the initial import re-creates
 * it upstream via the OAuth callback / cron self-heal).
 */
async function loadSyncState(
  supabase: ReturnType<typeof getServiceClient>,
  accountId: string,
) {
  const { data } = await supabase
    .from('crm_sync_state')
    .select('*')
    .eq('account_id', accountId)
    .maybeSingle()
  return data as Record<string, unknown> | null
}

// =====================================================================
// Function 1: Initial import (backfill) — companies then contacts
// =====================================================================

export const hubspotInitialImport = inngest.createFunction(
  {
    id: 'hubspot-initial-import',
    retries: 3,
    // Per-account keyed concurrency: at most one run per account at a time, so a
    // slow self-chaining import can never overlap the next invocation for the
    // same account and race its crm_sync_state read-modify-writes (cursors,
    // counters). Different accounts still run in parallel. (Repo precedent:
    // capture-ingest.ts keys concurrency on workspace_id.)
    concurrency: [{ limit: 1, key: 'event.data.accountId' }],
    triggers: [{ event: 'crm/hubspot-initial-import' }],
  },
  async ({ event, step }) => {
    const { userId, workspaceId, accountId } = event.data as HubspotEventData
    const supabase = getServiceClient()

    // Step 1: load state; short-circuit if already complete. Snapshot the
    // incremental watermark = now() BEFORE any listing so records modified
    // mid-backfill are re-caught by the first incremental run (the ordering
    // lesson from email-functions.ts:98-111).
    const state = await step.run('start-sync-state', async () => {
      const existing = await loadSyncState(supabase, accountId)
      if (existing?.initial_import_status === 'complete') {
        return { alreadyComplete: true as const }
      }

      // A continuation already in the contacts phase keeps that status: writing
      // 'importing_companies' here would make the NEXT self-chained run re-list
      // companies and restart contacts from scratch, looping forever on a big
      // portal.
      const patch: Record<string, unknown> = {
        initial_import_status:
          existing?.initial_import_status === 'importing_contacts'
            ? 'importing_contacts'
            : 'importing_companies',
      }
      // First invocation of a fresh (or re-kicked) import: stamp start time and
      // snapshot the watermark. On a self-chained continuation these are
      // already set, so don't reset them. A re-kick after a failure is a new
      // run: it re-stamps the start (the ledger keys each run on it, so the
      // new run is a new Activity row, not the failed one reopened).
      const fresh = !existing?.initial_import_started_at || existing?.initial_import_status === 'failed'
      const startedAt = fresh
        ? new Date().toISOString()
        : (existing?.initial_import_started_at as string)
      if (fresh) {
        patch.initial_import_started_at = startedAt
      }
      if (!existing?.sync_watermark) {
        patch.sync_watermark = new Date().toISOString()
      }

      await supabase.from('crm_sync_state').update(patch).eq('account_id', accountId)

      // The import batch the pages go into: the one still staging (a
      // self-chained continuation), else a new one.
      let batch = await stagingBatchForAccount(supabase, accountId)
      if (!batch) {
        const { data: account } = await supabase.from('connected_account').select('account_email').eq('id', accountId).maybeSingle()
        const created = await createImportBatch(supabase, {
          workspaceId,
          userId,
          source: 'hubspot',
          label: (account as { account_email?: string } | null)?.account_email ?? null,
          accountId,
          notify: true,
        })
        if (!created.ok) throw new Error(created.error)
        batch = created.batch
      }

      return {
        alreadyComplete: false as const,
        fresh,
        startedAt,
        batchId: batch.id,
        companiesCursor: (existing?.companies_cursor as string | null) ?? null,
        contactsCursor: (existing?.contacts_cursor as string | null) ?? null,
        companiesDone: existing?.initial_import_status === 'importing_contacts',
        totalCompanies: (existing?.total_companies_synced as number | null) ?? 0,
        totalContacts: (existing?.total_contacts_synced as number | null) ?? 0,
      }
    })

    if (state.alreadyComplete) {
      return { status: 'already_complete' as const }
    }

    // The run's Activity row (src/lib/work/import-mirror.ts), found by its
    // start time on every self-chained invocation.
    const ledger = { accountId, workspaceId, userId, startedAt: state.startedAt }
    await step.run('ledger-open', () => openHubspotImport(supabase, ledger, state.fresh))

    // Resolve the token once per invocation. Null → mark failed and stop
    // (don't throw forever; the cron self-heals a failed import later).
    const tokenResult = await step.run('resolve-token', async () => {
      const result = await getValidTokenForAccount(accountId)
      return result ? { token: result.token } : null
    })

    if (!tokenResult) {
      await step.run('mark-failed-no-token', async () => {
        await supabase
          .from('crm_sync_state')
          .update({
            initial_import_status: 'failed',
            last_sync_error: 'No valid HubSpot token for account',
          })
          .eq('account_id', accountId)
        await failHubspotImport(supabase, ledger, 'No valid HubSpot token for this account — reconnect HubSpot')
      })
      return { status: 'failed' as const, reason: 'no_token' }
    }
    const token = tokenResult.token

    // Step 2: backfill companies (bounded page loop, resume-safe cursor).
    if (!state.companiesDone) {
      const companiesResult = await step.run('backfill-companies', async () => {
        return backfillPages(
          supabase,
          token,
          state.batchId,
          accountId,
          'companies',
          state.companiesCursor,
          state.totalCompanies,
        )
      })

      await step.run('ledger-companies', () =>
        stepHubspotImport(supabase, ledger, companiesResult.totalSynced, null),
      )

      if (companiesResult.moreRemaining) {
        // Persist status + re-fire self, then RETURN (bounded invocation).
        await step.sendEvent('continue-import-companies', {
          name: 'crm/hubspot-initial-import',
          data: { userId, workspaceId, accountId },
        })
        return { status: 'continued' as const, phase: 'companies' }
      }

      // Companies done → advance status to importing_contacts.
      await step.run('mark-importing-contacts', async () => {
        await supabase
          .from('crm_sync_state')
          .update({ initial_import_status: 'importing_contacts', companies_cursor: null })
          .eq('account_id', accountId)
      })
    }

    // Step 3: backfill contacts (associations=companies for company linking).
    const contactsResult = await step.run('backfill-contacts', async () => {
      const startCursor = state.companiesDone ? state.contactsCursor : null
      const startTotal = state.companiesDone ? state.totalContacts : 0
      return backfillPages(
        supabase,
        token,
        state.batchId,
        accountId,
        'contacts',
        startCursor,
        startTotal,
      )
    })

    const companiesTotal = state.companiesDone ? state.totalCompanies : await step.run('ledger-company-total', async () => {
      const current = await loadSyncState(supabase, accountId)
      return (current?.total_companies_synced as number | null) ?? 0
    })
    await step.run('ledger-contacts', () =>
      stepHubspotImport(supabase, ledger, companiesTotal, contactsResult.totalSynced),
    )

    if (contactsResult.moreRemaining) {
      await step.sendEvent('continue-import-contacts', {
        name: 'crm/hubspot-initial-import',
        data: { userId, workspaceId, accountId },
      })
      return { status: 'continued' as const, phase: 'contacts' }
    }

    // Step 4: finish — complete, clear cursors, stamp completion.
    await step.run('finish', async () => {
      await supabase
        .from('crm_sync_state')
        .update({
          initial_import_status: 'complete',
          initial_import_completed_at: new Date().toISOString(),
          companies_cursor: null,
          contacts_cursor: null,
          last_sync_at: new Date().toISOString(),
          last_sync_error: null,
        })
        .eq('account_id', accountId)
      await finishHubspotImport(supabase, ledger, companiesTotal, contactsResult.totalSynced)
    })

    // Every page is staged: the importer applies them and texts the summary.
    await step.sendEvent('apply-import', { name: CONTACT_IMPORT_APPLY, data: { batchId: state.batchId, workspaceId } })

    return {
      status: 'complete' as const,
      companies: contactsResult.totalSynced,
    }
  },
)

/**
 * List + stage up to MAX_PAGES_PER_RUN pages of an object type into the
 * import batch, persisting the cursor + running total after EVERY page so a
 * crash/retry resumes where it left off. Returns whether more pages remain
 * (the caller self-chains) and the running total.
 */
async function backfillPages(
  supabase: ReturnType<typeof getServiceClient>,
  token: string,
  batchId: string,
  accountId: string,
  objectType: 'companies' | 'contacts',
  startCursor: string | null,
  startTotal: number,
): Promise<{ moreRemaining: boolean; totalSynced: number }> {
  const cursorColumn = objectType === 'companies' ? 'companies_cursor' : 'contacts_cursor'
  const totalColumn = objectType === 'companies' ? 'total_companies_synced' : 'total_contacts_synced'
  const properties = objectType === 'companies' ? COMPANY_PROPERTIES : CONTACT_PROPERTIES

  let after = startCursor ?? undefined
  let total = startTotal

  for (let page = 0; page < MAX_PAGES_PER_RUN; page++) {
    const listing = await listObjects(token, objectType, {
      after,
      properties,
      limit: 100,
      associations: objectType === 'contacts' ? ['companies'] : undefined,
    })

    const batch = await loadImportBatch(supabase, batchId)
    if (!batch) throw new Error(`import batch ${batchId} is gone`)
    await stageRecords(supabase, batch, hubspotPageToRecords(objectType, listing.results as HubspotObject[]))
    total += listing.results.length

    const nextAfter = listing.paging?.next?.after ?? null

    // Persist progress after EVERY page (resume-safe).
    await supabase
      .from('crm_sync_state')
      .update({ [cursorColumn]: nextAfter, [totalColumn]: total })
      .eq('account_id', accountId)

    if (!nextAfter) {
      return { moreRemaining: false, totalSynced: total }
    }
    after = nextAfter
  }

  // Hit the per-invocation page bound with pages still remaining.
  return { moreRemaining: true, totalSynced: total }
}

// =====================================================================
// Function 2: Incremental sync — search since watermark, advance monotonically
// =====================================================================

export const hubspotIncrementalSync = inngest.createFunction(
  {
    id: 'hubspot-incremental-sync',
    retries: 3,
    debounce: { key: 'event.data.accountId', period: '30s' },
    // Per-account keyed concurrency: debounce only coalesces bursts, it is NOT
    // mutual exclusion — a slow run can still overlap the next cron tick for the
    // same account and clobber sync_watermark / counters. Limit 1 per account
    // serializes those read-modify-writes; different accounts stay parallel.
    concurrency: [{ limit: 1, key: 'event.data.accountId' }],
    triggers: [{ event: 'crm/hubspot-incremental-sync' }],
  },
  async ({ event, step }) => {
    const { workspaceId, accountId } = event.data as HubspotEventData
    const supabase = getServiceClient()

    // Guard: incremental requires a completed initial import AND a watermark.
    // Otherwise no-op — the cron re-fires the initial import to self-heal.
    const guard = await step.run('load-state', async () => {
      const state = await loadSyncState(supabase, accountId)
      if (!state) return { ok: false as const, reason: 'no_state' }
      if (state.initial_import_status !== 'complete') {
        return { ok: false as const, reason: 'import_incomplete' }
      }
      if (!state.sync_watermark) return { ok: false as const, reason: 'no_watermark' }
      return {
        ok: true as const,
        watermark: state.sync_watermark as string,
      }
    })

    if (!guard.ok) {
      return { status: 'skipped' as const, reason: guard.reason }
    }

    const tokenResult = await step.run('resolve-token', async () => {
      const result = await getValidTokenForAccount(accountId)
      return result ? { token: result.token } : null
    })
    if (!tokenResult) {
      await step.run('record-token-error', async () => {
        await supabase
          .from('crm_sync_state')
          .update({ last_sync_error: 'No valid HubSpot token for account' })
          .eq('account_id', accountId)
      })
      return { status: 'skipped' as const, reason: 'no_token' }
    }
    const token = tokenResult.token
    const sinceMs = Date.parse(guard.watermark)

    // Companies then contacts: search since watermark, upsert pages, track the
    // max hs_lastmodifieddate. advanceSearchWatermark handles the 10k re-anchor.
    const result = await step.run('sync-since-watermark', async () => {
      let maxSeen = Number.isNaN(sinceMs) ? 0 : sinceMs
      let companies = 0
      let contacts = 0

      try {
        const companiesRun = await advanceSearchWatermark(token, 'companies', {
          since: Number.isNaN(sinceMs) ? 0 : sinceMs,
          properties: COMPANY_PROPERTIES,
          onPage: async (results: HubspotObject[]) => {
            for (const obj of results) {
              await upsertHubspotCompany(supabase, workspaceId, obj)
            }
          },
        })
        companies = companiesRun.totalSeen
        if (companiesRun.watermark > maxSeen) maxSeen = companiesRun.watermark

        const contactsRun = await advanceSearchWatermark(token, 'contacts', {
          since: Number.isNaN(sinceMs) ? 0 : sinceMs,
          properties: CONTACT_PROPERTIES,
          onPage: async (results: HubspotObject[]) => {
            for (const obj of results) {
              await upsertHubspotContact(supabase, workspaceId, obj)
            }
          },
        })
        contacts = contactsRun.totalSeen
        if (contactsRun.watermark > maxSeen) maxSeen = contactsRun.watermark
      } catch (err) {
        // Record the error, then rethrow so Inngest retries.
        await supabase
          .from('crm_sync_state')
          .update({ last_sync_error: err instanceof Error ? err.message : String(err) })
          .eq('account_id', accountId)
        throw err
      }

      return { maxSeen, companies, contacts }
    })

    // Persist the advanced watermark + counters + last_sync_at.
    //
    // The watermark write is done SEPARATELY and CONDITIONALLY so it can only
    // move forward at the row level: `.lt('sync_watermark', next)` makes the
    // UPDATE a no-op when the stored watermark is already >= the new value.
    // Per-account keyed concurrency now serializes runs for one account, but the
    // conditional keeps the monotonic invariant even if that config is ever
    // relaxed (belt-and-suspenders — the DB, not just the scheduler, guards it).
    // Counters + last_sync_at are always written; their read-modify-write relies
    // on the single-writer-per-account guarantee from keyed concurrency.
    await step.run('persist-watermark', async () => {
      const state = await loadSyncState(supabase, accountId)

      // Always-write fields: timestamp, clear the error, accumulate counters.
      const prevCompanies = (state?.total_companies_synced as number | null) ?? 0
      const prevContacts = (state?.total_contacts_synced as number | null) ?? 0
      await supabase
        .from('crm_sync_state')
        .update({
          last_sync_at: new Date().toISOString(),
          last_sync_error: null,
          total_companies_synced: prevCompanies + result.companies,
          total_contacts_synced: prevContacts + result.contacts,
        })
        .eq('account_id', accountId)

      // Conditional watermark advance (only when we actually saw something new).
      if (result.maxSeen > 0) {
        const nextIso = new Date(result.maxSeen).toISOString()
        const hasStored = !!state?.sync_watermark
        let query = supabase
          .from('crm_sync_state')
          .update({ sync_watermark: nextIso })
          .eq('account_id', accountId)
        // A stored watermark: only overwrite when strictly older (monotonic).
        // No stored watermark yet (NULL): `.lt` would never match a NULL, so
        // seed it unconditionally on the first advance.
        if (hasStored) query = query.lt('sync_watermark', nextIso)
        await query
      }
    })

    return {
      status: 'synced' as const,
      companies: result.companies,
      contacts: result.contacts,
    }
  },
)
