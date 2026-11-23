/**
 * The import journal's shapes (docs/plans/imports.md, migration 704).
 *
 * An import is planned as a list of items in the order they are applied. An
 * item names the things it needs either by our own id (a label that already
 * exists) or by the `ref` of an earlier item of the same import (a label this
 * import makes): apply resolves a ref to the id its item made. So a plan is
 * pure data, made and previewed before anything is written.
 *
 * Client-safe: the preview reads these.
 */

export const IMPORT_SOURCES = ['task_csv', 'linear', 'notion'] as const
export type ImportSource = (typeof IMPORT_SOURCES)[number]

export const IMPORT_STATUSES = ['staged', 'running', 'done', 'failed', 'undoing', 'undone', 'discarded'] as const
export type ImportStatus = (typeof IMPORT_STATUSES)[number]

export const ITEM_KINDS = ['label', 'project', 'workflow_state', 'action', 'drive_folder', 'document', 'data_table', 'asset'] as const
export type ItemKind = (typeof ITEM_KINDS)[number]

export type ItemOutcome = 'pending' | 'created' | 'matched' | 'skipped' | 'failed'
export type UndoOutcome = 'removed' | 'kept' | 'none'

/** Something an item needs: one we have, or one an earlier item makes. */
export type Ref = { id: string } | { ref: string }

export interface LabelRecord {
  kind: 'label'
  name: string
}

export interface ProjectRecord {
  kind: 'project'
  name: string
  description?: string | null
}

export interface WorkflowStateRecord {
  kind: 'workflow_state'
  team_id: string
  name: string
  category: 'backlog' | 'unstarted' | 'started' | 'completed' | 'canceled'
  color?: string
}

export interface ActionRecord {
  kind: 'action'
  team_id: string
  title: string
  description: string | null
  status: Ref
  priority: 'none' | 'low' | 'medium' | 'high' | 'urgent'
  assignee_member_id: string | null
  due_date: string | null
  project: Ref | null
  labels: Ref[]
  parent: Ref | null
  estimate: number | null
  /** Shown in the preview: the source's identifier ("ENG-42", "row 7"). */
  source_label: string
}

export interface DriveFolderRecord {
  kind: 'drive_folder'
  name: string
  /** The folder it sits in: an existing one, an earlier item's, or the top of Drive. */
  parent: Ref | null
}

export interface DocumentRecord {
  kind: 'document'
  title: string
  /** The body as markdown, with `{{ref:<ref>}}` where a link to another item goes and `{{asset:<ref>}}` where an image's address goes. */
  body: string
  folder: Ref | null
  visibility: 'workspace' | 'private'
}

export interface DataTableRecord {
  kind: 'data_table'
  name: string
  folder: Ref | null
  visibility: 'workspace' | 'private'
  headers: string[]
  rows: string[][]
}

export interface AssetRecord {
  kind: 'asset'
  /** Its path inside the upload (a Notion zip's entry). */
  path: string
  file_name: string
  mime_type: string
  size: number
}

export type ItemRecord = LabelRecord | ProjectRecord | WorkflowStateRecord | ActionRecord | DriveFolderRecord | DocumentRecord | DataTableRecord | AssetRecord

/** One item of a plan. */
export interface PlannedItem {
  /** Unique in its import: what later items name it by. */
  ref: string
  /** The source's own id (a Linear issue id, a Notion page id, a CSV row number). */
  external_id: string | null
  /** An existing record it matched: nothing is made, and its undo touches nothing. */
  matched_id?: string | null
  record: ItemRecord
}

/** One line of a preview's notes: what will happen that the person should know. */
export interface PlanNote {
  level: 'info' | 'warn'
  text: string
}

export interface ImportPlan {
  items: PlannedItem[]
  counts: Record<string, number>
  notes: PlanNote[]
}

export function isRef(value: unknown): value is Ref {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.id === 'string' || typeof v.ref === 'string'
}

/** "1,200 tasks". */
export function countOf(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}
