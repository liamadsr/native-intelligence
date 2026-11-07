import { describe, it, expect } from 'vitest'
import { SlabAllocator } from '../slab-allocator'

/**
 * The tile store hands one slab to a tile for its whole residency, and the
 * renderer addresses nodes as `(slab, index)`. If a free ever moved another
 * tile's slab — or if the same slab were handed out twice — every held
 * NodeRef would silently point at the wrong node. These tests lock that down.
 */
describe('SlabAllocator', () => {
  it('hands out distinct slabs up to capacity, then -1', () => {
    const alloc = new SlabAllocator(3)
    const slabs = [alloc.alloc(), alloc.alloc(), alloc.alloc()]
    expect(new Set(slabs).size).toBe(3)
    expect(slabs.every((s) => s >= 0 && s < 3)).toBe(true)
    expect(alloc.used).toBe(3)
    expect(alloc.alloc()).toBe(-1)
    // A failed alloc must not consume anything.
    expect(alloc.used).toBe(3)
  })

  it('reuses a freed slab without moving the others', () => {
    const alloc = new SlabAllocator(4)
    const a = alloc.alloc()
    const b = alloc.alloc()
    const c = alloc.alloc()

    alloc.free(b)
    expect(alloc.used).toBe(2)

    const recycled = alloc.alloc()
    expect(recycled).toBe(b)
    // The neighbours kept their identity — no compaction, ever.
    expect(a).toBe(0)
    expect(c).toBe(2)
    expect(alloc.used).toBe(3)
  })

  it('never returns a slab that is still in use', () => {
    const alloc = new SlabAllocator(8)
    const live = new Set<number>()
    for (let i = 0; i < 8; i++) live.add(alloc.alloc())

    // Churn: free every other slab, reallocate, and check for collisions.
    for (const slab of [1, 3, 5, 7]) {
      alloc.free(slab)
      live.delete(slab)
    }
    for (let i = 0; i < 4; i++) {
      const slab = alloc.alloc()
      expect(slab).toBeGreaterThanOrEqual(0)
      expect(live.has(slab)).toBe(false)
      live.add(slab)
    }
    expect(live.size).toBe(8)
    expect(alloc.alloc()).toBe(-1)
  })

  it('rejects double-free and out-of-range frees', () => {
    const alloc = new SlabAllocator(2)
    const a = alloc.alloc()
    alloc.free(a)
    expect(() => alloc.free(a)).toThrow(/not allocated/)
    expect(() => alloc.free(9)).toThrow(/outside/)
    expect(() => alloc.free(-1)).toThrow(/outside/)
    // A never-allocated slab is not a valid free either.
    expect(() => alloc.free(1)).toThrow(/not allocated/)
  })

  it('rejects a non-positive capacity at construction', () => {
    expect(() => new SlabAllocator(0)).toThrow(/positive integer/)
    expect(() => new SlabAllocator(-4)).toThrow(/positive integer/)
  })
})
