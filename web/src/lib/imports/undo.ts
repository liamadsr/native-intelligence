/**
 * Undoing an import as a whole (docs/plans/imports.md, "Undo").
 *
 * Never destructive beyond the import:
 *   - only items it MADE (outcome 'created') are touched; a record it matched
 *     (an existing label, state, project or person) is never touched;
 *   - a made record that anyone changed after the import is KEPT and listed,
 *     not removed (no question asked: "kept 3 changed records" says why);
 *   - every record is removed on the person's OWN client, so an undo cannot
 *     remove what they could not; a refusal keeps the record and says so.
 *
 * Walked in reverse: tasks before the labels, states and projects they use;
 * documents before the files they link and the folders they sit in.
 *
 *   action          deleted, unless changed since (updated_at after the import)
 *   workflow_state  deleted, unless a task outside this undo uses it
 *   label           deleted, unless a task or project outside it uses it
 *   project         deleted, unless changed or a task outside it uses it
 *   document        archived (restorable), unless changed since
 *   data_table      archived (restorable), unless it has a change that isn't the import's
 *   drive_folder    deleted, unless it holds something this undo didn't remove
 *   asset           its file removed, unless a kept document links it
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { applyOps } from '@/lib/tables/store'
import { loadItems, updateItem, type WorkImport, type WorkImportItem } from './journal'
import { assetAddress, assetStoragePath } from './assets'
import { countOf, type AssetRecord, type ItemKind, type UndoOutcome } from './types'

/** A record changed within this long of its import is still the import's own write. */
const SLACK_MS = 2000

export interface UndoDeps {
  db: SupabaseClient
  svc: SupabaseClient
  imp: WorkImport
  userId: string
  onProgress?: (done: number, total: number) => Promise<void>
}

export interface UndoResult {
  removed: Partial<Record<ItemKind, number>>
  kept: Array<{ kind: ItemKind; id: string; reason: string }>
}

function changedSince(updatedAt: string | null | undefined, appliedAt: string | null): boolean {
  if (!updatedAt || !appliedAt) return false
  return Date.parse(updatedAt) > Date.parse(appliedAt) + SLACK_MS
}

const NOUN: Record<ItemKind, [string, string]> = {
  action: ['task', 'tasks'],
  label: ['label', 'labels'],
  project: ['project', 'projects'],
  workflow_state: ['status', 'statuses'],
  drive_folder: ['folder', 'folders'],
  document: ['document', 'documents'],
  data_table: ['table', 'tables'],
  asset: ['file', 'files'],
}

export async function undoImport(deps: UndoDeps): Promise<UndoResult> {
  const { db, svc, imp, userId } = deps
  const items = (await loadItems(svc, imp.id)).filter((i) => i.outcome === 'created' && !i.undone_at)
  items.sort((a, b) => b.seq - a.seq)
  const result: UndoResult = { removed: {}, kept: [] }
  const removedIds = new Set<string>()
  const keptDocBodies: string[] = []
  let done = 0

  const finish = async (item: WorkImportItem, outcome: UndoOutcome, reason?: string) => {
    await updateItem(svc, item.id, { undo_outcome: outcome, undone_at: new Date().toISOString() })
    if (outcome === 'removed') {
      result.removed[item.kind] = (result.removed[item.kind] ?? 0) + 1
      if (item.entity_id) removedIds.add(item.entity_id)
    } else if (outcome === 'kept') result.kept.push({ kind: item.kind, id: item.entity_id ?? item.id, reason: reason ?? 'changed since' })
    done++
    if (done % 50 === 0) await deps.onProgress?.(done, items.length).catch(() => {})
  }

  /** Delete one row on the person's client; false when row security left it. */
  const remove = async (table: string, id: string): Promise<boolean> => {
    const { data, error } = await db.from(table).delete().eq('id', id).select('id')
    return !error && (data ?? []).length > 0
  }

  /** Rows of `table` whose `column` is `id`, other than those this undo removed. */
  const usedElsewhere = async (table: string, column: string, id: string, key = 'id'): Promise<boolean> => {
    const { data } = await db.from(table).select(key).eq(column, id).limit(50)
    return ((data ?? []) as unknown as Array<Record<string, string>>).some((r) => !removedIds.has(r[key]))
  }

  // Tasks first, in bulk: one read of when each last changed.
  const actions = items.filter((i) => i.kind === 'action' && i.entity_id)
  const touched = new Map<string, string>()
  for (let i = 0; i < actions.length; i += 500) {
    const { data } = await db.from('actions').select('id, updated_at').in('id', actions.slice(i, i + 500).map((a) => a.entity_id!))
    for (const r of (data ?? []) as Array<{ id: string; updated_at: string }>) touched.set(r.id, r.updated_at)
  }

  for (const item of items) {
    const id = item.entity_id
    try {
      switch (item.kind) {
        case 'action': {
          if (!id || !touched.has(id)) {
            await finish(item, 'none')
            break
          }
          if (changedSince(touched.get(id), item.applied_at)) await finish(item, 'kept', 'changed since the import')
          else if (await remove('actions', id)) await finish(item, 'removed')
          else await finish(item, 'kept', 'you can’t delete it')
          break
        }
        case 'workflow_state': {
          if (!id) break
          if (await usedElsewhere('actions', 'status_id', id)) await finish(item, 'kept', 'tasks use it')
          else if (await remove('workflow_state', id)) await finish(item, 'removed')
          else await finish(item, 'kept', 'you can’t delete it')
          break
        }
        case 'label': {
          if (!id) break
          if ((await usedElsewhere('action_label', 'label_id', id, 'action_id')) || (await usedElsewhere('project_label', 'label_id', id, 'project_id'))) await finish(item, 'kept', 'other records use it')
          else if (await remove('label', id)) await finish(item, 'removed')
          else await finish(item, 'kept', 'you can’t delete it')
          break
        }
        case 'project': {
          if (!id) break
          const { data } = await db.from('projects').select('updated_at').eq('id', id).maybeSingle()
          if (!data) await finish(item, 'none')
          else if (changedSince((data as { updated_at: string }).updated_at, item.applied_at)) await finish(item, 'kept', 'changed since the import')
          else if (await usedElsewhere('actions', 'project_id', id)) await finish(item, 'kept', 'tasks use it')
          else if (await remove('projects', id)) await finish(item, 'removed')
          else await finish(item, 'kept', 'you can’t delete it')
          break
        }
        case 'document': {
          if (!id) break
          const { data } = await db.from('document').select('updated_at, status, content').eq('id', id).maybeSingle()
          const doc = data as { updated_at: string; status: string; content: string | null } | null
          if (!doc) await finish(item, 'none')
          else if (doc.status === 'archived') await finish(item, 'removed')
          else if (changedSince(doc.updated_at, item.applied_at)) {
            keptDocBodies.push(doc.content ?? '')
            await finish(item, 'kept', 'changed since the import')
          } else {
            const { data: out, error } = await db.from('document').update({ status: 'archived' }).eq('id', id).select('id')
            if (!error && (out ?? []).length) await finish(item, 'removed')
            else {
              keptDocBodies.push(doc.content ?? '')
              await finish(item, 'kept', 'you can’t archive it')
            }
          }
          break
        }
        case 'data_table': {
          if (!id) break
          const { data } = await db.from('data_change').select('source').eq('table_id', id).neq('source', 'import').limit(1)
          if ((data ?? []).length) {
            await finish(item, 'kept', 'changed since the import')
            break
          }
          const out = await applyOps(db, imp.workspace_id, id, { baseVersion: null, ops: [{ op: 'archive_table' }] }, { userId, source: 'import', reason: 'Import undone' })
          if (out.ok) await finish(item, 'removed')
          else if (out.reason === 'not_found') await finish(item, 'none')
          else await finish(item, 'kept', 'you can’t archive it')
          break
        }
        case 'asset': {
          const address = assetAddress(item.id)
          if (keptDocBodies.some((b) => b.includes(address))) {
            await finish(item, 'kept', 'a kept document shows it')
            break
          }
          const r = item.record as AssetRecord
          await svc.storage.from('attachments').remove([assetStoragePath(userId, imp.id, item.id, r.file_name)])
          await finish(item, 'removed')
          break
        }
        case 'drive_folder': {
          if (!id) break
          const { data: filed } = await db.from('drive_folder_item').select('item_id').eq('folder_id', id).limit(200)
          const { data: subs } = await db.from('drive_folder').select('id').eq('parent_id', id).limit(200)
          // Subfolders come later in the import, so they are undone first; anything still here is someone's.
          const foreign = [...((filed ?? []) as Array<{ item_id: string }>).map((r) => r.item_id), ...((subs ?? []) as Array<{ id: string }>).map((r) => r.id)].some((x) => !removedIds.has(x))
          if (foreign) await finish(item, 'kept', 'it holds something else')
          else if (await remove('drive_folder', id)) await finish(item, 'removed')
          else await finish(item, 'kept', 'you can’t delete it')
          break
        }
      }
    } catch {
      await finish(item, 'kept', 'it could not be undone')
    }
  }
  await deps.onProgress?.(items.length, items.length).catch(() => {})
  return result
}

/** "Removed 40 tasks and 3 labels. Kept 2 tasks changed since the import." */
export function undoSummary(result: UndoResult): string {
  const removed = (Object.entries(result.removed) as [ItemKind, number][]).filter(([, n]) => n > 0).map(([k, n]) => countOf(n, ...NOUN[k]))
  const parts = [removed.length ? `Removed ${joinAnd(removed)}.` : 'Nothing was removed.']
  if (result.kept.length) {
    const byReason = new Map<string, Map<ItemKind, number>>()
    for (const k of result.kept) {
      const m = byReason.get(k.reason) ?? new Map<ItemKind, number>()
      m.set(k.kind, (m.get(k.kind) ?? 0) + 1)
      byReason.set(k.reason, m)
    }
    for (const [reason, m] of byReason) parts.push(`Kept ${joinAnd([...m].map(([k, n]) => countOf(n, ...NOUN[k])))}: ${reason}.`)
  }
  return parts.join(' ')
}

export function joinAnd(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}
