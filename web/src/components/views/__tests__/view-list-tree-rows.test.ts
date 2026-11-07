/**
 * The tree walk behind the flat list (`buildVisualRows` / `isTreeRowOpen`).
 *
 * Two kinds of parent row: LAZY (actions: `has_children`, children fetched on
 * first expand, closed by default) and INLINE (prospect companies: `children`
 * attached by the views route, OPEN by default — the people are the point of
 * the row). The walk decides what the user sees, so it is pinned here without
 * a virtualizer, which jsdom cannot size.
 */
import { describe, it, expect } from 'vitest'
import { buildVisualRows, isTreeRowOpen } from '../view-list'

const person = (id: string) => ({ id, kind: 'person' })
const company = (id: string, children?: Record<string, unknown>[]) =>
  children ? { id, kind: 'company', children } : { id, kind: 'company' }
const action = (id: string, hasChildren = false) => ({ id, has_children: hasChildren })

const none = new Set<string>()
const walk = (
  items: Record<string, unknown>[],
  over: Partial<Parameters<typeof buildVisualRows>[1]> = {},
) =>
  buildVisualRows(items, {
    treeEnabled: true,
    expanded: none,
    collapsed: none,
    childrenByParent: {},
    ...over,
  })

describe('buildVisualRows', () => {
  it('is flat when the tree is off, whatever the rows carry', () => {
    const rows = walk([company('c1', [person('p1')]), action('a1', true)], { treeEnabled: false })
    expect(rows.map((r) => [r.item.id, r.depth, r.hasChildren])).toEqual([
      ['c1', 0, false],
      ['a1', 0, false],
    ])
  })

  it('opens INLINE children by default, one level down, in order', () => {
    const rows = walk([company('c1', [person('p1'), person('p2')]), company('c2', [])])
    expect(rows.map((r) => [r.item.id, r.depth, r.hasChildren])).toEqual([
      ['c1', 0, true],
      ['p1', 1, false],
      ['p2', 1, false],
      ['c2', 0, false],
    ])
  })

  it('folds an inline parent the user collapsed, and only that one', () => {
    const rows = walk([company('c1', [person('p1')]), company('c2', [person('p2')])], {
      collapsed: new Set(['c1']),
    })
    expect(rows.map((r) => r.item.id)).toEqual(['c1', 'c2', 'p2'])
  })

  it('keeps LAZY children closed until expanded, then reads them from the cache', () => {
    const items = [action('a1', true)]
    expect(walk(items).map((r) => r.item.id)).toEqual(['a1'])
    expect(
      walk(items, { expanded: new Set(['a1']), childrenByParent: { a1: [action('a1.1')] } }).map(
        (r) => [r.item.id, r.depth],
      ),
    ).toEqual([
      ['a1', 0],
      ['a1.1', 1],
    ])
    // Expanded but not fetched yet: the parent alone, no crash.
    expect(walk(items, { expanded: new Set(['a1']) }).map((r) => r.item.id)).toEqual(['a1'])
  })

  it('a company with an empty children array has no chevron', () => {
    expect(walk([company('c1', [])])[0].hasChildren).toBe(false)
  })
})

describe('isTreeRowOpen', () => {
  it('inline rows are open unless collapsed; lazy rows are closed unless expanded', () => {
    const inline = company('c1', [person('p1')])
    const lazy = action('a1', true)
    expect(isTreeRowOpen(inline, none, none)).toBe(true)
    expect(isTreeRowOpen(inline, none, new Set(['c1']))).toBe(false)
    expect(isTreeRowOpen(lazy, none, none)).toBe(false)
    expect(isTreeRowOpen(lazy, new Set(['a1']), none)).toBe(true)
  })
})
