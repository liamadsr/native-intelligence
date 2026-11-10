/**
 * Tables (phase 1, migrations 520 and 521): a workspace's own databases. A
 * table has rows; a row has a title (the primary column, what a mention or a
 * link shows) and the values of the table's own columns. Columns are
 * `custom_field_definition` rows with a `table_id`, so a column takes exactly
 * the field types every kind's custom fields take (src/lib/crm/custom-fields.ts).
 *
 * Every write is one batch of ops (`DataOp`), applied all or nothing by the
 * `apply_data_ops` RPC against the version the writer read. Each batch is one
 * `data_change` row, the undo log: its `changes` say what each op did, with
 * every field's before and after (`DataChangeEntry`).
 *
 * Client-safe: plain types and constants only.
 */
import type { CustomFieldType, CustomFieldValue } from '@/lib/crm/custom-fields'

export type DataTableVisibility = 'workspace' | 'private'
export const DATA_TABLE_VISIBILITIES = ['workspace', 'private'] as const

/** Where a batch came from (data_change.source). */
export type DataChangeSource = 'person' | 'agent' | 'import' | 'email' | 'capture' | 'sms'
export const DATA_CHANGE_SOURCES = ['person', 'agent', 'import', 'email', 'capture', 'sms'] as const

/**
 * A table column's custom_field_definition.entity_type (520): beside the
 * registry's customFields kinds in the CHECK, never one of them.
 */
export const TABLE_COLUMN_ENTITY_TYPE = 'data_row' as const

/** The column types a table takes: the custom field types, one list. */
export type DataColumnType = CustomFieldType

/** The limits the database enforces too (520). */
export const TABLE_LIMITS = {
  name: 200,
  icon: 32,
  description: 2000,
  title: 2000,
  label: 60,
  options: 50,
  opsPerBatch: 500,
  rowsPerOp: 1000,
  reason: 500,
} as const

/** The rows a new table starts with (blank, under a Name column: the title). */
export const NEW_TABLE_ROWS = 3

export interface DataTable {
  id: string
  workspace_id: string
  name: string
  icon: string | null
  description: string | null
  owner_member_id: string | null
  visibility: DataTableVisibility
  version: number
  position: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

export interface DataColumn {
  id: string
  table_id: string
  key: string
  label: string
  field_type: DataColumnType
  options: string[]
  position: number
  deleted_at: string | null
}

export interface DataRow {
  id: string
  table_id: string
  title: string
  custom_fields: Record<string, CustomFieldValue>
  /** Order in the table. A numeric in Postgres: a string here when it has more digits than a double holds. */
  position: number | string
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** A table with its live columns, in order. */
export interface DataTableWithColumns extends DataTable {
  columns: DataColumn[]
}

// ── Ops: what a write batch asks for ────────────────────────────────────────

export interface NewRow {
  /** A client-made id, so the writer can name the row before the reply. */
  id?: string
  title?: string
  values?: Record<string, CustomFieldValue>
}

export type DataOp =
  | { op: 'update_table'; name?: string; icon?: string | null; description?: string | null; visibility?: DataTableVisibility }
  | { op: 'archive_table' }
  | { op: 'restore_table' }
  | { op: 'create_column'; key: string; label: string; field_type: DataColumnType; options?: string[] }
  | { op: 'update_column'; key: string; label?: string; options?: string[] }
  | { op: 'delete_column'; key: string }
  | { op: 'restore_column'; key: string }
  | { op: 'reorder_columns'; keys: string[] }
  | { op: 'insert_rows'; rows: NewRow[] }
  | { op: 'update_row'; row_id: string; title?: string; values?: Record<string, CustomFieldValue> }
  | { op: 'archive_rows'; row_ids: string[] }
  | { op: 'restore_rows'; row_ids: string[] }
  /** After a row (null: to the top), or back to an exact position (an undo). */
  | { op: 'move_row'; row_id: string; after_row_id?: string | null; position?: string }

export type DataOpKind = DataOp['op']
export const DATA_OP_KINDS: readonly DataOpKind[] = [
  'update_table',
  'archive_table',
  'restore_table',
  'create_column',
  'update_column',
  'delete_column',
  'restore_column',
  'reorder_columns',
  'insert_rows',
  'update_row',
  'archive_rows',
  'restore_rows',
  'move_row',
]

// ── Changes: what a batch did (data_change.changes) ─────────────────────────

export interface FieldChange<T = unknown> {
  from: T
  to: T
}

export type DataChangeEntry =
  | { op: 'create_table' }
  | { op: 'update_table'; fields: Partial<Record<'name' | 'icon' | 'description' | 'visibility', FieldChange<string | null>>> }
  | { op: 'archive_table' }
  | { op: 'restore_table' }
  | { op: 'create_column'; key: string; column_id: string; label: string; field_type: DataColumnType; options: string[] }
  | { op: 'update_column'; key: string; fields: { label?: FieldChange<string>; options?: FieldChange<string[]> } }
  | { op: 'delete_column'; key: string }
  | { op: 'restore_column'; key: string }
  | { op: 'reorder_columns'; from: string[]; to: string[] }
  | { op: 'insert_rows'; row_ids: string[] }
  /** fields: `title`, and `values.<column key>` (null for a value not set). */
  | { op: 'update_row'; row_id: string; fields: Record<string, FieldChange<CustomFieldValue | string>> }
  | { op: 'archive_rows'; row_ids: string[] }
  | { op: 'restore_rows'; row_ids: string[] }
  | { op: 'move_row'; row_id: string; from: string; to: string }

export interface DataChange {
  id: string
  table_id: string
  version: number
  actor_user_id: string | null
  actor_member_id: string | null
  source: DataChangeSource
  reason: string | null
  changes: DataChangeEntry[]
  undo_of: string | null
  undone_at: string | null
  created_at: string
}

/** What a write batch answers. */
export interface ApplyResult {
  version: number
  /** Null when the batch changed nothing (no version bump, no log row). */
  change_id: string | null
  inserted_row_ids: string[]
  created_column_ids: Record<string, string>
}
