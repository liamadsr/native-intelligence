/**
 * Starting one person-asked contact enrichment: the ONE path both senders
 * take, so the Enrich button and the chat can't drift.
 *
 *   - the Enrich button: POST /api/account/contacts/[id]/enrich, on the
 *     person's own (RLS) client;
 *   - the chat's `enrich_contact` tool (src/lib/ai/tools/enrich-contact.ts),
 *     after the person said yes, on the tool's client (service role on the eve
 *     proxies and MCP), with the visibility fence done by the tool first.
 *
 * Steps, in order: read the row in the workspace (the SELECT is the ownership
 * check on an RLS client); refuse a permanently-failed row (those failures
 * reproduce identically, so a retry only pays to reach the same dead end);
 * CLAIM it, `enrichment_status = 'pending'` only where it isn't pending yet,
 * so a click and a chat yes at the same moment start one paid run, not two
 * (the loser gets 'already_running'); open the click's Activity row
 * (enrichment-mirror.ts, fail-soft: no row, no key); send
 * `crm/enrich-contact.manual`. When the send throws, nothing will run, so the
 * Activity row is settled failed rather than left queued for the reaper, and
 * the error is rethrown to the caller.
 *
 * A row that is already enriched is NOT refused: re-running is a refresh, and
 * it is safe because the column write-back is fill-empty only.
 *
 * A row already pending is running, unless no Activity row for it is still
 * queued or running: then the run it was marked for never happened (a lost
 * event, a refused run), and it is put back to its last outcome first so the
 * claim can take it. Without that it would be stuck: the button is disabled on
 * a pending row, and nothing else re-admits it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getServiceClient } from '@/lib/admin'
import { inngest } from '@/lib/inngest/client'
import { hasPermanentFailure, lastEnrichmentOutcome } from '@/lib/crm/enrichment'
import { openManualEnrichment, settleManualEnrichment } from '@/lib/work/enrichment-mirror'
import { WORK_KINDS } from '@/lib/work/types'

/** The error code a permanently-failed contact is refused with (the route's 409). */
export const ENRICHMENT_PERMANENTLY_FAILED = 'ENRICHMENT_PERMANENTLY_FAILED'

export const PERMANENT_FAILURE_MESSAGE =
  'This contact previously failed enrichment in a way that will not succeed on retry.'

/** The contact as it stood when the run was asked for. */
export interface EnrichContactRow {
  id: string
  full_name: string | null
  email: string | null
  metadata: unknown
}

export type StartContactEnrichmentResult =
  | { ok: true; contact: EnrichContactRow; workRunKey: string | null }
  | { ok: false; reason: 'not_found' }
  /** Another request holds the row: its run's key when its Activity row is known. */
  | { ok: false; reason: 'already_running'; workRunKey: string | null }
  | { ok: false; reason: 'permanent_failure'; code: typeof ENRICHMENT_PERMANENTLY_FAILED; error: string }
  | { ok: false; reason: 'db_error'; error: string }

/**
 * Queue one manual enrichment of `contactId` in `workspaceId`, asked for by
 * `userId`. Throws only when the event send throws (after settling the
 * Activity row); every other outcome is a returned result.
 */
export async function startContactEnrichment(
  supabase: SupabaseClient,
  args: { contactId: string; workspaceId: string; userId: string },
): Promise<StartContactEnrichmentResult> {
  const { contactId, workspaceId, userId } = args

  const { data: contact, error } = await supabase
    .from('contact')
    .select('id, metadata, full_name, email, enrichment_status')
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (error) return { ok: false, reason: 'db_error', error: error.message }
  if (!contact) return { ok: false, reason: 'not_found' }

  if (hasPermanentFailure(contact.metadata)) {
    return { ok: false, reason: 'permanent_failure', code: ENRICHMENT_PERMANENTLY_FAILED, error: PERMANENT_FAILURE_MESSAGE }
  }

  if (contact.enrichment_status === 'pending') {
    const live = await liveEnrichmentRunKey(workspaceId, contactId)
    if (live) return { ok: false, reason: 'already_running', workRunKey: live }
    // Marked for a run that never happened: back to its last outcome.
    const { error: releaseErr } = await supabase
      .from('contact')
      .update({ enrichment_status: lastEnrichmentOutcome(contact.metadata) })
      .eq('id', contactId)
      .eq('workspace_id', workspaceId)
      .eq('enrichment_status', 'pending')
    if (releaseErr) return { ok: false, reason: 'db_error', error: releaseErr.message }
  }

  const { data: claimed, error: markErr } = await supabase
    .from('contact')
    .update({ enrichment_status: 'pending' })
    .eq('id', contactId)
    .eq('workspace_id', workspaceId)
    .or('enrichment_status.is.null,enrichment_status.neq.pending')
    .select('id')
  if (markErr) return { ok: false, reason: 'db_error', error: markErr.message }
  // Zero rows: another request claimed it between the read and here.
  if (!claimed || claimed.length === 0) {
    return { ok: false, reason: 'already_running', workRunKey: await liveEnrichmentRunKey(workspaceId, contactId) }
  }

  const row = contact as EnrichContactRow

  // The Activity row for this request (owned by the person asking); the
  // handler settles it by the run key the event carries. Fail-soft: no row, no key.
  const workRunKey = await openManualEnrichment(getServiceClient(), {
    workspaceId,
    userId,
    table: 'contact',
    recordId: contactId,
    name: row.full_name || row.email,
  })

  try {
    await inngest.send({
      name: 'crm/enrich-contact.manual',
      // `allowSelf` lifts the self-contact skip the lib applies to every other
      // caller: a person asking for a teammate's (or their own) card is asking
      // for that row specifically.
      data: { contactId, workspaceId, userId, allowSelf: true, workRunKey },
    })
  } catch (err) {
    // Nothing will run for this request: settle its row rather than leave it
    // queued for the reaper.
    await settleManualEnrichment(
      getServiceClient(),
      workRunKey,
      { status: 'failed', error: 'The search could not be queued' },
      { workspaceId, table: 'contact', recordId: contactId },
    )
    throw err
  }

  return { ok: true, contact: row, workRunKey }
}

/**
 * The run key of an enrichment of this contact whose Activity row is still
 * queued or running, or null. The reaper fails a live row after
 * MANUAL_RUNNING_DEADLINE_MS, so a stuck one does not hold the contact for
 * long. Service client (the ledger is not the caller's to read). Never throws.
 */
export async function liveEnrichmentRunKey(workspaceId: string, contactId: string): Promise<string | null> {
  try {
    const { data } = await getServiceClient()
      .from('tracked_job')
      .select('run_key')
      .eq('workspace_id', workspaceId)
      .eq('kind', WORK_KINDS.crmEnrichment)
      .in('status', ['queued', 'running'])
      .eq('source->>record_id', contactId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const runKey = (data as { run_key?: unknown } | null)?.run_key
    return typeof runKey === 'string' && runKey ? runKey : null
  } catch {
    return null
  }
}

/**
 * Give a row marked 'pending' back its last outcome (lastEnrichmentOutcome),
 * when the run it was marked for won't happen: the usage guard refused it.
 * Only while it is still pending, so a run that did write its outcome is never
 * undone. Service client, either table. Never throws.
 */
export async function releasePendingEnrichment(
  supabase: SupabaseClient,
  args: { table: 'contact' | 'company'; id: string; workspaceId: string },
): Promise<void> {
  try {
    const { data } = await supabase
      .from(args.table)
      .select('metadata')
      .eq('id', args.id)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    await supabase
      .from(args.table)
      .update({ enrichment_status: lastEnrichmentOutcome((data as { metadata?: unknown } | null)?.metadata) })
      .eq('id', args.id)
      .eq('workspace_id', args.workspaceId)
      .eq('enrichment_status', 'pending')
  } catch (err) {
    console.warn('[crm-enrichment] pending release failed:', err instanceof Error ? err.message : err)
  }
}
