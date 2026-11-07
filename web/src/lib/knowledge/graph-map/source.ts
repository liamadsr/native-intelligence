/**
 * Knowledge Map — source reads (I/O layer).
 *
 * Everything here runs on the **user-session** Supabase client handed back by
 * `requireWorkspace()`. That is the whole security model of the map
 * (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §3): a viewer's map is built only from
 * rows that viewer can read under RLS, so no shared artefact ever has to be
 * filtered after the fact. Never swap in a service-role client, an RPC that
 * bypasses RLS, or a cache shared between users — a hub whose label row is
 * invisible is simply absent from `hubs`, and the pure core drops its links.
 *
 * Nothing here reads `claim_source` or excerpts: the map never needs them, and
 * fetching them is what made the old `GET /api/account/knowledge` payload
 * enormous. The inspector fetches them per node (`…/map/node`).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'crypto'
import {
  ALGO_VERSION,
  type SourceClaimRow,
  type SourceHubRow,
  type SourceLinkRow,
  type SourceRows,
} from '@/lib/knowledge/graph-map/types'
import { ENTITY_REGISTRY, entityDescriptor } from '@/lib/knowledge/entity-registry'

/**
 * The client the map is built with: whatever `requireWorkspace()` returned.
 * Typed as the plain Supabase client so this module has no opinion about how
 * the caller authenticated (cookie session, Bearer JWT or device token) — only
 * that RLS is in force on it.
 */
export type MapSourceClient = SupabaseClient

/** PostgREST caps a response at 1000 rows regardless of `.limit()`. */
const PAGE_SIZE = 1000
/** Parallel in-flight page/label requests. Enough to hide latency, few enough
 *  not to open a connection storm against the pooler. */
const CONCURRENCY = 8
/** Ids per `.in(…)` — keeps each request URL well under proxy limits. */
const LABEL_CHUNK = 300
/** Refuse to page forever if `count` comes back absurd (or lies). */
const MAX_ROWS = 400_000

/**
 * The claim columns the map reads — ONE list, shared with the delta path.
 *
 * Every filterable field is here (`MAP_FILTER_FIELDS`) plus the three the
 * layout itself needs. Two copies of this list is how the delta would start
 * quietly returning rows with a missing column, which reads downstream as
 * "every claim appended since the last full fetch has no author".
 */
export const CLAIM_SELECT =
  'id, text, type, confidence, confirmation, status, scope, auto_accepted, created_by, created_at, event_at, last_verified_at'

/** A row read back through a runtime-built select list. */
type Row = Record<string, unknown>

/** Coerce an unknown column value to a trimmed string. */
function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

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

/** Citable entity types, from the registry — never a hard-coded list. The old
 *  route's literal CITABLE array is stale and silently drops company, campaign
 *  and conversation, which is exactly the drift this avoids. */
export const CITABLE_TYPES: readonly string[] = ENTITY_REGISTRY.filter(
  (e) => e.citable,
).map((e) => e.id)

const CITABLE_SET = new Set(CITABLE_TYPES)

export function isCitableType(type: string): boolean {
  return CITABLE_SET.has(type)
}

/**
 * Resolve display labels for `(type, id)` pairs through the viewer's RLS.
 *
 * Exported because `…/map/node` must resolve labels exactly the same way the
 * map did — a label that differs between the dot and the inspector reads as a
 * bug, and two copies of the table mapping is how the old route drifted.
 *
 * Ids whose row does not come back (RLS-hidden, deleted, or a type the registry
 * does not know) are simply absent from the returned map. Callers treat absence
 * as "not visible".
 */
export async function resolveEntityLabels(
  supabase: MapSourceClient,
  workspaceId: string,
  byType: Map<string, Set<string>>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>()

  const tasks: Array<() => Promise<void>> = []
  for (const [type, idSet] of byType) {
    const descriptor = entityDescriptor(type)
    if (!descriptor) continue
    const { label, workspaceScoped } = descriptor
    const ids = [...idSet]
    for (let i = 0; i < ids.length; i += LABEL_CHUNK) {
      const chunk = ids.slice(i, i + LABEL_CHUNK)
      tasks.push(async () => {
        // Table + column names come from the registry (fixed literals), never
        // from user input, so the runtime-built select list is not injectable.
        const base = supabase
          .from(label.table)
          .select(`id, ${label.columns}`)
          .in('id', chunk)
        // Only fence on workspace_id where the table actually has the column;
        // `cycle`/`milestone` are fenced through a parent (registry:
        // workspaceScoped.kind === 'indirect') and would 400 on the filter.
        const query =
          workspaceScoped.kind === 'column' ? base.eq('workspace_id', workspaceId) : base
        // The select list is computed at runtime, which defeats the typed
        // builder's column inference — read the rows as plain records.
        const { data, error } = (await query) as {
          data: Row[] | null
          error?: { message: string; code?: string } | null
        }
        // "Not readable" means RLS returned no row — that is NOT an error.
        // A real error (network, timeout, a renamed column) must not be read
        // as "this viewer cannot see these hubs": that would silently re-home
        // their claims to `unfiled` and cache the wrong map. Only an explicit
        // permission denial (42501) is treated as unreadable.
        if (error && error.code !== '42501') {
          throw new Error(`knowledge map: label read failed (${type}): ${error.message}`)
        }
        for (const row of data ?? []) {
          const id = str(row.id)
          if (!id) continue
          labels.set(`${type}:${id}`, str(label.render(row)) || '(untitled)')
        }
      })
    }
  }

  await pooled(tasks, CONCURRENCY)
  return labels
}

/**
 * Cheap freshness probe: four small queries, no row bodies.
 *
 * `count: 'exact', head: true` gives the row count without a payload; a
 * `limit(1)` descending order gives the newest timestamp. PostgREST aggregates
 * (`max()`) may be disabled on the project, so we never use them.
 *
 * The result is opaque to callers — it exists only to be compared. Hashing
 * keeps the version short enough to ride in a query string and hides the raw
 * counts (which are themselves a weak signal about workspace size).
 */
export async function probeVersion(
  supabase: MapSourceClient,
  workspaceId: string,
): Promise<string> {
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

  // A failed probe must not hash to a valid-looking "empty workspace" token.
  for (const probe of [claimCount, claimLatest, linkCount, linkLatest]) {
    if (probe.error) {
      throw new Error(`knowledge map: version probe failed: ${probe.error.message}`)
    }
  }

  const claimMax = str((claimLatest.data ?? [])[0]?.updated_at)
  const linkMax = str((linkLatest.data ?? [])[0]?.created_at)
  const raw = [
    ALGO_VERSION,
    claimCount.count ?? 0,
    claimMax,
    linkCount.count ?? 0,
    linkMax,
  ].join(':')

  // base64url, truncated: 128 bits of a sha256 is far beyond enough to make an
  // accidental collision (which would serve a stale map) impossible in practice.
  return createHash('sha256').update(raw).digest('base64url').slice(0, 22)
}

/**
 * Fetch every page of a workspace-scoped table in PARALLEL.
 *
 * The old route looped pages sequentially and stopped on a short page, so a
 * 20k-row workspace paid 20 serial round-trips. We ask for the exact count
 * first, then request all pages at once under a concurrency cap. A stable
 * ORDER is essential: without it PostgREST may return the same row on two
 * pages and miss another, so we order by `(created_at, id)` — `id` breaks
 * timestamp ties — and dedupe by id as a belt-and-braces guard against rows
 * inserted between the count and the page reads.
 */
async function fetchAllPages<T extends { id?: string }>(
  count: number,
  page: (
    from: number,
    to: number,
  ) => PromiseLike<{ data: unknown[] | null; error?: { message: string } | null }>,
  keyOf: (row: T) => string,
): Promise<T[]> {
  const total = Math.min(Math.max(count, 0), MAX_ROWS)
  if (total === 0) return []

  const pages = Math.ceil(total / PAGE_SIZE)
  const chunks = await pooled(
    Array.from({ length: pages }, (_unused, i) => async () => {
      const from = i * PAGE_SIZE
      const { data, error } = await page(from, from + PAGE_SIZE - 1)
      // A failed read must NEVER degrade into "no rows": that renders as an
      // empty map ("No claims yet") for a workspace that has thousands.
      if (error) throw new Error(`knowledge map: source read failed: ${error.message}`)
      return (data ?? []) as T[]
    }),
    CONCURRENCY,
  )

  const seen = new Set<string>()
  const rows: T[] = []
  for (const chunk of chunks) {
    for (const row of chunk) {
      const key = keyOf(row)
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(row)
    }
  }
  return rows
}

/**
 * Read every row the map is built from, through the viewer's own client.
 *
 * Claims: ALL statuses and confirmations. Dismissed and superseded rows are
 * needed even though they are not drawn — the layout ranks a claim's spiral
 * slot among *all* of its hub's claims, so dropping them here would make every
 * later claim shift when one is dismissed (§4.2).
 *
 * Links: only the ones the map can draw — claim→claim edges and claim→citable
 * hubs. The COUNT probe above still counts every claim-sourced link row,
 * which is deliberate: it is a freshness signal over the rows we read, and a
 * write to a dropped link type still means the read set may have moved.
 * Over-counting only costs an extra page request, never a missed row.
 */
export async function fetchSourceRows(
  supabase: MapSourceClient,
  workspaceId: string,
): Promise<SourceRows> {
  const [claimCount, linkCount] = await Promise.all([
    supabase
      .from('claim')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    supabase
      .from('entity_link')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim'),
  ])

  for (const probe of [claimCount, linkCount]) {
    if (probe.error) {
      throw new Error(`knowledge map: source count failed: ${probe.error.message}`)
    }
  }

  const [claims, links] = await Promise.all([
    fetchAllPages<SourceClaimRow>(
      claimCount.count ?? 0,
      (from, to) =>
        supabase
          .from('claim')
          .select(CLAIM_SELECT)
          .eq('workspace_id', workspaceId)
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      (row) => row.id,
    ),
    fetchAllPages<SourceLinkRow & { id?: string }>(
      linkCount.count ?? 0,
      (from, to) =>
        supabase
          .from('entity_link')
          .select('id, source_id, target_type, target_id, relation, created_at')
          .eq('workspace_id', workspaceId)
          .eq('source_type', 'claim')
          .order('created_at', { ascending: true })
          .order('id', { ascending: true })
          .range(from, to),
      // entity_link rows have no natural key beyond their id; dedupe on it and
      // fall back to the tuple when a fake/older row omits it.
      (row) =>
        row.id ??
        `${row.source_id}|${row.target_type}|${row.target_id}|${row.relation}`,
    ),
  ])

  // Links the map can actually use. A claim→claim link is an edge; a link to a
  // registry-citable type can become a hub. Anything else — `decision`,
  // `member` and the other linkable-but-not-citable types that real data is
  // full of — can never be either, so it is dropped HERE rather than left for
  // the core to skip. The core picks a claim's primary hub from the earliest
  // link it is given, so a `member` row surviving this far would win that race
  // and strand the claim under `unfiled` with no hub to show for it.
  const usableLinks = links.filter(
    (l) => l.target_type === 'claim' || (isCitableType(l.target_type) && !!l.target_id),
  )

  // Hubs: group link targets by type, then resolve labels in chunks. Anything
  // that does not come back is invisible to this viewer and stays out of the
  // map.
  const byType = new Map<string, Set<string>>()
  for (const link of usableLinks) {
    if (link.target_type === 'claim') continue
    let ids = byType.get(link.target_type)
    if (!ids) byType.set(link.target_type, (ids = new Set()))
    ids.add(link.target_id)
  }

  const labels = await resolveEntityLabels(supabase, workspaceId, byType)

  const hubs: SourceHubRow[] = []
  for (const [type, ids] of byType) {
    for (const id of ids) {
      const label = labels.get(`${type}:${id}`)
      if (label === undefined) continue // RLS-hidden or deleted → not a hub
      hubs.push({ type, id, label })
    }
  }

  // Strip the transport-only `id` so what leaves this module is exactly the
  // frozen SourceLinkRow shape the pure core consumes.
  const linkRows: SourceLinkRow[] = usableLinks.map((l) => ({
    source_id: l.source_id,
    target_type: l.target_type,
    target_id: l.target_id,
    relation: l.relation,
    created_at: l.created_at,
  }))

  return { claims, links: linkRows, hubs }
}
