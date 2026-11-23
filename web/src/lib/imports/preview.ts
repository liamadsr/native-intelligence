/**
 * An import as the person sees it (docs/plans/imports.md, "Preview"): its
 * counts and notes, a sample of the tasks it makes with names in place of
 * ids, or the tree of folders, pages and tables it makes. Names are read on
 * the PERSON'S OWN client, so a preview shows only what they can read; it
 * never shows an email address.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadItems, type WorkImport, type WorkImportItem } from './journal'
import type { ActionRecord, DataTableRecord, DocumentRecord, DriveFolderRecord, PlanNote, Ref } from './types'

export const PREVIEW_TASKS = 50

export interface TaskPreview {
  source: string
  title: string
  status: string | null
  priority: string
  assignee: string | null
  due_date: string | null
  project: string | null
  labels: string[]
  parent: string | null
  outcome: string
}

export interface TreeNode {
  kind: 'drive_folder' | 'document' | 'data_table'
  ref: string
  name: string
  parent: string | null
  /** A table's columns. */
  columns?: string[]
  rows?: number
  outcome: string
}

export interface ImportView {
  id: string
  source: WorkImport['source']
  label: string | null
  status: WorkImport['status']
  counts: Record<string, number>
  notes: PlanNote[]
  summary: string | null
  error: string | null
  created_at: string
  finished_at: string | null
  undone_at: string | null
  destination: Record<string, unknown>
  tasks?: TaskPreview[]
  tree?: TreeNode[]
  /** Items not yet applied, made, matched, failed. */
  progress: { pending: number; created: number; matched: number; failed: number; total: number }
}

export function importSummaryView(imp: WorkImport): Omit<ImportView, 'progress' | 'tasks' | 'tree'> {
  return {
    id: imp.id,
    source: imp.source,
    label: imp.label,
    status: imp.status,
    counts: imp.counts,
    notes: imp.notes,
    summary: imp.summary,
    error: imp.error,
    created_at: imp.created_at,
    finished_at: imp.finished_at,
    undone_at: imp.undone_at,
    destination: imp.destination,
  }
}

async function namesOf(db: SupabaseClient, table: string, column: string, ids: readonly string[]): Promise<Map<string, string>> {
  if (!ids.length) return new Map()
  const { data } = await db.from(table).select(`id, ${column}`).in('id', [...new Set(ids)].slice(0, 500))
  return new Map(((data ?? []) as unknown as Array<Record<string, string>>).map((r) => [r.id, r[column]]))
}

export async function importView(db: SupabaseClient, svc: SupabaseClient, imp: WorkImport): Promise<ImportView> {
  const items = await loadItems(svc, imp.id)
  const progress = { pending: 0, created: 0, matched: 0, failed: 0, total: items.length }
  for (const i of items) if (i.outcome in progress) progress[i.outcome as keyof typeof progress]++
  const view: ImportView = { ...importSummaryView(imp), progress }
  const byRef = new Map(items.map((i) => [i.ref, i]))
  const refName = (ref: Ref | null): { id?: string; name?: string } => {
    if (!ref) return {}
    if ('id' in ref) return { id: ref.id }
    const r = byRef.get(ref.ref)?.record as { name?: string; title?: string } | undefined
    return { name: r?.name ?? r?.title }
  }

  if (imp.source === 'notion') {
    view.tree = items
      .filter((i): i is WorkImportItem => i.kind === 'drive_folder' || i.kind === 'document' || i.kind === 'data_table')
      .slice(0, 2000)
      .map((i) => {
        const r = i.record as DriveFolderRecord | DocumentRecord | DataTableRecord
        const parent = r.kind === 'drive_folder' ? r.parent : r.folder
        return {
          kind: r.kind,
          ref: i.ref,
          name: r.kind === 'document' ? r.title : r.name,
          parent: parent && 'ref' in parent ? parent.ref : null,
          ...(r.kind === 'data_table' ? { columns: r.headers.slice(0, 30), rows: r.rows.length } : {}),
          outcome: i.outcome,
        }
      })
    return view
  }

  const actions = items.filter((i) => i.kind === 'action').slice(0, PREVIEW_TASKS)
  const recs = actions.map((a) => a.record as ActionRecord)
  const ids = (pick: (r: ActionRecord) => Array<Ref | null>) => recs.flatMap(pick).flatMap((r) => (r && 'id' in r ? [r.id] : []))
  const [states, labels, projects, members] = await Promise.all([
    namesOf(db, 'workflow_state', 'name', ids((r) => [r.status])),
    namesOf(db, 'label', 'name', ids((r) => r.labels)),
    namesOf(db, 'projects', 'name', ids((r) => [r.project])),
    namesOf(db, 'member', 'display_name', recs.flatMap((r) => (r.assignee_member_id ? [r.assignee_member_id] : []))),
  ])
  const name = (ref: Ref | null, map: Map<string, string>) => {
    const n = refName(ref)
    return n.id ? map.get(n.id) ?? null : n.name ?? null
  }
  view.tasks = actions.map((a, k) => {
    const r = recs[k]
    return {
      source: r.source_label,
      title: r.title,
      status: name(r.status, states),
      priority: r.priority,
      assignee: r.assignee_member_id ? members.get(r.assignee_member_id) ?? null : null,
      due_date: r.due_date,
      project: name(r.project, projects),
      labels: r.labels.map((l) => name(l, labels)).filter((x): x is string => !!x),
      parent: r.parent && 'ref' in r.parent ? (byRef.get(r.parent.ref)?.record as ActionRecord | undefined)?.source_label ?? null : null,
      outcome: a.outcome,
    }
  })
  return view
}
