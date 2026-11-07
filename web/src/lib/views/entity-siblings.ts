/** Default list ordering and neighbour lookup for entity detail navigation. */
import type { SupabaseClient } from '@supabase/supabase-js'
import { serverError } from '@/lib/api-errors'

/** Upper bound on rows pulled for one ordering scope. Exported for the
 *  ordered-truncation regression test. */
export const SCOPE_LIMIT = 2000

export type EntityType =
  | 'action'
  | 'capture'
  | 'document'
  | 'contact'
  | 'company'
  | 'project'
  | 'initiative'

interface EntityConfig {
  /** Physical table name (several differ from the API's plural noun). */
  table: string
  /** Column carrying the human-readable label for this entity. */
  titleColumn: string
  /**
   * Ordering strategy:
   *   - 'identifier_ladder': actions — same-team numeric identifier DESC, with
   *     a created_at DESC fallback for team-less / identifier-less rows.
   *   - 'started_at': captures — COALESCE(started_at, created_at) DESC, which
   *     is what the captures list groups its days by.
   *   - 'created_at': everything else.
   */
  order: 'identifier_ladder' | 'started_at' | 'created_at'
  /**
   * Columns the default list requires to be NULL, mirroring the unconditional
   * filters in the view query engine (src/lib/views/query-engine.ts). Contacts
   * merged away into another contact are hidden from the contacts list, and
   * actions with a parent are sub-tasks that never appear as list rows —
   * stepping the arrows onto either would land the user on a row no list shows.
   */
  requireNull?: string[]
  /** [column, value] inequality filters the default list applies (e.g. the
   *  internal '__default__' project every workspace carries but never lists). */
  exclude?: [string, string][]
}

const ENTITY_CONFIG: Record<EntityType, EntityConfig> = {
  action: {
    table: 'actions',
    titleColumn: 'title',
    order: 'identifier_ladder',
    requireNull: ['parent_id'],
  },
  capture: { table: 'captures', titleColumn: 'title', order: 'started_at' },
  document: { table: 'document', titleColumn: 'title', order: 'created_at' },
  contact: {
    table: 'contact',
    titleColumn: 'full_name',
    order: 'created_at',
    requireNull: ['merged_into_contact_id'],
  },
  company: { table: 'company', titleColumn: 'name', order: 'created_at' },
  project: {
    table: 'projects',
    titleColumn: 'name',
    order: 'created_at',
    exclude: [['name', '__default__']],
  },
  initiative: { table: 'initiative', titleColumn: 'name', order: 'created_at' },
}

export interface SiblingRef {
  id: string
  title: string | null
}

export interface SiblingsResult {
  prev: SiblingRef | null
  next: SiblingRef | null
}

const NO_SIBLINGS: SiblingsResult = { prev: null, next: null }

/** Raw shape every scope query selects into (extra columns are per-strategy). */
interface ScopeRow {
  id: string
  created_at?: string | null
  identifier?: string | null
  team_id?: string | null
  started_at?: string | null
  [key: string]: unknown
}

export function isEntityType(value: string | null): value is EntityType {
  return value !== null && Object.hasOwn(ENTITY_CONFIG, value)
}

/**
 * Parse the numeric tail of an action identifier ('GEN-52' → 52).
 *
 * The ladder is gap-ridden by design (moved/deleted actions leave holes), so
 * neighbours are whatever ranks adjacent — prev of GEN-52 may well be GEN-54.
 * Returns null for a shape we can't rank, which drops the row out of the
 * ladder scope entirely.
 */
export function parseIdentifierNumber(identifier: string | null | undefined): number | null {
  if (!identifier) return null
  const match = /-(\d+)$/.exec(identifier)
  if (!match) return null
  const n = Number(match[1])
  return Number.isFinite(n) ? n : null
}

/** Epoch millis for a timestamp column; missing/unparseable sorts oldest. */
function timeKey(value: string | null | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY
  const t = Date.parse(value)
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t
}

/**
 * Sort rows into the list's visual order (index 0 = top of the list).
 *
 * Every strategy tiebreaks on id so the total order is stable — without it two
 * rows created in the same millisecond (bulk import, extraction batch) could
 * swap places between requests and the arrows would oscillate.
 */
export function sortScope(rows: ScopeRow[], strategy: EntityConfig['order'], useLadder: boolean): ScopeRow[] {
  const rank = (row: ScopeRow): number => {
    if (strategy === 'identifier_ladder' && useLadder) {
      return parseIdentifierNumber(row.identifier) ?? Number.NEGATIVE_INFINITY
    }
    if (strategy === 'started_at') {
      return timeKey(row.started_at ?? row.created_at)
    }
    return timeKey(row.created_at)
  }

  return [...rows].sort((a, b) => {
    const ra = rank(a)
    const rb = rank(b)
    // Compare rather than subtract: two -Infinity ranks (rows with no usable
    // timestamp) subtract to NaN, which would make the sort order undefined.
    if (ra !== rb) return rb > ra ? 1 : -1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

function toRef(row: ScopeRow | undefined, titleColumn: string): SiblingRef | null {
  if (!row) return null
  const raw = row[titleColumn]
  return { id: row.id, title: typeof raw === 'string' ? raw : null }
}

/**
 * Resolve neighbours for one entity. Exported for direct unit testing — the
 * route handler is just auth + param validation around this.
 */
export async function resolveSiblings(
  supabase: SupabaseClient,
  workspaceId: string,
  type: EntityType,
  id: string,
): Promise<SiblingsResult | Response> {
  const config = ENTITY_CONFIG[type]

  // Load the target first: for actions its team_id defines the ladder scope,
  // and for every type its absence is the "no siblings" answer.
  const targetSelect =
    config.order === 'identifier_ladder' ? 'id, identifier, team_id' : 'id'
  let targetQuery = supabase
    .from(config.table)
    .select(targetSelect)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
  for (const column of config.requireNull ?? []) {
    targetQuery = targetQuery.is(column, null)
  }
  for (const [column, value] of config.exclude ?? []) {
    targetQuery = targetQuery.neq(column, value)
  }
  const { data: target, error: targetError } = await targetQuery.maybeSingle<ScopeRow>()

  if (targetError) {
    console.error('[entity-siblings] target lookup failed:', targetError)
    return serverError()
  }
  if (!target) return NO_SIBLINGS

  // An action only rides the identifier ladder when it has BOTH a team and a
  // parseable identifier — the ladder is per-team, and a team-less action has
  // no rung to stand on. Those fall back to workspace-wide created_at DESC,
  // which is what the "all actions" list shows them in anyway.
  const teamId = typeof target.team_id === 'string' ? target.team_id : null
  const useLadder =
    config.order === 'identifier_ladder' &&
    teamId !== null &&
    parseIdentifierNumber(target.identifier) !== null

  const columns =
    config.order === 'identifier_ladder'
      ? `id, ${config.titleColumn}, identifier, created_at`
      : config.order === 'started_at'
        ? `id, ${config.titleColumn}, started_at, created_at`
        : `id, ${config.titleColumn}, created_at`

  let query = supabase
    .from(config.table)
    .select(columns)
    .eq('workspace_id', workspaceId)

  if (useLadder) query = query.eq('team_id', teamId)
  for (const column of config.requireNull ?? []) {
    query = query.is(column, null)
  }
  for (const [column, value] of config.exclude ?? []) {
    query = query.neq(column, value)
  }

  // ORDER BY before LIMIT, always. Without it Postgres returns a planner-chosen
  // arbitrary subset, so on a scope past SCOPE_LIMIT the cap would silently
  // corrupt the answer (target missing → "no siblings"; neighbours computed
  // against a random sample) instead of gracefully bounding it. The DB order
  // decides WHICH rows survive the cap; the exact list order is still computed
  // by sortScope. For the identifier ladder PostgREST can't rank the numeric
  // tail of a TEXT identifier, so created_at DESC is the retention heuristic —
  // ladder position correlates with creation time, so the newest SCOPE_LIMIT
  // rungs are the right ones to keep. The trailing id order makes retention
  // deterministic across identical timestamps (bulk imports).
  if (config.order === 'started_at') {
    query = query
      .order('started_at', { ascending: false, nullsFirst: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
  } else {
    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
  }

  const { data, error } = await query.limit(SCOPE_LIMIT)

  if (error) {
    console.error('[entity-siblings] scope query failed:', error)
    return serverError()
  }

  const rows = ((data ?? []) as unknown as ScopeRow[]).filter((row) => {
    if (!useLadder) return true
    // Within a ladder scope, an unranked row would collapse to -Infinity and
    // pile up at the bottom in arbitrary order — exclude it instead.
    return parseIdentifierNumber(row.identifier) !== null
  })

  const ordered = sortScope(rows, config.order, useLadder)
  const index = ordered.findIndex((row) => row.id === id)
  if (index === -1) return NO_SIBLINGS

  return {
    prev: toRef(ordered[index - 1], config.titleColumn),
    next: toRef(ordered[index + 1], config.titleColumn),
  }
}

