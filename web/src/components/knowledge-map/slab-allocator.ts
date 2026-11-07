/**
 * Fixed-size slab allocator for the tile store's GPU buffers.
 *
 * The renderer allocates `capacity` node slabs (HARD_TILE_CAP nodes each) and
 * `capacity` edge slabs (TILE_EDGE_CAPACITY each) ONCE, up front. A resident
 * tile owns one slab index for its whole residency, so `(slab, index)` is a
 * stable node address that survives any number of other tiles loading and
 * evicting. Freeing a slab never moves another tile's data — there is no
 * compaction, ever, because compaction would invalidate every NodeRef the
 * inspector, hover state and picking hold.
 *
 * Free slabs are kept on a LIFO stack: the most recently freed slab is handed
 * out first, which keeps the working set of GPU buffer ranges hot rather than
 * cycling through all `capacity` of them.
 */

export class SlabAllocator {
  readonly capacity: number

  /** Free slab indices, most-recently-freed last (LIFO). */
  private readonly freeList: number[] = []
  /** Slabs handed out but never yet freed live in [next, capacity). */
  private next = 0
  private inUse = 0

  constructor(capacity: number) {
    // A non-positive capacity would make alloc() silently always fail; catch
    // the misconfiguration at construction instead of at the first frame.
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`SlabAllocator capacity must be a positive integer, got ${capacity}`)
    }
    this.capacity = capacity
  }

  get used(): number {
    return this.inUse
  }

  /** Returns a free slab index, or -1 when every slab is in use. */
  alloc(): number {
    const recycled = this.freeList.pop()
    if (recycled !== undefined) {
      this.inUse++
      return recycled
    }
    if (this.next >= this.capacity) return -1
    this.inUse++
    return this.next++
  }

  /**
   * Returns a slab to the pool. Double-freeing would hand the same slab to two
   * resident tiles, which silently corrupts both — so it throws rather than
   * corrupting the map.
   */
  free(slab: number): void {
    if (!Number.isInteger(slab) || slab < 0 || slab >= this.capacity) {
      throw new RangeError(`slab ${slab} is outside [0, ${this.capacity})`)
    }
    if (slab >= this.next || this.freeList.includes(slab)) {
      throw new Error(`slab ${slab} is not allocated`)
    }
    this.freeList.push(slab)
    this.inUse--
  }
}
