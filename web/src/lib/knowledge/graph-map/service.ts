/**
 * Knowledge Map — cached map service.
 *
 * Sits between the routes and the pure core: probes the source version, builds
 * (layout → tiling) at most once per `(workspace, user, version)`, and answers
 * tile requests out of that cache.
 *
 * THE USER ID IS PART OF THE CACHE KEY. A map is built from rows the viewer can
 * read under RLS (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §3), so two members of the
 * same workspace can legitimately have different maps — hub degrees, tile
 * membership and counts all differ when one of them cannot see a capture. A
 * workspace-only key would serve one viewer's map to the other, which is
 * exactly the leak that killed the persisted-layout design.
 *
 * The cache is in-process and best-effort: a miss costs a rebuild, never a
 * wrong answer. Serverless instances come and go, so nothing may depend on a
 * hit — `getTiles` re-probes and rebuilds deterministically rather than
 * returning 'stale' just because an instance is cold.
 */

import {
  filtersKey,
  hasRelativeFilter,
  layoutMap,
  tileMap,
  type BuiltMap,
  type LaidOutMap,
} from '@/lib/knowledge/graph-map'
import type { MapPredicate } from '@/lib/knowledge/graph-map/filter-model'
import type {
  MapFilters,
  MapResponse,
  MapTile,
  TileId,
} from '@/lib/knowledge/graph-map/types'
import type { RelativeDateValue } from '@/lib/views/types'
import { resolveRelativeDate } from '@/lib/views/query-engine'
import { INLINE_NODE_BUDGET } from '@/lib/knowledge/graph-map/types'
import {
  fetchSourceRows,
  type MapSourceClient,
} from '@/lib/knowledge/graph-map/source'
import {
  applyDelta,
  deltaMatchesProbe,
  fetchSourceDelta,
  probeParts,
  snapshotOf,
  type ProbeParts,
  type SourceSnapshot,
} from '@/lib/knowledge/graph-map/source-delta'

/** Cached layouts. Small: each entry holds a whole workspace's positions. */
const MAX_ENTRIES = 24
/** Entries older than this are rebuilt — bounds how stale a served map can be
 *  when the probe itself is skipped (it never is today, but the TTL also caps
 *  memory held by a user who stopped looking). */
const TTL_MS = 10 * 60 * 1000
/**
 * How long a viewer's cached `SourceRows` may be extended by deltas before the
 * next refresh has to be a full fetch.
 *
 * A delta sees inserts and updates. It cannot see a hub RENAME (the hub row's
 * own timestamp is not part of the probe), a label edit, or a visibility change
 * that does not move `claim.updated_at`. Count validation catches deletions but
 * not those, so freshness for them is bounded by this TTL rather than by a
 * signal. Ten minutes: long enough that a heavy editing session pays one full
 * read, short enough that a renamed capture converges while the tab is open.
 */
const ROWS_TTL_MS = 10 * 60 * 1000
/** Tilings kept per layout, one per filter set (+ time bucket). */
const MAX_BUILDS = 8

interface CacheEntry {
  laidOut: LaidOutMap
  built: Map<string, BuiltMap>
  touchedAt: number
}

/** LRU by insertion order: a Map re-inserts on touch, so the first key is oldest. */
const cache = new Map<string, CacheEntry>()
/** In-flight builds, so N concurrent requests for a cold key do ONE fetch+layout. */
const inFlight = new Map<string, Promise<CacheEntry>>()

/**
 * The latest `SourceRows` per VIEWER — keyed `(workspace, user)` with no
 * version, because the whole point is to carry rows ACROSS versions and extend
 * them. Exactly one snapshot per viewer: each refresh replaces its predecessor,
 * so deltas never accumulate (see `applyDelta` for the per-viewer byte budget).
 *
 * Per-viewer keying is the same security invariant as the layout cache: rows
 * are what the viewer can read under RLS, so they are never shared across users
 * (§3).
 */
const rowsCache = new Map<string, SourceSnapshot>()
/**
 * In-flight row refreshes, so concurrent getMap/getTiles for one viewer share a
 * single fetch rather than racing two reads of the same workspace.
 *
 * The target version rides along: a caller may only join a refresh already
 * aimed at the version it needs. Joining one aimed at an older version would
 * block it behind a result it would have to discard anyway.
 */
const rowsInFlight = new Map<
  string,
  { version: string; promise: Promise<SourceSnapshot> }
>()

function cacheKey(workspaceId: string, userId: string, version: string): string {
  return `${workspaceId}:${userId}:${version}`
}

function viewerKey(workspaceId: string, userId: string): string {
  return `${workspaceId}:${userId}`
}

/**
 * A relative window makes tiling time-dependent, so the built-tiling key has to
 * carry time too — otherwise "last 7 days" would keep answering from a tiling
 * built hours ago. Bucketing to the hour keeps the cache useful while bounding
 * drift to well under the finest window the picker offers (a day).
 *
 * The condition is `hasRelativeFilter`, not any one field: `created_at`,
 * `event_at` and `last_verified_at` can all carry `is_relative`, and any of
 * them makes the result move with the clock. Keying on a single named field
 * would silently freeze the other two at whatever hour they were first built.
 *
 * `filtersKey` sees the UNRESOLVED predicate, which is the point — the key
 * stays stable while the window it stands for advances with the bucket.
 */
function buildKey(filters: MapFilters, nowMs: number): string {
  const bucket = hasRelativeFilter(filters) ? Math.floor(nowMs / 3_600_000) : 0
  return `${filtersKey(filters)}@${bucket}`
}

/**
 * Resolve every `is_relative` predicate into a concrete `between` range.
 *
 * ONCE, SERVER-SIDE, and through `resolveRelativeDate` — the views query
 * engine's own resolver, which is what the SQL list uses for the identical
 * saved view. Resolving on the client, or reimplementing the arithmetic here,
 * would let the list and the canvas answer one view with two different windows,
 * which is the exact failure the shared filter vocabulary exists to prevent.
 *
 * `between` is not an approximation of `is_relative`: the SQL path compiles
 * `is_relative` to `gte(from).lte(to)`, which is literally what `between` is.
 *
 * It happens HERE rather than in the mask because the pure core is isomorphic
 * (the benchmark page runs layout and tiling in the browser) and
 * `query-engine` transitively imports `next/headers`. `service.ts` is
 * server-only already.
 */
function resolveRelativeWindows(filters: MapFilters): MapFilters {
  if (!hasRelativeFilter(filters)) return filters
  const where = (filters.where ?? []).map((p): MapPredicate => {
    if (p.op !== 'is_relative') return p
    const { from, to } = resolveRelativeDate(p.value as RelativeDateValue)
    return { field: p.field, op: 'between', value: { from, to } }
  })
  return { where }
}

function touch(key: string, entry: CacheEntry): void {
  entry.touchedAt = Date.now()
  cache.delete(key)
  cache.set(key, entry)
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next()
    if (oldest.done) break
    cache.delete(oldest.value)
  }
}

function lookup(key: string): CacheEntry | undefined {
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.touchedAt > TTL_MS) {
    cache.delete(key)
    return undefined
  }
  touch(key, entry)
  return entry
}

/**
 * Monotonic refresh sequence.
 *
 * `nowMs` cannot order two refreshes against each other: it is caller-supplied
 * (routes pass a request timestamp, tests pass fixtures) so two concurrent
 * refreshes routinely carry the SAME value, and nothing forbids a later one
 * from carrying a smaller one. A counter taken when a refresh STARTS gives the
 * store a real happens-before, independent of any clock.
 */
let refreshSeq = 0

/** Take a full `SourceRows` read and remember it as this viewer's snapshot. */
async function fullRefresh(
  supabase: MapSourceClient,
  workspaceId: string,
  userId: string,
  parts: ProbeParts,
  nowMs: number,
  seq: number,
): Promise<SourceSnapshot> {
  const rows = await fetchSourceRows(supabase, workspaceId)
  const snapshot = snapshotOf(rows, parts, nowMs)
  storeSnapshot(workspaceId, userId, snapshot, seq)
  return snapshot
}

/** The sequence number each cached snapshot was started at. */
const snapshotSeq = new WeakMap<SourceSnapshot, number>()

/**
 * Store a snapshot, unless a NEWER refresh has already landed.
 *
 * A delta started against version V can finish after a concurrent full refresh
 * has already installed V+1 (the delta's own read is slower, or the two were
 * kicked off by different routes). Overwriting then would hand the next caller
 * rows that are behind the ones it just paid for, and — worse — a watermark
 * saying otherwise, which is how a delta chain silently diverges from the
 * table. The start-order counter is the guard: a refresh that started earlier
 * never clobbers one that started later.
 */
function storeSnapshot(
  workspaceId: string,
  userId: string,
  snapshot: SourceSnapshot,
  seq: number,
): void {
  const key = viewerKey(workspaceId, userId)
  const current = rowsCache.get(key)
  if (current && (snapshotSeq.get(current) ?? -1) > seq) return

  snapshotSeq.set(snapshot, seq)
  rowsCache.delete(key)
  rowsCache.set(key, snapshot)
  // One snapshot per viewer, and the same LRU bound as the layout cache.
  while (rowsCache.size > MAX_ENTRIES) {
    const oldest = rowsCache.keys().next()
    if (oldest.done) break
    rowsCache.delete(oldest.value)
  }
}

/**
 * Get this viewer's `SourceRows` at `parts.version`, by DELTA when possible.
 *
 * The expensive path is the full read: ~N/1000 parallel pages plus a label
 * lookup per hub. When we already hold rows for this viewer we instead read
 * only what moved past the watermark — for one new claim in a 10k-claim
 * workspace that is 2 count queries + 1 page + (usually) 0 label lookups,
 * against 2 + 20 + ~10 for the full read.
 *
 * A delta is only ever SERVED once it agrees with the probe's counts. Anything
 * else — a deletion, a row that became visible without its timestamp moving, an
 * expired TTL, or an error inside the delta itself — falls back to a full
 * fetch, because a map built from rows that failed validation is a wrong map,
 * not a slightly stale one.
 */
async function ensureRows(
  supabase: MapSourceClient,
  workspaceId: string,
  userId: string,
  parts: ProbeParts,
  nowMs: number,
): Promise<SourceSnapshot> {
  const key = viewerKey(workspaceId, userId)

  const cached = rowsCache.get(key)
  if (cached && cached.version === parts.version && nowMs - cached.fetchedAt <= ROWS_TTL_MS) {
    return cached
  }

  // Share an in-flight refresh ONLY when it is already aimed at the version
  // this caller needs. Awaiting one aimed at an older version would block this
  // caller behind a read it cannot use — and, when that older refresh is the
  // slow one, block it for as long as the slow read takes.
  const pending = rowsInFlight.get(key)
  if (pending && pending.version === parts.version) return pending.promise

  const seq = ++refreshSeq
  const started = (async () => {
    const base = rowsCache.get(key)
    // Past the TTL the rows must be re-read in full: a delta cannot see hub
    // renames, label edits or visibility changes that leave timestamps alone,
    // so without this they would never converge.
    const fresh = base && nowMs - base.fetchedAt <= ROWS_TTL_MS
    if (base && fresh) {
      try {
        const delta = await fetchSourceDelta(supabase, workspaceId, base)
        const merged = applyDelta(base, delta, parts, nowMs)
        // Counts disagree ⇒ deletions, or rows the delta cannot see. Never
        // serve a map built from rows that failed this.
        if (deltaMatchesProbe(merged, parts)) {
          storeSnapshot(workspaceId, userId, merged, seq)
          return merged
        }
      } catch {
        // A failed delta is never fatal: the full read below is always correct.
      }
    }
    return fullRefresh(supabase, workspaceId, userId, parts, nowMs, seq)
  })()

  const refresh = started.finally(() => {
    // Only clear the slot if it is still OURS — a later refresh may already
    // have replaced it, and deleting that one would let a third caller start a
    // duplicate read.
    if (rowsInFlight.get(key)?.promise === refresh) rowsInFlight.delete(key)
  })

  rowsInFlight.set(key, { version: parts.version, promise: refresh })
  return refresh
}

/**
 * Get (or build) the layout for one `(workspace, user, version)`.
 *
 * Concurrent callers share one in-flight promise: a browser that opens the map
 * and immediately asks for tiles must not trigger two source reads +
 * `layoutMap` passes.
 */
async function ensureEntry(
  supabase: MapSourceClient,
  workspaceId: string,
  userId: string,
  parts: ProbeParts,
  nowMs: number,
): Promise<CacheEntry> {
  const version = parts.version
  const key = cacheKey(workspaceId, userId, version)
  const hit = lookup(key)
  if (hit) return hit

  const pending = inFlight.get(key)
  if (pending) return pending

  const build = (async () => {
    const snapshot = await ensureRows(supabase, workspaceId, userId, parts, nowMs)
    const entry: CacheEntry = {
      laidOut: layoutMap(snapshot.rows),
      built: new Map(),
      touchedAt: Date.now(),
    }
    touch(key, entry)
    return entry
  })()
    // Always clear the in-flight slot, including on failure — a rejected build
    // must not poison every later request for this key.
    .finally(() => {
      inFlight.delete(key)
    })

  inFlight.set(key, build)
  return build
}

/** Get (or compute) the tiling of a laid-out map for one filter set. */
function ensureBuilt(
  entry: CacheEntry,
  filters: MapFilters,
  version: string,
  nowMs: number,
): BuiltMap {
  const key = buildKey(filters, nowMs)
  const hit = entry.built.get(key)
  if (hit) {
    entry.built.delete(key)
    entry.built.set(key, hit)
    return hit
  }

  // Resolved AFTER the key is taken: the key must stand for the saved view's
  // unresolved window (plus its hour bucket), not for one request's instants.
  const built = tileMap(entry.laidOut, {
    filters: resolveRelativeWindows(filters),
    version,
    nowMs,
  })
  entry.built.set(key, built)
  while (entry.built.size > MAX_BUILDS) {
    const oldest = entry.built.keys().next()
    if (oldest.done) break
    entry.built.delete(oldest.value)
  }
  return built
}

export interface GetMapArgs {
  supabase: MapSourceClient
  workspaceId: string
  userId: string
  filters: MapFilters
  /** Version the caller already holds; `{ unchanged: true }` when it matches. */
  have?: string
  nowMs?: number
}

/**
 * Build the map response for the current filters.
 *
 * The probe runs on EVERY call — it is four head/limit-1 queries and it is what
 * makes `have=` cheap for the realtime revalidation loop (§4.5): an unchanged
 * workspace costs the probe and nothing else, no matter how large it is.
 */
export async function getMap(args: GetMapArgs): Promise<MapResponse> {
  const { supabase, workspaceId, userId, filters, have } = args
  const nowMs = args.nowMs ?? Date.now()

  const parts = await probeParts(supabase, workspaceId)
  const version = parts.version
  if (have && have === version) return { unchanged: true, version }

  const entry = await ensureEntry(supabase, workspaceId, userId, parts, nowMs)
  const built = ensureBuilt(entry, filters, version, nowMs)

  return { ...built.meta, tiles: built.inline }
}

export interface GetTilesArgs {
  supabase: MapSourceClient
  workspaceId: string
  userId: string
  filters: MapFilters
  /** Version the client's manifest came from. */
  version: string
  ids: TileId[]
  nowMs?: number
}

/**
 * Serve individual tiles for a version the client already has.
 *
 * On a cache miss we do NOT immediately declare the map stale — a cold
 * serverless instance would then force every client into a full reload. We
 * re-probe instead: same version ⇒ rebuild (the algorithm is deterministic, so
 * the rebuilt tiles are bit-identical to the ones the manifest describes);
 * different version ⇒ `'stale'`, which the route turns into a 409 and the
 * client answers by re-fetching the map.
 */
export async function getTiles(args: GetTilesArgs): Promise<MapTile[] | 'stale'> {
  const { supabase, workspaceId, userId, filters, version, ids } = args
  const nowMs = args.nowMs ?? Date.now()

  let entry = lookup(cacheKey(workspaceId, userId, version))
  if (!entry) {
    const parts = await probeParts(supabase, workspaceId)
    if (parts.version !== version) return 'stale'
    entry = await ensureEntry(supabase, workspaceId, userId, parts, nowMs)
  }

  const built = ensureBuilt(entry, filters, version, nowMs)
  const tiles: MapTile[] = []
  for (const id of ids) {
    const tile = built.tiles.get(id)
    // An unknown id is not an error: the client may ask for a tile that the
    // current filter set emptied out. Skipping it means "no nodes here".
    if (tile) tiles.push(tile)
  }
  return tiles
}

/** Node budget the `…/map` route inlines up to — re-exported so the route and
 *  the core agree without the route importing the core directly. */
export { INLINE_NODE_BUDGET }

/** Drop every cached layout AND every cached row snapshot. Tests only — never
 *  call this from a route. */
export function __resetMapCacheForTests(): void {
  cache.clear()
  inFlight.clear()
  rowsCache.clear()
  rowsInFlight.clear()
}
