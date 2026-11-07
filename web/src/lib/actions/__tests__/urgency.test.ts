import { describe, it, expect, vi } from 'vitest'
import { compareByUrgency, orderByUrgency } from '../urgency'

describe('orderByUrgency', () => {
  it('orders priority descending, then due_at ascending, nulls last on both', () => {
    const calls: unknown[][] = []
    const query = {
      order: vi.fn((...args: unknown[]) => {
        calls.push(args)
        return query
      }),
    }
    expect(orderByUrgency(query)).toBe(query)
    expect(calls).toEqual([
      ['priority', { ascending: false, nullsFirst: false }],
      ['due_at', { ascending: true, nullsFirst: false }],
    ])
  })
})

describe('compareByUrgency', () => {
  it('sorts urgent → none, then earliest due, undated last', () => {
    const rows = [
      { id: 'none-dated', priority: 'none', due_at: '2026-10-01T00:00:00Z' },
      { id: 'high-undated', priority: 'high', due_at: null },
      { id: 'urgent-late', priority: 'urgent', due_at: '2026-10-20T00:00:00Z' },
      { id: 'low', priority: 'low', due_at: null },
      { id: 'high-dated', priority: 'high', due_at: '2026-10-05T00:00:00Z' },
      { id: 'urgent-soon', priority: 'urgent', due_at: '2026-10-02T00:00:00Z' },
      { id: 'medium', priority: 'medium', due_at: null },
      { id: 'missing', priority: null, due_at: null },
    ]
    expect([...rows].sort(compareByUrgency).map((r) => r.id)).toEqual([
      'urgent-soon',
      'urgent-late',
      'high-dated',
      'high-undated',
      'medium',
      'low',
      'none-dated',
      'missing',
    ])
  })
})
