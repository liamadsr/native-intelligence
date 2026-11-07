/**
 * The claim mask — an open `MapPredicate[]` evaluated over the laid-out map's
 * typed arrays.
 *
 * This is the map's half of the invariant `filter-model.ts` exists to protect:
 * one saved claim view, drawn either as SQL rows or as this canvas, must select
 * the SAME claims. The SQL side gets Postgres's semantics for free; everything
 * below is that behaviour written out by hand.
 *
 * THREE-VALUED LOGIC IS THE WHOLE JOB. A null fails `is`, `is_not`,
 * `is_any_of`, `is_none_of`, every text operator, `gt`/`gte`/`lt`/`lte`,
 * `between` and `is_relative`; it matches `is_empty` alone. `is_not` is the one
 * that reads wrong: "confidence is not 0.9" feels like it should include the
 * un-scored claims, and in SQL it does not, because `NULL <> 0.9` is NULL and
 * NULL is not true. Every negative operator below therefore gates on the null
 * sentinel FIRST and only then negates.
 *
 * Positions are never consulted. The mask decides membership over a map that is
 * already laid out, which is what lets a filter change re-rank tiles without
 * moving a single node (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §4.3).
 */

import { isUnsetFilterValue, type FilterOperator, type RangeValue } from '@/lib/views/types'
import {
  MAP_FILTER_FIELDS,
  type MapFilterField,
  type MapFilters,
  type MapPredicate,
} from './filter-model'
import {
  NO_CODE,
  NO_CONFIDENCE,
  NO_INDEX,
  SCOPE_CODE,
  type LaidOutMap,
} from './layout'
import { CLAIM_TYPES } from './types'

/** Decides ONE claim index against ONE predicate. */
type ClaimTest = (claim: number) => boolean

const MATCH_NONE: ClaimTest = () => false
const MATCH_ALL: ClaimTest = () => true

/**
 * `is` / `is_any_of` select the listed values; `is_not` / `is_none_of` reject
 * them. Anything else is not a set operator at all.
 *
 * Returning `null` rather than a boolean is what makes the set compilers fail
 * CLOSED like the number, date and text ones already do. A plain
 * `op === 'is' || op === 'is_any_of'` reads an unrecognised operator as a
 * NEGATION, so a predicate the type system did not stop — `created_by contains`
 * from a hand-built `TileMapOptions`, say — would have quietly inverted the
 * filter and drawn every claim the user was excluding.
 */
function setDirection(op: FilterOperator): boolean | null {
  if (op === 'is' || op === 'is_any_of') return true
  if (op === 'is_not' || op === 'is_none_of') return false
  return null
}

/** Hub node keys are `<entity_type>:<uuid>`. */
const PROJECT_PREFIX = 'project:'

/**
 * Per-build scratch shared by every predicate.
 *
 * Built lazily because each entry costs a pass over the map: a filter set with
 * no `project_ids` chip must not pay for a hub scan, and one with no `text`
 * chip must not allocate a lower-cased copy of every claim.
 */
class MaskContext {
  private projectsByIdCache: Map<string, number> | null = null
  private projectNodesCache: Uint8Array | null = null
  private creatorsCache: Map<string, number> | null = null
  private loweredCache: Array<string | undefined> | null = null

  constructor(private readonly map: LaidOutMap) {}

  /** Lower-cased project id → its hub node index. */
  projectsById(): Map<string, number> {
    if (!this.projectsByIdCache) this.scanProjectHubs()
    return this.projectsByIdCache as Map<string, number>
  }

  /** `1` at every node index that is a project hub. */
  projectNodes(): Uint8Array {
    if (!this.projectNodesCache) this.scanProjectHubs()
    return this.projectNodesCache as Uint8Array
  }

  /**
   * The map already walks `claimHubOffsets`/`claimHubTargets` for every hub a
   * claim links to; a project filter is that adjacency restricted to project
   * hubs. Identifying them by key prefix is the only handle the laid-out map
   * offers — `etype` indexes a per-map table whose contents depend on which
   * entity types this viewer can see.
   */
  private scanProjectHubs(): void {
    const byId = new Map<string, number>()
    const isProject = new Uint8Array(this.map.count)
    for (let n = this.map.claimCount; n < this.map.count; n++) {
      const key = this.map.keys[n]
      if (!key.startsWith(PROJECT_PREFIX)) continue
      isProject[n] = 1
      byId.set(key.slice(PROJECT_PREFIX.length).toLowerCase(), n)
    }
    this.projectsByIdCache = byId
    this.projectNodesCache = isProject
  }

  /** Lower-cased author id → index into `claimCreatedBy`'s string table. */
  creators(): Map<string, number> {
    if (!this.creatorsCache) {
      const byId = new Map<string, number>()
      this.map.claimCreators.forEach((id, i) => byId.set(id, i))
      this.creatorsCache = byId
    }
    return this.creatorsCache
  }

  /**
   * A claim's text, lower-cased once per BUILD rather than once per predicate.
   *
   * Two text chips over a 10⁵-claim workspace would otherwise allocate 2×10⁵
   * strings; the memo makes it 10⁵, and only when a text chip exists at all.
   */
  lowered(claim: number): string {
    if (!this.loweredCache) this.loweredCache = new Array(this.map.claimCount)
    const hit = this.loweredCache[claim]
    if (hit !== undefined) return hit
    const value = this.raw(claim).toLowerCase()
    this.loweredCache[claim] = value
    return value
  }

  /**
   * A claim's text exactly as stored.
   *
   * `is` / `is_not` are `eq` / `neq` in SQL — case-SENSITIVE — so they compare
   * against this rather than the folded copy. Since `shortLabel` moved to tile
   * serialization, `labels[claim]` IS the full untruncated text.
   */
  raw(claim: number): string {
    return this.map.labels[claim]
  }
}

/**
 * Which claims survive `filters`. Returns a keep-mask over claim indices.
 *
 * Predicates are ANDed, matching the views engine, which chains every filter
 * onto one PostgREST query.
 */
export function maskClaims(map: LaidOutMap, filters: MapFilters): Uint8Array {
  const keep = new Uint8Array(map.claimCount).fill(1)
  const where = filters.where ?? []
  if (where.length === 0) return keep

  const ctx = new MaskContext(map)
  const tests = where.map((p) => compile(map, p, ctx))

  for (let c = 0; c < map.claimCount; c++) {
    for (let t = 0; t < tests.length; t++) {
      if (tests[t](c)) continue
      keep[c] = 0
      break
    }
  }
  return keep
}

function compile(map: LaidOutMap, p: MapPredicate, ctx: MaskContext): ClaimTest {
  switch (MAP_FILTER_FIELDS[p.field].kind) {
    case 'enum':
      return compileEnum(map, p)
    case 'boolean':
      return compileBoolean(map, p)
    case 'id':
      return compileId(map, p, ctx)
    case 'idSet':
      return compileIdSet(map, p, ctx)
    case 'number':
      return compileNumber(map, p)
    case 'date':
      return compileDate(map, p)
    case 'text':
      return compileText(p, ctx)
  }
}

// ─── enum: type · confirmation · scope ────────────────────────────────────────

/** How a claim's enum column is read, and which value means "not set". */
interface EnumColumn {
  read: (claim: number) => number
  /** Codes accepted by this field, by their wire spelling. */
  codes: ReadonlyMap<string, number>
  /** `NO_CODE`, or -1 for a column that genuinely cannot be null. */
  nullCode: number
}

function enumColumn(map: LaidOutMap, field: MapFilterField): EnumColumn {
  switch (field) {
    case 'type': {
      const codes = new Map<string, number>()
      // Index into CLAIM_TYPES itself: the same ordering is baked into the
      // per-node `flags` byte the renderer reads.
      CLAIM_TYPES.forEach((t, i) => codes.set(t, i))
      // `graph-build` coerces an unrecognised type to 'fact', so there is no
      // null to gate on — a claim always has one of the four.
      return { read: (c) => map.claimTypeIdx[c], codes, nullCode: -1 }
    }
    case 'confirmation': {
      // Dismissed rows are not nodes at all (§4.1), so the column is a bit.
      const codes = new Map<string, number>([['suggested', 0], ['confirmed', 1]])
      return { read: (c) => map.claimConfirmed[c], codes, nullCode: -1 }
    }
    default: {
      const codes = new Map<string, number>(Object.entries(SCOPE_CODE))
      return { read: (c) => map.claimScope[c], codes, nullCode: NO_CODE }
    }
  }
}

function compileEnum(map: LaidOutMap, p: MapPredicate): ClaimTest {
  const { read, codes, nullCode } = enumColumn(map, p.field)
  const wanted = new Set<number>()
  for (const raw of p.value as string[]) {
    const code = codes.get(raw)
    if (code !== undefined) wanted.add(code)
  }
  const positive = setDirection(p.op)
  if (positive === null) return MATCH_NONE

  return (c) => {
    const code = read(c)
    if (code === nullCode) return false
    return wanted.has(code) === positive
  }
}

// ─── boolean: auto_accepted ───────────────────────────────────────────────────

function compileBoolean(map: LaidOutMap, p: MapPredicate): ClaimTest {
  const want = p.value === true ? 1 : 0
  return (c) => {
    const v = map.claimAutoAccepted[c]
    return v !== NO_CODE && v === want
  }
}

// ─── id: created_by ───────────────────────────────────────────────────────────

function compileId(map: LaidOutMap, p: MapPredicate, ctx: MaskContext): ClaimTest {
  if (p.op === 'is_empty') return (c) => map.claimCreatedBy[c] === NO_INDEX
  if (p.op === 'is_not_empty') return (c) => map.claimCreatedBy[c] !== NO_INDEX

  const creators = ctx.creators()
  const wanted = new Set<number>()
  for (const raw of p.value as string[]) {
    const at = creators.get(raw.toLowerCase())
    if (at !== undefined) wanted.add(at)
  }
  const positive = setDirection(p.op)
  if (positive === null) return MATCH_NONE

  return (c) => {
    const at = map.claimCreatedBy[c]
    // A null author fails BOTH directions. "created_by is not Ana" must not
    // sweep in the rows nobody is recorded as having written.
    if (at === NO_INDEX) return false
    return wanted.has(at) === positive
  }
}

// ─── idSet: project_ids ───────────────────────────────────────────────────────

/**
 * A claim's project links, against a set of project hub node indices.
 *
 * `want === null` asks only whether the claim sits on ANY project, which is
 * what `is_empty` / `is_not_empty` mean for a set-valued field.
 */
function linksToProject(
  map: LaidOutMap,
  isProject: Uint8Array,
  claim: number,
  want: ReadonlySet<number> | null,
): boolean {
  const end = map.claimHubOffsets[claim + 1]
  for (let i = map.claimHubOffsets[claim]; i < end; i++) {
    const node = map.claimHubTargets[i]
    if (!isProject[node]) continue
    if (want === null || want.has(node)) return true
  }
  return false
}

function compileIdSet(map: LaidOutMap, p: MapPredicate, ctx: MaskContext): ClaimTest {
  const isProject = ctx.projectNodes()

  if (p.op === 'is_empty') return (c) => !linksToProject(map, isProject, c, null)
  if (p.op === 'is_not_empty') return (c) => linksToProject(map, isProject, c, null)

  const byId = ctx.projectsById()
  const wanted = new Set<number>()
  for (const raw of p.value as string[]) {
    const node = byId.get(raw.toLowerCase())
    // A project this viewer cannot see, or one with no claims, is simply not a
    // node here. Dropping it is right: no claim on THIS map is linked to it.
    if (node !== undefined) wanted.add(node)
  }

  // `project_ids` is `uuid[] NOT NULL DEFAULT '{}'` (migration 276), so unlike
  // every other nullable field the empty set is a VALUE, not a null — and
  // `NOT (project_ids && ARRAY[…])` is true for it in Postgres. So a claim on
  // no project really does satisfy "project is none of X", and the
  // three-valued gate that guards `created_by` would be wrong here.
  const positive = setDirection(p.op)
  if (positive === null) return MATCH_NONE
  if (positive) return (c) => linksToProject(map, isProject, c, wanted)
  return (c) => !linksToProject(map, isProject, c, wanted)
}

// ─── number: confidence ───────────────────────────────────────────────────────

/**
 * Round the operand into the array's own precision before comparing.
 *
 * `claimConfidence` is a Float32Array, so a claim stored as exactly 0.7 reads
 * back as 0.699999988…. Comparing that against the float64 literal 0.7 makes
 * `confidence >= 0.7` exclude the claim whose confidence IS 0.7 — off by one
 * claim, silently, and only for the values a person actually types. Rounding
 * the operand the same way puts both sides in the same number system.
 */
function operand(value: unknown): number {
  return Math.fround(Number(value))
}

function compileNumber(map: LaidOutMap, p: MapPredicate): ClaimTest {
  const conf = map.claimConfidence
  // The CHECK constraint bounds a real confidence to [0, 1], so any negative
  // value in the column is the `NO_CONFIDENCE` sentinel.
  const isNull = (c: number): boolean => conf[c] < 0

  switch (p.op) {
    case 'is_empty':
      return isNull
    case 'is_not_empty':
      return (c) => !isNull(c)
    case 'between': {
      // A half-filled range bounds only the side that is set, like the SQL
      // list (`Number('')` would otherwise turn an empty bound into 0).
      const range = (p.value ?? {}) as Partial<RangeValue>
      const fromSet = !isUnsetFilterValue(range.from)
      const toSet = !isUnsetFilterValue(range.to)
      if (!fromSet && !toSet) return MATCH_ALL
      const from = fromSet ? operand(range.from) : -Infinity
      const to = toSet ? operand(range.to) : Infinity
      return (c) => !isNull(c) && conf[c] >= from && conf[c] <= to
    }
    default: {
      const v = operand(p.value)
      if (!Number.isFinite(v)) return MATCH_NONE
      switch (p.op) {
        case 'is':
          return (c) => !isNull(c) && conf[c] === v
        case 'is_not':
          return (c) => !isNull(c) && conf[c] !== v
        case 'gt':
          return (c) => !isNull(c) && conf[c] > v
        case 'gte':
          return (c) => !isNull(c) && conf[c] >= v
        case 'lt':
          return (c) => !isNull(c) && conf[c] < v
        case 'lte':
          return (c) => !isNull(c) && conf[c] <= v
        default:
          return MATCH_NONE
      }
    }
  }
}

// ─── date: created_at · event_at · last_verified_at ───────────────────────────

function dateColumn(map: LaidOutMap, field: MapFilterField): Float64Array {
  switch (field) {
    case 'event_at':
      return map.claimEventAt
    case 'last_verified_at':
      return map.claimLastVerifiedAt
    default:
      return map.claimCreatedAt
  }
}

function compileDate(map: LaidOutMap, p: MapPredicate): ClaimTest {
  const at = dateColumn(map, p.field)

  switch (p.op) {
    case 'is_empty':
      return (c) => Number.isNaN(at[c])
    case 'is_not_empty':
      return (c) => !Number.isNaN(at[c])
    case 'is_relative':
      // Unreachable in production: `service.ts` rewrites every relative window
      // into a concrete `between` before tiling, using the SAME resolver the
      // SQL list uses, so one saved view cannot mean two windows. Resolving it
      // here instead would need that resolver inside the isomorphic core,
      // which transitively imports `next/headers` and would break every client
      // bundle that touches the map. Throwing keeps a mis-wired caller loud
      // rather than handing it a silently unfiltered map.
      throw new Error(
        'knowledge map: is_relative reached the mask unresolved — resolve it in service.ts',
      )
    case 'between': {
      // A half-filled range bounds only the side that is set, like the SQL list.
      const range = (p.value ?? {}) as Partial<RangeValue>
      const fromSet = !isUnsetFilterValue(range.from)
      const toSet = !isUnsetFilterValue(range.to)
      if (!fromSet && !toSet) return MATCH_ALL
      const from = fromSet ? Date.parse(String(range.from)) : -Infinity
      const to = toSet ? Date.parse(String(range.to)) : Infinity
      if (Number.isNaN(from) || Number.isNaN(to)) return MATCH_NONE
      // NaN fails both comparisons on its own, which is exactly a null's
      // behaviour — no explicit gate needed on the ordered operators.
      return (c) => at[c] >= from && at[c] <= to
    }
    default: {
      const v = Date.parse(String(p.value))
      if (!Number.isFinite(v)) return MATCH_NONE
      switch (p.op) {
        case 'is':
          // Instant equality, mirroring the SQL `=`. The views date picker
          // sends an instant, not a day, on both paths.
          return (c) => at[c] === v
        case 'is_not':
          // The one comparison NaN would get WRONG by falling through:
          // `NaN !== v` is true, so an unset date has to be gated explicitly.
          return (c) => !Number.isNaN(at[c]) && at[c] !== v
        case 'gt':
          return (c) => at[c] > v
        case 'gte':
          return (c) => at[c] >= v
        case 'lt':
          return (c) => at[c] < v
        case 'lte':
          return (c) => at[c] <= v
        default:
          return MATCH_NONE
      }
    }
  }
}

// ─── text ─────────────────────────────────────────────────────────────────────

function compileText(p: MapPredicate, ctx: MaskContext): ClaimTest {
  // `claim.text` is `TEXT NOT NULL`, so the SQL `text IS NULL` matches nothing
  // and `IS NOT NULL` matches everything — including a claim whose text is the
  // empty string. The map has to answer the same way or the two engines
  // disagree on a filter the picker offers.
  if (p.op === 'is_empty') return MATCH_NONE
  if (p.op === 'is_not_empty') return MATCH_ALL

  // CASE SENSITIVITY IS PER OPERATOR, because it is per operator in SQL.
  // `applyColumnFilter` runs the four substring operators through `ilike`
  // (case-INsensitive) and `is` / `is_not` through `eq` / `neq`
  // (case-SENSITIVE). The map has to split the same way: lower-casing
  // everything would make `Text is "budget approved"` match a claim reading
  // "Budget approved" on the canvas and not in the list, for one saved view.
  //
  // The needle arrives exactly as the user typed it — `normalisePredicate` does
  // not fold case or collapse whitespace, because `ilike` does neither.
  const needle = p.value as string
  const lowerNeedle = needle.toLowerCase()

  switch (p.op) {
    case 'contains':
      return (c) => ctx.lowered(c).includes(lowerNeedle)
    case 'does_not_contain':
      return (c) => !ctx.lowered(c).includes(lowerNeedle)
    case 'starts_with':
      return (c) => ctx.lowered(c).startsWith(lowerNeedle)
    case 'ends_with':
      return (c) => ctx.lowered(c).endsWith(lowerNeedle)
    case 'is':
      return (c) => ctx.raw(c) === needle
    case 'is_not':
      return (c) => ctx.raw(c) !== needle
    default:
      return MATCH_NONE
  }
}
