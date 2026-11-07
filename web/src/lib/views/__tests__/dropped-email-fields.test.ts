/**
 * Email views after 344 (no stored mail): the index has no subject, preview,
 * display name or recipient lists. A saved filter or sort on one degrades (is
 * ignored) instead of failing the view, and the field lists no longer offer them.
 */
import { describe, it, expect, vi } from 'vitest'
import { applyFilters, applyOrdering, isDroppedField } from '../query-engine'
import { DEFAULT_DISPLAY_PROPERTIES, FILTERABLE_FIELDS } from '../types'

function recorder() {
  const calls: string[] = []
  const q: Record<string, unknown> = {}
  for (const m of ['order', 'eq', 'neq', 'ilike', 'in', 'is', 'or', 'gte', 'lte', 'not', 'contains', 'overlaps']) {
    q[m] = (...args: unknown[]) => {
      calls.push(`${m}:${String(args[0])}`)
      return q
    }
  }
  return { q, calls }
}

describe('email views without stored subjects', () => {
  it('a saved sort or filter on a dropped column is ignored; others still apply', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { q, calls } = recorder()
    applyOrdering(q as never, [{ field: 'subject', direction: 'asc' }, { field: 'last_message_at', direction: 'desc' }], 'email_thread')
    await applyFilters(q as never, 'email_thread', [
      { field: 'from_name', operator: 'contains', value: 'Dana' },
      { field: 'is_unread', operator: 'is', value: true },
    ] as never)
    expect(calls).toContain('order:last_message_at')
    expect(calls.some((c) => c.endsWith(':subject') || c.endsWith(':from_name'))).toBe(false)
  })

  it('the field lists no longer offer subject or display name', () => {
    expect(isDroppedField('email_thread', 'subject')).toBe(true)
    expect(isDroppedField('action', 'subject')).toBe(false)
    expect(FILTERABLE_FIELDS.email_thread.map((f) => f.field)).not.toEqual(expect.arrayContaining(['subject']))
    expect(FILTERABLE_FIELDS.email_thread.map((f) => f.field)).not.toContain('from_name')
    expect(DEFAULT_DISPLAY_PROPERTIES.email_thread).not.toContain('subject')
  })
})
