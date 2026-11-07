/**
 * The Cases tab's default ordering, and the Ordering control that renders it.
 *
 * Two defects met here, and they are the same mistake seen from both ends:
 *
 *  1. The default was a SINGLE key, `sort_order asc`. Nothing in the feature
 *     ever writes `sort_order` — migration 252 declares it `integer NOT NULL
 *     DEFAULT 0` and every code path only reads it — so every row holds 0 and
 *     the sort is a total tie. Postgres may then return a different order per
 *     statement, and the list's OFFSET pagination (`range(n, n+49)`, then
 *     `range(n+50, …)` on scroll) would show a case twice or skip it outright.
 *     The suite's own reader already carries the tie-break the 252 index
 *     `(suite_id, sort_order, created_at)` was built for.
 *  2. `sort_order` was not declared in FILTERABLE_FIELDS, which is the ONLY
 *     source ViewSettingsPopover builds its Ordering select from — so the
 *     control rendered blank (a Radix Select whose value matches no item) and
 *     the direction toggle rewrote the ordering from a fallback.
 *
 * Both stay fixed only if the default ordering and the sortable-field list are
 * pinned against each other, which is what the last test here does.
 */
import { describe, it, expect } from 'vitest'
import { defaultConfig } from '@/components/views/hooks/use-view'
import { FILTERABLE_FIELDS, type ViewEntityType } from '@/lib/views/types'

/** The same derivation ViewSettingsPopover uses for its Ordering select. */
function sortableFields(entityType: ViewEntityType) {
  return FILTERABLE_FIELDS[entityType].filter(
    (f) => f.type !== 'relation' && f.type !== 'label' && f.type !== 'tag',
  )
}

describe('eval_case default ordering', () => {
  it('orders by sort_order, then created_at — never a bare tie', () => {
    expect(defaultConfig('eval_case').ordering).toEqual([
      { field: 'sort_order', direction: 'asc' },
      { field: 'created_at', direction: 'asc' },
    ])
  })

  it('sort_order is a sortable field, so the Ordering control has an item for it', () => {
    expect(sortableFields('eval_case').map((f) => f.field)).toContain('sort_order')
  })

  it('sort_order stays OUT of the filter picker — it is machine order, not a user filter', async () => {
    const { FIELD_CATEGORIES } = await import('@/lib/views/types')
    for (const category of FIELD_CATEGORIES.eval_case) {
      expect(category.fields).not.toContain('sort_order')
    }
  })
})

describe('every entity default ordering is renderable and unambiguous', () => {
  const entityTypes = Object.keys(FILTERABLE_FIELDS) as ViewEntityType[]

  it.each(entityTypes)('%s', (entityType) => {
    const ordering = defaultConfig(entityType).ordering ?? []
    // The library's endpoints already order each collection. Its settings
    // have an explicit Default option, covered in view-settings-ordering.
    if (entityType === 'agent' || entityType === 'skill') {
      expect(ordering).toEqual([])
      return
    }
    expect(ordering.length).toBeGreaterThan(0)
    // The Ordering select shows only the FIRST key, and a Radix Select whose
    // value matches no SelectItem renders a blank trigger.
    const sortable = new Set(sortableFields(entityType).map((f) => f.field))
    // eval_run's `started_at` is its only birth time (252 gives it no
    // created_at), and eval_suite/eval_run declare it; everything else must be
    // a declared field too or the control goes blank.
    expect(
      sortable.has(ordering[0].field),
      `${entityType} defaults to ordering on "${ordering[0].field}", which has no SelectItem`,
    ).toBe(true)
  })
})
