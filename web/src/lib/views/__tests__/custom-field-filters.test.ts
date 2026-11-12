/**
 * Views by custom field, in the engine: a filter or a sort on
 * `custom_fields.<key>` becomes a PostgREST json path on the record's
 * `custom_fields`, `->` (jsonb, numbers compare as numbers) for a number and
 * `->>` (text) for everything else; a malformed key or a kind that takes no
 * fields is ignored, never put in a column string; and every kind that takes
 * fields selects them, so a column can draw them.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyFilters, applyOrdering, buildEntityQuery, groupResults, layoutCustomSelectGroups } from '@/lib/views/query-engine'
import { CUSTOM_FIELD_ENTITY_TYPES } from '@/lib/knowledge/entity-registry'
import type { FilterOperator, ViewEntityType, ViewFilter } from '@/lib/views/types'

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

async function run(field: string, operator: FilterOperator, value: unknown, entityType: ViewEntityType = 'company') {
  const { query, calls } = makeQuerySpy()
  const f: ViewFilter = { id: 'f', field, operator, value: value as ViewFilter['value'] }
  await applyFilters(query as never, entityType, [f])
  return calls
}

describe('custom field filters', () => {
  it('a number compares through -> (jsonb), so 6 is less than 10', async () => {
    expect(await run('custom_fields.retainer_months', 'gt', 10)).toEqual([
      { method: 'gt', args: ['custom_fields->retainer_months', 10] },
    ])
    expect(await run('custom_fields.retainer_months', 'is', 6)).toEqual([
      { method: 'eq', args: ['custom_fields->retainer_months', 6] },
    ])
    expect(await run('custom_fields.retainer_months', 'is_not', 6)).toEqual([
      { method: 'neq', args: ['custom_fields->retainer_months', 6] },
    ])
  })

  it('a number range applies only the bounds that are set', async () => {
    expect(await run('custom_fields.retainer_months', 'between', { from: 3, to: 12 })).toEqual([
      { method: 'gte', args: ['custom_fields->retainer_months', 3] },
      { method: 'lte', args: ['custom_fields->retainer_months', 12] },
    ])
    expect(await run('custom_fields.retainer_months', 'between', { from: '', to: 12 })).toEqual([
      { method: 'lte', args: ['custom_fields->retainer_months', 12] },
    ])
  })

  it('a select compares its option as text through ->>', async () => {
    expect(await run('custom_fields.project_type', 'is', 'Brand')).toEqual([
      { method: 'eq', args: ['custom_fields->>project_type', 'Brand'] },
    ])
    expect(await run('custom_fields.project_type', 'is_any_of', ['Brand', 'Website'])).toEqual([
      { method: 'filter', args: ['custom_fields->>project_type', 'in', '("Brand","Website")'] },
    ])
  })

  it('escapes a quote inside an option for "is any of" as for "is none of"', async () => {
    expect(await run('custom_fields.pipe_size', 'is_any_of', ['12" pipe, large', 'a\\b'])).toEqual([
      { method: 'filter', args: ['custom_fields->>pipe_size', 'in', '("12\\" pipe, large","a\\\\b")'] },
    ])
    expect(await run('custom_fields.pipe_size', 'is_none_of', ['12" pipe, large'])).toEqual([
      { method: 'not', args: ['custom_fields->>pipe_size', 'in', '("12\\" pipe, large")'] },
    ])
  })

  it('a list of numbers compares through ->', async () => {
    expect(await run('custom_fields.retainer_months', 'is_any_of', [6, 12])).toEqual([
      { method: 'filter', args: ['custom_fields->retainer_months', 'in', '(6,12)'] },
    ])
  })

  it('quotes "is none of" options so a comma or bracket stays inside its option', async () => {
    expect(await run('custom_fields.project_type', 'is_none_of', ['Brand, print', 'Web (new)'])).toEqual([
      { method: 'not', args: ['custom_fields->>project_type', 'in', '("Brand, print","Web (new)")'] },
    ])
  })

  it('text takes the text operators through ->>', async () => {
    expect(await run('custom_fields.referral_source', 'contains', 'fair')).toEqual([
      { method: 'ilike', args: ['custom_fields->>referral_source', '%fair%'] },
    ])
    expect(await run('custom_fields.referral_source', 'starts_with', 'Trade')).toEqual([
      { method: 'ilike', args: ['custom_fields->>referral_source', 'Trade%'] },
    ])
  })

  it('"is" on text keeps a value that only starts like a date', async () => {
    expect(await run('custom_fields.referral_source', 'is', '2026-11-10 kickoff')).toEqual([
      { method: 'eq', args: ['custom_fields->>referral_source', '2026-11-10 kickoff'] },
    ])
  })

  it('a date compares as a YYYY-MM-DD day, an instant read as its day', async () => {
    expect(await run('custom_fields.renewal_date', 'gte', '2026-12-01')).toEqual([
      { method: 'gte', args: ['custom_fields->>renewal_date', '2026-12-01'] },
    ])
    expect(await run('custom_fields.renewal_date', 'lt', '2026-12-01T00:00:00.000Z')).toEqual([
      { method: 'lt', args: ['custom_fields->>renewal_date', '2026-12-01'] },
    ])
    expect(await run('custom_fields.renewal_date', 'is', '2026-12-01')).toEqual([
      { method: 'eq', args: ['custom_fields->>renewal_date', '2026-12-01'] },
    ])
  })

  it('a relative window is a pair of days', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 10, 10, 15, 0, 0))
    try {
      const calls = await run('custom_fields.renewal_date', 'is_relative', { direction: 'future', count: 7, unit: 'day' })
      expect(calls).toEqual([
        { method: 'gte', args: ['custom_fields->>renewal_date', '2026-11-10'] },
        { method: 'lte', args: ['custom_fields->>renewal_date', '2026-11-17'] },
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('empty and not empty are a null test on the text value', async () => {
    expect(await run('custom_fields.project_type', 'is_empty', '')).toEqual([
      { method: 'is', args: ['custom_fields->>project_type', null] },
    ])
    expect(await run('custom_fields.project_type', 'is_not_empty', '')).toEqual([
      { method: 'not', args: ['custom_fields->>project_type', 'is', null] },
    ])
  })

  it('an unfilled chip applies nothing', async () => {
    expect(await run('custom_fields.project_type', 'is', '')).toEqual([])
    expect(await run('custom_fields.project_type', 'is_any_of', [])).toEqual([])
  })

  it('works on every kind that takes fields, tasks included', async () => {
    for (const kind of CUSTOM_FIELD_ENTITY_TYPES) {
      expect(await run('custom_fields.tier', 'is', 'Gold', kind as ViewEntityType)).toEqual([
        { method: 'eq', args: ['custom_fields->>tier', 'Gold'] },
      ])
    }
  })

  it('ignores a kind that takes no fields', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(await run('custom_fields.tier', 'is', 'Gold', 'capture')).toEqual([])
      expect(await run('custom_fields.tier', 'is', 'Gold', 'email_thread')).toEqual([])
    } finally {
      warn.mockRestore()
    }
  })

  it('never puts a malformed key in a column string', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const field of [
        'custom_fields.',
        'custom_fields.Tier',
        'custom_fields.tier->>x',
        'custom_fields.tier,id.eq.1',
        'custom_fields.tier.nested',
        'custom_fields.1tier',
        `custom_fields.${'a'.repeat(41)}`,
      ]) {
        expect(await run(field, 'is', 'Gold')).toEqual([])
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('custom field sorts', () => {
  it('orders through -> with records lacking the field last', () => {
    const { query, calls } = makeQuerySpy()
    applyOrdering(query as never, [{ field: 'custom_fields.retainer_months', direction: 'desc' }], 'company')
    expect(calls).toEqual([{ method: 'order', args: ['custom_fields->retainer_months', { ascending: false, nullsFirst: false }] }])
  })

  it('drops a sort on a malformed key, a kind without fields, or an unknown kind', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const [field, kind] of [
        ['custom_fields.tier;drop', 'company'],
        ['custom_fields.tier', 'capture'],
        ['custom_fields.tier', undefined],
      ] as const) {
        const { query, calls } = makeQuerySpy()
        applyOrdering(query as never, [{ field, direction: 'asc' }], kind as ViewEntityType | undefined)
        expect(calls).toEqual([])
      }
    } finally {
      warn.mockRestore()
    }
  })
})

describe('custom field selects', () => {
  function selectFor(entityType: ViewEntityType): string {
    let selected = ''
    const { query } = makeQuerySpy()
    const supabase = {
      from: () => ({
        select: (cols: string) => {
          selected = cols
          return query
        },
      }),
    }
    buildEntityQuery(supabase as never, entityType, 'ws-1', 'user-1')
    return selected
  }

  it('every kind that takes fields selects custom_fields', () => {
    for (const kind of CUSTOM_FIELD_ENTITY_TYPES) {
      expect(selectFor(kind as ViewEntityType).split(/[\s,]+/)).toContain('custom_fields')
    }
  })
})

describe('a custom select board laid out by its definition', () => {
  function supabaseWith(def: unknown, calls: unknown[][] = []) {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq']) chain[m] = (...a: unknown[]) => { calls.push([m, ...a]); return chain }
    chain.maybeSingle = async () => ({ data: def, error: null })
    return { from: (t: string) => { calls.push(['from', t]); return chain } }
  }
  const grouped = () => groupResults(
    [
      { id: 'd1', custom_fields: { project_type: 'Website' } },
      { id: 'd2', custom_fields: { project_type: 'Retired option' } },
    ],
    { field: 'custom_fields.project_type', direction: 'asc' },
  )

  it('gives every option a column, in option order, then old values, then No value', async () => {
    const calls: unknown[][] = []
    const out = await layoutCustomSelectGroups(
      supabaseWith({ field_type: 'select', options: ['Brand', 'Website', 'Packaging'] }, calls) as never,
      'ws-1', 'company', { field: 'custom_fields.project_type', direction: 'asc' }, grouped(),
    )
    expect(out.map((g) => [g.key, g.items.length])).toEqual([
      ['Brand', 0], ['Website', 1], ['Packaging', 0], ['Retired option', 1], ['__none__', 0],
    ])
    expect(calls).toEqual([
      ['from', 'custom_field_definition'],
      ['select', 'field_type, options'],
      ['eq', 'workspace_id', 'ws-1'],
      ['eq', 'entity_type', 'company'],
      ['eq', 'key', 'project_type'],
    ])
  })

  it('a brand-new field still has a column per option to drag into', async () => {
    const empty = groupResults([{ id: 'd1', custom_fields: {} }], { field: 'custom_fields.tier', direction: 'asc' })
    const out = await layoutCustomSelectGroups(
      supabaseWith({ field_type: 'select', options: ['Gold', 'Silver'] }) as never,
      'ws-1', 'action', { field: 'custom_fields.tier', direction: 'desc' }, empty,
    )
    expect(out.map((g) => g.key)).toEqual(['Silver', 'Gold', '__none__'])
  })

  it('leaves the groups alone for a non-select field, a missing one, or a kind without fields', async () => {
    const g = grouped()
    expect(await layoutCustomSelectGroups(supabaseWith({ field_type: 'text', options: [] }) as never, 'ws-1', 'company', { field: 'custom_fields.project_type', direction: 'asc' }, g)).toBe(g)
    expect(await layoutCustomSelectGroups(supabaseWith(null) as never, 'ws-1', 'company', { field: 'custom_fields.project_type', direction: 'asc' }, g)).toBe(g)
    const calls: unknown[][] = []
    expect(await layoutCustomSelectGroups(supabaseWith(null, calls) as never, 'ws-1', 'capture', { field: 'custom_fields.project_type', direction: 'asc' }, g)).toBe(g)
    expect(await layoutCustomSelectGroups(supabaseWith(null, calls) as never, 'ws-1', 'company', { field: 'stage_id', direction: 'asc' }, g)).toBe(g)
    expect(calls).toEqual([])
  })
})

describe('grouping by a custom select field', () => {
  it('groups by the record value, the records without one last', () => {
    const groups = groupResults(
      [
        { id: 'd1', custom_fields: { project_type: 'Website' } },
        { id: 'd2', custom_fields: {} },
        { id: 'd3', custom_fields: { project_type: 'Brand' } },
        { id: 'd4', custom_fields: { project_type: 'Website' } },
      ],
      { field: 'custom_fields.project_type', direction: 'asc' },
    )
    expect(groups.map((g) => [g.key, g.label, g.items.map((i) => i.id)])).toEqual([
      ['Brand', 'Brand', ['d3']],
      ['Website', 'Website', ['d1', 'd4']],
      ['__none__', 'No value', ['d2']],
    ])
  })
})
