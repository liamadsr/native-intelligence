/**
 * Label filters on a real PostgREST builder are a join, not an id list.
 *
 * Resolving "has label X" to `id=in.(…every tagged row…)` overflowed the
 * request URL once a label tagged a few hundred rows (the view errored) and
 * stopped at 1000 junction rows. On a PostgREST builder the filter is now an
 * aliased embed of the junction table: `!inner` for includes/equals, and a
 * label-filtered embed tested for null (anti-join) for excludes. The spy-based
 * tests in capture-label-filter.test.ts cover the subquery path a non-PostgREST
 * query still takes.
 */
import { describe, it, expect, vi } from 'vitest'
import { PostgrestClient } from '@supabase/postgrest-js'
import { applyFilters } from '@/lib/views/query-engine'
import type { ViewFilter } from '@/lib/views/types'

function actionQuery() {
  return new PostgrestClient('http://db.test').from('actions').select('id, labels:action_label(label:label(id, name, color))')
}

function labelFilter(operator: ViewFilter['operator'], value: ViewFilter['value']): ViewFilter[] {
  return [{ id: 'f', field: 'labels', operator, value }]
}

describe('label filters as a join', () => {
  it('includes adds an !inner junction embed filtered to the labels and reads no ids', async () => {
    const q = actionQuery()
    const supabase = { from: vi.fn() }
    await applyFilters(q as never, 'action', labelFilter('includes', ['l1', 'l2']), supabase as never, 'ws-1')
    const url = (q as unknown as { url: URL }).url
    expect(url.searchParams.get('select')).toBe(
      'id,labels:action_label(label:label(id,name,color)),label_match:action_label!inner(label_id)',
    )
    expect(url.searchParams.get('label_match.label_id')).toBe('in.(l1,l2)')
    expect(url.searchParams.has('id')).toBe(false)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('excludes is an anti-join: an embed filtered to the labels, required to be empty', async () => {
    const q = actionQuery()
    await applyFilters(q as never, 'action', labelFilter('excludes', ['l1']), { from: vi.fn() } as never, 'ws-1')
    const url = (q as unknown as { url: URL }).url
    expect(url.searchParams.get('select')).toContain(',label_exclude:action_label(label_id)')
    expect(url.searchParams.get('label_exclude.label_id')).toBe('in.(l1)')
    expect(url.searchParams.get('label_exclude')).toBe('is.null')
  })

  it('gives each label filter its own join, so "has A" and "has B" both hold', async () => {
    const q = actionQuery()
    const filters: ViewFilter[] = [
      { id: 'a', field: 'labels', operator: 'includes', value: ['l1'] },
      { id: 'b', field: 'labels', operator: 'includes', value: ['l2'] },
      { id: 'c', field: 'labels', operator: 'excludes', value: ['l3'] },
    ]
    await applyFilters(q as never, 'action', filters, { from: vi.fn() } as never, 'ws-1')
    const url = (q as unknown as { url: URL }).url
    expect(url.searchParams.get('select')).toBe(
      'id,labels:action_label(label:label(id,name,color)),label_match:action_label!inner(label_id),' +
        'label_match_2:action_label!inner(label_id),label_exclude:action_label(label_id)',
    )
    expect(url.searchParams.get('label_match.label_id')).toBe('in.(l1)')
    expect(url.searchParams.get('label_match_2.label_id')).toBe('in.(l2)')
    expect(url.searchParams.get('label_exclude.label_id')).toBe('in.(l3)')
  })

})
