import { describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/labels/use-scoped-labels', () => ({ useScopedLabels: () => ({ labels: [], grouped: [], loading: false }), invalidateLabelsCache: () => {} }))
import { tagMenuRows } from '../tag-menu'
import type { LabelWithScope } from '@/lib/labels/utils'

const tag = (name: string): LabelWithScope => ({ id: name, name, color: '#22c55e', group_name: null, scopes: null, created_at: '' })
const tags = [tag('Renewal'), tag('Urgent'), tag('Q4 renewal')]

describe('tagMenuRows', () => {
  it('lists prefix matches before contains matches, then Create', () => {
    const rows = tagMenuRows(tags, 'ren')
    expect(rows.map((r) => `${r.kind}:${r.name}`)).toEqual(['tag:Renewal', 'tag:Q4 renewal', 'create:ren'])
  })

  it('offers no Create for an existing name (any case) or an empty query', () => {
    expect(tagMenuRows(tags, 'urgent').some((r) => r.kind === 'create')).toBe(false)
    expect(tagMenuRows(tags, '').map((r) => r.kind)).toEqual(['tag', 'tag', 'tag'])
  })

  it('caps the tag rows', () => {
    const many = Array.from({ length: 20 }, (_, i) => tag(`t${i}`))
    expect(tagMenuRows(many, 't').filter((r) => r.kind === 'tag')).toHaveLength(8)
  })
})
