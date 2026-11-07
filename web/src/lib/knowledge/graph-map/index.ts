/**
 * Knowledge Map — pure core.
 *
 * Isomorphic (Node + browser), no I/O, no DOM. `layoutMap` builds positions
 * from the UNFILTERED rows; `tileMap` applies filters and cuts the quadtree.
 * See docs/KNOWLEDGE_MAP_ARCHITECTURE.md §4.
 */

export * from './types'

export { hash01, hash32, hashInt01 } from './hash'

export {
  buildGraph,
  claimKey,
  hubKey,
  hubTypeWeight,
  shortLabel,
  unfiledKeyFor,
  unfiledLabel,
  type BuiltClaim,
  type BuiltEdge,
  type BuiltGraph,
  type BuiltHub,
} from './graph-build'

export {
  discCapacity,
  discRadius,
  layoutBuiltGraph,
  layoutMap,
  slotOffset,
  worldBounds,
  NO_CODE,
  NO_CONFIDENCE,
  NO_INDEX,
  SCOPE_CODE,
  type LaidOutMap,
} from './layout'

export { maskClaims } from './mask'

export {
  FILTER_PARAM,
  filtersKey,
  filtersToParam,
  filtersToParams,
  hasRelativeFilter,
  isEmptyFilters,
  parseFilters,
  type ParsedFilters,
} from './filters'

// The shared claim-filter vocabulary. Re-exported so a caller that only knows
// about "the map" does not have to reach past the barrel for the one thing
// that decides what the map shows.
export {
  MAP_FILTER_FIELDS,
  MAX_FILTER_PAYLOAD_BYTES,
  MAX_PREDICATES,
  isMapFilterField,
  normalisePredicate,
  toMapFilters,
  type MapFilterField,
  type MapPredicate,
  type RejectedFilter,
} from './filter-model'

export { tileMap, tilingCacheKey, type BuiltMap, type TileMapOptions } from './tiling'

export {
  generateSyntheticMap,
  generateSyntheticRows,
  SYNTHETIC_SHAPE,
  type SyntheticMapOptions,
  type SyntheticRowOptions,
} from './synthetic'
