/**
 * The first import from a connected account (roadmap tracks G2 and G4):
 * when Google Contacts or Brevo connects (src/lib/oauth/complete-connect.ts),
 * a batch is opened for the account and the source's Inngest function reads
 * it page by page into the importer (src/lib/inngest/contact-import-functions.ts).
 * Once per account: a reconnect (a refreshed sign-in) never imports again,
 * unless that import failed or was undone. HubSpot's first import runs from its own
 * initial sync (src/lib/inngest/hubspot-functions.ts), into the same importer.
 *
 * Stripe (roadmap #10) is connected for payments, not for its customers, so
 * its import runs when the owner asks ({@link startStripeImport}), through the
 * account payments already connected: no sign-in of its own.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { getConnectedAccount } from '@/lib/payments/accounts'
import { createImportBatch } from './batch'
import type { ImportSource } from './record'
import { CONTACT_IMPORT_BREVO, CONTACT_IMPORT_GOOGLE, CONTACT_IMPORT_STRIPE, type ContactImportEventData } from './run'

type Db = SupabaseClient

export type ConnectedImportProvider = 'google' | 'brevo'

const SOURCE: Record<ConnectedImportProvider, ImportSource> = { google: 'google_contacts', brevo: 'brevo' }
const EVENT: Record<ConnectedImportProvider, string> = { google: CONTACT_IMPORT_GOOGLE, brevo: CONTACT_IMPORT_BREVO }

/** Seams for the tests. */
export interface ConnectedImportDeps {
  send?: (event: { name: string; data: ContactImportEventData }) => Promise<unknown>
}

/** Open the account's first import and start reading it. Returns the batch id, or null when it already has one. */
export async function startConnectedImport(
  db: Db,
  args: { provider: ConnectedImportProvider; userId: string; workspaceId: string; accountId: string; accountEmail: string | null },
  deps: ConnectedImportDeps = {},
): Promise<string | null> {
  // A failed or undone import doesn't count: reconnecting tries again.
  const { data: earlier } = await db.from('contact_import_batch').select('id, status').eq('account_id', args.accountId).in('status', ['staging', 'running', 'done', 'undoing']).limit(1)
  if (Array.isArray(earlier) && earlier.length > 0) return null
  const created = await createImportBatch(db, {
    workspaceId: args.workspaceId,
    userId: args.userId,
    source: SOURCE[args.provider],
    label: args.accountEmail,
    accountId: args.accountId,
    notify: true,
  })
  if (!created.ok) throw new Error(created.error)
  await (deps.send ?? ((event) => inngest.send(event)))({ name: EVENT[args.provider], data: { batchId: created.batch.id, workspaceId: args.workspaceId } })
  return created.batch.id
}

export type StartStripeImportResult = { ok: true; batchId: string; alreadyRunning: boolean } | { ok: false; error: string }

/**
 * Import the customers of the workspace's connected Stripe account: a batch
 * opened here, read and applied in the background
 * (src/lib/inngest/contact-import-functions.ts), the owner texted the summary.
 * Refused when Stripe isn't connected. While one is still reading or applying,
 * asking again returns that one.
 */
export async function startStripeImport(db: Db, args: { userId: string; workspaceId: string }, deps: ConnectedImportDeps = {}): Promise<StartStripeImportResult> {
  const account = await getConnectedAccount(db, args.workspaceId)
  if (!account || account.status === 'disconnected') {
    return {
      ok: false,
      error: 'Stripe is not connected here. They can export their customers from Stripe (Customers, then Export) and send you the file, or connect Stripe for payments and ask again.',
    }
  }
  const { data: running } = await db.from('contact_import_batch').select('id').eq('workspace_id', args.workspaceId).eq('source', 'stripe').in('status', ['staging', 'running']).limit(1)
  const current = Array.isArray(running) ? (running[0] as { id: string } | undefined) : undefined
  if (current) return { ok: true, batchId: current.id, alreadyRunning: true }
  const created = await createImportBatch(db, { workspaceId: args.workspaceId, userId: args.userId, source: 'stripe', label: null, notify: true })
  if (!created.ok) return { ok: false, error: created.error }
  await (deps.send ?? ((event) => inngest.send(event)))({ name: CONTACT_IMPORT_STRIPE, data: { batchId: created.batch.id, workspaceId: args.workspaceId } })
  return { ok: true, batchId: created.batch.id, alreadyRunning: false }
}
