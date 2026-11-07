/**
 * Taking an import back, as a whole (roadmap track G). Items are undone
 * newest first, so a repeat later in the file is unwound before the contact
 * it folded into:
 *
 *   a contact it created     deleted, unless it has been worked with since
 *                            (any column changed from what the insert wrote,
 *                            timeline rows the import didn't add, or anything
 *                            pointing at it: a merge, a meeting, an email
 *                            thread, an action, a voice, a share, a sequence,
 *                            another import): then kept, with the import's
 *                            tag and history taken off.
 *   a contact it matched     each field it changed goes back to what it was,
 *                            when it still holds what the import wrote (an
 *                            edit since then stays); the tags and emails it
 *                            added come off; its timeline rows go.
 *   a company it created     the workspace's contacts its domain trigger
 *                            adopted are given back, then it is deleted when
 *                            no contact points at it any more.
 *   a failed item            what it wrote before it failed (its journal says
 *                            how far it got) is undone the same way.
 *   its source links         removed, so a later import starts fresh.
 *
 * Resumable: each item is stamped `undone_at`, so a large undo runs in
 * chunks (the Inngest function) and a retry picks up where it stopped.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { INSERT_SNAPSHOT_FIELDS, ITEM_COLUMNS, loadImportBatch, type ImportBatch, type ImportItem } from './batch'
import { provenanceOf, withProvenance } from './plan'
import { sourceTag } from './record'

type Db = SupabaseClient

export type UndoOutcome = 'removed' | 'restored' | 'kept' | 'none'

export interface UndoTallies {
  removed: number
  restored: number
  kept: number
}

/** What undo does per chunk by default. */
export const UNDO_CHUNK = 200

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Start undoing a done (or failed) batch. Only the person who ran it, or a
 * workspace owner or admin, may (the contacts it deletes are theirs). Refuses
 * one already undone or still running; an interrupted undo resumes.
 */
export async function startUndo(db: Db, batchId: string, workspaceId: string, userId?: string): Promise<{ ok: true; batch: ImportBatch } | { ok: false; error: string }> {
  const batch = await loadImportBatch(db, batchId)
  if (!batch || batch.workspace_id !== workspaceId) return { ok: false, error: 'No import with that id in this workspace.' }
  if (userId && batch.user_id !== userId) {
    const { data: member } = await db.from('member').select('role').eq('user_id', userId).eq('workspace_id', workspaceId).maybeSingle()
    const role = (member as { role?: string } | null)?.role
    if (role !== 'owner' && role !== 'admin') return { ok: false, error: 'Only the person who ran that import (or a workspace admin) can undo it.' }
  }
  if (batch.status === 'undone') return { ok: false, error: 'That import was already undone.' }
  if (batch.status === 'undoing') return { ok: true, batch }
  if (batch.status !== 'done' && batch.status !== 'failed') return { ok: false, error: 'That import is still running. Undo it once it finishes.' }
  const { data } = await db.from('contact_import_batch').update({ status: 'undoing' }).eq('id', batch.id).in('status', ['done', 'failed']).select('id')
  if (!Array.isArray(data) || data.length === 0) return { ok: false, error: 'That import changed state just now. Try again.' }
  batch.status = 'undoing'
  return { ok: true, batch }
}

async function deleteHistory(db: Db, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return
  const { error } = await db.from('contact_interaction').delete().in('id', [...ids])
  if (error) throw new Error(`contact_interaction delete failed: ${error.message}`)
}

/** The keys of an item's journal that are not columns to restore. */
const JOURNAL_ONLY = new Set(['metadata_imported', 'inserted', 'adopted_contact_ids'])

/**
 * Has anything other than this import touched a contact it created? Its
 * columns no longer what the insert wrote (the owner typed a note, set a
 * follow-up, added it to a list), timeline rows the import didn't add, or
 * anything pointing at it: a merge, a meeting, an email thread, an action, a
 * voice, a share, a sequence, another import. When in doubt, it is kept.
 */
async function workedWithSince(db: Db, batch: ImportBatch, contact: Record<string, unknown>, item: ImportItem): Promise<boolean> {
  const inserted = item.changes?.inserted?.after as Record<string, unknown> | undefined
  if (!inserted) return true
  for (const field of INSERT_SNAPSHOT_FIELDS) if (!sameValue(contact[field], inserted[field])) return true
  const contactId = String(contact.id)
  const own = new Set(item.history_ids ?? [])
  const { data: interactions } = await db.from('contact_interaction').select('id').eq('contact_id', contactId).limit(500)
  if (((interactions as Array<{ id: string }> | null) ?? []).some((r) => !own.has(r.id))) return true
  const checks: Array<PromiseLike<{ data: unknown }>> = [
    db.from('contact').select('id').eq('merged_into_contact_id', contactId).limit(1),
    db.from('capture_participant').select('id').eq('contact_id', contactId).limit(1),
    db.from('email_thread_index').select('id').eq('linked_contact_id', contactId).limit(1),
    db.from('actions').select('id').eq('assignee_contact_id', contactId).limit(1),
    db.from('voice_enrollment').select('id').eq('contact_id', contactId).limit(1),
    db.from('voice_contact_trust').select('id').eq('contact_id', contactId).limit(1),
    db.from('contact_share').select('id').eq('contact_id', contactId).limit(1),
    db.from('sequence_enrollment').select('id').eq('contact_id', contactId).limit(1),
    db.from('contact_import_item').select('id').eq('contact_id', contactId).neq('batch_id', batch.id).is('undone_at', null).limit(1),
  ]
  for (const { data, error } of (await Promise.all(checks)) as Array<{ data: unknown; error?: unknown }>) {
    if (error) return true // can't tell: keep it
    if (Array.isArray(data) && data.length > 0) return true
  }
  return false
}

/** Restore what an import changed on an existing row, where it still holds what the import wrote. */
async function restoreChanges(db: Db, batch: ImportBatch, table: 'contact' | 'company', id: string, changes: ImportItem['changes']): Promise<boolean> {
  const fields = Object.keys(changes ?? {}).filter((f) => !JOURNAL_ONLY.has(f) || f === 'metadata_imported')
  if (fields.length === 0) return false
  const { data } = await db.from(table).select('*').eq('id', id).eq('workspace_id', batch.workspace_id).maybeSingle()
  const current = data as Record<string, unknown> | null
  if (!current) return false
  const patch: Record<string, unknown> = {}
  for (const field of fields) {
    const { before, after } = changes[field]
    if (field === 'metadata_imported') {
      if (sameValue(provenanceOf(current.metadata as Record<string, unknown> | null, batch.source), after)) {
        patch.metadata = withProvenance((patch.metadata as Record<string, unknown>) ?? (current.metadata as Record<string, unknown> | null), batch.source, (before as Record<string, unknown>) ?? {})
      }
      continue
    }
    if (field === 'tags' || field === 'secondary_emails') {
      const added = new Set(((after as string[] | null) ?? []).filter((v) => !((before as string[] | null) ?? []).includes(v)))
      const now = (current[field] as string[] | null) ?? []
      const next = now.filter((v) => !added.has(v))
      if (next.length !== now.length) patch[field] = next
      continue
    }
    if (sameValue(current[field], after)) patch[field] = before ?? null
  }
  if (Object.keys(patch).length === 0) return false
  const { error } = await db.from(table).update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id)
  if (error) throw new Error(`${table} restore failed: ${error.message}`)
  return true
}

/**
 * Delete a company this import created. The contacts its domain trigger
 * adopted (they were the workspace's, unassigned) are given back first; the
 * company goes once no contact points at it any more.
 */
async function dropCreatedCompany(db: Db, batch: ImportBatch, companyId: string, adopted: readonly string[]): Promise<UndoOutcome> {
  if (adopted.length) {
    const { error } = await db.from('contact').update({ company_id: null }).in('id', [...adopted]).eq('company_id', companyId)
    if (error) throw new Error(`contact company restore failed: ${error.message}`)
  }
  const { data: used } = await db.from('contact').select('id').eq('company_id', companyId).limit(1)
  if (Array.isArray(used) && used.length > 0) {
    const { data } = await db.from('company').select('tags').eq('id', companyId).maybeSingle()
    const tags = ((data as { tags?: string[] } | null)?.tags ?? []).filter((t) => t !== sourceTag(batch.source))
    await db.from('company').update({ tags }).eq('id', companyId)
    return 'kept'
  }
  const { error } = await db.from('company').delete().eq('id', companyId).eq('workspace_id', batch.workspace_id).eq('is_workspace_company', false)
  if (error) throw new Error(`company delete failed: ${error.message}`)
  return 'removed'
}

/** Did the item create its contact? A failed item says how far it got (`partial:created`). */
function createdContact(item: ImportItem): boolean {
  return item.outcome === 'created' || item.outcome === 'review' || item.match_type === 'partial:created'
}

async function undoItem(db: Db, batch: ImportBatch, item: ImportItem): Promise<UndoOutcome> {
  let outcome: UndoOutcome = 'none'
  if (item.kind === 'contact' && item.contact_id) {
    if (createdContact(item)) {
      const { data } = await db.from('contact').select('*').eq('id', item.contact_id).eq('workspace_id', batch.workspace_id).maybeSingle()
      const row = data as Record<string, unknown> | null
      if (row) {
        if (!row.merged_into_contact_id && !(await workedWithSince(db, batch, row, item))) {
          const { error } = await db.from('contact').delete().eq('id', String(row.id)).eq('workspace_id', batch.workspace_id)
          if (error) throw new Error(`contact delete failed: ${error.message}`)
          outcome = 'removed'
        } else {
          await deleteHistory(db, item.history_ids ?? [])
          await db.from('contact').update({ tags: ((row.tags as string[] | null) ?? []).filter((t) => t !== sourceTag(batch.source)) }).eq('id', String(row.id))
          outcome = 'kept'
        }
      }
    } else {
      await deleteHistory(db, item.history_ids ?? [])
      const restored = await restoreChanges(db, batch, 'contact', item.contact_id, item.changes)
      outcome = restored || (item.history_ids?.length ?? 0) > 0 ? 'restored' : 'none'
    }
  }
  if (item.kind === 'company' && item.company_id && (item.outcome === 'matched' || item.match_type === 'partial:matched')) {
    outcome = (await restoreChanges(db, batch, 'company', item.company_id, item.changes)) ? 'restored' : 'none'
  }
  // A company the item created (its own row, or a contact's): gone once nothing points at it.
  if (item.created_company_id) {
    const adopted = (item.changes?.adopted_contact_ids?.after as string[] | undefined) ?? []
    const dropped = await dropCreatedCompany(db, batch, item.created_company_id, adopted)
    if (item.kind === 'company') outcome = dropped
  }
  return outcome
}

/**
 * Undo up to `limit` of an undoing batch's items, newest first. Returns how
 * many were undone and whether any are left.
 */
export async function undoImportItems(db: Db, batchId: string, opts: { limit?: number } = {}): Promise<{ undone: number; remaining: boolean }> {
  const batch = await loadImportBatch(db, batchId)
  if (!batch || batch.status !== 'undoing') return { undone: 0, remaining: false }
  const limit = opts.limit ?? UNDO_CHUNK
  const { data, error } = await db
    .from('contact_import_item')
    .select(ITEM_COLUMNS)
    .eq('batch_id', batch.id)
    .is('undone_at', null)
    .in('outcome', ['created', 'review', 'matched', 'repeat', 'unchanged', 'failed'])
    .order('seq', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`contact_import_item read failed: ${error.message}`)
  const items = (data as unknown as ImportItem[] | null) ?? []
  for (const item of items) {
    const outcome = await undoItem(db, batch, item)
    const { error: saveError } = await db.from('contact_import_item').update({ undone_at: new Date().toISOString(), undo_outcome: outcome }).eq('id', item.id)
    if (saveError) throw new Error(`contact_import_item update failed: ${saveError.message}`)
  }
  return { undone: items.length, remaining: items.length === limit }
}

/** End an undo: its source links removed, the batch marked undone, the tallies counted. */
export async function finishUndo(db: Db, batchId: string): Promise<{ batch: ImportBatch | null; tallies: UndoTallies; transitioned: boolean }> {
  const tallies: UndoTallies = { removed: 0, restored: 0, kept: 0 }
  const batch = await loadImportBatch(db, batchId)
  if (!batch) return { batch: null, tallies, transitioned: false }
  await db.from('crm_source_link').delete().eq('batch_id', batch.id)
  for (let from = 0; ; from += 1000) {
    const { data } = await db.from('contact_import_item').select('kind, undo_outcome').eq('batch_id', batch.id).eq('kind', 'contact').order('seq', { ascending: true }).range(from, from + 999)
    const rows = (data as Array<{ undo_outcome: UndoOutcome | null }> | null) ?? []
    for (const r of rows) if (r.undo_outcome && r.undo_outcome !== 'none') tallies[r.undo_outcome]++
    if (rows.length < 1000) break
  }
  // The transition is the claim: a retried finish (already undone) tells nobody twice.
  let transitioned = false
  if (batch.status === 'undoing') {
    const { data } = await db.from('contact_import_batch').update({ status: 'undone', undone_at: new Date().toISOString() }).eq('id', batch.id).eq('status', 'undoing').select('id')
    transitioned = Array.isArray(data) && data.length > 0
    batch.status = 'undone'
  }
  return { batch, tallies, transitioned }
}
