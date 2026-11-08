/**
 * Running an import or an undo, inline or in the background (roadmap track G):
 * a small one (a texted spreadsheet of a few dozen customers) finishes inside
 * the agent's own call, and the agent's reply is the summary; a large one is
 * staged here and applied by Inngest (src/lib/inngest/contact-import-functions.ts),
 * which texts the summary when it ends.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { inngest } from '@/lib/inngest/client'
import { applyPendingItems, createImportBatch, INLINE_IMPORT_MAX, loadImportBatch, reviewItems, stageRecords, workspaceImportBusy, type ImportBatch } from './batch'
import { finishImportBatch } from './finish'
import type { ImportRecord, ImportSource } from './record'
import { importedPeople, undoSummaryText } from './summary'
import { finishUndo, startUndo, undoImportItems } from './undo'

type Db = SupabaseClient

/** Inngest events (names shared by the senders here and the functions). */
export const CONTACT_IMPORT_APPLY = 'crm/import.apply' as const
export const CONTACT_IMPORT_UNDO = 'crm/import.undo' as const
export const CONTACT_IMPORT_GOOGLE = 'crm/import.google-contacts' as const
export const CONTACT_IMPORT_BREVO = 'crm/import.brevo' as const
export const CONTACT_IMPORT_STRIPE = 'crm/import.stripe' as const

export interface ContactImportEventData {
  batchId: string
  workspaceId: string
}

/** At or under this many items, an undo runs inside the agent's own call. */
const INLINE_UNDO_MAX = 300

/** Seams for the tests. */
export interface RunImportDeps {
  send?: (event: { name: string; data: ContactImportEventData }) => Promise<unknown>
}

const sendEvent = (deps: RunImportDeps) => deps.send ?? ((event) => inngest.send(event))

export type RunImportResult =
  | { status: 'done'; batchId: string; summary: string; toCheck: Awaited<ReturnType<typeof reviewItems>>; imported: number }
  | { status: 'running'; batchId: string; total: number }
  | { status: 'failed'; error: string }

/** Import records from one source: stage them, then apply inline (small) or in the background (large). */
export async function runImport(
  db: Db,
  args: { workspaceId: string; userId: string; source: ImportSource; label?: string | null; records: ImportRecord[] },
  deps: RunImportDeps = {},
): Promise<RunImportResult> {
  // Inline only when small and nothing else is importing or undoing here: the background
  // functions take one batch per workspace at a time, and an inline run would race them.
  const inline = args.records.length <= INLINE_IMPORT_MAX && !(await workspaceImportBusy(db, args.workspaceId))
  const created = await createImportBatch(db, { workspaceId: args.workspaceId, userId: args.userId, source: args.source, label: args.label, notify: !inline })
  if (!created.ok) return { status: 'failed', error: created.error }
  const batch = created.batch
  try {
    await stageRecords(db, batch, args.records)
    if (!inline) {
      await sendEvent(deps)({ name: CONTACT_IMPORT_APPLY, data: { batchId: batch.id, workspaceId: batch.workspace_id } })
      return { status: 'running', batchId: batch.id, total: args.records.length }
    }
    for (let guard = 0; guard < 20; guard++) {
      const { remaining } = await applyPendingItems(db, batch.id)
      if (!remaining) break
    }
    const { summary } = await finishImportBatch(db, batch.id)
    const fresh = await loadImportBatch(db, batch.id)
    return {
      status: 'done',
      batchId: batch.id,
      summary: summary ?? '',
      toCheck: await reviewItems(db, batch.id),
      imported: fresh ? importedPeople(fresh.counts) : 0,
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    await db.from('contact_import_batch').update({ status: 'failed', error: error.slice(0, 1000) }).eq('id', batch.id)
    return { status: 'failed', error }
  }
}

export type RunUndoResult = { status: 'done'; text: string } | { status: 'running'; batchId: string } | { status: 'refused'; error: string }

/** Undo one batch as a whole: inline when small, else in the background (texted when done). */
export async function runUndo(db: Db, args: { workspaceId: string; batchId: string; userId?: string }, deps: RunImportDeps = {}): Promise<RunUndoResult> {
  const busy = await workspaceImportBusy(db, args.workspaceId)
  const started = await startUndo(db, args.batchId, args.workspaceId, args.userId)
  if (!started.ok) return { status: 'refused', error: started.error }
  const batch: ImportBatch = started.batch
  if (batch.total > INLINE_UNDO_MAX || busy) {
    await sendEvent(deps)({ name: CONTACT_IMPORT_UNDO, data: { batchId: batch.id, workspaceId: batch.workspace_id } })
    return { status: 'running', batchId: batch.id }
  }
  for (let guard = 0; guard < 10; guard++) {
    const { remaining } = await undoImportItems(db, batch.id)
    if (!remaining) break
  }
  const { tallies } = await finishUndo(db, batch.id)
  return { status: 'done', text: undoSummaryText({ source: batch.source, label: batch.label, ...tallies }) }
}
