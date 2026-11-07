import { describe, it, expect } from 'vitest'
import { getAdjacentItems, type VisibleItem } from '../detail-nav-utils'

function makeItems(ids: string[]): VisibleItem[] {
  return ids.map((id) => ({ id, title: `Title ${id}`, item: { id } }))
}

describe('getAdjacentItems', () => {
  describe('happy path', () => {
    it('returns prev and next for a middle item', () => {
      const items = makeItems(['a', 'b', 'c'])
      const result = getAdjacentItems('b', items)
      expect(result.prevItem?.id).toBe('a')
      expect(result.nextItem?.id).toBe('c')
    })

    it('returns null prev for the first item', () => {
      const items = makeItems(['a', 'b', 'c'])
      const result = getAdjacentItems('a', items)
      expect(result.prevItem).toBeNull()
      expect(result.nextItem?.id).toBe('b')
    })

    it('returns null next for the last item', () => {
      const items = makeItems(['a', 'b', 'c'])
      const result = getAdjacentItems('c', items)
      expect(result.prevItem?.id).toBe('b')
      expect(result.nextItem).toBeNull()
    })

    it('returns both null for a single-item list', () => {
      const items = makeItems(['only'])
      const result = getAdjacentItems('only', items)
      expect(result.prevItem).toBeNull()
      expect(result.nextItem).toBeNull()
    })

    it('returns full item objects, not just ids', () => {
      const items: VisibleItem[] = [
        { id: '1', title: 'First', item: { foo: 'bar' } },
        { id: '2', title: 'Second', item: { baz: 'qux' } },
        { id: '3', title: 'Third', item: {} },
      ]
      const result = getAdjacentItems('2', items)
      expect(result.prevItem).toEqual({ id: '1', title: 'First', item: { foo: 'bar' } })
      expect(result.nextItem).toEqual({ id: '3', title: 'Third', item: {} })
    })
  })

  describe('error / edge cases', () => {
    it('returns both null when currentId is null', () => {
      const items = makeItems(['a', 'b'])
      const result = getAdjacentItems(null, items)
      expect(result.prevItem).toBeNull()
      expect(result.nextItem).toBeNull()
    })

    it('returns both null when items list is empty', () => {
      const result = getAdjacentItems('a', [])
      expect(result.prevItem).toBeNull()
      expect(result.nextItem).toBeNull()
    })

    it('returns both null when currentId is not in items', () => {
      const items = makeItems(['a', 'b', 'c'])
      const result = getAdjacentItems('z', items)
      expect(result.prevItem).toBeNull()
      expect(result.nextItem).toBeNull()
    })
  })
})
