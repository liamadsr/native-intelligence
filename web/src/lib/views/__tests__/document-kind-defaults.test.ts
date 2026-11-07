/**
 * A document list shows docs only (documents phase 1, item 7): skill and loop
 * reports and meeting preps (document.kind, migration 367) are a third of the
 * documents, so the Docs cards leave them out unless a filter names `kind`
 * ("Kind is report"), which a person can pick like any other field.
 */
import { describe, expect, it, vi } from 'vitest'
import { applyEntityDefaults, buildEntityQuery } from '@/lib/views/query-engine'
import { FILTERABLE_FIELDS, type ViewFilter } from '@/lib/views/types'

function build() {
  const eqs: Array<[string, unknown]> = []
  const columns: string[] = []
  const chain = {
    select: vi.fn((cols: string) => {
      columns.push(cols)
      return chain
    }),
    eq: vi.fn((col: string, value: unknown) => {
      eqs.push([col, value])
      return chain
    }),
  }
  const query = buildEntityQuery({ from: vi.fn(() => chain) } as never, 'document', 'ws-1', 'user-1')
  return { query, eqs, columns }
}

const filter = (field: string, value: unknown): ViewFilter => ({ id: `f-${field}`, field, operator: 'is', value }) as ViewFilter

describe('applyEntityDefaults — documents', () => {
  it('shows docs only when no filter names kind, and reads the kind', () => {
    const { query, eqs, columns } = build()
    applyEntityDefaults(query as never, 'document', [])
    expect(eqs).toContainEqual(['kind', 'doc'])
    expect(columns[0]).toMatch(/\bkind\b/)
  })

  it('a kind filter says what to show, and the default steps aside', () => {
    const { query, eqs } = build()
    applyEntityDefaults(query as never, 'document', [filter('kind', 'report')])
    expect(eqs).not.toContainEqual(['kind', 'doc'])
  })

  it('a query scoped by id gets every kind: a delivered report opened by id is never hidden', () => {
    for (const f of [filter('id', 'doc-report-1'), { id: 'scope', field: 'id', operator: 'is_any_of', value: ['a', 'b'] } as ViewFilter]) {
      const { query, eqs } = build()
      applyEntityDefaults(query as never, 'document', [f])
      expect(eqs).not.toContainEqual(['kind', 'doc'])
    }
  })

  it('kind is a filter field a person can pick', () => {
    expect(FILTERABLE_FIELDS.document.find((f) => f.field === 'kind')).toMatchObject({ type: 'enum', options: ['doc', 'report', 'prep'] })
  })
})
