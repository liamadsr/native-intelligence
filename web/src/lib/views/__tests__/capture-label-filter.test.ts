/**
 * Capture labels in the views pipeline.
 *
 * capture_label is a junction table exactly mirroring action_label, and the
 * generic applyJunctionFilter handles every operator once the three registry
 * entries exist. These tests pin the REGISTRATION (the CAPTURE_VIEW_SELECT
 * label embed, junction table / entity-id column names, types.ts
 * declarations) AND the subquery semantics of includes/excludes/equals:
 * embedded-resource filters only thin the embedded array — they never
 * exclude parent rows — so every value-carrying operator must resolve entity
 * ids through a junction subquery to actually filter the list.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyFilters, buildEntityQuery, NoMatchSignal } from '@/lib/views/query-engine'
import {
  DEFAULT_DISPLAY_PROPERTIES,
  DISPLAY_PROPERTIES,
  FIELD_CATEGORIES,
  FILTERABLE_FIELDS,
  type ViewFilter,
} from '@/lib/views/types'

/** A query spy that records every builder method call and returns itself. */
function makeQuerySpy() {
  const calls: Array<{ method: string; args: unknown[] }> = []
  const proxy: Record<string, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string) {
        return (...args: unknown[]) => {
          calls.push({ method: prop, args })
          return proxy
        }
      },
    },
  )
  return { query: proxy, calls }
}

/**
 * Supabase mock whose chains record from()/select()/in() args and resolve to
 * the given rows — enough to observe the junction subqueries.
 */
function makeSupabase(rows: unknown[]) {
  const froms: string[] = []
  const selects: string[] = []
  const ins: Array<{ column: string; values: unknown }> = []
  const result = { data: rows, error: null }
  const chain: Record<string, unknown> = new Proxy(
    {
      then: (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve),
    },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop]
        if (prop === 'select') {
          return (columns: string) => {
            selects.push(columns)
            return chain
          }
        }
        if (prop === 'in') {
          return (column: string, values: unknown) => {
            ins.push({ column, values })
            return chain
          }
        }
        return () => chain
      },
    },
  )
  return {
    supabase: {
      from: vi.fn((table: string) => {
        froms.push(table)
        return chain
      }),
    },
    froms,
    selects,
    ins,
  }
}

function labelFilter(operator: ViewFilter['operator'], value: ViewFilter['value'] = 'label-1'): ViewFilter[] {
  return [{ id: 'f', field: 'labels', operator, value }]
}

describe('CAPTURE_VIEW_SELECT label embed', () => {
  it('embeds labels via the capture_label junction, same shape as action rows', () => {
    const { supabase, selects } = makeSupabase([])
    buildEntityQuery(supabase as never, 'capture', 'ws-1', 'user-1')
    expect(selects[0]).toContain('labels:capture_label(label:label(id, name, color))')
  })
})

describe('capture label junction filters', () => {
  it('includes resolves capture ids through a capture_label subquery — an embedded filter would only thin the labels array, never exclude rows', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase, froms, selects, ins } = makeSupabase([
      { capture_id: 'cap-1' },
      { capture_id: 'cap-2' },
      { capture_id: 'cap-1' }, // two selected labels on the same capture — deduped
    ])
    await applyFilters(
      query as never,
      'capture',
      labelFilter('includes', ['label-1', 'label-2']),
      supabase as never,
      'ws-1',
    )
    expect(froms).toEqual(['capture_label'])
    expect(selects).toEqual(['capture_id'])
    expect(ins).toEqual([{ column: 'label_id', values: ['label-1', 'label-2'] }])
    expect(calls).toEqual([{ method: 'in', args: ['id', ['cap-1', 'cap-2']] }])
  })

  it('includes with zero labeled captures short-circuits (no sentinel uuid cast)', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([])
    await expect(
      applyFilters(query as never, 'capture', labelFilter('includes', ['label-1']), supabase as never, 'ws-1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('includes falls back to the embedded filter without a supabase client', async () => {
    const { query, calls } = makeQuerySpy()
    await applyFilters(query as never, 'capture', labelFilter('includes'))
    expect(calls).toEqual([
      { method: 'filter', args: ['capture_label.label_id', 'eq', 'label-1'] },
    ])
  })

  it('excludes removes the labeled capture ids via not-in', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase, ins } = makeSupabase([
      { capture_id: 'cap-1' },
      { capture_id: 'cap-2' },
    ])
    await applyFilters(
      query as never,
      'capture',
      labelFilter('excludes', ['label-1']),
      supabase as never,
      'ws-1',
    )
    expect(ins).toEqual([{ column: 'label_id', values: ['label-1'] }])
    expect(calls).toEqual([{ method: 'not', args: ['id', 'in', '(cap-1,cap-2)'] }])
  })

  it('excludes with zero labeled captures filters nothing', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([])
    await applyFilters(query as never, 'capture', labelFilter('excludes', ['label-1']), supabase as never, 'ws-1')
    expect(calls).toEqual([])
  })

  it('equals resolves capture ids through a capture_label subquery on capture_id', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase, froms, selects, ins } = makeSupabase([
      { capture_id: 'cap-1' },
      { capture_id: 'cap-2' },
    ])
    await applyFilters(query as never, 'capture', labelFilter('equals'), supabase as never, 'ws-1')
    expect(froms).toEqual(['capture_label'])
    expect(selects).toEqual(['capture_id'])
    expect(ins).toEqual([{ column: 'label_id', values: ['label-1'] }])
    expect(calls).toEqual([{ method: 'in', args: ['id', ['cap-1', 'cap-2']] }])
  })

  it('equals with zero labeled captures short-circuits (no sentinel uuid cast)', async () => {
    const { query, calls } = makeQuerySpy()
    const { supabase } = makeSupabase([])
    await expect(
      applyFilters(query as never, 'capture', labelFilter('equals'), supabase as never, 'ws-1'),
    ).rejects.toBeInstanceOf(NoMatchSignal)
    expect(calls).toEqual([])
  })

  it('is_empty / is_not_empty test the embedded junction for null', async () => {
    const empty = makeQuerySpy()
    await applyFilters(empty.query as never, 'capture', labelFilter('is_empty', ''))
    expect(empty.calls).toEqual([{ method: 'is', args: ['capture_label', null] }])

    const notEmpty = makeQuerySpy()
    await applyFilters(notEmpty.query as never, 'capture', labelFilter('is_not_empty', ''))
    expect(notEmpty.calls).toEqual([{ method: 'not', args: ['capture_label', 'is', null] }])
  })
})

describe('capture label registration in types.ts', () => {
  it('declares the labels filterable field, mirroring the action entry', () => {
    expect(FILTERABLE_FIELDS.capture.find((f) => f.field === 'labels')).toEqual({
      field: 'labels',
      label: 'Labels',
      type: 'label',
      isArray: true,
    })
  })

  it('surfaces labels in the capture filter-picker categories', () => {
    const allFields = FIELD_CATEGORIES.capture.flatMap((c) => c.fields)
    expect(allFields).toContain('labels')
  })

  it('labels display property is read-only — the captures PATCH route has no label_ids handling', () => {
    const labels = DISPLAY_PROPERTIES.capture.find((d) => d.field === 'labels')
    expect(labels).toBeDefined()
    expect(labels?.editable).toBeUndefined()
  })

  it('labels stays out of the capture display defaults (users toggle it on)', () => {
    expect(DEFAULT_DISPLAY_PROPERTIES.capture).not.toContain('labels')
  })
})
