import { inngest } from './client'
import { getServiceClient } from '@/lib/admin'
import { getValidTokenForAccount } from '@/lib/oauth/token-manager'
import { applyPendingItems, failImportBatch, loadImportBatch, stageRecords } from '@/lib/crm/import/batch'
import { finishImportBatch, tellOwner, tellUndo } from '@/lib/crm/import/finish'
import { CONTACT_IMPORT_APPLY, CONTACT_IMPORT_BREVO, CONTACT_IMPORT_GOOGLE, CONTACT_IMPORT_STRIPE, CONTACT_IMPORT_UNDO, type ContactImportEventData } from '@/lib/crm/import/run'
import { finishUndo, undoImportItems } from '@/lib/crm/import/undo'
import { googlePersonToRecord, listGoogleConnections, listGoogleContactGroups } from '@/lib/crm/import/sources/google-contacts'
import {
  brevoCompanyToRecord,
  brevoContactToRecord,
  brevoCrmIndex,
  listBrevoCompanies,
  listBrevoContacts,
  listBrevoDeals,
  listBrevoLists,
  BREVO_CONTACTS_PAGE,
  type BrevoCompany,
  type BrevoCrmIndex,
  type BrevoDeal,
} from '@/lib/crm/import/sources/brevo'
import type { ImportPastJob } from '@/lib/crm/import/record'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { listStripeCustomers, readStripePayments, stripeCustomerToRecord, stripeGuestToRecord, type StripePayments } from '@/lib/crm/import/sources/stripe'

// =====================================================================
// Bringing existing customers in (roadmap track G, docs/plans/customer-import.md)
// =====================================================================
//
//   apply    a staged batch's items, a chunk per step, then the summary and
//            the owner's text. One batch per workspace at a time (the dedupe
//            reads what the batch before it wrote).
//   undo     a batch taken back, a chunk per step, then a text.
//   google   Google Contacts, read page by page into a batch, then apply.
//   brevo    Brevo's lists, companies, deals and contacts, then apply.
//   stripe   a connected Stripe account's payments, its customers page by
//            page with theirs, then the guests who paid without one; then
//            apply (roadmap #10).
//
// Every step is idempotent: an applied item is no longer pending, an undone
// one is stamped, a staged page is staged after the batch's last item (a
// retried page stages again, and the importer folds the repeats).

/**
 * One import job per workspace at a time, across all four functions: they
 * share one key (scope env), so an apply, an undo and a source read never
 * dedupe against each other's half-written contacts. (An inline import in the
 * agent's own call goes to the background instead when one is running:
 * src/lib/crm/import/run.ts.)
 */
const IMPORT_CONCURRENCY: [{ limit: number; key: string; scope: 'env' }] = [{ limit: 1, key: '"contact-import:" + event.data.workspaceId', scope: 'env' }]

/**
 * After every retry failed: the batch is marked failed (so undo can take back
 * what it wrote, and a reconnect can import again) and the owner is told once.
 * An undo that failed stays `undoing`: "undo import" again resumes it.
 */
async function importOnFailure({ event, error }: { event: { data?: { event?: { data?: unknown } | null } | null }; error: { message?: string } | null }) {
  const original = event?.data?.event?.data as Partial<ContactImportEventData> | null
  if (!original?.batchId) return { skipped: 'missing_ids' }
  const supabase = getServiceClient()
  const batch = await loadImportBatch(supabase, original.batchId)
  if (!batch) return { skipped: 'no_batch' }
  if (batch.status === 'undoing') {
    await tellOwner(supabase, batch, 'I couldn\'t finish undoing that import. Text "undo import" again and I\'ll pick up where it stopped.', `contact-import-undo-failed-${batch.id}`)
    return { undo: 'left_resumable' }
  }
  if (batch.status !== 'staging' && batch.status !== 'running') return { skipped: batch.status }
  await failImportBatch(supabase, batch.id, error?.message ?? 'import failed')
  const { data: claimed } = await supabase.from('contact_import_batch').update({ notified_at: new Date().toISOString() }).eq('id', batch.id).is('notified_at', null).select('id')
  if (Array.isArray(claimed) && claimed.length > 0) {
    await tellOwner(supabase, batch, 'Your contacts import stopped partway. What came in is still there (text "undo import" to take it back), or send it again to try once more.', `contact-import-failed-${batch.id}`)
  }
  return { failed: true }
}

/** Chunks one invocation applies or undoes before handing on to a fresh one. */
const CHUNKS_PER_RUN = 25
/** Pages one source invocation reads (Google: 1000 a page; Brevo: 1000). */
const MAX_PAGES = 50

export const contactImportApply = inngest.createFunction(
  {
    id: 'contact-import-apply',
    retries: 3,
    concurrency: IMPORT_CONCURRENCY,
    onFailure: (ctx: unknown) => importOnFailure(ctx as Parameters<typeof importOnFailure>[0]),
    triggers: [{ event: CONTACT_IMPORT_APPLY }],
  },
  async ({ event, step }) => {
    const { batchId, workspaceId } = event.data as ContactImportEventData
    const supabase = getServiceClient()
    for (let i = 0; i < CHUNKS_PER_RUN; i++) {
      const { remaining } = await step.run(`apply-${i}`, () => applyPendingItems(supabase, batchId))
      if (!remaining) {
        const finished = await step.run('finish', () => finishImportBatch(supabase, batchId))
        return { status: 'done' as const, summary: finished.summary }
      }
    }
    await step.sendEvent('continue-apply', { name: CONTACT_IMPORT_APPLY, data: { batchId, workspaceId } })
    return { status: 'continued' as const }
  },
)

export const contactImportUndo = inngest.createFunction(
  {
    id: 'contact-import-undo',
    retries: 3,
    concurrency: IMPORT_CONCURRENCY,
    onFailure: (ctx: unknown) => importOnFailure(ctx as Parameters<typeof importOnFailure>[0]),
    triggers: [{ event: CONTACT_IMPORT_UNDO }],
  },
  async ({ event, step }) => {
    const { batchId, workspaceId } = event.data as ContactImportEventData
    const supabase = getServiceClient()
    for (let i = 0; i < CHUNKS_PER_RUN; i++) {
      const { remaining } = await step.run(`undo-${i}`, () => undoImportItems(supabase, batchId))
      if (!remaining) {
        await step.run('finish-undo', async () => {
          const { batch, tallies, transitioned } = await finishUndo(supabase, batchId)
          if (batch && transitioned) await tellUndo(supabase, batch, tallies)
        })
        return { status: 'undone' as const }
      }
    }
    await step.sendEvent('continue-undo', { name: CONTACT_IMPORT_UNDO, data: { batchId, workspaceId } })
    return { status: 'continued' as const }
  },
)

/** A source that can't be read: the batch fails and the owner hears how to try again, once. */
async function sourceFailed(supabase: ReturnType<typeof getServiceClient>, batchId: string, error: string, tryAgain: string) {
  await failImportBatch(supabase, batchId, error)
  const { data: claimed } = await supabase.from('contact_import_batch').update({ notified_at: new Date().toISOString() }).eq('id', batchId).is('notified_at', null).select('id')
  if (!Array.isArray(claimed) || claimed.length === 0) return
  const batch = await loadImportBatch(supabase, batchId)
  if (batch) await tellOwner(supabase, batch, `I couldn't read your contacts just now. ${tryAgain}`, `contact-import-failed-${batchId}`)
}

export const contactImportGoogle = inngest.createFunction(
  {
    id: 'contact-import-google-contacts',
    retries: 3,
    concurrency: IMPORT_CONCURRENCY,
    onFailure: (ctx: unknown) => importOnFailure(ctx as Parameters<typeof importOnFailure>[0]),
    triggers: [{ event: CONTACT_IMPORT_GOOGLE }],
  },
  async ({ event, step }) => {
    const { batchId, workspaceId } = event.data as ContactImportEventData
    const supabase = getServiceClient()
    const batch = await step.run('load', () => loadImportBatch(supabase, batchId))
    if (!batch || batch.status !== 'staging' || !batch.account_id) return { status: 'skipped' as const }
    const accountId = batch.account_id

    const token = await step.run('token', async () => (await getValidTokenForAccount(accountId))?.token ?? null)
    if (!token) {
      await step.run('fail-no-token', () => sourceFailed(supabase, batchId, 'No valid Google token for this account', 'Text me "connect Google Contacts" for a new link.'))
      return { status: 'failed' as const }
    }
    const groups = await step.run('groups', () => listGoogleContactGroups(token).catch(() => ({}) as Record<string, string>))

    let pageToken: string | null = null
    for (let page = 0; page < MAX_PAGES; page++) {
      const result: { next: string | null } | { error: string } = await step.run(`page-${page}`, async () => {
        try {
          const { people, nextPageToken } = await listGoogleConnections(token, pageToken)
          await stageRecords(supabase, (await loadImportBatch(supabase, batchId))!, people.map((p) => googlePersonToRecord(p, groups)))
          return { next: nextPageToken }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      })
      if ('error' in result) {
        await step.run('fail-read', () => sourceFailed(supabase, batchId, result.error, 'Text me "connect Google Contacts" to try again.'))
        return { status: 'failed' as const }
      }
      pageToken = result.next
      if (!pageToken) break
    }

    await step.sendEvent('apply', { name: CONTACT_IMPORT_APPLY, data: { batchId, workspaceId } })
    return { status: 'staged' as const }
  },
)

export const contactImportBrevo = inngest.createFunction(
  {
    id: 'contact-import-brevo',
    retries: 3,
    concurrency: IMPORT_CONCURRENCY,
    onFailure: (ctx: unknown) => importOnFailure(ctx as Parameters<typeof importOnFailure>[0]),
    triggers: [{ event: CONTACT_IMPORT_BREVO }],
  },
  async ({ event, step }) => {
    const { batchId, workspaceId } = event.data as ContactImportEventData
    const supabase = getServiceClient()
    const batch = await step.run('load', () => loadImportBatch(supabase, batchId))
    if (!batch || batch.status !== 'staging' || !batch.account_id) return { status: 'skipped' as const }
    const accountId = batch.account_id

    const token = await step.run('token', async () => (await getValidTokenForAccount(accountId))?.token ?? null)
    if (!token) {
      await step.run('fail-no-token', () => sourceFailed(supabase, batchId, 'No valid Brevo token for this account', 'Text me "connect Brevo" for a new link.'))
      return { status: 'failed' as const }
    }

    // The CRM first: companies become records of their own, and each contact's
    // company and won deals ride on its record. Lists name the tags.
    // The step returns only what the contacts need (each contact's company and
    // won deals), never the raw lists: a step's output has a size limit.
    const crm = await step.run('crm', async () => {
      const [lists, companies, deals] = await Promise.all([
        listBrevoLists(token).catch(() => ({}) as Record<number, string>),
        listBrevoCompanies(token).catch(() => [] as BrevoCompany[]),
        listBrevoDeals(token).catch(() => [] as BrevoDeal[]),
      ])
      await stageRecords(supabase, (await loadImportBatch(supabase, batchId))!, companies.map(brevoCompanyToRecord))
      const index = brevoCrmIndex(companies, deals)
      return { lists, companyByContact: [...index.companyByContact], jobsByContact: [...index.jobsByContact] }
    })
    const index: BrevoCrmIndex = { companyByContact: new Map(crm.companyByContact), jobsByContact: new Map(crm.jobsByContact as Array<[number, ImportPastJob[]]>) }

    for (let page = 0; page < MAX_PAGES; page++) {
      const result: { more: boolean } | { error: string } = await step.run(`contacts-${page}`, async () => {
        try {
          const { contacts, more } = await listBrevoContacts(token, page * BREVO_CONTACTS_PAGE)
          await stageRecords(supabase, (await loadImportBatch(supabase, batchId))!, contacts.map((c) => brevoContactToRecord(c, crm.lists, index)))
          return { more }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      })
      if ('error' in result) {
        await step.run('fail-read', () => sourceFailed(supabase, batchId, result.error, 'Text me "connect Brevo" to try again.'))
        return { status: 'failed' as const }
      }
      if (!result.more) break
    }

    await step.sendEvent('apply', { name: CONTACT_IMPORT_APPLY, data: { batchId, workspaceId } })
    return { status: 'staged' as const }
  },
)

/** Customer pages one Stripe import reads (100 a page). */
const MAX_STRIPE_PAGES = 100

export const contactImportStripe = inngest.createFunction(
  {
    id: 'contact-import-stripe',
    retries: 3,
    concurrency: IMPORT_CONCURRENCY,
    onFailure: (ctx: unknown) => importOnFailure(ctx as Parameters<typeof importOnFailure>[0]),
    triggers: [{ event: CONTACT_IMPORT_STRIPE }],
  },
  async ({ event, step }) => {
    const { batchId, workspaceId } = event.data as ContactImportEventData
    const supabase = getServiceClient()
    const batch = await step.run('load', () => loadImportBatch(supabase, batchId))
    if (!batch || batch.status !== 'staging' || batch.source !== 'stripe') return { status: 'skipped' as const }

    const stripeAccount = await step.run('account', async () => {
      const account = await getConnectedAccount(supabase, workspaceId)
      return account && account.status !== 'disconnected' ? account.stripeAccountId : null
    })
    if (!stripeAccount) {
      await step.run('fail-not-connected', () => sourceFailed(supabase, batchId, 'Stripe is not connected', 'Connect Stripe again, then ask me to import your Stripe customers.'))
      return { status: 'failed' as const }
    }
    // Loaded on use, like the payments tools: the Stripe SDK stays out of the other functions' path.
    const stripe = async () => (await import('@/lib/stripe')).getStripe()

    // Payments first: each customer's ride on its record. The step returns only what the records need.
    const payments: StripePayments | { error: string } = await step.run('payments', async () => {
      try {
        return await readStripePayments(await stripe(), stripeAccount)
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) }
      }
    })
    if ('error' in payments) {
      await step.run('fail-payments', () => sourceFailed(supabase, batchId, payments.error, 'Ask me to import your Stripe customers again in a bit.'))
      return { status: 'failed' as const }
    }
    const jobsByCustomer = new Map(payments.byCustomer)

    let cursor: string | null = null
    for (let page = 0; page < MAX_STRIPE_PAGES; page++) {
      const result: { next: string | null } | { error: string } = await step.run(`customers-${page}`, async () => {
        try {
          const { customers, next } = await listStripeCustomers(await stripe(), stripeAccount, cursor)
          await stageRecords(supabase, (await loadImportBatch(supabase, batchId))!, customers.map((c) => stripeCustomerToRecord(c, jobsByCustomer.get(c.id) ?? [], { allPaymentsRead: !payments.truncated })))
          return { next }
        } catch (err) {
          return { error: err instanceof Error ? err.message : String(err) }
        }
      })
      if ('error' in result) {
        await step.run('fail-read', () => sourceFailed(supabase, batchId, result.error, 'Ask me to import your Stripe customers again in a bit.'))
        return { status: 'failed' as const }
      }
      cursor = result.next
      if (!cursor) break
    }
    // After the customers: a guest who is also a customer folds into them.
    if (payments.guests.length) await step.run('guests', async () => stageRecords(supabase, (await loadImportBatch(supabase, batchId))!, payments.guests.map(stripeGuestToRecord)))

    await step.sendEvent('apply', { name: CONTACT_IMPORT_APPLY, data: { batchId, workspaceId } })
    return { status: 'staged' as const }
  },
)
