import { describe, expect, it } from 'vitest'
import { canOfferUndo, cellText, describeChange } from '../describe'
import type { DataChangeEntry } from '../types'

const c = (changes: DataChangeEntry[], undo_of: string | null = null) => ({ changes, undo_of, undone_at: null })
const cols = [{ key: 'status', label: 'Status' }]

describe('describeChange', () => {
  it('says a table’s first batch made it, whatever else it held', () => {
    expect(describeChange(c([{ op: 'create_table' }, { op: 'insert_rows', row_ids: ['a', 'b', 'c'] }]))).toBe('Made the table')
  })

  it('counts edited rows once each, and names columns by their label', () => {
    expect(describeChange(c([{ op: 'update_row', row_id: 'a', fields: {} }, { op: 'update_row', row_id: 'a', fields: {} }, { op: 'update_row', row_id: 'b', fields: {} }]))).toBe('Edited 2 rows')
    expect(describeChange(c([{ op: 'create_column', key: 'status', column_id: 'x', label: 'Status', field_type: 'select', options: [] }, { op: 'insert_rows', row_ids: ['a'] }]), cols)).toBe('Added column “Status” and added 1 row')
  })

  it('says an undo is one', () => {
    expect(describeChange(c([{ op: 'archive_rows', row_ids: ['a'] }], 'c1'))).toBe('Undid a change: archived 1 row')
  })
})

describe('canOfferUndo', () => {
  it('offers it on a change that can be taken back only', () => {
    expect(canOfferUndo(c([{ op: 'insert_rows', row_ids: ['a'] }]))).toBe(true)
    expect(canOfferUndo(c([{ op: 'create_table' }]))).toBe(false)
    expect(canOfferUndo(c([{ op: 'insert_rows', row_ids: ['a'] }], 'c1'))).toBe(false)
    expect(canOfferUndo({ ...c([{ op: 'archive_table' }]), undone_at: '2026-11-10' })).toBe(false)
  })
})

describe('cellText', () => {
  it('shows an empty cell as empty', () => {
    expect(cellText(null)).toBe('')
    expect(cellText(undefined)).toBe('')
    expect(cellText('Done')).toBe('Done')
  })
})
