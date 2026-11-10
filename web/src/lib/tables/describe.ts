/**
 * Tables: a change and a value in words, for the page's history and its cells.
 * Client-safe and pure.
 */
import type { CustomFieldValue } from '@/lib/crm/custom-fields'
import type { DataChange, DataChangeEntry, DataColumn } from './types'

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function entryWords(e: DataChangeEntry, label: (key: string) => string): string | null {
  switch (e.op) {
    case 'create_table':
      return 'made the table'
    case 'update_table': {
      const fields = Object.keys(e.fields ?? {})
      if (fields.includes('name')) return `renamed the table to “${e.fields.name?.to ?? ''}”`
      if (fields.includes('visibility')) return e.fields.visibility?.to === 'private' ? 'made the table private' : 'shared the table with the workspace'
      return `changed the table's ${fields.join(' and ')}`
    }
    case 'archive_table':
      return 'archived the table'
    case 'restore_table':
      return 'brought the table back'
    case 'create_column':
      return `added column ${label(e.key)}`
    case 'update_column':
      return e.fields?.label ? `renamed column “${e.fields.label.from}” to “${e.fields.label.to}”` : `changed column ${label(e.key)}'s options`
    case 'delete_column':
      return `deleted column ${label(e.key)}`
    case 'restore_column':
      return `brought back column ${label(e.key)}`
    case 'reorder_columns':
      return 'reordered the columns'
    case 'insert_rows':
      return `added ${plural(e.row_ids?.length ?? 0, 'row')}`
    case 'update_row':
      return null
    case 'archive_rows':
      return `archived ${plural(e.row_ids?.length ?? 0, 'row')}`
    case 'restore_rows':
      return `brought back ${plural(e.row_ids?.length ?? 0, 'row')}`
    case 'move_row':
      return 'moved a row'
    default:
      return null
  }
}

/**
 * "Added 3 rows", "Edited 2 rows", "Added column “Status” and 3 rows": one
 * line per change, the first part capitalized.
 */
export function describeChange(change: Pick<DataChange, 'changes' | 'undo_of'>, columns: readonly Pick<DataColumn, 'key' | 'label'>[] = []): string {
  const byKey = new Map(columns.map((c) => [c.key, c.label]))
  const label = (key: string) => `“${byKey.get(key) ?? key}”`
  const entries = Array.isArray(change.changes) ? change.changes : []
  const parts: string[] = []
  const edited = new Set(entries.filter((e) => e?.op === 'update_row').map((e) => (e as { row_id: string }).row_id))
  for (const e of entries) {
    const words = e ? entryWords(e, label) : null
    if (words && !parts.includes(words)) parts.push(words)
  }
  if (edited.size) parts.push(`edited ${plural(edited.size, 'row')}`)
  // A new table's first rows and columns are part of making it.
  const shown = parts.includes('made the table') ? ['made the table'] : parts
  const text = shown.length > 2 ? `${shown.slice(0, 2).join(', ')} and ${shown.length - 2} more` : shown.join(' and ')
  const line = text || 'changed nothing'
  const sentence = line.charAt(0).toUpperCase() + line.slice(1)
  return change.undo_of ? `Undid a change: ${line}` : sentence
}

/** Can the page offer Undo on this change? (The server decides; this only hides what it would refuse.) */
export function canOfferUndo(change: Pick<DataChange, 'changes' | 'undo_of' | 'undone_at'>): boolean {
  if (change.undo_of || change.undone_at) return false
  return !(Array.isArray(change.changes) ? change.changes : []).some((e) => e?.op === 'create_table')
}

/** A cell's value as text: an empty cell is empty. */
export function cellText(value: CustomFieldValue | undefined): string {
  if (value === null || value === undefined) return ''
  return typeof value === 'number' ? value.toLocaleString() : String(value)
}
