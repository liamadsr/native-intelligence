/**
 * Migration 529, Tables phase 4: a table's saved views. Applied to DEV after
 * a rolled-back dry run, which read back the view_layout values (list,
 * board, graph, grid, calendar, gallery), 'data_row' on view_entity_type,
 * the scope CHECK with 'data_table' added to 257's list, and both indexes.
 * These hold the shape that made it so: the app's layouts and scope are the
 * database's, the scope CHECK is the newest and keeps every older scope, and
 * the containment index is the operator class the views' filters use.
 */
import { describe, expect, it } from 'vitest'
import { migrationsInOrder } from '@/test/migration-sql'
import { TABLE_LAYOUTS } from '@/lib/views/types'

const all = migrationsInOrder()
const sql = all.find((m) => m.file.startsWith('529_'))!.sql
const quoted = (s: string) => [...s.matchAll(/'([a-z_]+)'/g)].map((x) => x[1])

describe('529: a table’s saved views', () => {
  it('adds the kind and the table layouts to their enums', () => {
    expect(sql).toMatch(/alter type public\.view_entity_type add value if not exists 'data_row';/)
    const added = [...sql.matchAll(/alter type public\.view_layout add value if not exists '([a-z]+)';/g)].map((m) => m[1])
    // A board was every kind's already (039).
    expect([...added, 'board'].sort()).toEqual([...TABLE_LAYOUTS].sort())
  })

  it('the scope CHECK is the newest, adds data_table and keeps every older scope', () => {
    const hits = all.flatMap((m) =>
      [...m.sql.matchAll(/add constraint view_scope_type_check\s+check \(scope_type is null or scope_type in \(([^)]*)\)\)/gi)].map((h) => ({ file: m.file, list: quoted(h[1]) })),
    )
    const last = hits[hits.length - 1]
    expect(last.file.startsWith('529_')).toBe(true)
    const before = hits[hits.length - 2]
    expect(before.file.startsWith('257_')).toBe(true)
    expect(last.list).toEqual([...before.list, 'data_table'])
  })

  it('indexes the rows’ values for containment (jsonb_path_ops) and the name for a sort, live rows only', () => {
    expect(sql).toMatch(/create index if not exists data_row_custom_fields_idx\s+on public\.data_row using gin \(custom_fields jsonb_path_ops\)\s+where archived_at is null;/)
    expect(sql).toMatch(/create index if not exists data_row_table_title_idx\s+on public\.data_row \(table_id, title\)\s+where archived_at is null;/)
  })

  it('never uses an enum value it adds (one transaction)', () => {
    const body = sql.replace(/^--.*$/gm, '')
    expect(body.match(/'data_row'/g)).toHaveLength(1)
    for (const layout of ['grid', 'calendar', 'gallery']) expect(body.match(new RegExp(`'${layout}'`, 'g'))).toHaveLength(1)
  })
})
