/**
 * Custom fields read by their own type (Tables, phase 4): with the field
 * types known (a table's columns, a kind's definitions), each filter reads a
 * value in its stored form. A select, a person, a checkbox, a multi-select
 * and a relation are containments on the whole `custom_fields` object (what
 * the jsonb_path_ops index of migration 529 answers); "is not" counts a row
 * with no value; "any of" is one or=(...) of quoted containments; a currency
 * compares its amount; "me" on a person is the caller's member id. Sorts
 * order a currency by its amount and skip what holds ids or lists.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyFilters, applyOrdering, customFieldTypesFor, fieldShapes, holdsTerm, isRelativeDateValue, viewFieldsOf, wallClockIn, type CustomFieldTypes } from '@/lib/views/query-engine'
import type { CustomFieldType } from '@/lib/crm/custom-field-types'
import { customFieldFilterFields } from '@/lib/views/custom-field-columns'
import { defaultOperatorFor, operatorsFor } from '@/components/views/filters/field-traits'
import type { FilterOperator, ViewFilter } from '@/lib/views/types'

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

const TYPES: CustomFieldTypes = fieldShapes(
  ([
    ['stage', 'select'],
    ['tags', 'multi_select'],
    ['paid', 'checkbox'],
    ['owner', 'person'],
    ['price', 'currency'],
    ['client', 'relation'],
    ['qty', 'number'],
    ['due', 'date'],
    ['notes', 'text'],
    ['site', 'url'],
  ] as Array<[string, CustomFieldType]>).map(([key, field_type]) => ({ key, field_type, config: key === 'price' ? { currency: 'USD' } : {} })),
)

async function run(key: string, operator: FilterOperator, value: unknown, resolved?: { memberId?: string; userId?: string }, timeZone?: string) {
  const { query, calls } = makeQuerySpy()
  const f: ViewFilter = { id: 'f', field: `custom_fields.${key}`, operator, value: value as ViewFilter['value'] }
  await applyFilters(query as never, 'data_row', [f], undefined, 'ws-1', resolved, { fieldTypes: TYPES, timeZone })
  return calls
}

describe('text, url', () => {
  it('contains and is read the text through ->>', async () => {
    expect(await run('notes', 'contains', 'oak')).toEqual([{ method: 'ilike', args: ['custom_fields->>notes', '%oak%'] }])
    expect(await run('site', 'is', 'https://fernhill.example')).toEqual([{ method: 'eq', args: ['custom_fields->>site', 'https://fernhill.example'] }])
    expect(await run('notes', 'is_empty', '')).toEqual([{ method: 'is', args: ['custom_fields->>notes', null] }])
  })
})

describe('number, currency', () => {
  it('a number range compares as jsonb', async () => {
    expect(await run('qty', 'between', { from: 2, to: 10 })).toEqual([
      { method: 'gte', args: ['custom_fields->qty', 2] },
      { method: 'lte', args: ['custom_fields->qty', 10] },
    ])
  })

  it('a currency compares its amount in its own code only, and is empty without one', async () => {
    const usd = { method: 'contains', args: ['custom_fields', { price: { currency: 'USD' } }] }
    expect(await run('price', 'gte', 1000)).toEqual([usd, { method: 'gte', args: ['custom_fields->price->amount', 1000] }])
    expect(await run('price', 'between', { from: 100, to: '' })).toEqual([usd, { method: 'gte', args: ['custom_fields->price->amount', 100] }])
    expect(await run('price', 'between', { from: 100, to: 900 })).toEqual([
      usd,
      { method: 'gte', args: ['custom_fields->price->amount', 100] },
      { method: 'lte', args: ['custom_fields->price->amount', 900] },
    ])
    expect(await run('price', 'is', '250')).toEqual([usd, { method: 'eq', args: ['custom_fields->price->amount', 250] }])
    expect(await run('price', 'is_empty', '')).toEqual([{ method: 'is', args: ['custom_fields->>price', null] }])
    expect(await run('price', 'is_not_empty', '')).toEqual([{ method: 'not', args: ['custom_fields->>price', 'is', null] }])
  })
})

describe('date', () => {
  it('a relative window is calendar days through ->>', async () => {
    const calls = await run('due', 'is_relative', { unit: 'day', direction: 'future', count: 7 })
    expect(calls.map((c) => [c.method, c.args[0]])).toEqual([
      ['gte', 'custom_fields->>due'],
      ['lte', 'custom_fields->>due'],
    ])
    for (const c of calls) expect(String(c.args[1])).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('select', () => {
  it('is, is not, any of, none of', async () => {
    expect(await run('stage', 'is', 'Won')).toEqual([{ method: 'contains', args: ['custom_fields', { stage: 'Won' }] }])
    // As a column's `neq`: a stage, and not Won (a row with none isn't counted).
    expect(await run('stage', 'is_not', 'Won')).toEqual([
      { method: 'not', args: ['custom_fields->>stage', 'is', null] },
      { method: 'not', args: ['custom_fields', 'cs', '{"stage":"Won"}'] },
    ])
    expect(await run('stage', 'is_any_of', ['Lead', 'Won'])).toEqual([{ method: 'or', args: [`${holdsTerm('stage', 'Lead')},${holdsTerm('stage', 'Won')}`] }])
    expect(await run('stage', 'is_any_of', ['Lead'])).toEqual([{ method: 'contains', args: ['custom_fields', { stage: 'Lead' }] }])
    expect(await run('stage', 'is_none_of', ['Lead', 'Won'])).toEqual([
      { method: 'not', args: ['custom_fields->>stage', 'is', null] },
      { method: 'not', args: ['custom_fields', 'cs', '{"stage":"Lead"}'] },
      { method: 'not', args: ['custom_fields', 'cs', '{"stage":"Won"}'] },
    ])
    expect(await run('stage', 'is_empty', '')).toEqual([{ method: 'is', args: ['custom_fields->>stage', null] }])
  })

  it('quotes a term of an or=() list, escaping its quotes and backslashes', () => {
    expect(holdsTerm('stage', 'Lead')).toBe('custom_fields.cs."{\\"stage\\":\\"Lead\\"}"')
    expect(holdsTerm('stage', 'a, (b)')).toBe('custom_fields.cs."{\\"stage\\":\\"a, (b)\\"}"')
    expect(holdsTerm('stage', 'a"b\\c')).toBe('custom_fields.cs."{\\"stage\\":\\"a\\\\\\"b\\\\\\\\c\\"}"')
  })
})

describe('multi-select and relation', () => {
  it('includes holds every value picked; excludes holds none; any of holds one', async () => {
    expect(await run('tags', 'includes', ['Rush', 'Gift'])).toEqual([{ method: 'contains', args: ['custom_fields', { tags: ['Rush', 'Gift'] }] }])
    expect(await run('tags', 'excludes', ['Rush', 'Gift'])).toEqual([
      { method: 'not', args: ['custom_fields', 'cs', '{"tags":["Rush"]}'] },
      { method: 'not', args: ['custom_fields', 'cs', '{"tags":["Gift"]}'] },
    ])
    expect(await run('tags', 'is_any_of', ['Rush', 'Gift'])).toEqual([{ method: 'or', args: [`${holdsTerm('tags', ['Rush'])},${holdsTerm('tags', ['Gift'])}`] }])
    expect(await run('tags', 'is_empty', '')).toEqual([{ method: 'is', args: ['custom_fields->>tags', null] }])
  })

  it('a relation includes the records picked', async () => {
    const co = '77777777-7777-4777-8777-777777777777'
    expect(await run('client', 'includes', [co])).toEqual([{ method: 'contains', args: ['custom_fields', { client: [co] }] }])
    expect(await run('client', 'excludes', [co])).toEqual([{ method: 'not', args: ['custom_fields', 'cs', `{"client":["${co}"]}`] }])
    expect(await run('client', 'is_not_empty', '')).toEqual([{ method: 'not', args: ['custom_fields->>client', 'is', null] }])
  })

  it('an unfilled chip filters nothing', async () => {
    expect(await run('tags', 'includes', [])).toEqual([])
    expect(await run('stage', 'is', '')).toEqual([])
  })
})

describe('checkbox', () => {
  it('checked is a containment; not checked counts a box never ticked', async () => {
    expect(await run('paid', 'is', true)).toEqual([{ method: 'contains', args: ['custom_fields', { paid: true }] }])
    expect(await run('paid', 'is', false)).toEqual([{ method: 'not', args: ['custom_fields', 'cs', '{"paid":true}'] }])
  })
})

describe('person', () => {
  it('is a member, or me', async () => {
    const m = '66666666-6666-4666-8666-666666666666'
    expect(await run('owner', 'is', m)).toEqual([{ method: 'contains', args: ['custom_fields', { owner: m }] }])
    expect(await run('owner', 'is', '@me', { memberId: 'member-me' })).toEqual([{ method: 'contains', args: ['custom_fields', { owner: 'member-me' }] }])
    expect(await run('owner', 'is_any_of', ['@me', m], { memberId: 'member-me' })).toEqual([
      { method: 'or', args: [`${holdsTerm('owner', 'member-me')},${holdsTerm('owner', m)}`] },
    ])
    expect(await run('owner', 'is_empty', '')).toEqual([{ method: 'is', args: ['custom_fields->>owner', null] }])
  })
})

describe('sorts', () => {
  it('a currency by its code then its amount; a person, a relation and a multi-select not at all', () => {
    const { query, calls } = makeQuerySpy()
    applyOrdering(
      query as never,
      [
        { field: 'custom_fields.price', direction: 'desc' },
        { field: 'custom_fields.owner', direction: 'asc' },
        { field: 'custom_fields.tags', direction: 'asc' },
        { field: 'custom_fields.qty', direction: 'asc' },
        { field: 'title', direction: 'asc' },
      ],
      'data_row',
      { fieldTypes: TYPES },
    )
    expect(calls).toEqual([
      { method: 'order', args: ['custom_fields->price->currency', { ascending: true, nullsFirst: false }] },
      { method: 'order', args: ['custom_fields->price->amount', { ascending: false, nullsFirst: false }] },
      { method: 'order', args: ['custom_fields->qty', { ascending: true, nullsFirst: false }] },
      { method: 'order', args: ['title', { ascending: true, nullsFirst: false }] },
    ])
  })
})

describe('a kind’s definitions as the types', () => {
  it('reads the types of the custom fields a view names, once, and nothing when it names none', async () => {
    const reads: Array<{ method: string; args: unknown[] }> = []
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve({ data: [{ key: 'tags', field_type: 'multi_select' }], error: null })
          return (...args: unknown[]) => {
            reads.push({ method: prop, args })
            return chain
          }
        },
      },
    )
    const db = { from: (t: string) => (reads.push({ method: 'from', args: [t] }), chain) }
    const fields = viewFieldsOf([{ id: 'f', field: 'custom_fields.tags', operator: 'includes', value: ['Rush'] }], [{ field: 'name', direction: 'asc' }])
    const types = await customFieldTypesFor(db as never, 'ws-1', 'deal', fields)
    expect(types?.get('tags')).toEqual({ type: 'multi_select' })
    expect(reads).toContainEqual({ method: 'from', args: ['custom_field_definition'] })
    expect(reads).toContainEqual({ method: 'in', args: ['key', ['tags']] })
    expect(reads).toContainEqual({ method: 'is', args: ['table_id', null] })
    reads.length = 0
    expect(await customFieldTypesFor(db as never, 'ws-1', 'deal', ['name'])).toBeUndefined()
    // A table's rows take only their own table's live columns, and none without a table.
    expect(await customFieldTypesFor(db as never, 'ws-1', 'data_row', ['custom_fields.tags'])).toBeUndefined()
    expect(reads).toEqual([])
    await customFieldTypesFor(db as never, 'ws-1', 'data_row', ['custom_fields.tags'], 't-1')
    expect(reads).toContainEqual({ method: 'eq', args: ['table_id', 't-1'] })
    expect(reads).toContainEqual({ method: 'is', args: ['deleted_at', null] })
  })
})

describe('every field type as a filter field', () => {
  it('a list enum, a yes or no, a member, an amount, and a relation with its target', () => {
    const fields = customFieldFilterFields([
      { key: 'tags', label: 'Tags', field_type: 'multi_select', options: ['Rush', 'Gift'] },
      { key: 'paid', label: 'Paid', field_type: 'checkbox', options: [] },
      { key: 'owner', label: 'Owner', field_type: 'person', options: [] },
      { key: 'price', label: 'Price', field_type: 'currency', options: [] },
      { key: 'client', label: 'Client', field_type: 'relation', options: [], config: { target: { kind: 'company' } } },
      { key: 'parts', label: 'Parts', field_type: 'relation', options: [], config: { target: { kind: 'data_row', table_id: 't-2' } } },
      // A relation that names no target can't pick records: no filter.
      { key: 'loose', label: 'Loose', field_type: 'relation', options: [] },
    ])
    expect(fields).toEqual([
      { field: 'custom_fields.tags', label: 'Tags', type: 'enum', options: ['Rush', 'Gift'], isArray: true, allowEmpty: true, custom: true },
      { field: 'custom_fields.paid', label: 'Paid', type: 'boolean', allowEmpty: true, custom: true },
      { field: 'custom_fields.owner', label: 'Owner', type: 'member', allowEmpty: true, custom: true },
      { field: 'custom_fields.price', label: 'Price', type: 'number', currency: 'USD', allowEmpty: true, custom: true },
      { field: 'custom_fields.client', label: 'Client', type: 'relation', relationTarget: { kind: 'company' }, allowEmpty: true, custom: true },
      { field: 'custom_fields.parts', label: 'Parts', type: 'relation', relationTarget: { kind: 'data_row', table_id: 't-2' }, allowEmpty: true, custom: true },
    ])
    const ops = Object.fromEntries(fields.map((f) => [f.field.slice('custom_fields.'.length), operatorsFor(f)]))
    expect(ops.tags).toEqual(['includes', 'excludes', 'is_empty', 'is_not_empty'])
    expect(ops.client).toEqual(['includes', 'excludes', 'is_empty', 'is_not_empty'])
    expect(ops.paid).toEqual(['is'])
    expect(ops.owner).toContain('is_any_of')
    expect(ops.price).toContain('between')
    expect(defaultOperatorFor(fields[0])).toBe('includes')
  })
})

describe('relative windows', () => {
  it('a broken one is skipped, not a failure', async () => {
    for (const bad of [{ unit: 'fortnight', direction: 'past' }, { unit: 'day', direction: 'sideways' }, { unit: 'day', direction: 'past', count: -2 }, 'soon', ['day']]) {
      expect(isRelativeDateValue(bad), JSON.stringify(bad)).toBe(false)
      expect(await run('due', 'is_relative', bad)).toEqual([])
    }
    expect(isRelativeDateValue({ unit: 'week', direction: 'this' })).toBe(true)
  })

  it('a custom date’s window is the reader’s days', async () => {
    // 05:00 UTC is still the day before in Los Angeles and already that day in Tokyo.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T05:00:00Z'))
    try {
      const day = (calls: Array<{ args: unknown[] }>) => calls.map((c) => c.args[1])
      expect(day(await run('due', 'is_relative', { unit: 'day', direction: 'this' }, undefined, 'America/Los_Angeles'))).toEqual(['2026-11-11', '2026-11-11'])
      expect(day(await run('due', 'is_relative', { unit: 'day', direction: 'this' }, undefined, 'Asia/Tokyo'))).toEqual(['2026-11-12', '2026-11-12'])
      expect(wallClockIn('Not/A_Zone')).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })
})
