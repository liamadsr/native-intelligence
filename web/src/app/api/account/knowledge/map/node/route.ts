import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { entityDescriptor } from '@/lib/knowledge/entity-registry'
import {
  isCitableType,
  resolveEntityLabels,
  type MapSourceClient,
} from '@/lib/knowledge/graph-map/source'
import type {
  ClaimDetail,
  ClaimType,
  EntityDetail,
} from '@/lib/knowledge/graph-map/types'
import { MAP_HEADERS } from '../headers'

/**
 * GET /api/account/knowledge/map/node?key=<node_key>[&cursor=<opaque>]
 *
 * Details on demand (§2.6). The map itself carries only what the canvas draws —
 * a short label, a position, a few bytes of state. Claim text, evidence
 * excerpts and an entity's claim list are fetched here, once, when the viewer
 * clicks a node. That is what keeps the map payload small enough to be one
 * request.
 *
 * `key` is a node key from the wire contract:
 *   claim:<uuid>          → the claim, its claim_source evidence, its links
 *   <entity_type>:<uuid>  → the entity's label + a page of claims citing it
 *   unfiled:<yyyy-mm>     → 400; virtual hubs are a layout device, not a row
 *
 * Everything is read through the caller's own RLS client, so a node they
 * cannot see is a 404 — the same answer they would get for one that does not
 * exist, which is what keeps the route from confirming hidden rows.
 */

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/** Claims per page in an entity's claim list. */
const CLAIM_PAGE = 25

/**
 * PostgREST caps a response at 1000 rows regardless of `.limit()`, so the
 * citing-link read has to be paged or a hub with more citations than this is
 * silently truncated — total included. Prod already has a project hub at 1,614
 * (docs/KNOWLEDGE_MAP_ARCHITECTURE.md §"Real sizing").
 */
const LINK_PAGE = 1000

/**
 * Ids per `.in(…)`. The same bound `resolveEntityLabels` uses — an `.in()` list
 * is serialized into the request URI, and 1,000 uuids is a ~37KB query string
 * that a proxy will eventually refuse with a 414.
 */
const ID_CHUNK = 300

/**
 * Refuse to page forever if `count` comes back absurd (or lies). Matches
 * `source.ts`'s MAX_ROWS: past this a hub is not inspectable in a request
 * budget anyway.
 */
const MAX_LINKS = 400_000

/** Parallel in-flight reads — enough to hide latency, few enough to be polite. */
const CONCURRENCY = 8

/**
 * Deepest page the cursor may address. Cursors are client-supplied, and the
 * offset sizes the per-chunk head read, so an unclamped one is a memory lever.
 * 100k pages is ~4,000 clicks of "load more" past any hub that exists.
 */
const MAX_OFFSET = 100_000

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

interface ClaimRow {
  id: string
  text: string
  type: ClaimType
  confidence: number | null
  confirmation: 'suggested' | 'confirmed' | 'dismissed'
  auto_accepted: boolean | null
  created_at: string
}

/** Cursors are opaque to the client; today they encode nothing but an offset. */
function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string | null): number {
  if (!cursor) return 0
  const n = Number(Buffer.from(cursor, 'base64url').toString('utf8'))
  if (!Number.isInteger(n) || n < 0) return 0
  // Clamped because the offset sizes the per-chunk head read: a crafted cursor
  // of 10,000,000 would otherwise ask every chunk for ten million rows. Past
  // MAX_OFFSET the answer is an empty page, which is what a real cursor that
  // far out would return anyway.
  return Math.min(n, MAX_OFFSET)
}

/** Split `type:id` on the FIRST colon — ids are uuids, but types never contain one. */
function splitKey(key: string): { type: string; id: string } | null {
  const i = key.indexOf(':')
  if (i <= 0 || i === key.length - 1) return null
  return { type: key.slice(0, i), id: key.slice(i + 1) }
}

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { searchParams } = request.nextUrl
  const key = searchParams.get('key')
  if (!key) return badRequest('key is required')

  const parsed = splitKey(key)
  if (!parsed) return badRequest(`invalid node key: ${key}`)
  const { type, id } = parsed

  // Virtual hubs exist only to give hub-less claims a position; there is no row
  // behind them, so there is nothing to inspect.
  if (type === 'unfiled') {
    return badRequest('virtual hubs have no detail')
  }

  try {
    const detail =
      type === 'claim'
        ? await claimDetail(supabase, workspaceId, id)
        : await entityDetail(
            supabase,
            workspaceId,
            type,
            id,
            decodeCursor(searchParams.get('cursor')),
          )

    if (!detail) return notFound('Node not found')
    return NextResponse.json(detail, { headers: MAP_HEADERS })
  } catch (err) {
    console.error('[knowledge/map/node] lookup failed:', err)
    return serverError('Failed to load node detail')
  }
}

/**
 * A claim node: the row itself, its evidence (`claim_source`, WITH excerpts —
 * the one place the map fetches them), and its outgoing links to entities.
 *
 * Labels for both source rows and link targets go through the map's own
 * resolver, so the inspector shows exactly the label the dot showed. A source
 * or link whose row is invisible keeps its entry but with a null/empty label
 * rather than being dropped — the viewer can see that evidence exists.
 */
async function claimDetail(
  supabase: MapSourceClient,
  workspaceId: string,
  claimId: string,
): Promise<ClaimDetail | null> {
  const { data: claim } = await supabase
    .from('claim')
    .select('id, text, type, confidence, confirmation, auto_accepted, created_at')
    .eq('workspace_id', workspaceId)
    .eq('id', claimId)
    .maybeSingle<ClaimRow>()

  // Not in this workspace, or RLS hides it — indistinguishable on purpose.
  if (!claim) return null

  const [sourcesRes, linksRes] = await Promise.all([
    supabase
      .from('claim_source')
      .select('source_type, source_id, source_uri, excerpt')
      .eq('workspace_id', workspaceId)
      .eq('claim_id', claimId)
      .order('created_at', { ascending: true }),
    supabase
      .from('entity_link')
      .select('relation, target_type, target_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim')
      .eq('source_id', claimId)
      .neq('target_type', 'claim')
      .order('created_at', { ascending: true }),
  ])

  const sourceRows = (sourcesRes.data ?? []) as Array<{
    source_type: string
    source_id: string | null
    source_uri: string | null
    excerpt: string | null
  }>
  const linkRows = (linksRes.data ?? []) as Array<{
    relation: string
    target_type: string
    target_id: string
  }>

  // One label resolution pass over both lists — sources and link targets
  // frequently point at the same capture.
  const byType = new Map<string, Set<string>>()
  const note = (entityType: string, entityId: string | null) => {
    if (!entityId) return
    if (!entityDescriptor(entityType)) return
    let ids = byType.get(entityType)
    if (!ids) byType.set(entityType, (ids = new Set()))
    ids.add(entityId)
  }
  for (const s of sourceRows) note(s.source_type, s.source_id)
  for (const l of linkRows) note(l.target_type, l.target_id)

  const labels = await resolveEntityLabels(supabase, workspaceId, byType)

  return {
    kind: 'claim',
    key: `claim:${claim.id}`,
    claim: {
      id: claim.id,
      text: claim.text,
      type: claim.type,
      confidence: claim.confidence,
      confirmation: claim.confirmation,
      auto_accepted: claim.auto_accepted,
      created_at: claim.created_at,
    },
    sources: sourceRows.map((s) => ({
      source_type: s.source_type,
      source_id: s.source_id,
      source_uri: s.source_uri,
      excerpt: s.excerpt,
      label: s.source_id ? labels.get(`${s.source_type}:${s.source_id}`) ?? null : null,
    })),
    links: linkRows.map((l) => ({
      relation: l.relation,
      type: l.target_type,
      id: l.target_id,
      label: labels.get(`${l.target_type}:${l.target_id}`) ?? '',
    })),
  }
}

/** A claim row as read for the entity list — `created_at` is the tiebreaker. */
interface RankedClaim {
  id: string
  text: string
  type: ClaimType
  confidence: number | null
  confirmation: 'suggested' | 'confirmed' | 'dismissed'
  created_at: string
}

/**
 * The documented order, implemented client-side so it survives chunking:
 * confirmed first ('confirmed' < 'suggested' alphabetically), then confidence
 * DESC with NULLS LAST, then newest first, and finally id so two rows that are
 * identical on all three still have ONE stable position — without that last
 * key a row could sit on two pages and another on none.
 */
function compareRanked(a: RankedClaim, b: RankedClaim): number {
  if (a.confirmation !== b.confirmation) return a.confirmation < b.confirmation ? -1 : 1
  const ac = a.confidence
  const bc = b.confidence
  if (ac !== bc) {
    if (ac === null) return 1 // NULLS LAST
    if (bc === null) return -1
    return bc - ac
  }
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * Every claim id citing this entity, paged around PostgREST's 1000-row cap.
 *
 * The unpaged version of this read silently truncated at 1000, which made both
 * the list and its `total` wrong for exactly the biggest hubs — the ones the
 * map draws largest and the viewer is most likely to click. A stable
 * `(source_id)` order is what keeps the pages from overlapping; ids are
 * deduped anyway, so a row inserted mid-read can only be missed, never doubled.
 */
async function citingClaimIds(
  supabase: MapSourceClient,
  workspaceId: string,
  type: string,
  id: string,
): Promise<string[]> {
  const base = () =>
    supabase
      .from('entity_link')
      .select('source_id')
      .eq('workspace_id', workspaceId)
      .eq('source_type', 'claim')
      .eq('target_type', type)
      .eq('target_id', id)

  const { count } = await supabase
    .from('entity_link')
    .select('source_id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'claim')
    .eq('target_type', type)
    .eq('target_id', id)

  const total = Math.min(Math.max(count ?? 0, 0), MAX_LINKS)
  if (total === 0) return []

  const pages = Math.ceil(total / LINK_PAGE)
  const chunks = await pooled(
    Array.from({ length: pages }, (_unused, i) => async () => {
      const from = i * LINK_PAGE
      const { data } = await base()
        .order('source_id', { ascending: true })
        .range(from, from + LINK_PAGE - 1)
      return (data ?? []) as Array<{ source_id: string }>
    }),
    CONCURRENCY,
  )

  const seen = new Set<string>()
  for (const chunk of chunks) {
    for (const row of chunk) if (row.source_id) seen.add(row.source_id)
  }
  return [...seen]
}

/**
 * An entity (hub) node: its label plus a page of the claims citing it.
 *
 * The claim order is the map's notion of importance made legible: confirmed
 * claims first, then confidence descending (NULLS LAST so an unscored claim
 * does not outrank a scored one), then newest first — the order the wire
 * contract documents, preserved exactly.
 *
 * HOW, given a hub with thousands of citations: the id list is chunked at
 * `ID_CHUNK` so no `.in()` ever grows into a URI a proxy will refuse. The
 * database applies the order and an exact count WITHIN each chunk, and each
 * chunk returns only its own first `offset + CLAIM_PAGE` rows — the most any
 * chunk can contribute to the requested page. Merging those heads under the
 * same comparator and slicing reproduces the global order exactly, while the
 * rows crossing the wire stay bounded by `chunks × (offset + CLAIM_PAGE)`
 * rather than by the workspace's size.
 */
async function entityDetail(
  supabase: MapSourceClient,
  workspaceId: string,
  type: string,
  id: string,
  offset: number,
): Promise<EntityDetail | null> {
  // Only registry-citable types can be hubs, so anything else is a bad key
  // rather than a missing row.
  if (!isCitableType(type)) return null

  const labels = await resolveEntityLabels(
    supabase,
    workspaceId,
    new Map([[type, new Set([id])]]),
  )
  const label = labels.get(`${type}:${id}`)
  // Unreadable (RLS) or gone — the same 404 the dot's absence implies.
  if (label === undefined) return null

  const empty: EntityDetail = {
    kind: 'entity',
    key: `${type}:${id}`,
    entityType: type,
    entityId: id,
    label,
    claims: [],
    total: 0,
    nextCursor: null,
  }

  const claimIds = await citingClaimIds(supabase, workspaceId, type, id)
  if (claimIds.length === 0) return empty

  // Each chunk needs the head of its own ordered list, never more: a row past
  // position `offset + CLAIM_PAGE` within its chunk cannot reach this page,
  // because every row above it in the chunk also outranks it globally. And a
  // chunk holds at most ID_CHUNK ids, so it can never yield more rows than
  // that however deep the offset goes — which is what keeps a deep page from
  // multiplying into an unbounded read.
  const head = Math.min(offset + CLAIM_PAGE, ID_CHUNK)

  const chunks = await pooled(
    Array.from({ length: Math.ceil(claimIds.length / ID_CHUNK) }, (_unused, i) => async () => {
      const { data, count } = await supabase
        .from('claim')
        .select('id, text, type, confidence, confirmation, created_at', { count: 'exact' })
        .eq('workspace_id', workspaceId)
        .in('id', claimIds.slice(i * ID_CHUNK, (i + 1) * ID_CHUNK))
        .eq('status', 'active')
        .neq('confirmation', 'dismissed')
        // 'confirmed' sorts before 'suggested' alphabetically, so ascending IS
        // "confirmed first" — no CASE expression needed.
        .order('confirmation', { ascending: true })
        .order('confidence', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: true })
        .range(0, head - 1)
      const rows = (data ?? []) as RankedClaim[]
      return { rows, count: count ?? rows.length }
    }),
    CONCURRENCY,
  )

  // `count` is exact PER CHUNK and the chunks partition a deduped id set, so
  // the sum is the exact total — not the 1000-row lie the single read told.
  const total = chunks.reduce((sum, c) => sum + c.count, 0)

  const merged = chunks
    .flatMap((c) => c.rows)
    .sort(compareRanked)
    .slice(offset, offset + CLAIM_PAGE)

  // `created_at` was read for the tiebreaker only; the wire contract's claim
  // shape does not carry it, so it does not leave here.
  const claims: EntityDetail['claims'] = merged.map((c) => ({
    id: c.id,
    text: c.text,
    type: c.type,
    confidence: c.confidence,
    confirmation: c.confirmation,
  }))

  const nextOffset = offset + claims.length

  return {
    ...empty,
    claims,
    total,
    nextCursor: nextOffset < total ? encodeCursor(nextOffset) : null,
  }
}
