/**
 * The end of an import (roadmap track G): the batch is marked done with its
 * summary (./summary.ts), and the owner is told once, in their home thread
 * and by text from their agent: "412 customers imported from HubSpot: 37
 * matched ones you had, 3 to check." An import the agent ran inside its own
 * reply (`notify` false) is not told twice: the agent's reply says it.
 *
 * The claim on `notified_at` makes the message once-only across retries.
 * Never throws for the telling: a text that can't go is a no-op.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { appendHomeMessage } from '@/lib/chat/home-message-writer'
import { textPerson } from '@/lib/chat/text-turn-server'
import { loadImportBatch, type ImportBatch } from './batch'
import { importSummaryText, undoSummaryText } from './summary'

type Db = SupabaseClient

/** Seams for the tests. */
export interface ImportNotifyDeps {
  appendHome?: typeof appendHomeMessage
  text?: (db: Db, args: { userId: string; workspaceId: string; body: string }) => Promise<{ sent: boolean }>
}

/** Tell the owner, once per `key`: their home thread and a text. */
export async function tellOwner(db: Db, batch: ImportBatch, body: string, key: string, deps: ImportNotifyDeps = {}): Promise<{ texted: boolean }> {
  try {
    await (deps.appendHome ?? appendHomeMessage)(db, {
      userId: batch.user_id,
      workspaceId: batch.workspace_id,
      parts: [{ type: 'text', text: body }],
      messageId: key,
      metadata: { kind: 'contact_import', batch_id: batch.id, source: batch.source },
    })
    const sent = await (deps.text ?? ((client, args) => textPerson(client, { ...args, kind: 'notice' })))(db, { userId: batch.user_id, workspaceId: batch.workspace_id, body })
    return { texted: sent.sent }
  } catch (err) {
    console.warn('[contact-import] telling the owner failed:', err instanceof Error ? err.message : err)
    return { texted: false }
  }
}

/**
 * Finish a batch whose items are all applied: status 'done', the summary
 * saved, and (when the batch notifies) the owner told. Idempotent: a second
 * call on a done batch only retries an untold notice.
 */
export async function finishImportBatch(db: Db, batchId: string, deps: ImportNotifyDeps = {}): Promise<{ summary: string | null; texted: boolean }> {
  const batch = await loadImportBatch(db, batchId)
  if (!batch) return { summary: null, texted: false }
  let summary = batch.summary
  if (batch.status === 'staging' || batch.status === 'running') {
    summary = importSummaryText({ source: batch.source, counts: batch.counts, label: batch.label })
    await db.from('contact_import_batch').update({ status: 'done', summary, finished_at: new Date().toISOString() }).eq('id', batch.id)
  }
  if (!summary || !batch.notify || batch.notified_at || batch.status === 'undoing' || batch.status === 'undone') return { summary, texted: false }
  const { data: claimed } = await db.from('contact_import_batch').update({ notified_at: new Date().toISOString() }).eq('id', batch.id).is('notified_at', null).select('id')
  if (!Array.isArray(claimed) || claimed.length === 0) return { summary, texted: false }
  const told = await tellOwner(db, batch, summary, `contact-import-${batch.id}`, deps)
  return { summary, texted: told.texted }
}

/** Tell the owner an undo finished (a background undo; an inline one is the agent's reply). */
export async function tellUndo(db: Db, batch: ImportBatch, tallies: { removed: number; restored: number; kept: number }, deps: ImportNotifyDeps = {}): Promise<{ texted: boolean }> {
  const body = undoSummaryText({ source: batch.source, label: batch.label, ...tallies })
  return tellOwner(db, batch, body, `contact-import-undo-${batch.id}`, deps)
}
