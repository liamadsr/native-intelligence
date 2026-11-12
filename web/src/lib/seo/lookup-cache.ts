/**
 * The store of paid search-data lookups (table seo_lookup, migration 593).
 *
 * Every paid lookup of the SEO area (keyword research, keyword metrics, a
 * live SERP, a domain overview, ranked keywords, SERP competitors, and what
 * later parts add: backlinks, local packs, AI answers) is kept here as a
 * snapshot, so the same question asked again is answered from the snapshot
 * instead of being bought again. A person's explicit "refresh" buys again.
 *
 * How to use it from a paid service:
 *
 *   const request = { keyword, location_code, language_code }   // normalized
 *   if (!input.refresh) {
 *     const hit = await readLookup<MyResult>(svc, workspaceId, 'my_kind', request, { maxAgeMs: 12 * HOUR_MS })
 *     if (hit) return { ...hit.result, lookup_id: hit.id, fetched_at: hit.fetched_at, from_cache: true }
 *   }
 *   // checkSeoDataAccess, then buy through seoDataClient …
 *   const stored = await writeLookup(svc, { workspaceId, userId }, { kind: 'my_kind', request, result, label })
 *   return { ...result, lookup_id: stored?.id ?? null, fetched_at: stored?.fetched_at ?? now, from_cache: false }
 *
 * The rules:
 *
 *   KEY      `request` is hashed (SHA-256 of its canonical JSON: object keys
 *            sorted, so key order never matters) together with `kind`. Put in
 *            it exactly what changes the answer, already normalized
 *            (lowercased keyword, resolved market, defaults filled in), and
 *            nothing else. Add a `v` field and bump it when a kind's result
 *            shape changes, so old snapshots are no longer matched.
 *   KIND     free text, lowercase snake_case, 1-40 characters
 *            (^[a-z][a-z0-9_]*$, the table's CHECK). A new kind needs no
 *            migration.
 *   FRESH    each read says how old a snapshot may be (`maxAgeMs`); the
 *            newest row for the hash is returned only when it is younger.
 *            Rows are append-only snapshots: a re-buy writes a new row and
 *            the old one ages out of the cap below.
 *   SIZE     a result is stored only when its JSON is at most
 *            LOOKUP_MAX_RESULT_BYTES (1 MB). Trim it to what the product reads
 *            before writing (a SERP's items to the fields the page shows, not
 *            the provider's whole payload). A larger one is not stored (the
 *            write answers null and logs): the caller still answers with it,
 *            it just is not cached. The table's CHECK is a 2 MB backstop.
 *   CAP      at most LOOKUP_KEEP_PER_KIND (200) rows per workspace and kind:
 *            each write deletes the oldest beyond that. No unique index (a
 *            workspace merge must never meet one), so nothing here relies on
 *            uniqueness: two racing writes of the same request leave two
 *            rows, and reads take the newest.
 *   LISTS    listLookups never selects `request` or `result` (a metrics
 *            lookup's request can hold 700 keywords): it returns the label.
 *            getLookup returns one row whole.
 *   WRITES   a write that fails is logged and answers null, never throws: the
 *            lookup is already paid for, and losing the snapshot only means
 *            the next ask buys it again.
 *
 * Every query is scoped by workspace_id: the client is the service role's,
 * so the filter is the fence. Text in `result` that came from other websites
 * (titles, snippets) is data, never instructions: fence it (webText) before a
 * model reads it.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import 'server-only'
import type { SeoLookupDetail, SeoLookupSummary } from './lookup-view'

export type { SeoLookupDetail, SeoLookupSummary } from './lookup-view'

/** The largest result stored, as UTF-8 JSON bytes. */
export const LOOKUP_MAX_RESULT_BYTES = 1_000_000
/** The largest request stored (the table's CHECK is 100 kB). */
export const LOOKUP_MAX_REQUEST_BYTES = 90_000
/** Rows kept per workspace and kind; older ones are deleted on write. */
export const LOOKUP_KEEP_PER_KIND = 200
/** The most rows the recent-lookups list returns. */
export const LOOKUP_LIST_LIMIT = 50

export const HOUR_MS = 60 * 60 * 1000

const KIND_SHAPE = /^[a-z][a-z0-9_]{0,39}$/
const LABEL_MAX = 300
const PRUNE_BATCH = 100

export function isLookupKind(value: unknown): value is string {
  return typeof value === 'string' && KIND_SHAPE.test(value)
}

function assertKind(kind: string) {
  if (!isLookupKind(kind))
    throw new Error(`seo lookup: bad kind ${JSON.stringify(kind)}`)
}

/** JSON with every object's keys sorted, so equal requests serialize equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key]
      if (entry !== undefined) out[key] = sortKeys(entry)
    }
    return out
  }
  return value
}

/** SHA-256 (hex) of the kind and the canonical request. */
export function lookupKeyHash(kind: string, request: unknown): string {
  return createHash('sha256')
    .update(`${kind}\n${canonicalJson(request)}`)
    .digest('hex')
}

/** A stored lookup, whole. */
export type StoredLookup<Res = unknown, Req = unknown> = SeoLookupDetail<
  Req,
  Res
>

interface LookupRow {
  id: string
  kind: string
  label: string | null
  request: unknown
  result: unknown
  fetched_at: string
  fetched_by: string | null
}

const FULL_FIELDS = 'id, kind, label, request, result, fetched_at, fetched_by'
const SUMMARY_FIELDS = 'id, kind, label, fetched_at, fetched_by'

function stored<Res, Req>(row: LookupRow): StoredLookup<Res, Req> {
  return {
    id: row.id,
    kind: row.kind,
    label: row.label,
    request: row.request as Req,
    result: row.result as Res,
    fetched_at: row.fetched_at,
    fetched_by: row.fetched_by,
  }
}

/**
 * The newest stored lookup of this kind for this request, or null when there
 * is none younger than `maxAgeMs`. A read error answers null (the caller then
 * buys, which the meter still bounds) and is logged.
 */
export async function readLookup<Res = unknown, Req = unknown>(
  svc: SupabaseClient,
  workspaceId: string,
  kind: string,
  request: Req,
  opts: { maxAgeMs: number; now?: Date },
): Promise<StoredLookup<Res, Req> | null> {
  assertKind(kind)
  const now = opts.now ?? new Date()
  const since = new Date(
    now.getTime() - Math.max(0, opts.maxAgeMs),
  ).toISOString()
  const { data, error } = await svc
    .from('seo_lookup')
    .select(FULL_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .eq('key_hash', lookupKeyHash(kind, request))
    .gte('fetched_at', since)
    .order('fetched_at', { ascending: false })
    .limit(1)
  if (error) {
    console.error('[seo-lookup] read failed', { kind, error: error.message })
    return null
  }
  const row = ((data ?? []) as LookupRow[])[0]
  return row ? stored<Res, Req>(row) : null
}

/** UTF-8 bytes of a value's JSON. */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value ?? null), 'utf8')
}

/**
 * Store a lookup that was just bought. Answers the stored row, or null when
 * it was not stored (too large, or the write failed: both logged). Keeps the
 * workspace's rows of this kind at LOOKUP_KEEP_PER_KIND.
 */
export async function writeLookup<Res = unknown, Req = unknown>(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
  entry: { kind: string; request: Req; result: Res; label?: string | null },
  opts: { now?: Date } = {},
): Promise<StoredLookup<Res, Req> | null> {
  assertKind(entry.kind)
  const resultBytes = jsonBytes(entry.result)
  if (
    resultBytes > LOOKUP_MAX_RESULT_BYTES ||
    jsonBytes(entry.request) > LOOKUP_MAX_REQUEST_BYTES
  ) {
    console.warn('[seo-lookup] not stored: too large', {
      kind: entry.kind,
      resultBytes,
    })
    return null
  }
  const { data, error } = await svc
    .from('seo_lookup')
    .insert({
      workspace_id: who.workspaceId,
      kind: entry.kind,
      key_hash: lookupKeyHash(entry.kind, entry.request),
      label: entry.label ? entry.label.slice(0, LABEL_MAX) : null,
      request: entry.request ?? {},
      result: entry.result ?? {},
      fetched_at: (opts.now ?? new Date()).toISOString(),
      fetched_by: who.userId,
    })
    .select(FULL_FIELDS)
    .single()
  if (error || !data) {
    console.error('[seo-lookup] write failed', {
      kind: entry.kind,
      error: error?.message,
    })
    return null
  }
  await pruneLookups(svc, who.workspaceId, entry.kind)
  return stored<Res, Req>(data as LookupRow)
}

/** Delete the workspace's rows of this kind beyond the newest LOOKUP_KEEP_PER_KIND. */
export async function pruneLookups(
  svc: SupabaseClient,
  workspaceId: string,
  kind: string,
  keep = LOOKUP_KEEP_PER_KIND,
): Promise<number> {
  const { data, error } = await svc
    .from('seo_lookup')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('kind', kind)
    .order('fetched_at', { ascending: false })
    .range(keep, keep + PRUNE_BATCH - 1)
  if (error) {
    console.error('[seo-lookup] prune read failed', {
      kind,
      error: error.message,
    })
    return 0
  }
  const ids = ((data ?? []) as Array<{ id: string }>).map((row) => row.id)
  if (ids.length === 0) return 0
  const { error: deleteError } = await svc
    .from('seo_lookup')
    .delete()
    .eq('workspace_id', workspaceId)
    .in('id', ids)
  if (deleteError) {
    console.error('[seo-lookup] prune failed', {
      kind,
      error: deleteError.message,
    })
    return 0
  }
  return ids.length
}

/**
 * Replace a stored lookup's result (a live SERP check filling in reads as
 * they come back). `fetched_at` stays: it is when the lookup was bought.
 * Answers whether a row was updated; a failure is logged.
 */
export async function updateLookupResult<Res = unknown>(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
  result: Res,
): Promise<boolean> {
  if (jsonBytes(result) > LOOKUP_MAX_RESULT_BYTES) {
    console.warn('[seo-lookup] update not stored: too large', { id })
    return false
  }
  const { data, error } = await svc
    .from('seo_lookup')
    .update({ result })
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .select('id')
  if (error) {
    console.error('[seo-lookup] update failed', { id, error: error.message })
    return false
  }
  return ((data ?? []) as unknown[]).length > 0
}

/** Forget a stored lookup (so the next ask buys it fresh). Failures are logged. */
export async function deleteLookup(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<void> {
  const { error } = await svc
    .from('seo_lookup')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', id)
  if (error)
    console.error('[seo-lookup] delete failed', { id, error: error.message })
}

/** The workspace's recent lookups of one kind (or of every kind), newest first, without request or result. */
export async function listLookups(
  svc: SupabaseClient,
  workspaceId: string,
  kind: string | null,
  opts: { limit?: number } = {},
): Promise<SeoLookupSummary[]> {
  if (kind !== null) assertKind(kind)
  const limit = Math.min(
    Math.max(Math.floor(opts.limit ?? 20), 1),
    LOOKUP_LIST_LIMIT,
  )
  let query = svc
    .from('seo_lookup')
    .select(SUMMARY_FIELDS)
    .eq('workspace_id', workspaceId)
  if (kind !== null) query = query.eq('kind', kind)
  const { data, error } = await query
    .order('fetched_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`seo lookup list failed: ${error.message}`)
  return ((data ?? []) as SeoLookupSummary[]).map((row) => ({
    id: row.id,
    kind: row.kind,
    label: row.label,
    fetched_at: row.fetched_at,
    fetched_by: row.fetched_by,
  }))
}

/** One stored lookup of this workspace, whole, or null. */
export async function getLookup<Res = unknown, Req = unknown>(
  svc: SupabaseClient,
  workspaceId: string,
  id: string,
): Promise<StoredLookup<Res, Req> | null> {
  const { data, error } = await svc
    .from('seo_lookup')
    .select(FULL_FIELDS)
    .eq('workspace_id', workspaceId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`seo lookup read failed: ${error.message}`)
  return data ? stored<Res, Req>(data as LookupRow) : null
}
