/**
 * Graph build — rows → the deterministic node/edge model (no positions yet).
 *
 * Everything here is order-independent: each input array is sorted by a total
 * order before it is read, and no Map/Set is ever iterated in insertion order.
 * See docs/KNOWLEDGE_MAP_ARCHITECTURE.md §4.2.
 */

import type {
  ClaimScope,
  ClaimType,
  NodeKey,
  SourceClaimRow,
  SourceLinkRow,
  SourceRows,
} from './types'
import { CLAIM_TYPES } from './types'

/** Longest label we ship; the renderer never draws more than this. */
const LABEL_MAX = 80

/** Collapse whitespace and truncate with an ellipsis (§4 "Labels"). */
export function shortLabel(text: string | null | undefined): string {
  if (!text) return ''
  const collapsed = text.replace(/\s+/g, ' ').trim()
  if (collapsed.length <= LABEL_MAX) return collapsed
  return collapsed.slice(0, LABEL_MAX - 1) + '…'
}

export function claimKey(id: string): NodeKey {
  return `claim:${id}`
}

export function hubKey(type: string, id: string): NodeKey {
  return `${type}:${id}`
}

/** `unfiled:<yyyy-mm>` from an ISO instant, in UTC. */
export function unfiledKeyFor(createdAt: string): NodeKey {
  const t = Date.parse(createdAt)
  const d = new Date(Number.isFinite(t) ? t : 0)
  const month = String(d.getUTCMonth() + 1).padStart(2, '0')
  return `unfiled:${d.getUTCFullYear()}-${month}`
}

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

/** 'unfiled:2026-09' → 'Unfiled · Sep 2026'. */
export function unfiledLabel(key: NodeKey): string {
  const m = /^unfiled:(\d{4})-(\d{2})$/.exec(key)
  if (!m) return 'Unfiled'
  const monthIndex = Number(m[2]) - 1
  const name = MONTH_NAMES[monthIndex] ?? '?'
  return `Unfiled · ${name} ${m[1]}`
}

/** First instant of an `unfiled:<yyyy-mm>` hub's month, ms since epoch. */
export function unfiledFirstSeen(key: NodeKey): number {
  const m = /^unfiled:(\d{4})-(\d{2})$/.exec(key)
  if (!m) return 0
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)
}

/** ms since epoch; non-parsable dates sort first but stay deterministic. */
export function parseTime(iso: string): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : 0
}

/**
 * ms since epoch, or NaN for "this claim has no such date".
 *
 * NOT `parseTime`'s 0 fallback: 0 is 1970-01-01, a date a filter can legally
 * ask about, so an unset `event_at` falling through to 0 would be swept up by
 * `event_at is before 2020` — the exact three-valued-logic bug the SQL side
 * never has. NaN is the only sentinel a timestamp cannot collide with, and it
 * makes every ordered comparison false for free, which is what Postgres does
 * with a null.
 */
export function parseNullableTime(iso: string | null | undefined): number {
  if (!iso) return Number.NaN
  const t = Date.parse(iso)
  return Number.isFinite(t) ? t : Number.NaN
}

/** Narrow a raw `scope` value; anything unrecognised is honestly "unknown". */
function claimScope(value: string | null | undefined): ClaimScope | null {
  return value === 'workspace' || value === 'personal' ? value : null
}

export function claimTypeIndex(type: string): number {
  const i = (CLAIM_TYPES as readonly string[]).indexOf(type)
  return i < 0 ? 0 : i
}

/** Structural importance weight of a hub type (§4.2). */
export function hubTypeWeight(type: string): number {
  switch (type) {
    case 'project':
    case 'company':
    case 'campaign':
    case 'contact':
      return 3
    case 'capture':
    case 'document':
      return 2
    default:
      return 1
  }
}

/** A claim row that became a node. */
export interface BuiltClaim {
  key: NodeKey
  id: string
  /**
   * The claim's FULL text — the `SourceClaimRow`'s own string, never a copy.
   *
   * Truncation used to happen here, which meant the only text the map held was
   * 80 characters long: a `text contains …` filter would then silently miss
   * every match past the cut-off while the SQL list found it. The short label
   * is produced at tile serialization instead (`tiling.ts`), where it is
   * actually needed, and this field carries one pointer per claim into the row
   * the snapshot is already holding — no second allocation.
   */
  text: string
  type: ClaimType
  confidence: number | null
  confirmed: boolean
  scope: ClaimScope | null
  autoAccepted: boolean | null
  /** `member.id` of the author, lower-cased by the layout's string table. */
  createdBy: string | null
  createdAt: number
  /** NaN when unset — see `parseNullableTime`. */
  eventAt: number
  lastVerifiedAt: number
  /** Index into `BuiltGraph.hubs` of the claim's primary hub. */
  hub: number
  /** Rank among ALL rows of that hub (dismissed rows consume slots). */
  slot: number
  degree: number
}

export interface BuiltHub {
  key: NodeKey
  /** '' for virtual hubs. */
  type: string
  id: string
  label: string
  virtual: boolean
  /** Earliest incident link time (virtual: first instant of its month). */
  firstSeen: number
  /**
   * Claim ROWS assigned here, all statuses — and therefore how many slots the
   * hub's phyllotaxis spiral consumes, since a dismissed row keeps its slot
   * and leaves a hole.
   *
   * THIS IS GEOMETRY: `reservedRadius` sizes a hub's disc from it, so the
   * space a hub reserves matches what it actually holds.
   */
  rowCount: number
  /**
   * Claim rows homed here within 24 h of `firstSeen` — the hub's size at birth.
   *
   * Disc geometry USED to be reserved from this rather than `rowCount`,
   * because it cannot grow under an append and so froze every later hub's
   * position. Hub placement is ordered by degree now, which gave that
   * guarantee up for a map that reflects the current graph, so discs are
   * sized from `rowCount` instead. Kept because it is still the honest
   * "how big was this capture when it landed" figure.
   */
  birthCount: number
  degree: number
}

/** A kept edge, by index into the built claim / hub arrays. */
export interface BuiltEdge {
  /** Index into `claims`. */
  source: number
  /** Index into `claims` when `targetIsClaim`, else into `hubs`. */
  target: number
  targetIsClaim: boolean
  /** Index into `BuiltGraph.relations`. */
  rel: number
}

export interface BuiltGraph {
  claims: BuiltClaim[]
  hubs: BuiltHub[]
  edges: BuiltEdge[]
  /** Sorted distinct hub entity types (virtual hubs excluded). */
  entityTypes: string[]
  /** Sorted distinct relation names. */
  relations: string[]
  /** Every project hub in the map, sorted by label then id. */
  projects: Array<{ id: string; label: string }>
  /** claim index → indices of hub nodes it links to (for project filtering). */
  claimHubTargets: number[][]
  /**
   * hub index → {hub index → weight} of hubs co-cited inside its birth window.
   *
   * The placement target (§4.2). Links written after the window are excluded,
   * so a link added months later cannot move a hub that is already placed.
   */
  birthNeighbours: Array<Map<number, number>>
  /** Total claim ROWS read (all statuses) — `counts.totalClaims` uses nodes. */
  totalClaimNodes: number
}

/** Hubs a claim's provenance is written to; these win a same-instant tie. */
const PROVENANCE_TYPES: ReadonlySet<string> = new Set([
  'capture',
  'document',
  'conversation',
  'email_thread',
  'attachment',
])

/**
 * 0 for provenance types, 1 for everything else.
 *
 * Extraction writes a claim's provenance link and the weaver's anchor links in
 * the same transaction, so they carry identical `created_at`. Provenance must
 * win that tie: falling through to alphabetical key order would hand the home
 * to whatever type sorts first ('action:', 'campaign:' both beat 'capture:'),
 * which is arbitrary and would flip as soon as a new anchor type appeared.
 */
function sourceTypeRank(type: string): number {
  return PROVENANCE_TYPES.has(type) ? 0 : 1
}

/** Lexicographic on `(clock, sourceTypeRank, targetKey)`. */
function compareRank(
  a: [number, number, NodeKey],
  b: [number, number, NodeKey],
): number {
  if (a[0] !== b[0]) return a[0] - b[0]
  if (a[1] !== b[1]) return a[1] - b[1]
  return a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0
}

/** A hub is at most this old, relative to `firstSeen`, while it is "being born". */
const BIRTH_WINDOW_MS = 24 * 60 * 60 * 1000

/** Reserved capacity of a virtual `unfiled:` hub — fixed, so it never grows. */
export const UNFILED_RESERVED_CAPACITY = 256

/** A claim row is a node when it is active and not dismissed (§4.1). */
function isNodeRow(row: SourceClaimRow): boolean {
  return row.status === 'active' && row.confirmation !== 'dismissed'
}

/**
 * Build the graph. Pure and order-independent: `rows` may arrive in any order.
 */
export function buildGraph(rows: SourceRows): BuiltGraph {
  // ── Hubs the viewer can see. Links to anything else are dropped (§4.1). ──
  const hubByKey = new Map<NodeKey, { type: string; id: string; label: string }>()
  for (const h of rows.hubs) {
    const key = hubKey(h.type, h.id)
    const prev = hubByKey.get(key)
    // Duplicate rows: keep the lexicographically smallest label so the result
    // does not depend on which duplicate arrived first.
    if (!prev || h.label < prev.label) {
      hubByKey.set(key, { type: h.type, id: h.id, label: h.label })
    }
  }

  // ── Claim rows, sorted by (created_at, id) — the slot order. ──
  const claimRows = rows.claims.slice().sort(compareClaimRows)
  const rowByClaimId = new Map<string, SourceClaimRow>()
  for (const row of claimRows) {
    // First wins: claimRows is already in total order, so this is deterministic.
    if (!rowByClaimId.has(row.id)) rowByClaimId.set(row.id, row)
  }

  // ── Links, sorted by (created_at, sourceTypeRank, targetKey, source, rel). ──
  const links = rows.links
    .slice()
    .filter((l) => rowByClaimId.has(l.source_id))
    .sort(compareLinks)

  // ── Primary hub: decided BEFORE visibility, on a backdate-proof clock. ──
  // Every non-claim link target is a legitimate hub type (source.ts drops rows
  // whose target is neither 'claim' nor registry-citable), so the earliest such
  // link decides a claim's home whether or not THIS viewer can read it. Doing
  // it after the readability filter would let a hub becoming readable — a
  // contact being shared, a team membership — re-point a claim that already had
  // a home, moving it and renumbering every sibling slot (§4.2).
  //
  // The clock is `max(link.created_at, claim.created_at)`: a link cannot
  // predate the claim it comes from, so a row stamped earlier is backdated
  // metadata (a weaver anchor carrying the meeting's date) and must not be able
  // to insert itself ahead of the provenance link that is already the home.
  const linkClock = (l: SourceLinkRow): number =>
    Math.max(
      parseTime(l.created_at),
      parseTime((rowByClaimId.get(l.source_id) as SourceClaimRow).created_at),
    )

  const primaryHubKey = new Map<string, NodeKey>()
  const primaryHubRank = new Map<string, [number, number, NodeKey]>()
  for (const l of links) {
    if (l.target_type === 'claim') continue
    const key = hubKey(l.target_type, l.target_id)
    const rank: [number, number, NodeKey] = [
      linkClock(l),
      sourceTypeRank(l.target_type),
      key,
    ]
    const best = primaryHubRank.get(l.source_id)
    if (best !== undefined && compareRank(best, rank) <= 0) continue
    primaryHubRank.set(l.source_id, rank)
    primaryHubKey.set(l.source_id, key)
  }

  // Home = that hub when the viewer can read it. When they cannot, the claim
  // goes to its unfiled month hub — it does NOT fall through to the next
  // readable link, so a claim has ONE home, identical for every viewer who can
  // see that home.
  const assignedHubKey = new Map<string, NodeKey>()
  for (const row of claimRows) {
    const explicit = primaryHubKey.get(row.id)
    const visible = explicit !== undefined && hubByKey.has(explicit)
    assignedHubKey.set(
      row.id,
      visible ? (explicit as NodeKey) : unfiledKeyFor(row.created_at),
    )
  }

  // ── Hub set: every hub that is the primary hub of a row, plus every
  // resolvable hub targeted by a link from an included claim. ──
  const hubRowCount = new Map<NodeKey, number>()
  for (const row of claimRows) {
    const key = assignedHubKey.get(row.id) as NodeKey
    hubRowCount.set(key, (hubRowCount.get(key) ?? 0) + 1)
  }

  const hubFirstSeen = new Map<NodeKey, number>()
  const referenced = new Set<NodeKey>()
  for (const l of links) {
    if (l.target_type === 'claim') continue
    const key = hubKey(l.target_type, l.target_id)
    if (!hubByKey.has(key)) continue
    const row = rowByClaimId.get(l.source_id)
    // Only a link from an INCLUDED claim brings a hub into the map, but
    // firstSeen is "earliest incident link from claim rows" — every row counts,
    // so a hub's birth time does not move when one of its claims is dismissed.
    if (row && isNodeRow(row)) referenced.add(key)
    // Same backdate-proof clock as the primary hub: birth order is what the
    // whole sequential packing is indexed on, so a link stamped before its own
    // claim must not be able to re-order it.
    const t = linkClock(l)
    const prev = hubFirstSeen.get(key)
    if (prev === undefined || t < prev) hubFirstSeen.set(key, t)
  }

  // ── Birth count: rows homed here within 24 h of firstSeen. ──
  // This, not `rowCount`, sizes the reserved disc. It is immutable under
  // appends, which is the whole point: a hub's reserved radius is an input to
  // every LATER hub's placement, so anything that can grow would drag the
  // entire tail of the map with it.
  const hubBirthCount = new Map<NodeKey, number>()
  for (const row of claimRows) {
    const key = assignedHubKey.get(row.id) as NodeKey
    const born = key.startsWith('unfiled:')
      ? unfiledFirstSeen(key)
      : hubFirstSeen.get(key)
    if (born === undefined) continue
    if (parseTime(row.created_at) > born + BIRTH_WINDOW_MS) continue
    hubBirthCount.set(key, (hubBirthCount.get(key) ?? 0) + 1)
  }

  // A hub is in the map when an included claim's primary hub points at it, or
  // an included claim links to it.
  const includedPrimary = new Set<NodeKey>()
  for (const row of claimRows) {
    if (!isNodeRow(row)) continue
    includedPrimary.add(assignedHubKey.get(row.id) as NodeKey)
  }

  const hubKeys: NodeKey[] = []
  for (const key of hubRowCount.keys()) {
    if (includedPrimary.has(key) || referenced.has(key)) hubKeys.push(key)
  }
  for (const key of referenced) {
    if (!hubRowCount.has(key)) hubKeys.push(key)
  }
  hubKeys.sort()

  const hubIndex = new Map<NodeKey, number>()
  const hubs: BuiltHub[] = hubKeys.map((key, i) => {
    hubIndex.set(key, i)
    const meta = hubByKey.get(key)
    const virtual = meta === undefined
    return {
      key,
      type: meta?.type ?? '',
      id: meta?.id ?? key.slice('unfiled:'.length),
      label: virtual ? unfiledLabel(key) : shortLabel(meta.label),
      virtual,
      firstSeen: virtual ? unfiledFirstSeen(key) : (hubFirstSeen.get(key) ?? 0),
      rowCount: hubRowCount.get(key) ?? 0,
      birthCount: hubBirthCount.get(key) ?? 0,
      degree: 0,
    }
  })

  // ── Slots: rank among ALL rows of the hub, in (created_at, id) order. ──
  // claimRows is already in that order, so a running counter per hub is the
  // rank. Dismissed rows consume a slot and leave a hole (§4.2).
  const slotCursor = new Map<NodeKey, number>()
  const claims: BuiltClaim[] = []
  const claimIndex = new Map<string, number>()
  for (const row of claimRows) {
    const key = assignedHubKey.get(row.id) as NodeKey
    const slot = slotCursor.get(key) ?? 0
    slotCursor.set(key, slot + 1)
    if (!isNodeRow(row)) continue
    const hub = hubIndex.get(key)
    if (hub === undefined) continue
    claimIndex.set(row.id, claims.length)
    claims.push({
      key: claimKey(row.id),
      id: row.id,
      // The row's own string. Do NOT normalise or slice it here: the mask
      // compares against the full text, exactly as `ilike` does in SQL.
      text: row.text,
      type: (CLAIM_TYPES as readonly string[]).includes(row.type)
        ? row.type
        : 'fact',
      confidence: typeof row.confidence === 'number' ? row.confidence : null,
      confirmed: row.confirmation === 'confirmed',
      scope: claimScope(row.scope),
      autoAccepted: typeof row.auto_accepted === 'boolean' ? row.auto_accepted : null,
      createdBy: row.created_by || null,
      createdAt: parseTime(row.created_at),
      eventAt: parseNullableTime(row.event_at),
      lastVerifiedAt: parseNullableTime(row.last_verified_at),
      hub,
      slot,
      degree: 0,
    })
  }

  // ── Edges. Deduped on (source, target, relation), so a byte-identical
  // repeat row is dropped — but two rows that differ only in `relation` are
  // two edges, because the relation is visible in the renderer and the
  // inspector. Degree and `claimHubTargets` are therefore counted over
  // DISTINCT (source, target) pairs below, not over kept edges. ──
  const relationSet = new Set<string>()
  const seenEdge = new Set<string>()
  const rawEdges: Array<{ source: number; target: number; targetIsClaim: boolean; relation: string }> = []
  for (const l of links) {
    const source = claimIndex.get(l.source_id)
    if (source === undefined) continue
    let target: number | undefined
    let targetIsClaim = false
    if (l.target_type === 'claim') {
      // claim→claim links survive only when BOTH claims are included.
      target = claimIndex.get(l.target_id)
      targetIsClaim = true
      if (target === undefined) continue
      if (target === source) continue
    } else {
      target = hubIndex.get(hubKey(l.target_type, l.target_id))
      if (target === undefined) continue
    }
    const relation = l.relation || ''
    const dedupe = `${source}\u0000${targetIsClaim ? 'c' : 'h'}${target}\u0000${relation}`
    if (seenEdge.has(dedupe)) continue
    seenEdge.add(dedupe)
    relationSet.add(relation)
    rawEdges.push({ source, target, targetIsClaim, relation })
  }

  const relations = Array.from(relationSet).sort()
  const relIndex = new Map<string, number>()
  relations.forEach((r, i) => relIndex.set(r, i))

  const edges: BuiltEdge[] = rawEdges.map((e) => ({
    source: e.source,
    target: e.target,
    targetIsClaim: e.targetIsClaim,
    rel: relIndex.get(e.relation) as number,
  }))
  // Total order so the edge list itself is input-order independent.
  edges.sort(
    (a, b) =>
      a.source - b.source ||
      (a.targetIsClaim ? 1 : 0) - (b.targetIsClaim ? 1 : 0) ||
      a.target - b.target ||
      a.rel - b.rel,
  )

  // ── Degree = DISTINCT (source, target) pairs incident on the node (§4.2). ──
  // One claim that links to one hub under two relations is one connection: it
  // must not count twice toward the hub's degree, which drives its radius, its
  // importance and therefore which tile it lands in. `edges` is sorted by
  // (source, targetIsClaim, target, rel), so duplicates are adjacent and the
  // surviving entry is deterministically the lowest relation.
  const claimHubTargets: number[][] = claims.map(() => [])
  const seenPair = new Set<string>()
  for (const e of edges) {
    const pair = `${e.source} ${e.targetIsClaim ? 'c' : 'h'}${e.target}`
    if (seenPair.has(pair)) continue
    seenPair.add(pair)
    claims[e.source].degree++
    if (e.targetIsClaim) {
      claims[e.target].degree++
    } else {
      hubs[e.target].degree++
      claimHubTargets[e.source].push(e.target)
    }
  }

  // ── Birth neighbours: the placement target for each hub (§4.2). ──
  // Only links created inside a hub's birth window count, so a link added
  // months later cannot change where an already-placed hub was put. Weight is
  // per distinct (claim, hub) pair for the same reason degree is.
  // The relation is symmetric: a claim homed on X that links to Y makes each a
  // birth neighbour of the other, but each side is admitted only inside ITS OWN
  // window, so neither hub's target can be changed by the other's later links.
  const birthNeighbours: Array<Map<number, number>> = hubs.map(() => new Map())
  const seenBirthPair = new Set<string>()
  for (const l of links) {
    if (l.target_type === 'claim') continue
    const target = hubIndex.get(hubKey(l.target_type, l.target_id))
    if (target === undefined) continue
    const homeKey = assignedHubKey.get(l.source_id)
    if (homeKey === undefined) continue
    const home = hubIndex.get(homeKey)
    if (home === undefined || home === target) continue
    const pair = `${home} ${target} ${l.source_id}`
    if (seenBirthPair.has(pair)) continue
    seenBirthPair.add(pair)
    const t = linkClock(l)
    if (t <= hubs[home].firstSeen + BIRTH_WINDOW_MS) {
      const w = birthNeighbours[home]
      w.set(target, (w.get(target) ?? 0) + 1)
    }
    if (t <= hubs[target].firstSeen + BIRTH_WINDOW_MS) {
      const w = birthNeighbours[target]
      w.set(home, (w.get(home) ?? 0) + 1)
    }
  }

  const entityTypes = Array.from(
    new Set(hubs.filter((h) => !h.virtual).map((h) => h.type)),
  ).sort()

  const projects = hubs
    .filter((h) => h.type === 'project')
    .map((h) => ({ id: h.id, label: h.label }))
    .sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  return {
    claims,
    hubs,
    edges,
    entityTypes,
    relations,
    projects,
    claimHubTargets,
    birthNeighbours,
    totalClaimNodes: claims.length,
  }
}

function compareClaimRows(a: SourceClaimRow, b: SourceClaimRow): number {
  const ta = parseTime(a.created_at)
  const tb = parseTime(b.created_at)
  if (ta !== tb) return ta - tb
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Total order on links: `(created_at, sourceTypeRank, targetKey, source, rel)`.
 *
 * `sourceTypeRank` sits directly after the timestamp because the primary hub is
 * "the first link in this order", and provenance has to win a same-instant tie
 * against an anchor written in the same transaction.
 */
function compareLinks(a: SourceLinkRow, b: SourceLinkRow): number {
  const ta = parseTime(a.created_at)
  const tb = parseTime(b.created_at)
  if (ta !== tb) return ta - tb
  const ra = sourceTypeRank(a.target_type)
  const rb = sourceTypeRank(b.target_type)
  if (ra !== rb) return ra - rb
  const ka = hubKey(a.target_type, a.target_id)
  const kb = hubKey(b.target_type, b.target_id)
  if (ka !== kb) return ka < kb ? -1 : 1
  if (a.source_id !== b.source_id) return a.source_id < b.source_id ? -1 : 1
  return a.relation < b.relation ? -1 : a.relation > b.relation ? 1 : 0
}
