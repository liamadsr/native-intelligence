/**
 * Saved keywords (table seo_saved_keyword, migration 593): the keywords a
 * workspace keeps, each in one market, with its last known metrics, tags and
 * a note. Saving costs nothing; the metrics come from a research or metrics
 * lookup (passed in, or picked up later: every research and metrics lookup
 * refreshes the saved keywords it covers, see syncSavedKeywordMetrics).
 *
 * One row per (keyword, location, language), held in code: an add reads what
 * is already saved and inserts only the rest. There is no unique index (a
 * workspace merge must never meet one), so two adds racing on the same
 * keyword can both insert; each add ends by collapsing such duplicates to
 * the oldest row, so the next add (or this one) heals what a race left.
 *
 * Bounded: at most SAVED_KEYWORDS_MAX (10,000) per workspace. An add that
 * would pass it saves nothing and says so.
 *
 * Every query is scoped by workspace_id: the client is the service role's,
 * so the filter is the fence.
 *
 * Adapted from OpenSEO (MIT, see ../THIRD_PARTY_NOTICES.md).
 */
import { isSeoError } from '@/lib/seo/errors'
import type { SupabaseClient } from '@supabase/supabase-js'
import 'server-only'
import { resolveKeywordMarket, type Market } from './market'
import { trendFrom } from './rows'
import {
  isKeywordIntent,
  normalizeKeyword,
  normalizeTags,
  SAVED_KEYWORD_NOTE_LENGTH,
  SAVED_KEYWORD_PAGE_SIZE,
  SAVED_KEYWORD_SORTS,
  SAVED_KEYWORDS_MAX,
  SAVED_KEYWORDS_PER_ADD,
  type KeywordRow,
  type SavedKeyword,
  type SavedKeywordPage,
  type SavedKeywordSort,
  type SavedKeywordTagCount,
} from './view'

const FIELDS =
  'id, workspace_id, keyword, location_code, language_code, search_volume, cpc, competition, keyword_difficulty, intent, monthly_searches, metrics_fetched_at, tags, note, created_by, created_at'
/** Keywords per `in` filter, so a request URL stays short. */
const IN_BATCH = 100
const KEYWORD_MAX_LENGTH = 200

interface SavedRow {
  id: string
  workspace_id: string
  keyword: string
  location_code: number
  language_code: string
  search_volume: number | null
  cpc: number | string | null
  competition: number | string | null
  keyword_difficulty: number | null
  intent: string | null
  monthly_searches: unknown
  metrics_fetched_at: string | null
  tags: string[] | null
  note: string | null
  created_by: string | null
  created_at: string
}

function num(value: number | string | null): number | null {
  if (value === null || value === undefined) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

export function savedKeywordView(row: SavedRow): SavedKeyword {
  const monthly = Array.isArray(row.monthly_searches)
    ? (row.monthly_searches as Array<{
        year?: number
        month?: number
        search_volume?: number
      }>)
    : []
  return {
    id: row.id,
    keyword: row.keyword,
    location_code: row.location_code,
    language_code: row.language_code,
    search_volume: row.search_volume,
    cpc: num(row.cpc),
    competition: num(row.competition),
    keyword_difficulty: row.keyword_difficulty,
    intent: isKeywordIntent(row.intent) ? row.intent : null,
    trend: trendFrom(monthly),
    metrics_fetched_at: row.metrics_fetched_at,
    tags: row.tags ?? [],
    note: row.note,
    created_by: row.created_by,
    created_at: row.created_at,
  }
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size)
    out.push(items.slice(i, i + size))
  return out
}

/** The columns a metrics row writes. */
export function metricColumns(
  row: Pick<
    KeywordRow,
    | 'search_volume'
    | 'cpc'
    | 'competition'
    | 'keyword_difficulty'
    | 'intent'
    | 'trend'
  >,
  fetchedAt: string,
) {
  const clamp = (value: number | null, lo: number, hi: number) =>
    value === null || !Number.isFinite(value)
      ? null
      : Math.min(hi, Math.max(lo, value))
  return {
    search_volume:
      row.search_volume === null
        ? null
        : Math.max(0, Math.round(row.search_volume)),
    cpc: row.cpc === null ? null : Math.max(0, row.cpc),
    competition: clamp(row.competition, 0, 1),
    keyword_difficulty:
      row.keyword_difficulty === null
        ? null
        : Math.round(clamp(row.keyword_difficulty, 0, 100) as number),
    intent: row.intent ?? null,
    monthly_searches: row.trend.slice(-24),
    metrics_fetched_at: fetchedAt,
  }
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** Keywords as saved: normalized, empty and over-long ones dropped, each once, in order. */
export function normalizeSavedKeywords(keywords: readonly string[]): string[] {
  const out: string[] = []
  for (const raw of keywords) {
    const keyword = normalizeKeyword(raw)
    if (
      keyword &&
      keyword.length <= KEYWORD_MAX_LENGTH &&
      !out.includes(keyword)
    )
      out.push(keyword)
  }
  return out
}

/** Which keywords an add inserts, and which are already saved in that market. */
export function planSavedKeywordAdd(
  alreadySaved: Iterable<string>,
  keywords: readonly string[],
): { insert: string[]; existing: string[] } {
  const saved = new Set(alreadySaved)
  const insert: string[] = []
  const existing: string[] = []
  for (const keyword of keywords)
    (saved.has(keyword) ? existing : insert).push(keyword)
  return { insert, existing }
}

/** A row's tags after an edit: `set` replaces them, then `remove` and `add` apply. At most 20. */
export function retag(
  current: readonly string[],
  edit: {
    add?: readonly string[]
    remove?: readonly string[]
    set?: readonly string[] | null
  },
): string[] {
  const base = edit.set ? normalizeTags(edit.set) : [...current]
  const remove = new Set(normalizeTags(edit.remove ?? []))
  return normalizeTags([
    ...base.filter((tag) => !remove.has(tag)),
    ...normalizeTags(edit.add ?? []),
  ])
}

/** Of rows that share a (keyword, location, language), every one but the oldest: what a race left behind. */
export function duplicateIds(
  rows: ReadonlyArray<{
    id: string
    keyword: string
    location_code: number
    language_code: string
    created_at: string
  }>,
): string[] {
  const keep = new Map<string, { id: string; created_at: string }>()
  const extra: string[] = []
  for (const row of rows) {
    const key = `${row.keyword}\u0000${row.location_code}\u0000${row.language_code}`
    const kept = keep.get(key)
    if (!kept) {
      keep.set(key, row)
      continue
    }
    const older =
      row.created_at < kept.created_at ||
      (row.created_at === kept.created_at && row.id < kept.id)
    if (older) {
      extra.push(kept.id)
      keep.set(key, row)
    } else extra.push(row.id)
  }
  return extra
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface SavedKeywordListInput {
  offset?: number
  limit?: number
  /** Text the keyword contains. */
  search?: string
  /** Keywords carrying ANY of these tags. */
  tags?: string[]
  location_code?: number
  min_volume?: number
  max_volume?: number
  min_difficulty?: number
  max_difficulty?: number
  sort?: SavedKeywordSort
  dir?: 'asc' | 'desc'
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (match) => `\\${match}`).replace(/\*/g, '')
}

interface FilterChain {
  eq(column: string, value: unknown): FilterChain
  ilike(column: string, pattern: string): FilterChain
  contains(column: string, value: unknown): FilterChain
  or(filters: string): FilterChain
  gte(column: string, value: unknown): FilterChain
  lte(column: string, value: unknown): FilterChain
}

// The filters, on a PostgREST builder (the count and the page share them).
function applyListFilters<Q>(query: Q, input: SavedKeywordListInput): Q {
  let q = query as unknown as FilterChain
  if (typeof input.location_code === 'number')
    q = q.eq('location_code', input.location_code)
  const search = input.search?.trim().toLowerCase()
  if (search) q = q.ilike('keyword', `%${escapeLike(search)}%`)
  const tags = normalizeTags(input.tags ?? [])
  // Normalized tags carry no comma, quote, brace or dot, so they sit safely
  // inside the `or` filter's array literals.
  if (tags.length === 1) q = q.contains('tags', tags)
  else if (tags.length > 1)
    q = q.or(tags.map((tag) => `tags.cs.{"${tag}"}`).join(','))
  if (typeof input.min_volume === 'number')
    q = q.gte('search_volume', input.min_volume)
  if (typeof input.max_volume === 'number')
    q = q.lte('search_volume', input.max_volume)
  if (typeof input.min_difficulty === 'number')
    q = q.gte('keyword_difficulty', input.min_difficulty)
  if (typeof input.max_difficulty === 'number')
    q = q.lte('keyword_difficulty', input.max_difficulty)
  return q as unknown as Q
}

/** The workspace's saved keywords, filtered and sorted, a page at a time. */
export async function listSavedKeywords(
  svc: SupabaseClient,
  workspaceId: string,
  input: SavedKeywordListInput = {},
): Promise<SavedKeywordPage> {
  const from =
    typeof input.offset === 'number' &&
    Number.isFinite(input.offset) &&
    input.offset > 0
      ? Math.floor(input.offset)
      : 0
  const size =
    typeof input.limit === 'number' && Number.isFinite(input.limit)
      ? Math.min(Math.max(Math.floor(input.limit), 1), SAVED_KEYWORD_PAGE_SIZE)
      : SAVED_KEYWORD_PAGE_SIZE
  const sort: SavedKeywordSort =
    input.sort &&
    (SAVED_KEYWORD_SORTS as readonly string[]).includes(input.sort)
      ? input.sort
      : 'created_at'
  const ascending =
    (input.dir ?? (sort === 'keyword' ? 'asc' : 'desc')) === 'asc'

  const counted = await applyListFilters(
    svc
      .from('seo_saved_keyword')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId),
    input,
  )
  if (counted.error)
    throw new Error(`saved keywords count failed: ${counted.error.message}`)
  const page = await applyListFilters(
    svc
      .from('seo_saved_keyword')
      .select(FIELDS)
      .eq('workspace_id', workspaceId),
    input,
  )
    .order(sort, { ascending, nullsFirst: false })
    .range(from, from + size - 1)
  if (page.error)
    throw new Error(`saved keywords list failed: ${page.error.message}`)
  const rows = ((page.data ?? []) as SavedRow[]).map(savedKeywordView)
  const total =
    typeof counted.count === 'number' ? counted.count : from + rows.length
  return {
    rows,
    total,
    next_offset:
      from + rows.length < total && rows.length === size ? from + size : null,
  }
}

/** Every tag the workspace's saved keywords carry, and on how many: the list's tag filter. */
export async function savedKeywordTagCounts(
  svc: SupabaseClient,
  workspaceId: string,
): Promise<SavedKeywordTagCount[]> {
  const { data, error } = await svc.rpc('seo_saved_keyword_tag_counts', {
    p_workspace: workspaceId,
  })
  if (error) throw new Error(`saved keyword tags failed: ${error.message}`)
  return (
    (data ?? []) as Array<{ tag: string; keyword_count: number | string }>
  ).map((row) => ({ tag: row.tag, keyword_count: Number(row.keyword_count) }))
}

async function savedRowsFor(
  svc: SupabaseClient,
  workspaceId: string,
  market: Market,
  keywords: readonly string[],
): Promise<SavedRow[]> {
  const rows: SavedRow[] = []
  for (const batch of chunks(keywords, IN_BATCH)) {
    const { data, error } = await svc
      .from('seo_saved_keyword')
      .select(FIELDS)
      .eq('workspace_id', workspaceId)
      .eq('location_code', market.locationCode)
      .eq('language_code', market.languageCode)
      .in('keyword', batch)
    if (error) throw new Error(`saved keywords read failed: ${error.message}`)
    rows.push(...((data ?? []) as SavedRow[]))
  }
  return rows
}

async function savedRowsById(
  svc: SupabaseClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<SavedRow[]> {
  const rows: SavedRow[] = []
  for (const batch of chunks(ids, IN_BATCH)) {
    const { data, error } = await svc
      .from('seo_saved_keyword')
      .select(FIELDS)
      .eq('workspace_id', workspaceId)
      .in('id', batch)
    if (error) throw new Error(`saved keywords read failed: ${error.message}`)
    rows.push(...((data ?? []) as SavedRow[]))
  }
  return rows
}

/** Rewrites whole rows (every column, so a batch's rows share one shape). */
async function writeRows(
  svc: SupabaseClient,
  rows: SavedRow[],
  patch: (row: SavedRow) => Partial<SavedRow>,
  now: string,
): Promise<number> {
  if (rows.length === 0) return 0
  const next = rows.map((row) => {
    const {
      id,
      workspace_id,
      keyword,
      location_code,
      language_code,
      search_volume,
      cpc,
      competition,
      keyword_difficulty,
      intent,
      monthly_searches,
      metrics_fetched_at,
      tags,
      note,
      created_by,
      created_at,
    } = { ...row, ...patch(row) }
    return {
      id,
      workspace_id,
      keyword,
      location_code,
      language_code,
      search_volume,
      cpc,
      competition,
      keyword_difficulty,
      intent,
      monthly_searches,
      metrics_fetched_at,
      tags,
      note,
      created_by,
      created_at,
      updated_at: now,
    }
  })
  let written = 0
  for (const batch of chunks(next, 500)) {
    const { error } = await svc
      .from('seo_saved_keyword')
      .upsert(batch, { onConflict: 'id' })
    if (error) throw new Error(`saved keywords write failed: ${error.message}`)
    written += batch.length
  }
  return written
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export type SavedKeywordWriteFailure = {
  ok: false
  code: 'VALIDATION_ERROR' | 'SAVED_KEYWORDS_FULL' | 'NOT_FOUND'
  message: string
}

export interface AddSavedKeywordsInput {
  keywords: string[]
  location_code?: number | null
  language_code?: string | null
  /** Metrics to keep with them, matched by keyword (copied from a research or metrics result). */
  metrics?: Array<
    Pick<KeywordRow, 'keyword'> & Partial<Omit<KeywordRow, 'keyword'>>
  >
  /** Tags added to every keyword in this add (already-saved ones too). */
  tags?: string[]
  note?: string | null
  /** When `metrics` were read (default now). */
  metrics_fetched_at?: string | null
}

/** Save keywords in one market. Already-saved ones keep their row and gain the tags (and the metrics, when given). */
export async function addSavedKeywords(
  svc: SupabaseClient,
  who: { workspaceId: string; userId: string | null },
  input: AddSavedKeywordsInput,
  opts: { now?: Date } = {},
): Promise<
  | { ok: true; added: number; already_saved: number; rows: SavedKeyword[] }
  | SavedKeywordWriteFailure
> {
  const keywords = normalizeSavedKeywords(input.keywords ?? [])
  if (keywords.length === 0)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Give at least one keyword to save.',
    }
  if (keywords.length > SAVED_KEYWORDS_PER_ADD)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Save at most ${SAVED_KEYWORDS_PER_ADD} keywords at a time.`,
    }
  let market: Market
  try {
    market = resolveKeywordMarket(input)
  } catch (err) {
    if (isSeoError(err))
      return { ok: false, code: 'VALIDATION_ERROR', message: err.message }
    throw err
  }
  const now = (opts.now ?? new Date()).toISOString()
  const tags = normalizeTags(input.tags ?? [])
  const note = input.note?.trim()
    ? input.note.trim().slice(0, SAVED_KEYWORD_NOTE_LENGTH)
    : null
  const metricsAt = input.metrics_fetched_at ?? now
  const metricByKeyword = new Map<string, ReturnType<typeof metricColumns>>()
  for (const metric of input.metrics ?? []) {
    const keyword = normalizeKeyword(metric.keyword ?? '')
    if (!keyword || !keywords.includes(keyword)) continue
    metricByKeyword.set(
      keyword,
      metricColumns(
        {
          search_volume: metric.search_volume ?? null,
          cpc: metric.cpc ?? null,
          competition: metric.competition ?? null,
          keyword_difficulty: metric.keyword_difficulty ?? null,
          intent: isKeywordIntent(metric.intent) ? metric.intent : 'unknown',
          trend: Array.isArray(metric.trend) ? trendFrom(metric.trend) : [],
        },
        metricsAt,
      ),
    )
  }

  const existingRows = await savedRowsFor(
    svc,
    who.workspaceId,
    market,
    keywords,
  )
  const plan = planSavedKeywordAdd(
    existingRows.map((row) => row.keyword),
    keywords,
  )

  if (plan.insert.length > 0) {
    const { count, error } = await svc
      .from('seo_saved_keyword')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', who.workspaceId)
    if (error) throw new Error(`saved keywords count failed: ${error.message}`)
    const total = count ?? 0
    if (total + plan.insert.length > SAVED_KEYWORDS_MAX) {
      return {
        ok: false,
        code: 'SAVED_KEYWORDS_FULL',
        message: `This workspace has ${total.toLocaleString('en-US')} saved keywords and keeps at most ${SAVED_KEYWORDS_MAX.toLocaleString('en-US')}. Nothing was saved. Remove keywords you no longer need, then try again.`,
      }
    }
    const inserts = plan.insert.map((keyword) => ({
      workspace_id: who.workspaceId,
      keyword,
      location_code: market.locationCode,
      language_code: market.languageCode,
      search_volume: null,
      cpc: null,
      competition: null,
      keyword_difficulty: null,
      intent: null,
      monthly_searches: [],
      metrics_fetched_at: null,
      ...(metricByKeyword.get(keyword) ?? {}),
      tags,
      note,
      created_by: who.userId,
      created_at: now,
      updated_at: now,
    }))
    for (const batch of chunks(inserts, 500)) {
      const { error: insertError } = await svc
        .from('seo_saved_keyword')
        .insert(batch)
      if (insertError)
        throw new Error(`saved keywords insert failed: ${insertError.message}`)
    }
  }

  // Already saved: keep the row, add the tags, take the metrics when given.
  const touch = existingRows.filter(
    (row) =>
      tags.length > 0 || metricByKeyword.has(row.keyword) || note !== null,
  )
  await writeRows(
    svc,
    touch,
    (row) => ({
      tags: retag(row.tags ?? [], { add: tags }),
      ...(metricByKeyword.get(row.keyword) ?? {}),
      ...(note !== null ? { note } : {}),
    }),
    now,
  )

  await collapseDuplicates(svc, who.workspaceId, market, keywords)
  const rows = (await savedRowsFor(svc, who.workspaceId, market, keywords)).map(
    savedKeywordView,
  )
  return {
    ok: true,
    added: plan.insert.length,
    already_saved: plan.existing.length,
    rows,
  }
}

/** Deletes the rows a race duplicated (keeps the oldest of each keyword). Answers how many it removed. */
export async function collapseDuplicates(
  svc: SupabaseClient,
  workspaceId: string,
  market: Market,
  keywords: readonly string[],
): Promise<number> {
  const rows = await savedRowsFor(svc, workspaceId, market, keywords)
  const extra = duplicateIds(rows)
  if (extra.length === 0) return 0
  const { error } = await svc
    .from('seo_saved_keyword')
    .delete()
    .eq('workspace_id', workspaceId)
    .in('id', extra)
  if (error) {
    console.error(
      '[seo-saved-keywords] duplicate cleanup failed',
      error.message,
    )
    return 0
  }
  return extra.length
}

/** Delete saved keywords by id. Ids that are not this workspace's are ignored. */
export async function removeSavedKeywords(
  svc: SupabaseClient,
  workspaceId: string,
  ids: readonly string[],
): Promise<{ ok: true; removed: number }> {
  let removed = 0
  for (const batch of chunks([...new Set(ids)], IN_BATCH)) {
    const { data, error } = await svc
      .from('seo_saved_keyword')
      .delete()
      .eq('workspace_id', workspaceId)
      .in('id', batch)
      .select('id')
    if (error) throw new Error(`saved keywords delete failed: ${error.message}`)
    removed += ((data ?? []) as unknown[]).length
  }
  return { ok: true, removed }
}

export interface UpdateSavedKeywordsInput {
  ids: string[]
  add_tags?: string[]
  remove_tags?: string[]
  /** Replace every tag of these keywords with this list ([] clears them). */
  set_tags?: string[] | null
  /** A note for each of them; null or "" clears it. Leave out to keep notes. */
  note?: string | null
}

/** Retag (and annotate) saved keywords. */
export async function updateSavedKeywords(
  svc: SupabaseClient,
  workspaceId: string,
  input: UpdateSavedKeywordsInput,
  opts: { now?: Date } = {},
): Promise<
  { ok: true; updated: number; rows: SavedKeyword[] } | SavedKeywordWriteFailure
> {
  const ids = [...new Set(input.ids ?? [])]
  if (ids.length === 0)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Name the saved keywords to change.',
    }
  if (ids.length > SAVED_KEYWORDS_PER_ADD)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: `Change at most ${SAVED_KEYWORDS_PER_ADD} keywords at a time.`,
    }
  const changesTags =
    (input.add_tags?.length ?? 0) > 0 ||
    (input.remove_tags?.length ?? 0) > 0 ||
    Array.isArray(input.set_tags)
  if (!changesTags && input.note === undefined)
    return {
      ok: false,
      code: 'VALIDATION_ERROR',
      message: 'Nothing to change: add or remove tags, or set a note.',
    }
  const rows = await savedRowsById(svc, workspaceId, ids)
  if (rows.length === 0)
    return {
      ok: false,
      code: 'NOT_FOUND',
      message: 'Those saved keywords don’t exist.',
    }
  const note =
    input.note === undefined
      ? undefined
      : input.note?.trim()
        ? input.note.trim().slice(0, SAVED_KEYWORD_NOTE_LENGTH)
        : null
  const now = (opts.now ?? new Date()).toISOString()
  await writeRows(
    svc,
    rows,
    (row) => ({
      ...(changesTags
        ? {
            tags: retag(row.tags ?? [], {
              add: input.add_tags,
              remove: input.remove_tags,
              set: input.set_tags,
            }),
          }
        : {}),
      ...(note !== undefined ? { note } : {}),
    }),
    now,
  )
  const after = await savedRowsById(svc, workspaceId, ids)
  return { ok: true, updated: rows.length, rows: after.map(savedKeywordView) }
}

/**
 * Write fresh metrics onto the saved keywords they cover in that market
 * (after a research or metrics lookup was bought: the saved list then shows
 * what was just paid for). A row that came back empty clears stale numbers.
 * Never throws: the lookup is already paid for; a failure is logged.
 */
export async function syncSavedKeywordMetrics(
  svc: SupabaseClient,
  workspaceId: string,
  market: Market,
  rows: readonly KeywordRow[],
  fetchedAt: string,
): Promise<number> {
  if (rows.length === 0) return 0
  try {
    const byKeyword = new Map(rows.map((row) => [row.keyword, row]))
    const saved = await savedRowsFor(svc, workspaceId, market, [
      ...byKeyword.keys(),
    ])
    return await writeRows(
      svc,
      saved,
      (row) =>
        metricColumns(byKeyword.get(row.keyword) as KeywordRow, fetchedAt),
      fetchedAt,
    )
  } catch (err) {
    console.error('[seo-saved-keywords] metrics sync failed', err)
    return 0
  }
}
