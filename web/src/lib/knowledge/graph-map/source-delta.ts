/**
 * Knowledge Map — DELTA refresh of a viewer's cached `SourceRows` (tier A+).
 *
 * Today any write to the workspace moves the probe version, and the next
 * `GET …/map` re-reads EVERY claim and link through ~N/1000 parallel PostgREST
 * pages before the (comparatively fast) relayout. At 10⁵ claims that full
 * re-read — not the layout — is the on-demand tier's bottleneck
 * (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §8, tier "A+").
 *
 * This module reads only what changed since the cached rows' watermark, and the
 * service merges it into the rows it already holds.
 *
 * SECURITY: like `source.ts`, everything here runs on the **user-session**
 * client from `requireWorkspace()`. The delta is a narrower read of the same
 * RLS-scoped tables — never a service-role client, never a cache shared between
 * users. A row the viewer cannot read is absent from the delta exactly as it is
 * absent from a full fetch.
 *
 * CORRECTNESS: a delta can only ever ADD or UPDATE. It cannot see deletions,
 * hub renames, or a row becoming visible without its timestamp moving. Those
 * are caught by the caller, not here: `service.ts` validates the merged counts
 * against the probe and falls back to a full `fetchSourceRows` on any mismatch,
 * and forces a full refresh once the cached rows pass a TTL.
 */

import { createHash } from 'crypto'
import {
  ALGO_VERSION,
  type SourceClaimRow,
  type SourceLinkRow,
  type SourceHubRow,
  type SourceRows,
} from '@/lib/knowledge/graph-map/types'
import {
  CLAIM_SELECT,
  isCitableType,
  resolveEntityLabels,
  type MapSourceClient,
} from '@/lib/knowledge/graph-map/source'

/** PostgREST caps a response at 1000 rows regardless of `.limit()`. */
const PAGE_SIZE = 1000
/** Parallel in-flight page requests — same budget as `source.ts`. */
const CONCURRENCY = 8
/** Refuse to page forever if `count` comes back absurd (or lies). */
const MAX_ROWS = 400_000

/** Run `tasks` with at most `limit` in flight, preserving result order. */
async function pooled<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= tasks.length) return
      out[i] = await tasks[i]()
    }
  })
  await Promise.all(workers)
  return out
}

/** Coerce an unknown column value to a trimmed string. */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/**
 * The slice of the PostgREST builder the delta reads use, after `select`.
 *
 * supabase-js types the builder generically over the row shape its select list
 * produces, which differs per query and is deep enough to trip TS2589 when a
 * shared helper tries to infer through it. The delta only ever adds a lower
 * bound, an order and a range, so it speaks to this structural shape instead
 * and reads the rows back as plain records — the same trick `source.ts` uses
 * for its runtime-built select lists.
 */
interface QueryError {
  message: string
}

/**
 * A failed read must NEVER degrade into "no rows" or "count 0": the service
 * would cache an empty (or truncated) map for this viewer until the TTL. Throw
 * instead — service.ts treats a delta error as "do a full fetch", and a failed
 * full fetch surfaces as a 500 the client can retry.
 */
function assertOk(what: string, ...results: Array<{ error?: QueryError | null }>): void {
  for (const r of results) {
    if (r.error) throw new Error(`knowledge map: ${what} failed: ${r.error.message}`)
  }
}

interface Bounded {
  gte(column: string, value: string): Bounded
  order(column: string, opts?: { ascending?: boolean }): Bounded
  range(from: number, to: number): Bounded
  then<R>(
    ok: (v: { data: unknown[] | null; count: number | null; error?: QueryError | null }) => R,
  ): PromiseLike<R>
}

/** The same trick for the one strictly-before count. */
interface BoundedLt {
  lt(column: string, value: string): PromiseLike<{ count: number | null; error?: QueryError | null }>
}

/**
 * The raw parts of the freshness probe.
 *
 * `probeVersion` hashes these into an opaque token, which is all the wire needs
 * but not enough to drive a delta: we need the max timestamps to know where to
 * read from, and the counts to validate the merge. `probeParts` runs the same
 * four queries and returns both.
 */
export interface ProbeParts {
  claimCount: number
  /** Max `claim.updated_at` in the workspace; '' when there are no claims. */
  claimMaxUpdatedAt: string
  linkCount: number
  /** Max `entity_link.created_at` for claim-sourced links; '' when none. */
  linkMaxCreatedAt: string
  /** Identical to `probeVersion(supabase, workspaceId)` for the same rows. */
  version: string
}

/** A cached `SourceRows` plus everything needed to extend it incrementally. */
export interface SourceSnapshot {
  rows: SourceRows
  /** The probe parts the rows are known to match. */
  watermark: Omit<ProbeParts, 'version'>
  /** Version token the rows were built at. */
  version: string
  /** Claim id → index into `rows.claims`, so an update is an in-place upsert. */
  claimIndex: Map<string, number>
  /**
   * `entity_link` row ids already merged. `SourceLinkRow` carries no id, so the
   * ids are held here alongside the rows rather than on them — the frozen wire
   * shape the pure core consumes must not grow a transport-only field.
   */
  linkIds: Set<string>
  /** `${type}:${id}` of every hub already resolved (label lookups are the
   *  expensive part of a delta, so a known target is never re-queried). */
  hubKeys: Set<string>
  /**
   * How many RAW `entity_link` rows this snapshot stands for — usable ones and
   * the unusable ones both read paths discard.
   *
   * NOT `rows.links.length`: `fetchSourceRows` drops links whose target is
   * neither 'claim' nor citable, and the delta drops the same ones, so the
   * usable count is legitimately smaller than the probe's in any workspace
   * holding a single `member` link. Validation compares this instead — it is
   * the only link number the probe can speak to.
   *
   * Held as `usable + dropped`, both re-derived on every delta, never
   * accumulated: a snapshot from a full fetch has already discarded the
   * unusable rows it read, so there is nothing left to recognise them by and
   * accumulating would count them a second time.
   *
   * It is exactly `rows.links.length + droppedLinkCount`, which is what makes
   * the check meaningful: every raw row is either retained or knowingly
   * dropped, so a row that vanished from the table without the snapshot
   * noticing shows up as a disagreement with the probe. See `applyDelta`.
   */
  rawLinkCount: number
  /** Raw rows this snapshot knowingly discarded as unusable. Part of the
   *  tally, since the probe counts them. */
  droppedLinkCount: number
  /** Epoch ms the rows were last fully validated against a probe. */
  fetchedAt: number
}

/**
 * Compute the version token EXACTLY as `probeVersion` does.
 *
 * `probeVersion` lives in `source.ts` and returns only the hash, so the two
 * hashings are duplicated rather than shared. `probeParts` is asserted against
 * `probeVersion` in `__tests__/source-delta.test.ts` so they cannot drift.
 */
function versionToken(parts: Omit<ProbeParts, 'version'>): string {
  const raw = [
    ALGO_VERSION,
    parts.claimCount,
    parts.claimMaxUpdatedAt,
    parts.linkCount,
    parts.linkMaxCreatedAt,
  ].join(':')
  return createHash('sha256').update(raw).digest('base64url').slice(0, 22)
}

/**
 * The freshness probe, with its raw parts exposed.
 *
 * Same four cheap queries as `probeVersion` (two `count: 'exact', head: true`
 * and two `limit(1)` descending reads — no row bodies, no PostgREST aggregates,
 * which may be disabled on the project), so using this in place of
 * `probeVersion` costs the service nothing.
 */
export async function probeParts(
  supabase: MapSourceClient,
  workspaceId: string,
): Promise<ProbeParts> {
  const [claimCount, claimLatest, linkCount, linkLatest] = await Promise.all([
    supabase
      .from('claim')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('claim')
      .select('updated_at')
      .eq('workspace_id', workspaceId)
      .order('updated_at', { ascending: false })
      .limit(1),
    supabase
      .from('entity_link')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim'),
    supabase
      .from('entity_link')
      .select('created_at')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim')
      .order('created_at', { ascending: false })
      .limit(1),
  ])

  const parts = {
    claimCount: (assertOk('version probe', claimCount, claimLatest, linkCount, linkLatest), claimCount.count ?? 0),
    claimMaxUpdatedAt: str((claimLatest.data ?? [])[0]?.updated_at),
    linkCount: linkCount.count ?? 0,
    linkMaxCreatedAt: str((linkLatest.data ?? [])[0]?.created_at),
  }
  return { ...parts, version: versionToken(parts) }
}

/** Page a filtered read in parallel, given its exact count. */
async function fetchPages<T>(
  count: number,
  page: (from: number, to: number) => Bounded,
): Promise<T[]> {
  const total = Math.min(Math.max(count, 0), MAX_ROWS)
  if (total === 0) return []

  const pages = Math.ceil(total / PAGE_SIZE)
  const chunks = await pooled(
    Array.from({ length: pages }, (_unused, i) => async () => {
      const from = i * PAGE_SIZE
      const res = await page(from, from + PAGE_SIZE - 1)
      assertOk('delta read', res)
      return (res.data ?? []) as T[]
    }),
    CONCURRENCY,
  )
  return chunks.flat()
}

/** What changed since a snapshot's watermark. */
export interface SourceDelta {
  /** New AND modified claims (upsert by id). */
  claims: SourceClaimRow[]
  /** New USABLE links, with the row ids the snapshot dedupes on. */
  links: Array<{ id: string; row: SourceLinkRow }>
  /**
   * EVERY usable link at-or-after the watermark bound — new and already-known.
   *
   * `applyDelta` replaces the retained tail with this rather than appending
   * `links` to it. A link deleted from inside the tail moves neither side of
   * the raw-count check (the probe's count and the delta's re-count shrink
   * together), so rebuilding the tail from what the table actually holds is
   * what keeps such a deletion from surviving in the cached rows.
   */
  tailLinks: SourceLinkRow[]
  /** Hubs for link targets the snapshot did not already know. */
  hubs: SourceHubRow[]
  /**
   * ALL distinct raw `entity_link` rows at-or-after the watermark bound —
   * usable, unusable, new and already-known alike.
   *
   * This is a re-count of the whole inclusive tail rather than a count of what
   * is new, which is what lets the tally be re-derived instead of accumulated:
   * a snapshot taken from a full fetch has already discarded the unusable rows
   * it read, so there is no way to recognise them on the next delta, and
   * accumulating would count them twice.
   */
  rawLinksAtBound: number
  /**
   * Raw `entity_link` rows STRICTLY BEFORE the watermark bound.
   *
   * One extra head-only count, and the reason the tally needs no reconciliation
   * with what the full fetch discarded: these rows are settled and invisible to
   * every future delta, so `linksBeforeBound + rawLinksAtBound` is the exact
   * raw total, dropped rows included.
   */
  linksBeforeBound: number
  /** Ids of the raw rows DROPPED as unusable, so the next delta recognises
   *  them rather than re-appending their usable siblings' neighbours. */
  droppedLinkIds: string[]
}

/**
 * Read every row that changed since `snapshot`'s watermark.
 *
 * Both bounds are INCLUSIVE (`>=`). `claim.updated_at` is trigger-maintained
 * and two rows can share a timestamp to the microsecond, so an exclusive bound
 * would silently drop the co-timestamped siblings of the row that set the
 * watermark. The overlap re-reads those few rows instead, and the merge is an
 * upsert by id / a dedupe by link id, so re-reading them costs nothing.
 */
export async function fetchSourceDelta(
  supabase: MapSourceClient,
  workspaceId: string,
  snapshot: SourceSnapshot,
): Promise<SourceDelta> {
  const { claimMaxUpdatedAt, linkMaxCreatedAt } = snapshot.watermark

  // An empty watermark means the snapshot held no rows of that kind, so there
  // is no lower bound to apply and the "delta" is simply everything.
  //
  // Typed structurally on the one method these helpers call. The builder's own
  // generics are deep enough that inferring through them here trips
  // "excessively deep" instantiation, and the concrete type differs per select
  // list anyway — `Bounded` is the only shape the filter needs.
  const claimsFrom = (q: Bounded): Bounded =>
    claimMaxUpdatedAt ? q.gte('updated_at', claimMaxUpdatedAt) : q
  const linksFrom = (q: Bounded): Bounded =>
    linkMaxCreatedAt ? q.gte('created_at', linkMaxCreatedAt) : q

  const [claimCount, linkCount, linksBefore] = await Promise.all([
    claimsFrom(
      supabase
        .from('claim')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId) as unknown as Bounded,
    ),
    linksFrom(
      supabase
        .from('entity_link')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('source_type', 'claim') as unknown as Bounded,
    ),
    // Rows strictly BEFORE the bound: settled, invisible to this and every
    // future delta, and therefore the stable base of the raw tally. Head-only,
    // so it costs one count and no payload.
    linkMaxCreatedAt
      ? (
          supabase
            .from('entity_link')
            .select('id', { count: 'exact', head: true })
            .eq('workspace_id', workspaceId)
            .eq('source_type', 'claim') as unknown as BoundedLt
        ).lt('created_at', linkMaxCreatedAt)
      : Promise.resolve<{ count: number | null; error?: QueryError | null }>({ count: 0 }),
  ])
  assertOk('delta count', claimCount, linkCount, linksBefore)

  const [claims, linkRows] = await Promise.all([
    fetchPages<SourceClaimRow>(claimCount.count ?? 0, (from, to) =>
      claimsFrom(
        supabase
          .from('claim')
          // The SAME list the full fetch reads, or an appended claim would
          // arrive missing the columns the mask filters on.
          .select(CLAIM_SELECT)
          .eq('workspace_id', workspaceId) as unknown as Bounded,
      )
        // Same stable ORDER as the full fetch: without one, PostgREST may serve
        // a row on two pages and miss another entirely.
        .order('updated_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
    fetchPages<SourceLinkRow & { id?: string }>(linkCount.count ?? 0, (from, to) =>
      linksFrom(
        supabase
          .from('entity_link')
          .select('id, source_id, target_type, target_id, relation, created_at')
          .eq('workspace_id', workspaceId)
          .eq('source_type', 'claim') as unknown as Bounded,
      )
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to),
    ),
  ])

  // Keep only links this snapshot has not already merged, and only targets the
  // map can hang a hub on — the same "neither 'claim' nor citable" rule the
  // full fetch applies, so the delta path can never admit a link the full path
  // would have dropped.
  const links: Array<{ id: string; row: SourceLinkRow }> = []
  const tailLinks: SourceLinkRow[] = []
  const unknownByType = new Map<string, Set<string>>()
  const seenRaw = new Set<string>()
  const droppedIds: string[] = []
  for (const raw of linkRows) {
    const tuple = `${raw.source_id}|${raw.target_type}|${raw.target_id}|${raw.relation}`
    const id = raw.id ?? tuple
    // The inclusive `>=` bound re-reads the rows that set the watermark, and a
    // page can overlap, so a raw row may arrive twice within one delta.
    if (seenRaw.has(id)) continue
    seenRaw.add(id)

    const usable =
      raw.target_type === 'claim' || (isCitableType(raw.target_type) && !!raw.target_id)
    if (!usable) {
      // Dropped rows never enter `rows.links`, but they ARE in the raw tally,
      // so the snapshot has to remember them or the next delta counts them
      // again and validation starts failing forever.
      droppedIds.push(id)
      continue
    }

    const row: SourceLinkRow = {
      source_id: raw.source_id,
      target_type: raw.target_type,
      target_id: raw.target_id,
      relation: raw.relation,
      created_at: raw.created_at,
    }
    // EVERY usable row in the tail, known or not — `applyDelta` rebuilds the
    // tail from this, which is how a deletion inside it is undone.
    tailLinks.push(row)

    // Match on EITHER key. A snapshot taken from a full fetch only knows
    // tuples (`fetchSourceRows` strips the transport-only `id` before the rows
    // leave it), so an id-only check would treat every link the first delta
    // re-reads as new.
    const known = snapshot.linkIds.has(id) || snapshot.linkIds.has(tuple)
    if (known) continue
    links.push({ id, row })

    if (raw.target_type === 'claim') continue
    if (snapshot.hubKeys.has(`${raw.target_type}:${raw.target_id}`)) continue
    let ids = unknownByType.get(raw.target_type)
    if (!ids) unknownByType.set(raw.target_type, (ids = new Set()))
    ids.add(raw.target_id)
  }

  // Label resolution is the expensive half of a source read, so it runs only
  // for targets the snapshot has never seen. Renames of a KNOWN hub are not
  // picked up here — the TTL full refresh is what converges those.
  const hubs: SourceHubRow[] = []
  if (unknownByType.size > 0) {
    const labels = await resolveEntityLabels(supabase, workspaceId, unknownByType)
    for (const [type, ids] of unknownByType) {
      for (const id of ids) {
        const label = labels.get(`${type}:${id}`)
        if (label === undefined) continue // RLS-hidden or deleted → not a hub
        hubs.push({ type, id, label })
      }
    }
  }

  // `seenRaw` holds every DISTINCT raw row at-or-after the bound, including the
  // ones recognised from the snapshot and skipped above.
  return {
    claims,
    links,
    tailLinks,
    hubs,
    rawLinksAtBound: seenRaw.size,
    linksBeforeBound: linksBefore.count ?? 0,
    droppedLinkIds: droppedIds,
  }
}

/**
 * Build the snapshot for a freshly fetched full `SourceRows`.
 *
 * The link ids a full fetch dedupes on are stripped before the rows leave
 * `source.ts`, so they are recomputed here from the tuple. That is the same
 * fallback key `fetchSourceRows` uses for a row without an id, and it only has
 * to be stable within one snapshot: a delta row whose real id differs but whose
 * tuple matches is a duplicate of a link already in the map, which is exactly
 * what we want dropped.
 */
export function snapshotOf(
  rows: SourceRows,
  parts: ProbeParts,
  nowMs: number,
): SourceSnapshot {
  const claimIndex = new Map<string, number>()
  rows.claims.forEach((c, i) => claimIndex.set(c.id, i))

  const linkIds = new Set<string>()
  for (const l of rows.links) {
    linkIds.add(`${l.source_id}|${l.target_type}|${l.target_id}|${l.relation}`)
  }

  const hubKeys = new Set(rows.hubs.map((h) => `${h.type}:${h.id}`))

  const { version, ...watermark } = parts
  return {
    rows,
    watermark,
    version,
    claimIndex,
    linkIds,
    hubKeys,
    // A full fetch is by definition in agreement with the probe it was taken
    // against, so whatever it did not retain it dropped as unusable. That
    // difference is the dropped tally the next delta carries forward.
    rawLinkCount: parts.linkCount,
    droppedLinkCount: Math.max(parts.linkCount - rows.links.length, 0),
    fetchedAt: nowMs,
  }
}

/**
 * Merge a delta into a snapshot, returning a NEW snapshot.
 *
 * The rows arrays are copied rather than mutated: `layoutMap` may still be
 * holding the previous `SourceRows` (a concurrent build), and a map built from
 * rows that changed underneath it would be neither the old nor the new version.
 *
 * Memory: one snapshot per viewer key. A 10k-claim workspace is roughly 2.5 MB
 * of rows (claim text dominates, ~200 B/row) plus ~1.2 MB of links and ~1 MB of
 * indexes — call it ~5 MB per viewer, and the LRU holds at most MAX_ENTRIES of
 * them. A snapshot REPLACES its predecessor in the LRU; deltas never stack.
 */
export function applyDelta(
  snapshot: SourceSnapshot,
  delta: SourceDelta,
  parts: ProbeParts,
  nowMs: number,
): SourceSnapshot {
  const claims = snapshot.rows.claims.slice()
  const claimIndex = new Map(snapshot.claimIndex)
  for (const claim of delta.claims) {
    const at = claimIndex.get(claim.id)
    // Upsert: a confirmation/status flip arrives as a row we already hold, and
    // must replace it in place — appending would double the claim.
    if (at === undefined) {
      claimIndex.set(claim.id, claims.length)
      claims.push(claim)
    } else {
      claims[at] = claim
    }
  }

  // A link deleted from INSIDE the inclusive tail is invisible to the raw tally
  // (both the probe's count and the delta's re-count shrink together), so drop
  // the whole tail from the retained rows and rebuild it from what the delta
  // just read. Rows before the bound are settled and are kept as they are.
  const bound = snapshot.watermark.linkMaxCreatedAt
  const links = bound
    ? snapshot.rows.links.filter((l) => l.created_at < bound)
    : []
  const linkIds = new Set(snapshot.linkIds)
  for (const { id, row } of delta.links) {
    if (linkIds.has(id)) continue
    linkIds.add(id)
    // Also hold the tuple key, so a snapshot taken from a FULL fetch (which
    // only knows tuples) and this one dedupe the same rows.
    linkIds.add(
      `${row.source_id}|${row.target_type}|${row.target_id}|${row.relation}`,
    )
  }
  // Rebuild the tail: every usable row the delta saw at-or-after the bound,
  // new and previously-known alike. `delta.links` holds only the NEW ones, so
  // the known tail rows come back from `tailLinks`.
  for (const row of delta.tailLinks) links.push(row)
  // Remember the dropped rows too: they never enter `rows.links`, but the
  // tally counts them and the next delta must recognise them.
  for (const id of delta.droppedLinkIds) linkIds.add(id)

  // Split the dropped tally at the bound, the same way the links are split.
  //
  // The pre-bound share is not carried from the old snapshot (a full fetch
  // never recorded where its dropped rows sat) but DERIVED: the delta counted
  // the raw rows strictly before the bound, and the retained rows before the
  // bound are countable here, so the difference is exactly how many were
  // dropped down there. Those rows are settled and no delta will revisit them.
  const keptBeforeBound = links.length - delta.tailLinks.length
  const droppedBeforeBound = Math.max(delta.linksBeforeBound - keptBeforeBound, 0)
  const droppedLinkCount = droppedBeforeBound + delta.droppedLinkIds.length

  const hubs = snapshot.rows.hubs.slice()
  const hubKeys = new Set(snapshot.hubKeys)
  for (const hub of delta.hubs) {
    const key = `${hub.type}:${hub.id}`
    if (hubKeys.has(key)) continue
    hubKeys.add(key)
    hubs.push(hub)
  }

  const { version, ...watermark } = parts
  return {
    rows: { claims, links, hubs },
    watermark,
    version,
    claimIndex,
    linkIds,
    hubKeys,
    // Every raw row is either retained or knowingly dropped. The tail's share
    // of each is re-counted from what the delta just read; the pre-bound share
    // carries over untouched, because no delta can see those rows again.
    rawLinkCount: links.length + droppedLinkCount,
    droppedLinkCount,
    fetchedAt: nowMs,
  }
}

/**
 * Does the merged snapshot actually match what the workspace holds?
 *
 * A delta sees inserts and updates; it is blind to DELETIONS and to a row that
 * became visible without its timestamp moving (an RLS grant). Both show up as a
 * count disagreement with the probe, which is the signal to throw the snapshot
 * away and do a full fetch. Counting is the whole check — a map built from rows
 * that failed it must never be served.
 *
 * Links are compared on the RAW tally, not `rows.links.length`: the usable set
 * excludes the non-citable targets both read paths drop, so it is legitimately
 * smaller than the probe's `entity_link` count.
 */
export function deltaMatchesProbe(
  snapshot: SourceSnapshot,
  parts: ProbeParts,
): boolean {
  return (
    snapshot.rows.claims.length === parts.claimCount &&
    snapshot.rawLinkCount === parts.linkCount
  )
}
