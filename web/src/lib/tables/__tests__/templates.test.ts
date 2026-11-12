import { describe, expect, it } from 'vitest'
import { planComputed } from '../computed'
import { validateOps, type DataOpInput } from '../ops'
import { isTemplateId, TEMPLATE_IDS, tableTemplate, tableTemplates, templateViewRow } from '../templates'
import type { DataColumn } from '../types'

const NOW = new Date('2026-11-11T12:00:00Z')

/** The batch createTable sends for a starter: its columns, then its rows. */
function batchOf(id: (typeof TEMPLATE_IDS)[number]): DataOpInput[] {
  const t = tableTemplate(id, NOW)
  return [
    ...t.columns.map((c): DataOpInput => ({ op: 'create_column', key: c.key, label: c.label, field_type: c.field_type, options: c.options, config: c.config })),
    { op: 'insert_rows', rows: t.rows },
  ]
}

describe('starter tables', () => {
  it('offers the five starters, by id', () => {
    expect(tableTemplates(NOW).map((t) => t.name)).toEqual(['Simple list', 'Pipeline', 'Inventory', 'Job tracker', 'Contacts'])
    expect(isTemplateId('pipeline')).toBe(true)
    expect(isTemplateId('crm')).toBe(false)
  })

  for (const id of TEMPLATE_IDS) {
    it(`${id}: the write path takes its columns and example rows as they are`, () => {
      const t = tableTemplate(id, NOW)
      expect(t.rows.length).toBeGreaterThanOrEqual(2)
      expect(t.rows.length).toBeLessThanOrEqual(3)
      const checked = validateOps([], batchOf(id))
      if (!checked.ok) throw new Error(checked.error)
      // Every value an example row gives was kept (nothing coerced away).
      const inserted = checked.value.find((o) => o.op === 'insert_rows')
      expect(inserted && inserted.op === 'insert_rows' && inserted.rows.map((r) => Object.keys(r.values ?? {}).sort())).toEqual(t.rows.map((r) => Object.keys(r.values ?? {}).sort()))
    })

    it(`${id}: its formulas work out and its views name its own columns`, () => {
      const t = tableTemplate(id, NOW)
      const checked = validateOps([], batchOf(id))
      if (!checked.ok) throw new Error(checked.error)
      const columns = checked.value
        .filter((o) => o.op === 'create_column')
        .map((o) => o as Extract<typeof o, { op: 'create_column' }>)
        .map((o): DataColumn => ({ id: o.key, table_id: 't', key: o.key, label: o.label, field_type: o.field_type, options: o.options ?? [], config: o.config ?? {}, position: 0, deleted_at: null }))
      for (const [, e] of planComputed(columns).entries) expect(e.error).toBeUndefined()
      const keys = new Set(t.columns.map((c) => c.key))
      for (const v of t.views) {
        if (v.group_by) expect(keys.has(v.group_by)).toBe(true)
        if (v.sort) expect(keys.has(v.sort.key)).toBe(true)
        if (v.filter) expect(keys.has(v.filter.key)).toBe(true)
        for (const k of [v.table?.date_key, v.table?.total_key, v.table?.cover_key]) if (k) expect(keys.has(k)).toBe(true)
      }
    })
  }

  it('a view is stored the way the views system reads it', () => {
    const t = tableTemplate('inventory', NOW)
    expect(templateViewRow(t.views[1])).toEqual({
      name: 'To reorder',
      layout: 'grid',
      grouping: null,
      ordering: [],
      filters: [{ id: 'reorder-filter', field: 'custom_fields.reorder', operator: 'is', value: true }],
      metadata: {},
    })
    expect(templateViewRow(tableTemplate('pipeline', NOW).views[0])).toMatchObject({ layout: 'board', grouping: { field: 'custom_fields.stage', direction: 'asc' }, metadata: { table: { total_key: 'value' } } })
  })

  it('example dates sit around today', () => {
    const t = tableTemplate('jobs', NOW)
    expect(t.rows.map((r) => r.values?.scheduled)).toEqual(['2026-11-13', '2026-11-11', '2026-11-05'])
  })
})
