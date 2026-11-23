/**
 * Applying a staged import (docs/plans/imports.md): its items in order, each
 * record written on the PERSON'S OWN client (`db`), so row security decides
 * exactly as it does when they make the record by hand. The journal is
 * written on the service client (`svc`).
 *
 * Resumable without duplicates. Every record we can name ourselves was given
 * its id when the import was staged (journal.ts PRE_ASSIGNED); a run that
 * stopped part-way is run again by Apply, which first marks as made every
 * pending item whose record already exists, then writes the rest. A table
 * (named by its RPC) is journalled the moment it is made.
 *
 *   label, project, workflow_state   one by one; a name taken meanwhile is
 *                                    matched, not made (undo leaves it be)
 *   action                           in chunks of 200, with assignees and
 *                                    labels; a chunk that fails is retried
 *                                    one by one, so one bad row fails alone
 *   drive_folder                     one by one, inside its parent
 *   document                         made empty and filed; its body is
 *                                    written once every item has its id, with
 *                                    links and images filled in, and its
 *                                    record links synced
 *   data_table                       created, filled in one batch (source
 *                                    'import'), filed
 *   asset                            uploaded to the importer's own folder
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { dueAtFromDate } from '@/lib/actions/due-at'
import { createTable, applyOps } from '@/lib/tables/store'
import { importOps, planImport } from '@/lib/tables/csv'
import { fillPlaceholders, REF_PLACEHOLDER } from './notion/plan'
import { loadItems, updateImport, updateItem, updateItems, type WorkImport, type WorkImportItem } from './journal'
import { assetAddress, assetStoragePath } from './assets'
import type { ActionRecord, DataTableRecord, DocumentRecord, DriveFolderRecord, ItemKind, Ref, WorkflowStateRecord } from './types'

export interface ApplyDeps {
  /** The person's own session client: every record is written here. */
  db: SupabaseClient
  /** The service client: the journal, and the importer's own upload folder. */
  svc: SupabaseClient
  imp: WorkImport
  userId: string
  memberId: string
  /** A Notion export's file, by its path in the export. */
  readFile?: (path: string) => Promise<Uint8Array | null>
  /** After each chunk: how far along. */
  onProgress?: (done: number, total: number) => Promise<void>
  /** Index a written document for search (best-effort; skipped in tests). */
  indexDocument?: (id: string, content: string) => Promise<void>
  /** Turn a written document's mentions into record links. */
  syncLinks?: (id: string, content: string) => Promise<void>
}

export interface ApplyResult {
  status: 'done' | 'failed'
  counts: Record<string, number>
  failed: number
  error?: string
}

const TABLE_OF: Partial<Record<ItemKind, string>> = {
  label: 'label',
  project: 'projects',
  workflow_state: 'workflow_state',
  action: 'actions',
  drive_folder: 'drive_folder',
  document: 'document',
}

const ACTION_CHUNK = 200
const now = () => new Date().toISOString()
const clip = (s: string) => s.slice(0, 480)

function errText(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) return String((e as { message: unknown }).message)
  return String(e)
}

export async function applyImport(deps: ApplyDeps): Promise<ApplyResult> {
  const { db, svc, imp, userId, memberId } = deps
  const items = await loadItems(svc, imp.id)
  const byRef = new Map(items.map((i) => [i.ref, i]))
  const total = items.length

  /** The id a ref names now: a made or matched item's record. */
  const idOf = (ref: Ref | null | undefined): string | null => {
    if (!ref) return null
    if ('id' in ref) return ref.id
    const it = byRef.get(ref.ref)
    if (!it) return null
    if (it.outcome === 'matched') return it.matched_id
    if (it.outcome === 'created') return it.entity_id
    return null
  }

  // ── Resume: what a stopped run already made ──────────────────────────────
  for (const [kind, table] of Object.entries(TABLE_OF) as [ItemKind, string][]) {
    const pending = items.filter((i) => i.kind === kind && i.outcome === 'pending' && i.entity_id)
    for (let i = 0; i < pending.length; i += 500) {
      const ids = pending.slice(i, i + 500).map((p) => p.entity_id!)
      const { data } = await db.from(table).select('id').in('id', ids)
      const found = new Set(((data ?? []) as Array<{ id: string }>).map((r) => r.id))
      const made = pending.slice(i, i + 500).filter((p) => found.has(p.entity_id!))
      if (made.length) {
        const at = now()
        await updateItems(svc, made.map((m) => m.id), { outcome: 'created', applied_at: at })
        for (const m of made) Object.assign(m, { outcome: 'created', applied_at: at })
      }
    }
  }

  const mark = async (item: WorkImportItem, patch: Partial<WorkImportItem>) => {
    Object.assign(item, patch)
    await updateItem(svc, item.id, patch)
  }
  const made = (item: WorkImportItem, entityId?: string | null) => mark(item, { outcome: 'created', applied_at: now(), ...(entityId !== undefined ? { entity_id: entityId } : {}), error: null })
  const matched = (item: WorkImportItem, id: string) => mark(item, { outcome: 'matched', matched_id: id, entity_id: null, applied_at: now(), error: null })
  const failed = (item: WorkImportItem, e: unknown) => mark(item, { outcome: 'failed', error: clip(errText(e)) })

  const fileInFolder = async (type: 'document' | 'data_table', id: string, folder: Ref | null) => {
    const folderId = idOf(folder)
    if (!folderId) return
    const { error } = await db.from('drive_folder_item').upsert({ item_type: type, item_id: id, folder_id: folderId, workspace_id: imp.workspace_id, added_by: memberId }, { onConflict: 'item_type,item_id' })
    if (error) throw error
  }

  let done = items.filter((i) => i.outcome !== 'pending').length
  const progress = async () => {
    try {
      await deps.onProgress?.(done, total)
    } catch {
      /* the ledger is fail-soft */
    }
  }

  const pending = items.filter((i) => i.outcome === 'pending')
  let at = 0
  while (at < pending.length) {
    const item = pending[at]
    if (item.kind === 'action') {
      const chunk: WorkImportItem[] = []
      while (at < pending.length && pending[at].kind === 'action' && chunk.length < ACTION_CHUNK) chunk.push(pending[at++])
      await writeActions(chunk)
      done += chunk.length
      await progress()
      continue
    }
    at++
    try {
      await writeOne(item)
    } catch (e) {
      await failed(item, e)
    }
    done++
    if (done % 50 === 0) await progress()
  }

  // ── Bodies, once every item has its id ───────────────────────────────────
  const docs = items.filter((i) => i.kind === 'document' && i.outcome === 'created' && i.entity_id && (i.record as DocumentRecord).body)
  for (let i = 0; i < docs.length; i += 200) {
    const page = docs.slice(i, i + 200)
    const { data } = await db.from('document').select('id, content').in('id', page.map((d) => d.entity_id!))
    const empty = new Set(((data ?? []) as Array<{ id: string; content: string | null }>).filter((d) => !d.content).map((d) => d.id))
    for (const d of page) {
      if (!empty.has(d.entity_id!)) continue
      const content = fillBody((d.record as DocumentRecord).body)
      const { error } = await db.from('document').update({ content, edit_source: 'system', edit_summary: 'Imported' }).eq('id', d.entity_id!)
      if (error) {
        await mark(d, { error: clip(`Its text could not be written: ${error.message}`) })
        continue
      }
      // The body counts as part of the import: a change after this is someone's.
      await mark(d, { applied_at: now() })
      try {
        await deps.syncLinks?.(d.entity_id!, content)
        await deps.indexDocument?.(d.entity_id!, content)
      } catch {
        /* best-effort */
      }
    }
  }

  const counts: Record<string, number> = {}
  let failedCount = 0
  for (const i of items) {
    if (i.outcome === 'created') counts[i.kind] = (counts[i.kind] ?? 0) + 1
    if (i.outcome === 'matched') counts[`matched_${i.kind}`] = (counts[`matched_${i.kind}`] ?? 0) + 1
    if (i.outcome === 'failed') failedCount++
  }
  if (failedCount) counts.failed = failedCount
  await progress()
  const nothing = !items.some((i) => i.outcome === 'created' || i.outcome === 'matched')
  return nothing && failedCount ? { status: 'failed', counts, failed: failedCount, error: items.find((i) => i.error)?.error ?? 'Nothing could be imported.' } : { status: 'done', counts, failed: failedCount }

  // ── Writers ──────────────────────────────────────────────────────────────

  function fillBody(body: string): string {
    return fillPlaceholders(body, (kind, ref) => {
      const target = byRef.get(ref)
      if (!target) return null
      if (kind === 'asset') return target.outcome === 'created' ? assetAddress(target.id) : null
      const id = idOf({ ref })
      if (!id) return null
      return target.kind === 'data_table' ? `mention://data_table/${id}` : target.kind === 'document' ? `mention://document/${id}` : null
    })
  }

  async function writeOne(item: WorkImportItem): Promise<void> {
    const r = item.record
    switch (r.kind) {
      case 'label': {
        const { error } = await db.from('label').insert({ id: item.entity_id, workspace_id: imp.workspace_id, name: r.name })
        if (!error) return made(item)
        if (error.code !== '23505') throw error
        const { data } = await db.from('label').select('id').eq('workspace_id', imp.workspace_id).ilike('name', r.name.replace(/[%_\\]/g, (c) => `\\${c}`)).limit(1).maybeSingle()
        if (!data) throw error
        return matched(item, (data as { id: string }).id)
      }
      case 'project': {
        const { error } = await db.from('projects').insert({ id: item.entity_id, user_id: userId, workspace_id: imp.workspace_id, name: r.name, status: 'active', ...(r.description ? { description: r.description } : {}) })
        if (error) throw error
        return made(item)
      }
      case 'workflow_state': {
        const s = r as WorkflowStateRecord
        const { data: last } = await db.from('workflow_state').select('sort_order').eq('team_id', s.team_id).order('sort_order', { ascending: false }).limit(1).maybeSingle()
        const { error } = await db.from('workflow_state').insert({ id: item.entity_id, team_id: s.team_id, name: s.name, category: s.category, color: s.color ?? '#6b7280', sort_order: ((last as { sort_order: number } | null)?.sort_order ?? 0) + 1 })
        if (!error) return made(item)
        if (error.code !== '23505') throw error
        const { data } = await db.from('workflow_state').select('id').eq('team_id', s.team_id).eq('name', s.name).maybeSingle()
        if (!data) throw error
        return matched(item, (data as { id: string }).id)
      }
      case 'drive_folder': {
        const f = r as DriveFolderRecord
        const { error } = await db.from('drive_folder').insert({ id: item.entity_id, workspace_id: imp.workspace_id, name: f.name, parent_id: idOf(f.parent), created_by: memberId })
        if (error) throw error
        return made(item)
      }
      case 'document': {
        const d = r as DocumentRecord
        // A body with no link to fill goes in now; one with links waits for the pass after.
        REF_PLACEHOLDER.lastIndex = 0
        const later = REF_PLACEHOLDER.test(d.body)
        const { error } = await db.from('document').insert({
          id: item.entity_id,
          workspace_id: imp.workspace_id,
          title: d.title,
          content: later ? '' : d.body,
          created_by: memberId,
          visibility: d.visibility,
        })
        if (error) throw error
        await made(item)
        await fileInFolder('document', item.entity_id!, d.folder)
        if (!later && d.body) {
          try {
            await deps.syncLinks?.(item.entity_id!, d.body)
            await deps.indexDocument?.(item.entity_id!, d.body)
          } catch {
            /* best-effort */
          }
        }
        return
      }
      case 'data_table': {
        const t = r as DataTableRecord
        const created = await createTable(db, imp.workspace_id, { name: t.name, visibility: t.visibility, blankRows: 0 }, { userId, source: 'import', reason: `Imported from ${imp.label ?? 'a Notion export'}` })
        if (!created.ok) throw new Error(created.error)
        const tableId = created.value.table_id
        await made(item, tableId)
        const sheet = { headers: t.headers, rows: t.rows }
        if (sheet.rows.length) {
          const ops = importOps(sheet, planImport(sheet, []), [])
          if (!ops.ok) throw new Error(ops.error)
          const filled = await applyOps(db, imp.workspace_id, tableId, { baseVersion: null, ops: ops.plan.ops }, { userId, source: 'import', reason: `Imported ${ops.plan.rows.toLocaleString('en-US')} rows` })
          if (!filled.ok) await mark(item, { error: clip(`Its rows could not be written: ${filled.error}`) })
        }
        await fileInFolder('data_table', tableId, t.folder)
        return
      }
      case 'asset': {
        const bytes = await deps.readFile?.(r.path)
        if (!bytes) throw new Error('The file was not in the export.')
        const { error } = await svc.storage.from('attachments').upload(assetStoragePath(userId, imp.id, item.id, r.file_name), bytes, { contentType: r.mime_type, upsert: true })
        if (error) throw error
        return made(item, null)
      }
      case 'action':
        return writeActions([item])
    }
  }

  async function writeActions(chunk: WorkImportItem[]): Promise<void> {
    const rows = chunk.map((item) => {
      const a = item.record as ActionRecord
      const row: Record<string, unknown> = {
        id: item.entity_id,
        user_id: userId,
        workspace_id: imp.workspace_id,
        team_id: a.team_id,
        title: a.title,
        description: a.description,
        due_at: a.due_date ? dueAtFromDate(a.due_date) : null,
        all_day: !a.due_date,
        priority: a.priority,
        status_id: idOf(a.status),
        confirmation: 'confirmed',
        links: [],
      }
      if (a.assignee_member_id) row.assignee_id = a.assignee_member_id
      const project = idOf(a.project)
      if (project) row.project_id = project
      const parent = idOf(a.parent)
      if (parent) row.parent_id = parent
      if (a.estimate !== null) row.estimate = a.estimate
      return row
    })
    const { error } = await db.from('actions').insert(rows)
    if (error) {
      if (chunk.length === 1) return failed(chunk[0], error)
      // One bad row must not sink the rest: each alone.
      for (const item of chunk) await writeActions([item])
      return
    }
    const assignees = chunk.flatMap((item) => {
      const a = item.record as ActionRecord
      return a.assignee_member_id ? [{ action_id: item.entity_id, member_id: a.assignee_member_id }] : []
    })
    if (assignees.length) await db.from('action_assignee').insert(assignees)
    const labels = chunk.flatMap((item) => {
      const ids = [...new Set((item.record as ActionRecord).labels.map(idOf).filter((x): x is string => !!x))]
      return ids.map((label_id) => ({ action_id: item.entity_id, label_id }))
    })
    if (labels.length) await db.from('action_label').insert(labels)
    const at = now()
    await updateItems(svc, chunk.map((c) => c.id), { outcome: 'created', applied_at: at, error: null })
    for (const c of chunk) Object.assign(c, { outcome: 'created', applied_at: at, error: null })
  }
}

/** Finish an import's row from its result. */
export async function recordApplied(svc: SupabaseClient, imp: WorkImport, result: ApplyResult, summary: string): Promise<void> {
  await updateImport(svc, imp.id, {
    status: result.status,
    counts: { ...imp.counts, ...Object.fromEntries(Object.entries(result.counts).map(([k, v]) => [`made_${k}`, v])) },
    summary: summary.slice(0, 2000),
    error: result.error?.slice(0, 1000) ?? null,
    finished_at: now(),
  })
}
