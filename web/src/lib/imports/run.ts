/**
 * Running an import or its undo end to end (docs/plans/imports.md): claim it
 * (so two clicks never run it twice), open its ledger row, apply or undo,
 * write the summary, close the row. The routes call these after answering
 * (Next's `after`), and the page follows the import's status.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyImport, recordApplied, type ApplyDeps } from './apply'
import { uploadStoragePath } from './assets'
import { claimImport, updateImport, type WorkImport } from './journal'
import { openLedger, SOURCE_NAME } from './ledger'
import { readNotionExportFiles } from './notion/export'
import { joinAnd, undoImport, undoSummary } from './undo'
import { countOf } from './types'

export interface RunDeps {
  db: SupabaseClient
  svc: SupabaseClient
  imp: WorkImport
  userId: string
  memberId: string
  indexDocument?: ApplyDeps['indexDocument']
  syncLinks?: ApplyDeps['syncLinks']
}

/** "Imported 120 tasks, 4 labels and 1 project from a task CSV. 2 rows failed." */
export function applySummary(source: WorkImport['source'], counts: Record<string, number>): string {
  const made: string[] = []
  const add = (k: string, one: string, many: string) => {
    if (counts[k]) made.push(countOf(counts[k], one, many))
  }
  add('action', 'task', 'tasks')
  add('document', 'document', 'documents')
  add('data_table', 'table', 'tables')
  add('drive_folder', 'folder', 'folders')
  add('asset', 'file', 'files')
  add('label', 'label', 'labels')
  add('project', 'project', 'projects')
  add('workflow_state', 'status', 'statuses')
  const head = made.length ? `Imported ${joinAnd(made)} from ${SOURCE_NAME[source]}.` : `Nothing new came in from ${SOURCE_NAME[source]}.`
  return counts.failed ? `${head} ${countOf(counts.failed, 'item', 'items')} could not be imported.` : head
}

/** Apply a staged (or failed part-way) import. False when it was not in a state to run. */
export async function runApply(deps: RunDeps): Promise<boolean> {
  const { svc, imp } = deps
  if (!(await claimImport(svc, imp.id, ['staged', 'failed'], 'running', { started_at: new Date().toISOString(), error: null }))) return false
  const ledger = await openLedger(svc, imp, 'import')
  try {
    let readFile: ApplyDeps['readFile']
    if (imp.source === 'notion') {
      const files = await loadStagedExport(svc, deps.userId, imp.id)
      readFile = async (path) => files?.get(path) ?? null
    }
    const result = await applyImport({ ...deps, readFile, onProgress: (done, total) => ledger.step(done, total) })
    const summary = applySummary(imp.source, result.counts)
    await recordApplied(svc, imp, result, summary)
    if (result.status === 'done') {
      await ledger.finish(summary)
      if (imp.source === 'notion' && !result.failed) await svc.storage.from('attachments').remove([uploadStoragePath(deps.userId, imp.id)])
    } else await ledger.fail(result.error ?? summary)
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 900)
    await updateImport(svc, imp.id, { status: 'failed', error: `It stopped part-way: ${message}. Import again to carry on; nothing is made twice.`, finished_at: new Date().toISOString() }).catch(() => {})
    await ledger.fail(message)
  }
  return true
}

/** Undo a finished (or failed part-way) import. False when it was not in a state to undo. */
export async function runUndo(deps: Omit<RunDeps, 'memberId' | 'indexDocument' | 'syncLinks'>): Promise<boolean> {
  const { svc, imp } = deps
  if (!(await claimImport(svc, imp.id, ['done', 'failed', 'undoing'], 'undoing'))) return false
  const ledger = await openLedger(svc, imp, 'undo')
  try {
    const result = await undoImport({ ...deps, onProgress: (done, total) => ledger.step(done, total) })
    const summary = undoSummary(result)
    await updateImport(svc, imp.id, { status: 'undone', summary: summary.slice(0, 2000), undone_at: new Date().toISOString() })
    await ledger.finish(summary)
    await svc.storage.from('attachments').remove([uploadStoragePath(deps.userId, imp.id)]).catch(() => {})
  } catch (err) {
    const message = (err instanceof Error ? err.message : String(err)).slice(0, 900)
    // Still 'undoing': Undo again carries on (each item is undone once).
    await updateImport(svc, imp.id, { error: `The undo stopped part-way: ${message}. Undo again to carry on.` }).catch(() => {})
    await ledger.fail(message)
  }
  return true
}

/** A staged Notion export's files, by path (its pages and tables are already in the plan). */
async function loadStagedExport(svc: SupabaseClient, userId: string, importId: string): Promise<Map<string, Uint8Array> | null> {
  const { data, error } = await svc.storage.from('attachments').download(uploadStoragePath(userId, importId))
  if (error || !data) return null
  return readNotionExportFiles(new Uint8Array(await data.arrayBuffer()))
}
