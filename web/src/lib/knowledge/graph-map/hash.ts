/**
 * Seeded string hashing for the map layout.
 *
 * The layout has exactly one source of "randomness": these functions. Using a
 * hash of a stable key (rather than a PRNG stream) is what makes the layout
 * order-independent — a node's jitter depends only on its own key, never on
 * how many nodes were hashed before it.
 */

/** FNV-1a (32-bit). Fast, no allocation, good enough avalanche after the mix. */
export function hash32(str: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    // h *= 16777619, kept in 32 bits without Math.imul overflow surprises.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  // Final avalanche (xorshift-multiply), so adjacent keys don't produce
  // adjacent jitter — sequential uuids share long prefixes.
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return h >>> 0
}

/** Deterministic value in [0, 1). */
export function hash01(str: string, seed?: number): number {
  return hash32(str, seed) / 4294967296
}

/** Deterministic value in [0, 1) from a 32-bit integer (no string alloc). */
export function hashInt01(value: number, seed = 0x811c9dc5): number {
  let h = (value ^ seed) >>> 0
  h ^= h >>> 16
  h = Math.imul(h, 0x7feb352d) >>> 0
  h ^= h >>> 15
  h = Math.imul(h, 0x846ca68b) >>> 0
  h ^= h >>> 16
  return (h >>> 0) / 4294967296
}
