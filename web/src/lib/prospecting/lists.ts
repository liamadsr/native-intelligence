/**
 * Prospect-list mutations and reads — the single implementation behind the
 * routes under `src/app/api/account/prospecting/` (and, later, the AI tools),
 * following the `src/lib/sequences/mutations.ts` precedent.
 *
 * Everything here runs on whatever Supabase client the caller holds (the
 * routes pass the RLS-scoped one; the run engine holds the service-role
 * client), so EVERY query carries an explicit `workspace_id` filter — RLS is
 * never trusted alone. That rule is what makes it safe for the Inngest lane to
 * call these functions with a service client later.
 *
 * Scope: lists CRUD, hand-add-by-domain, stage transitions, and promotion for
 * BOTH kinds of entry. The person half of promotion — `createProspectContact`,
 * the purpose-derived `relationship_type`, the contact blob merge — lives in
 * `promote.ts`, because it is subtle enough to deserve its own tests and does
 * not belong in a function whose job is a loop.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  columnCandidates,
  ensureCompanyForDomain,
  mergeBlobFields,
  normalizeDomain,
} from '@/lib/crm/enrichment'
// `computeFillEmptyPatch` lives in hubspot-sync and is imported into
// enrichment.ts rather than re-exported from it, so promotion imports it from
// the same source enrichment does — one implementation, no re-export chain.
import { computeFillEmptyPatch } from '@/lib/crm/hubspot-sync'
import { readAll } from './exclusions'
import { fetchAllRows } from '@/lib/supabase/paging'
import { companyCandidateKey } from './keys'
import {
  mergeResearchIntoContact,
  promotePerson,
} from './promote'
import { emptyIcp, normalizeIcp, icpEquals } from './icp'
import type {
  Icp,
  ProspectCandidate,
  ProspectDismissedReason,
  ProspectEntryKind,
  ProspectEntryStage,
  ProspectExcludeContacted,
  ProspectListEntryRow,
  ProspectListPurpose,
  ProspectListRow,
  ProspectListStatus,
} from './types'
import {
  PROSPECT_DISMISSED_REASONS,
  PROSPECT_ENTRY_STAGES,
  PROSPECT_EXCLUDE_CONTACTED,
  PROSPECT_LIST_PURPOSES,
  PROSPECTING_RUN_LIVE_STATUSES,
} from './types'

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** Uniform failure shape. `code` is what the routes map to a status. */
export interface ProspectingError {
  ok: false
  code:
    | 'LIST_NAME_TAKEN'
    | 'NOT_FOUND'
    | 'INVALID_INPUT'
    | 'INVALID_DOMAIN'
    | 'PERSONAL_DOMAIN'
    | 'DB_ERROR'
    /** deleteList: a run is still going on the list — stop it first. */
    | 'RUN_LIVE'
  error: string
}

export type Result<T> = ({ ok: true } & T) | ProspectingError

function fail(code: ProspectingError['code'], error: string): ProspectingError {
  return { ok: false, code, error }
}

/**
 * Resolve a client-supplied `source_company_id` against the caller's workspace.
 *
 * `prospect_list.source_company_id` is written straight from request input and
 * `public.company` carries no cross-workspace FK guard, so without this a
 * member could pin their list to a company id belonging to another workspace —
 * and every later consumer of the column would inherit that pointer. RLS does
 * not catch it: the INSERT is on `prospect_list`, whose workspace is the
 * caller's own.
 *
 * Returns the id when it resolves inside the workspace, `null` for an empty or
 * non-string input, and a `ProspectingError` when the id is real but foreign
 * (or simply absent) — reported as INVALID_INPUT rather than NOT_FOUND, which
 * would confirm the id exists somewhere.
 */
async function resolveOwnCompanyId(
  supabase: SupabaseClient,
  workspaceId: string,
  candidate: unknown,
): Promise<{ ok: true; id: string | null } | ProspectingError> {
  if (typeof candidate !== 'string' || candidate === '') return { ok: true, id: null }
  const { data, error } = await supabase
    .from('company')
    .select('id')
    .eq('id', candidate)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] source company check failed:', error.message)
    return fail('DB_ERROR', 'Failed to validate source company')
  }
  if (!data) return fail('INVALID_INPUT', 'source_company_id is not a company in this workspace')
  return { ok: true, id: candidate }
}

/** Every column of `prospect_list`. */
const LIST_COLUMNS = '*'
/** Every column of `prospect_list_entry`. */
const ENTRY_COLUMNS = '*'

/**
 * Per-stage entry tally attached to a list in the index.
 *
 * `saved_people` is carved out of `saved` rather than derived from it, because
 * the two answer different questions and the index card asks the second one.
 * `saved` counts every promoted entry, companies included — and a company
 * promoted to the CRM is research, not a person anyone can email. "12 saved"
 * on a list holding 12 companies and nobody to contact overstates what the
 * list is worth by exactly the amount that matters.
 */
export type EntryStageCounts = Record<ProspectEntryStage, number> & {
  total: number
  /** Of `saved`, how many are `kind='person'` — someone reachable. */
  saved_people: number
  /**
   * Saved entries the CRM group does not hold yet — what Publish will write:
   * saved companies with no `published_at`, and saved people under a SAVED
   * company with none. The list header's "Publish · N" (migration 259).
   */
  pending_publish: number
}

function emptyCounts(): EntryStageCounts {
  const counts = { total: 0, saved_people: 0, pending_publish: 0 } as EntryStageCounts
  for (const stage of PROSPECT_ENTRY_STAGES) counts[stage] = 0
  return counts
}

/** The columns a tally needs — the index card's per-list read and the
 *  list-detail read both select exactly these. */
interface TallyRow {
  id: string
  stage: string
  kind: string
  parent_entry_id: string | null
  published_at: string | null
}

/**
 * The per-stage tally over ONE list's rows — the single implementation behind
 * both `countEntriesByList` and `listEntries`, so the index card and the list
 * header cannot disagree about what is pending (they did, for one commit).
 */
function tallyEntries(rows: TallyRow[]): EntryStageCounts {
  const counts = emptyCounts()
  // The saved companies first: a saved person only counts as pending when its
  // company is saved too (`isListMember`), and a person may precede its parent.
  const savedCompanyIds = new Set(
    rows.filter((r) => r.kind === 'company' && r.stage === 'saved').map((r) => r.id),
  )
  for (const row of rows) {
    counts.total += 1
    if (row.stage in counts) counts[row.stage as ProspectEntryStage] += 1
    if (row.stage === 'saved' && row.kind === 'person') counts.saved_people += 1
    if (row.published_at === null && isListMember(row, savedCompanyIds)) counts.pending_publish += 1
  }
  return counts
}

/**
 * Is this saved entry on the list AS A GROUP MEMBER — the thing Publish
 * writes? A saved company always is; a saved person only under a saved
 * company (a dismissed company takes its people out of the group with it,
 * whatever their own stage says).
 */
export function isListMember(
  entry: { kind: string; stage: string; parent_entry_id: string | null },
  savedCompanyIds: ReadonlySet<string>,
): boolean {
  if (entry.stage !== 'saved') return false
  if (entry.kind === 'company') return true
  return entry.parent_entry_id !== null && savedCompanyIds.has(entry.parent_entry_id)
}

export interface ProspectListWithCounts extends ProspectListRow {
  entry_counts: EntryStageCounts
}

// ---------------------------------------------------------------------------
// createList
// ---------------------------------------------------------------------------

export interface CreateListInput {
  name: string
  description?: string | null
  /** Validated against PROSPECT_LIST_PURPOSES; anything else degrades to
   *  'buyers' rather than producing a 23514. */
  purpose?: unknown
  icp?: unknown
  source_company_id?: string | null
  exclude_crm?: unknown
  exclude_other_lists?: unknown
  exclude_contacted?: unknown
  max_spend_dollars?: unknown
  target_new_candidates?: unknown
  max_rounds?: unknown
  people_per_company?: unknown
}

/** Clamp a numeric policy field to the range 248's CHECK enforces, so an
 *  out-of-range client value degrades rather than producing a 23514. */
function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

function clampSpend(raw: unknown, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  // 0 is legal (a browse-only list); the upper bound is the workspace monthly
  // ceiling (decision 5) — a single run may not book the whole month.
  return Math.min(20, Math.max(0, Math.round(raw * 1e4) / 1e4))
}

function asPurpose(raw: unknown): ProspectListPurpose {
  return PROSPECT_LIST_PURPOSES.includes(raw as ProspectListPurpose)
    ? (raw as ProspectListPurpose)
    : 'buyers'
}

function asExcludeContacted(raw: unknown, fallback: ProspectExcludeContacted): ProspectExcludeContacted {
  return PROSPECT_EXCLUDE_CONTACTED.includes(raw as ProspectExcludeContacted)
    ? (raw as ProspectExcludeContacted)
    : fallback
}

function asBool(raw: unknown, fallback: boolean): boolean {
  return typeof raw === 'boolean' ? raw : fallback
}

/**
 * Create a list. Name is unique per workspace, case-insensitively
 * (`prospect_list_workspace_name_idx` on `lower(name)`), and a collision comes
 * back as `LIST_NAME_TAKEN` for the route to render as a 409 — never as a
 * generic 500, because "you already have a list called that" is a thing the
 * user can fix in one keystroke.
 *
 * The `23505` is caught rather than pre-checked: a check-then-insert races two
 * concurrent creates, and the index is the only thing that actually decides.
 */
export async function createList(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; input: CreateListInput },
): Promise<Result<{ list: ProspectListRow }>> {
  const name = typeof args.input.name === 'string' ? args.input.name.trim() : ''
  if (!name) return fail('INVALID_INPUT', 'name is required')

  const purpose = asPurpose(args.input.purpose)
  const icp = args.input.icp === undefined ? emptyIcp() : normalizeIcp(args.input.icp)

  // Both the explicit field and the ICP's own `source.company_id` fallback are
  // client input, so both go through the workspace check.
  const sourceCompany = await resolveOwnCompanyId(
    supabase,
    args.workspaceId,
    typeof args.input.source_company_id === 'string' && args.input.source_company_id
      ? args.input.source_company_id
      : icp.source.company_id || null,
  )
  if (!sourceCompany.ok) return sourceCompany

  const { data, error } = await supabase
    .from('prospect_list')
    .insert({
      workspace_id: args.workspaceId,
      name,
      description:
        typeof args.input.description === 'string' && args.input.description.trim() !== ''
          ? args.input.description.trim()
          : null,
      purpose,
      icp,
      icp_version: 1,
      source_company_id: sourceCompany.id,
      exclude_crm: asBool(args.input.exclude_crm, true),
      exclude_other_lists: asBool(args.input.exclude_other_lists, false),
      exclude_contacted: asExcludeContacted(args.input.exclude_contacted, 'ever'),
      max_spend_dollars: clampSpend(args.input.max_spend_dollars, 2),
      target_new_candidates: clampInt(args.input.target_new_candidates, 5, 100, 20),
      max_rounds: clampInt(args.input.max_rounds, 1, 3, 2),
      people_per_company: clampInt(args.input.people_per_company, 0, 10, 3),
      status: 'active',
      created_by: args.userId,
    })
    .select(LIST_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      return fail('LIST_NAME_TAKEN', `A list called "${name}" already exists in this workspace`)
    }
    console.error('[prospecting] list create failed:', error.message)
    return fail('DB_ERROR', 'Failed to create list')
  }
  return { ok: true, list: data as unknown as ProspectListRow }
}

// ---------------------------------------------------------------------------
// listLists
// ---------------------------------------------------------------------------

/**
 * Every list in the workspace, newest first, each carrying its per-stage entry
 * tally.
 *
 * The counts come from ONE `select('list_id, stage')` over the workspace's
 * entries rather than a count query per list: the index page renders a handful
 * of cards and N+1 round trips for a number is not worth it. If entry volume
 * ever makes that read heavy, the fix is a view — not a denormalized counter
 * column, which would drift the moment the run engine writes entries.
 */
export async function listLists(
  supabase: SupabaseClient,
  args: { workspaceId: string; includeArchived?: boolean },
): Promise<Result<{ lists: ProspectListWithCounts[] }>> {
  let query = supabase
    .from('prospect_list')
    .select(LIST_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .order('created_at', { ascending: false })
  if (!args.includeArchived) query = query.eq('status', 'active')

  const { data, error } = await query
  if (error) {
    console.error('[prospecting] list index failed:', error.message)
    return fail('DB_ERROR', 'Failed to load lists')
  }
  const lists = (data ?? []) as unknown as ProspectListRow[]
  if (lists.length === 0) return { ok: true, lists: [] }

  let byList: Map<string, EntryStageCounts>
  try {
    byList = await countEntriesByList(supabase, {
      workspaceId: args.workspaceId,
      listIds: lists.map((l) => l.id),
    })
  } catch (err) {
    console.error('[prospecting] list entry counts failed:', err)
    return fail('DB_ERROR', 'Failed to load list counts')
  }

  return {
    ok: true,
    lists: lists.map((l) => ({ ...l, entry_counts: byList.get(l.id) ?? emptyCounts() })),
  }
}

// ---------------------------------------------------------------------------
// countEntriesByList
// ---------------------------------------------------------------------------

/**
 * Per-stage entry tallies for a set of lists, keyed by list id.
 *
 * ONE implementation, two callers: `listLists` above (the prospecting API's own
 * index) and the views/query route's `prospect_list` enrichment block, which
 * merges the result onto each row as `entry_counts`. They must agree — the
 * index page and a saved view over the same lists showing different candidate
 * counts is the kind of disagreement nobody debugs, they just stop trusting
 * both numbers.
 *
 * PAGED, and that is the load-bearing part. The counts span every entry in
 * every list on the page — the read most likely to pass 1000 rows, which
 * PostgREST truncates at silently. An unpaginated version quietly under-reports
 * the counts a user navigates by.
 *
 * Counts, not a count query per list: a page of lists is a handful of rows and
 * N+1 round trips for a number is not worth it. If entry volume ever makes this
 * read heavy the fix is a view — not a denormalized counter column, which would
 * drift the moment the run engine writes entries.
 *
 * THROWS on a read failure (readAll's contract) rather than returning a
 * partial map: a silently-short tally is worse than an error, because it looks
 * like a real answer.
 */
export async function countEntriesByList(
  supabase: SupabaseClient,
  args: { workspaceId: string; listIds: string[] },
): Promise<Map<string, EntryStageCounts>> {
  const byList = new Map<string, EntryStageCounts>()
  if (args.listIds.length === 0) return byList

  const entries = await readAll<{
    id: string
    list_id: string
    stage: ProspectEntryStage
    kind: string
    parent_entry_id: string | null
    published_at: string | null
  }>('list entry counts', (from, to) =>
    supabase
      .from('prospect_list_entry')
      .select('id, list_id, stage, kind, parent_entry_id, published_at')
      .eq('workspace_id', args.workspaceId)
      .in('list_id', args.listIds)
      .order('id')
      .range(from, to),
  )

  const rowsByList = new Map<string, TallyRow[]>()
  for (const raw of entries) {
    const rows = rowsByList.get(raw.list_id) ?? []
    rows.push(raw)
    rowsByList.set(raw.list_id, rows)
  }
  for (const [listId, rows] of rowsByList) byList.set(listId, tallyEntries(rows))
  return byList
}

/** The zero tally, for a list with no entries. Exported so the views/query
 *  enrichment can fill rows the count read returned nothing for — a list with
 *  no candidates must render "0", never a blank cell. */
export function emptyEntryCounts(): EntryStageCounts {
  return emptyCounts()
}

// ---------------------------------------------------------------------------
// getList
// ---------------------------------------------------------------------------

/** One list plus its entries. A cross-workspace id resolves to NOT_FOUND, not
 *  a 403 — a list the caller cannot see must not be confirmable by its id. */
export async function getList(
  supabase: SupabaseClient,
  args: ListEntriesArgs,
): Promise<Result<{ list: ProspectListRow; entries: ProspectListEntryRow[]; entry_counts: EntryStageCounts }>> {
  const { data, error } = await supabase
    .from('prospect_list')
    .select(LIST_COLUMNS)
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] list load failed:', error.message)
    return fail('DB_ERROR', 'Failed to load list')
  }
  if (!data) return fail('NOT_FOUND', 'List not found')

  const entriesResult = await listEntries(supabase, args)
  if (!entriesResult.ok) return entriesResult

  return {
    ok: true,
    list: data as unknown as ProspectListRow,
    entries: entriesResult.entries,
    entry_counts: entriesResult.entry_counts,
  }
}

/**
 * The filters a caller may narrow an entry read by.
 *
 * All three are SQL predicates, not post-filters. The score floor and `kind`
 * were added because the agent's `list_prospect_entries` was reading every row
 * of a list and then filtering the array in the tool — which on a 1200-entry
 * list is two paged round trips and 1200 rows of JSON to answer "show me the
 * hot ones". The stage filter was always pushed down; these two match it.
 */
export interface ListEntriesArgs {
  workspaceId: string
  listId: string
  stage?: ProspectEntryStage
  /** Keep only entries scored at or above this. Entries with a NULL score
   *  (not profiled yet) are excluded by `.gte()`, which is correct — an
   *  unscored row is not a match, it is a row nobody has profiled. */
  min_fit_score?: number
  kind?: ProspectEntryKind
}

/** The entries of one list, hottest first (unscored last, then newest),
 *  optionally filtered by stage, score floor and kind. Counts are always over
 *  the WHOLE list, never the filtered slice — the stage tabs have to show what
 *  is behind the tab you are not on. */
export async function listEntries(
  supabase: SupabaseClient,
  args: ListEntriesArgs,
): Promise<Result<{ entries: ProspectListEntryRow[]; entry_counts: EntryStageCounts }>> {
  // PAGED, for the same reason the exclusion set is. One discover run plus one
  // people run at `people_per_company = 3` is already several hundred entries,
  // so 1000 is reachable in ordinary use — and PostgREST's truncation at that
  // boundary is SILENT. Unpaginated, the board would simply stop showing rows
  // and the stage tabs would under-count, with nothing anywhere saying so.
  //
  // Hottest first, unscored rows after every scored one (NULLS LAST), then
  // newest. Neither the score nor `created_at` is unique, so neither can be
  // the paging key on its own: two rows written in the same millisecond can
  // straddle a window boundary and be returned twice or not at all. `id` is
  // the tiebreak that makes the windows disjoint.
  let entries: ProspectListEntryRow[]
  try {
    entries = await readAll<ProspectListEntryRow>('entries', (from, to) => {
      let query = supabase
        .from('prospect_list_entry')
        .select(ENTRY_COLUMNS)
        .eq('workspace_id', args.workspaceId)
        .eq('list_id', args.listId)
        .order('fit_score', { ascending: false, nullsFirst: false })
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
      if (args.stage) query = query.eq('stage', args.stage)
      // Pushed down beside the stage line rather than applied to the result:
      // the whole point of the two filters is that the rows the caller does
      // not want never leave Postgres.
      if (typeof args.min_fit_score === 'number') query = query.gte('fit_score', args.min_fit_score)
      if (args.kind) query = query.eq('kind', args.kind)
      return query.range(from, to)
    })
  } catch (err) {
    console.error('[prospecting] entries load failed:', err)
    return fail('DB_ERROR', 'Failed to load entries')
  }

  // ANY of the three filters makes `entries` a slice rather than the list, so
  // the second (unfiltered) read is what keeps the tab badges honest. Before
  // the score floor and `kind` existed this branched on `stage` alone; a
  // score-filtered read that fell into the else-branch would have counted only
  // the hot rows and reported that as the list's total.
  const filtered =
    Boolean(args.stage) || Boolean(args.kind) || typeof args.min_fit_score === 'number'
  let counts: EntryStageCounts
  if (filtered) {
    // Counts are always over the WHOLE list, so this second read exists only
    // when the first one was filtered — and it is paged too, or the tab badges
    // lie in exactly the case the pagination above was added for.
    let allRows: TallyRow[]
    try {
      // `kind` travels with `stage` because `saved_people` needs it, and the
      // parent and the stamp because `pending_publish` does: a count read that
      // omitted them would report 0 on every filtered view — the numbers the
      // list card and the Publish button lead with.
      allRows = await readAll<TallyRow>('entry counts', (from, to) =>
        supabase
          .from('prospect_list_entry')
          .select('id, stage, kind, parent_entry_id, published_at')
          .eq('workspace_id', args.workspaceId)
          .eq('list_id', args.listId)
          .order('id')
          .range(from, to),
      )
    } catch (err) {
      console.error('[prospecting] entry counts failed:', err)
      return fail('DB_ERROR', 'Failed to load entry counts')
    }
    counts = tallyEntries(allRows)
  } else {
    counts = tallyEntries(entries)
  }

  return { ok: true, entries, entry_counts: counts }
}

// ---------------------------------------------------------------------------
// updateList
// ---------------------------------------------------------------------------

export interface UpdateListInput {
  name?: unknown
  description?: unknown
  purpose?: unknown
  icp?: unknown
  source_company_id?: unknown
  exclude_crm?: unknown
  exclude_other_lists?: unknown
  exclude_contacted?: unknown
  max_spend_dollars?: unknown
  target_new_candidates?: unknown
  max_rounds?: unknown
  people_per_company?: unknown
  status?: unknown
}

/**
 * Patch a list. Only fields actually present in the input are written.
 *
 * ICP VERSIONING (§4). An ICP edit bumps `icp_version` and does NOT
 * retro-invalidate anything: entries keep the version they were found under
 * and the list badges the drift. The bump is conditional on the normalized ICP
 * actually DIFFERING — opening the panel and closing it must not drift every
 * entry's badge, which is what an unconditional bump would do on every save.
 */
export async function updateList(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string; input: UpdateListInput },
): Promise<Result<{ list: ProspectListRow; icp_version_bumped: boolean }>> {
  const { data: existing, error: loadError } = await supabase
    .from('prospect_list')
    .select(LIST_COLUMNS)
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (loadError) {
    console.error('[prospecting] list patch load failed:', loadError.message)
    return fail('DB_ERROR', 'Failed to load list')
  }
  if (!existing) return fail('NOT_FOUND', 'List not found')
  const current = existing as unknown as ProspectListRow

  const input = args.input
  const patch: Record<string, unknown> = {}

  if (input.name !== undefined) {
    const name = typeof input.name === 'string' ? input.name.trim() : ''
    if (!name) return fail('INVALID_INPUT', 'name cannot be empty')
    patch.name = name
  }
  if (input.description !== undefined) {
    patch.description =
      typeof input.description === 'string' && input.description.trim() !== ''
        ? input.description.trim()
        : null
  }
  if (input.purpose !== undefined) patch.purpose = asPurpose(input.purpose)
  if (input.source_company_id !== undefined) {
    const sourceCompany = await resolveOwnCompanyId(supabase, args.workspaceId, input.source_company_id)
    if (!sourceCompany.ok) return sourceCompany
    patch.source_company_id = sourceCompany.id
  }
  if (input.exclude_crm !== undefined) patch.exclude_crm = asBool(input.exclude_crm, current.exclude_crm)
  if (input.exclude_other_lists !== undefined) {
    patch.exclude_other_lists = asBool(input.exclude_other_lists, current.exclude_other_lists)
  }
  if (input.exclude_contacted !== undefined) {
    patch.exclude_contacted = asExcludeContacted(input.exclude_contacted, current.exclude_contacted)
  }
  if (input.max_spend_dollars !== undefined) {
    patch.max_spend_dollars = clampSpend(input.max_spend_dollars, current.max_spend_dollars)
  }
  if (input.target_new_candidates !== undefined) {
    patch.target_new_candidates = clampInt(input.target_new_candidates, 5, 100, current.target_new_candidates)
  }
  if (input.max_rounds !== undefined) {
    patch.max_rounds = clampInt(input.max_rounds, 1, 3, current.max_rounds)
  }
  if (input.people_per_company !== undefined) {
    patch.people_per_company = clampInt(input.people_per_company, 0, 10, current.people_per_company)
  }
  if (input.status !== undefined) {
    const status = input.status as ProspectListStatus
    if (status !== 'active' && status !== 'archived') {
      return fail('INVALID_INPUT', `Unsupported status '${String(input.status)}'`)
    }
    patch.status = status
  }

  let bumped = false
  if (input.icp !== undefined) {
    const next = normalizeIcp(input.icp)
    const previous = normalizeIcp(current.icp)
    patch.icp = next
    if (!icpEquals(previous, next)) {
      patch.icp_version = current.icp_version + 1
      bumped = true
    }
  }

  if (Object.keys(patch).length === 0) {
    return { ok: true, list: current, icp_version_bumped: false }
  }

  const { data, error } = await supabase
    .from('prospect_list')
    .update(patch)
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .select(LIST_COLUMNS)
    .maybeSingle()
  if (error) {
    if (error.code === '23505') {
      return fail('LIST_NAME_TAKEN', 'A list with that name already exists in this workspace')
    }
    console.error('[prospecting] list patch failed:', error.message)
    return fail('DB_ERROR', 'Failed to update list')
  }
  if (!data) return fail('NOT_FOUND', 'List not found')
  return { ok: true, list: data as unknown as ProspectListRow, icp_version_bumped: bumped }
}

/**
 * Archive rather than delete. Entries are the workspace's accumulated
 * suppression set (§6) — deleting a list cascades every one of them and
 * re-opens every dismissal for re-discovery and re-billing, so DELETE on the
 * route archives instead, mirroring the sequences precedent.
 */
export async function archiveList(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string },
): Promise<Result<{ list: ProspectListRow }>> {
  const result = await updateList(supabase, {
    workspaceId: args.workspaceId,
    listId: args.listId,
    input: { status: 'archived' },
  })
  if (!result.ok) return result
  return { ok: true, list: result.list }
}

// ---------------------------------------------------------------------------
// deleteList
// ---------------------------------------------------------------------------

/**
 * Delete a list — the row, and with it (ON DELETE CASCADE, migration 248)
 * every entry, run and run candidate it holds. Liam, 2026-09-06: "add a way
 * to delete a list".
 *
 * WHAT STAYS. Companies and people the list PUBLISHED are CRM records in
 * their own right — interactions, sequences and other lists may reference
 * them — so they are never deleted; they only leave this list's group, through
 * the same SECURITY DEFINER function unpublish uses (migration 259). Saved
 * views scoped to the list go with it; nothing else references its id.
 *
 * WHAT DOES NOT STAY, and the dialog says so before the user confirms: the
 * entries are part of the workspace's suppression set (§6), so a candidate
 * dismissed here can be found again by a later search. That is the trade the
 * old DELETE-archives route refused on the user's behalf; now it is theirs.
 *
 * REFUSED while a run is live on the list (`RUN_LIVE`): the engine re-reads
 * the list's rows per iteration and would fail mid-flight. Stop it first.
 *
 * ORDER. The list goes FIRST — the cascade is the one destructive act — and
 * the CRM group cleanup and the scoped views follow, best-effort. A dangling
 * id left in a `prospect_list_ids` array matches nothing and is harmless; a
 * list whose group had been cleared but which survived a failed delete would
 * read as published while the CRM had forgotten it, which is worse.
 */
export async function deleteList(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string },
): Promise<Result<{ list: ProspectListRow; unpublished: { companies: number; contacts: number } }>> {
  const { workspaceId, listId } = args

  const { data: list, error: readError } = await supabase
    .from('prospect_list')
    .select('*')
    .eq('workspace_id', workspaceId)
    .eq('id', listId)
    .maybeSingle()
  if (readError) return fail('DB_ERROR', readError.message)
  if (!list) return fail('NOT_FOUND', 'List not found')

  const { data: live, error: liveError } = await supabase
    .from('prospecting_run')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('list_id', listId)
    .in('status', [...PROSPECTING_RUN_LIVE_STATUSES])
    .limit(1)
  if (liveError) return fail('DB_ERROR', liveError.message)
  if ((live ?? []).length > 0) {
    return fail('RUN_LIVE', 'A run is still going on this list — stop it before deleting')
  }

  // The group members, read BEFORE the delete so the cleanup knows who to
  // touch — after the cascade nothing but these arrays remembers the list.
  // Paged (a response stops at 1000 rows, and a member missed here keeps a
  // dangling list id forever), and a failed read stops the delete for the
  // same reason.
  const [companiesRes, contactsRes] = await Promise.all([
    fetchAllRows(() =>
      supabase
        .from('company')
        .select('id')
        .eq('workspace_id', workspaceId)
        .contains('prospect_list_ids', [listId]),
    ),
    fetchAllRows(() =>
      supabase
        .from('contact')
        .select('id')
        .eq('workspace_id', workspaceId)
        .contains('prospect_list_ids', [listId]),
    ),
  ])
  const membersError = companiesRes.error ?? contactsRes.error
  if (membersError) return fail('DB_ERROR', membersError.message)
  const companyIds = (companiesRes.data as Array<{ id: string }>).map((r) => r.id)
  const contactIds = (contactsRes.data as Array<{ id: string }>).map((r) => r.id)

  const { error: deleteError } = await supabase
    .from('prospect_list')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('id', listId)
  if (deleteError) return fail('DB_ERROR', deleteError.message)

  if (companyIds.length > 0 || contactIds.length > 0) {
    const { error: rpcError } = await supabase.rpc('prospect_list_mark_unpublished', {
      p_workspace: workspaceId,
      p_list: listId,
      p_company_ids: companyIds,
      p_contact_ids: contactIds,
    })
    if (rpcError) {
      console.error('[prospecting] deleteList: CRM group cleanup failed:', rpcError.message)
    }
  }

  const { error: viewError } = await supabase
    .from('view')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('scope_type', 'prospect_list')
    .eq('scope_id', listId)
  if (viewError) {
    console.error('[prospecting] deleteList: scoped view cleanup failed:', viewError.message)
  }

  return {
    ok: true,
    list: list as unknown as ProspectListRow,
    unpublished: { companies: companyIds.length, contacts: contactIds.length },
  }
}

// ---------------------------------------------------------------------------
// addEntryByDomain
// ---------------------------------------------------------------------------

export type AddEntryOutcome =
  | { ok: true; status: 'created'; entry: ProspectListEntryRow }
  /** The DB refused re-entry (`UNIQUE (list_id, candidate_key)`), which is not
   *  an error — it is layer 2 of the dedup story doing its job. */
  | { ok: true; status: 'exists'; entry: ProspectListEntryRow }
  | ProspectingError

/**
 * Hand-add a company to a list by domain.
 *
 * The same `candidate_key` the run engine computes, from the same function, so
 * a hand-added company suppresses a later discovery of itself and vice versa.
 * A `23505` maps to `{status:'exists'}` with the existing row, never to a 500.
 */
export async function addEntryByDomain(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    listId: string
    domain: string
    name?: string | null
    icpVersion?: number
  },
): Promise<AddEntryOutcome> {
  const raw = typeof args.domain === 'string' ? args.domain.trim() : ''
  if (!raw) return fail('INVALID_INPUT', 'domain is required')

  // companyCandidateKey normalizes AND rejects personal/webmail domains, which
  // is the same gate `suppressed_by='personal_domain'` records in a run. Split
  // the two failures so the UI can say WHY.
  const key = companyCandidateKey(raw)
  if (!key) {
    return normalizeDomain(raw)
      ? fail('PERSONAL_DOMAIN', 'That is a personal email domain, not a company')
      : fail('INVALID_DOMAIN', 'That does not look like a company domain')
  }

  const { data, error } = await supabase
    .from('prospect_list_entry')
    .insert({
      workspace_id: args.workspaceId,
      list_id: args.listId,
      kind: 'company',
      candidate_key: key,
      candidate: {
        domain: key,
        name: typeof args.name === 'string' && args.name.trim() ? args.name.trim() : null,
      },
      stage: 'discovered',
      identity_state: 'resolved',
      icp_version: args.icpVersion ?? 1,
      // No `discovered_by_run_id`: a hand-added entry belongs to no run, and
      // the column is nullable precisely so it can say so honestly.
      discovery_angle: 'manual',
    })
    .select(ENTRY_COLUMNS)
    .single()

  if (error) {
    if (error.code === '23505') {
      const { data: existing, error: readError } = await supabase
        .from('prospect_list_entry')
        .select(ENTRY_COLUMNS)
        .eq('workspace_id', args.workspaceId)
        .eq('list_id', args.listId)
        .eq('candidate_key', key)
        .maybeSingle()
      if (readError || !existing) {
        console.error('[prospecting] entry conflict re-read failed:', readError?.message)
        return fail('DB_ERROR', 'Failed to add entry')
      }
      return { ok: true, status: 'exists', entry: existing as unknown as ProspectListEntryRow }
    }
    console.error('[prospecting] entry insert failed:', error.message)
    return fail('DB_ERROR', 'Failed to add entry')
  }

  return { ok: true, status: 'created', entry: data as unknown as ProspectListEntryRow }
}

// ---------------------------------------------------------------------------
// updateEntryStage
// ---------------------------------------------------------------------------

/**
 * Move one entry between stages.
 *
 * Only `shortlisted` and `dismissed` are settable here. `saved` is set by
 * promotion and nothing else — it means "a CRM record exists", so letting a
 * PATCH claim it would make the stage lie. `discovered` is reachable as an
 * un-dismiss, which clears the dismissal triple.
 *
 * DISMISS NEVER TOUCHES THE CRM. The entry persists so it keeps suppressing,
 * and with reason `competitor` or `already_customer` it suppresses in every
 * list in the workspace (decision 3).
 */
/**
 * Change one entry's stage — Save (curation), Dismiss, or a restore.
 *
 * SAVE IS CURATION, NOT PROMOTION (Liam, 2026-09-06: "every list that you
 * create becomes a group of contacts… we shouldn't even have an add-to-CRM
 * button at the company level or at the person level"). `saved` means ON THE
 * LIST; the CRM row appears when the list is PUBLISHED (publish.ts). Two
 * cascades keep the list a coherent group:
 *
 *   - saving a company saves the people found beneath it — every one the
 *     user has not dismissed; they asked for them by finding them;
 *   - saving a person saves its company — a person with no account is not
 *     something the CRM can show, and Publish promotes the parent first.
 *
 * Save on a dismissed entry restores it: Save means "I want this".
 *
 * LEAVING `saved` LEAVES THE CRM GROUP. A published entry that is dismissed
 * (or restored to discovered) is taken out of the list's group on its CRM
 * row — `array_remove`, never a delete: interactions, sequences and other
 * lists may reference it — and its `published_at` is cleared so a later
 * re-save re-publishes it. A company takes its published people with it.
 */
export async function updateEntryStage(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    entryId: string
    userId: string
    stage: string
    dismissedReason?: unknown
  },
): Promise<Result<{ entry: ProspectListEntryRow }>> {
  const stage = args.stage as ProspectEntryStage
  if (!(PROSPECT_ENTRY_STAGES as readonly string[]).includes(stage)) {
    return fail('INVALID_INPUT', `Unsupported stage '${String(args.stage)}'`)
  }

  // Read first: the cascades and the CRM group both need to know what the
  // row IS before it changes. Workspace-scoped, so a foreign id is NOT_FOUND.
  const { data: current, error: loadError } = await supabase
    .from('prospect_list_entry')
    .select(ENTRY_COLUMNS)
    .eq('id', args.entryId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (loadError) {
    console.error('[prospecting] entry load failed:', loadError.message)
    return fail('DB_ERROR', 'Failed to load entry')
  }
  if (!current) return fail('NOT_FOUND', 'Entry not found')
  const entry = current as unknown as ProspectListEntryRow

  const patch: Record<string, unknown> = { stage }
  if (stage === 'dismissed') {
    const reason = args.dismissedReason
    if (!PROSPECT_DISMISSED_REASONS.includes(reason as ProspectDismissedReason)) {
      return fail('INVALID_INPUT', 'dismissed_reason is required and must be a known reason')
    }
    patch.dismissed_reason = reason
    patch.dismissed_by = args.userId
    patch.dismissed_at = new Date().toISOString()
  } else {
    // Un-dismissing (and saving) clears the whole triple: a stale
    // `dismissed_at` on a shortlisted row would show up in the
    // global-suppression read as a dismissal that no longer exists.
    patch.dismissed_reason = null
    patch.dismissed_by = null
    patch.dismissed_at = null
  }

  if (entry.stage === 'saved' && stage !== 'saved') {
    const left = await leaveCrmGroup(supabase, { workspaceId: args.workspaceId, entry })
    if (!left) return fail('DB_ERROR', 'Failed to update the CRM group')
    patch.published_at = null
  }

  const { data, error } = await supabase
    .from('prospect_list_entry')
    .update(patch)
    .eq('id', args.entryId)
    .eq('workspace_id', args.workspaceId)
    .select(ENTRY_COLUMNS)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] entry stage update failed:', error.message)
    return fail('DB_ERROR', 'Failed to update entry')
  }
  if (!data) return fail('NOT_FOUND', 'Entry not found')

  if (stage === 'saved') {
    const cascaded = await cascadeSave(supabase, { workspaceId: args.workspaceId, entry })
    if (!cascaded) return fail('DB_ERROR', 'Failed to save the related entries')
  }
  return { ok: true, entry: data as unknown as ProspectListEntryRow }
}

/** The Save cascades — see {@link updateEntryStage}. */
async function cascadeSave(
  supabase: SupabaseClient,
  args: { workspaceId: string; entry: ProspectListEntryRow },
): Promise<boolean> {
  const { entry } = args
  const keep = { stage: 'saved', dismissed_reason: null, dismissed_by: null, dismissed_at: null }
  if (entry.kind === 'company') {
    // The people beneath it that the user has not rejected. A dismissed
    // person stays dismissed — that was a decision, and this is not the
    // place to reverse it.
    const { error } = await supabase
      .from('prospect_list_entry')
      .update(keep)
      .eq('workspace_id', args.workspaceId)
      .eq('parent_entry_id', entry.id)
      .in('stage', ['discovered', 'shortlisted'])
    if (error) {
      console.error('[prospecting] save cascade (people) failed:', error.message)
      return false
    }
    return true
  }
  if (!entry.parent_entry_id) return true
  // The company comes along — back from dismissed if it has to: the user
  // wants this person, and the person needs the account.
  const { error } = await supabase
    .from('prospect_list_entry')
    .update(keep)
    .eq('id', entry.parent_entry_id)
    .eq('workspace_id', args.workspaceId)
    .neq('stage', 'saved')
  if (error) {
    console.error('[prospecting] save cascade (company) failed:', error.message)
    return false
  }
  return true
}

/**
 * Take a published entry out of the list's CRM group — see
 * {@link updateEntryStage}. A company takes its published people with it;
 * their `published_at` is cleared here so a re-save of the company can
 * re-publish them. Returns false only when a write failed.
 */
async function leaveCrmGroup(
  supabase: SupabaseClient,
  args: { workspaceId: string; entry: ProspectListEntryRow },
): Promise<boolean> {
  const { entry } = args
  const companyIds: string[] = []
  const contactIds: string[] = []
  const childEntryIds: string[] = []

  if (entry.published_at) {
    if (entry.kind === 'company' && entry.company_id) companyIds.push(entry.company_id)
    if (entry.kind === 'person' && entry.contact_id) contactIds.push(entry.contact_id)
  }
  if (entry.kind === 'company') {
    const { data: kids, error } = await supabase
      .from('prospect_list_entry')
      .select('id, contact_id')
      .eq('workspace_id', args.workspaceId)
      .eq('parent_entry_id', entry.id)
      .not('published_at', 'is', null)
    if (error) {
      console.error('[prospecting] published people read failed:', error.message)
      return false
    }
    for (const kid of (kids ?? []) as Array<{ id: string; contact_id: string | null }>) {
      childEntryIds.push(kid.id)
      if (kid.contact_id) contactIds.push(kid.contact_id)
    }
  }

  if (companyIds.length > 0 || contactIds.length > 0) {
    const { error } = await supabase.rpc('prospect_list_mark_unpublished', {
      p_workspace: args.workspaceId,
      p_list: entry.list_id,
      p_company_ids: companyIds,
      p_contact_ids: contactIds,
    })
    if (error) {
      console.error('[prospecting] CRM group unpublish failed:', error.message)
      return false
    }
  }
  if (childEntryIds.length > 0) {
    const { error } = await supabase
      .from('prospect_list_entry')
      .update({ published_at: null })
      .eq('workspace_id', args.workspaceId)
      .in('id', childEntryIds)
    if (error) {
      console.error('[prospecting] published people clear failed:', error.message)
      return false
    }
  }
  return true
}

/**
 * Save — keep these entries ON THE LIST (§8, redefined 2026-09-06). Runs the
 * per-entry stage change with its cascades, and reports PER-ENTRY OUTCOMES
 * in the same shape Publish does, so the page's one reconciliation loop
 * serves both. Nothing here touches the CRM; that is {@link publishEntries}.
 */
export async function saveEntriesToList(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string; entryIds: string[] },
): Promise<Result<PromoteResult>> {
  const entryIds = Array.from(new Set(args.entryIds.filter((id) => typeof id === 'string' && id)))
  const saved: PromotedEntry[] = []
  const skipped: SkippedEntry[] = []
  for (const entryId of entryIds) {
    const result = await updateEntryStage(supabase, {
      workspaceId: args.workspaceId,
      userId: args.userId,
      entryId,
      stage: 'saved',
    })
    if (!result.ok) {
      skipped.push(
        result.code === 'NOT_FOUND'
          ? { entry_id: entryId, list_id: '', reason: 'not_found' }
          : { entry_id: entryId, list_id: '', reason: 'error', message: result.error },
      )
      continue
    }
    const e = result.entry
    saved.push({
      entry_id: e.id,
      list_id: e.list_id,
      kind: e.kind,
      ...(e.company_id ? { company_id: e.company_id } : {}),
      ...(e.contact_id ? { contact_id: e.contact_id } : {}),
    })
  }
  return { ok: true, saved, skipped }
}

// ---------------------------------------------------------------------------
// promoteEntries — Save (§8)
// ---------------------------------------------------------------------------

/** One promoted entry and the CRM record it became. `email` is present on a
 *  person and is the field the Add-to-sequence caller filters on: enrollment
 *  needs an address, and `no_email` must be reported per row rather than
 *  swallowed in a toast. */
export interface PromotedEntry {
  entry_id: string
  /** The list the entry belongs to. Carried on every outcome so a caller that
   *  saved across two lists — Scout does, when the user selected from a chat
   *  rather than from one page — can say WHERE each row landed instead of
   *  reporting one undifferentiated total. */
  list_id: string
  kind: ProspectEntryKind
  company_id?: string
  contact_id?: string
  email?: string | null
}

/** Why an entry in the request did not become a CRM record. */
export interface SkippedEntry {
  entry_id: string
  /** The list the entry belongs to, or '' for an id that resolved to no row in
   *  this workspace (`not_found`): there is no list to name, and inventing one
   *  would be worse than the empty string a caller can test for. */
  list_id: string
  reason:
    | 'not_found'
    /** RESERVED, and deliberately never emitted: an already-saved entry comes
     *  back in `saved` with the record it already became, because Save is
     *  idempotent and Add-to-sequence over a re-selected list must still
     *  receive its contact ids. Do not "restore" this — doing so would hand the
     *  dialog a shorter list than the user selected. */
    | 'already_saved'
    | 'dismissed'
    /** A person whose identity gate came back `needs_review` (the Devin Marsh
     *  namesake class). Bulk save refuses them; a per-row confirm passes
     *  `include_unverified` for that single id. */
    | 'needs_review'
    | 'no_domain'
    /** A person with neither a usable email nor a LinkedIn URL nor a name —
     *  nothing we could ever dedupe on. */
    | 'no_identity'
    /** The person's PARENT company could not be promoted, so the person was
     *  not either: a saved person implies a saved account. */
    | 'parent_failed'
    | 'error'
  message?: string
}

export interface PromoteResult {
  saved: PromotedEntry[]
  skipped: SkippedEntry[]
}

/** The parent company entry a person hangs off, loaded on demand. */
interface ParentResolution {
  companyId: string | null
  reason: SkippedEntry['reason'] | null
  message?: string
}

/**
 * Save is promotion, and it is the ONLY thing that writes to the CRM (§8).
 *
 * Returns PER-ENTRY OUTCOMES, not a count: Add-to-sequence needs contact ids
 * that only exist after Save, and a route that silently returned fewer ids
 * than the user selected would open the dialog with a shorter list and nobody
 * would notice. The UI reconciles its selection against `saved` + `skipped`.
 *
 * The company path:
 *   1. `ensureCompanyForDomain` — the same find-or-create the onboarding route
 *      uses, so the `UNIQUE (workspace_id, domain)` handling has exactly one
 *      implementation. This is promotion-time dedup, the second layer that
 *      costs nothing (§6): the exclusion set keeps the LIST clean, these
 *      functions keep the CRM clean.
 *   2. The entry's `research` blob merges into the company with the existing
 *      discipline and nothing new — `columnCandidates` for the high/medium
 *      gate, `computeFillEmptyPatch` so a populated column is never
 *      overwritten, `mergeBlobFields` so a CRM-verified fact can never be
 *      displaced by a lower-confidence prospecting guess.
 *   3. `metadata.prospecting = {list_id, run_id, first_seen_at}` is stamped,
 *      and is NOT overwritten on a second promotion — first_seen_at means the
 *      first time, which is the only thing it could usefully mean.
 *
 * The person path (`promote.ts`):
 *   0. THE PARENT COMPANY IS PROMOTED FIRST when it is not saved yet, even if
 *      the user did not select it. A saved person implies a saved account —
 *      the alternative is a contact hanging off a company that exists only as
 *      a list entry, which the CRM has no way to render. A parent that cannot
 *      be promoted skips the person with `parent_failed` rather than creating
 *      a company-less contact.
 *   1. With an email → `findOrCreateContact` (secondary-email OR-filter,
 *      merge-tombstone exclusion, noise filter — all inherited).
 *      Without one → `createProspectContact`, which dedupes on the normalized
 *      LinkedIn URL by query.
 *   2. The research blob merges into `contact.metadata.enrichment` exactly as
 *      the company path merges into the company's.
 *   3. `metadata.prospecting = {list_id, entry_id, first_seen_at}`.
 *
 * `identity_state='needs_review'` people are skipped unless `includeUnverified`
 * is set — the UI passes it for ONE id at a time, from a per-row confirm.
 */
export async function promoteEntries(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    userId: string
    entryIds: string[]
    /** Per-row override for `needs_review` people. Never a bulk default. */
    includeUnverified?: boolean
  },
): Promise<Result<PromoteResult>> {
  const entryIds = Array.from(new Set(args.entryIds.filter((id) => typeof id === 'string' && id)))
  if (entryIds.length === 0) return { ok: true, saved: [], skipped: [] }

  const { data, error } = await supabase
    .from('prospect_list_entry')
    .select(ENTRY_COLUMNS)
    .eq('workspace_id', args.workspaceId)
    .in('id', entryIds)
  if (error) {
    console.error('[prospecting] promote load failed:', error.message)
    return fail('DB_ERROR', 'Failed to load entries')
  }

  const rows = (data ?? []) as unknown as ProspectListEntryRow[]
  const byId = new Map(rows.map((r) => [r.id, r]))

  const saved: PromotedEntry[] = []
  const skipped: SkippedEntry[] = []

  // Per-call caches. A batch of 40 people at 8 companies must promote each
  // company ONCE — `ensureCompanyForDomain` is idempotent, but the research
  // merge and the stamp are writes, and repeating them per person is both
  // wasteful and a way to lose a race with ourselves.
  const promotedCompanyByEntry = new Map<string, string | null>()
  const purposeByList = new Map<string, ProspectListPurpose>()

  // Resolved ONCE per call, not per person. Contacts created here need an
  // owner: 058 defaults `contact.visibility` to 'private' and gates SELECT on
  // `can_view_contact`, so a row with a NULL `created_by_member_id` is
  // invisible to every non-admin member — including the one who saved it.
  const createdByMemberId = await resolveMemberId(supabase, {
    workspaceId: args.workspaceId,
    userId: args.userId,
  })

  // COMPANIES FIRST, regardless of the order the caller sent. A person's
  // parent may be in the same batch, and promoting it as a parent lookup and
  // then again as a selected entry would double-write. Sorting here means the
  // parent is already in `promotedCompanyByEntry` by the time the person runs.
  const ordered = [...entryIds].sort((a, b) => {
    const ka = byId.get(a)?.kind === 'person' ? 1 : 0
    const kb = byId.get(b)?.kind === 'person' ? 1 : 0
    return ka - kb
  })

  for (const entryId of ordered) {
    const entry = byId.get(entryId)
    // A cross-workspace id simply is not found — the read was workspace-scoped
    // and never leaks whether the row exists elsewhere.
    if (!entry) {
      skipped.push({ entry_id: entryId, list_id: '', reason: 'not_found' })
      continue
    }
    if (entry.stage === 'dismissed') {
      // Record the refusal in the cache too. A person later in this batch may
      // hang off this very entry, and parent-first must see "not promotable"
      // rather than fall through to a fresh DB read and resurrect it.
      if (entry.kind === 'company') promotedCompanyByEntry.set(entryId, null)
      skipped.push({ entry_id: entryId, list_id: entry.list_id, reason: 'dismissed' })
      continue
    }

    if (entry.kind === 'person') {
      const outcome = await promotePersonEntry(supabase, {
        workspaceId: args.workspaceId,
        entry,
        includeUnverified: args.includeUnverified === true,
        promotedCompanyByEntry,
        purposeByList,
        createdByMemberId,
      })
      if (outcome.ok) saved.push(outcome.promoted)
      else skipped.push(outcome.skipped)
      continue
    }

    const outcome = await promoteCompanyEntry(supabase, {
      workspaceId: args.workspaceId,
      entry,
      promotedCompanyByEntry,
    })
    if (outcome.ok) saved.push(outcome.promoted)
    else skipped.push(outcome.skipped)
  }

  return { ok: true, saved, skipped }
}

/** Outcome of one entry's promotion — the shape both per-kind helpers speak. */
type EntryOutcome =
  | { ok: true; promoted: PromotedEntry }
  | { ok: false; skipped: SkippedEntry }

/**
 * Promote one COMPANY entry, memoising the resulting company id against the
 * entry so a person whose parent is in the same batch reuses it.
 */
async function promoteCompanyEntry(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    entry: ProspectListEntryRow
    promotedCompanyByEntry: Map<string, string | null>
  },
): Promise<EntryOutcome> {
  const { entry } = args
  const entryId = entry.id

  if (entry.company_id && entry.stage === 'saved') {
    // Idempotent: re-saving an already-saved entry reports the record it
    // already became, so the dialog still gets its id.
    args.promotedCompanyByEntry.set(entryId, entry.company_id)
    return {
      ok: true,
      promoted: {
        entry_id: entryId,
        list_id: entry.list_id,
        kind: 'company',
        company_id: entry.company_id,
      },
    }
  }

  const candidate = readCandidate(entry.candidate)
  const domain = companyCandidateKey(candidate.domain ?? entry.candidate_key)
  if (!domain) {
    args.promotedCompanyByEntry.set(entryId, null)
    return { ok: false, skipped: { entry_id: entryId, list_id: entry.list_id, reason: 'no_domain' } }
  }

  const companyId = await ensureCompanyForDomain(
    supabase as unknown as Parameters<typeof ensureCompanyForDomain>[0],
    { workspaceId: args.workspaceId, domain, name: candidate.name ?? null },
  )
  if (!companyId) {
    args.promotedCompanyByEntry.set(entryId, null)
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: 'error',
        message: 'Failed to create the company',
      },
    }
  }

  const merged = await mergeResearchIntoCompany(supabase, {
    workspaceId: args.workspaceId,
    companyId,
    research: entry.research,
    sources: entry.sources,
    listId: entry.list_id,
    runId: entry.discovered_by_run_id,
  })
  if (!merged) {
    args.promotedCompanyByEntry.set(entryId, null)
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: 'error',
        message: 'Failed to write the company',
      },
    }
  }

  const { error: stageError } = await supabase
    .from('prospect_list_entry')
    .update({ company_id: companyId, stage: 'saved' })
    .eq('id', entryId)
    .eq('workspace_id', args.workspaceId)
  if (stageError) {
    console.error('[prospecting] entry save write failed:', stageError.message)
    args.promotedCompanyByEntry.set(entryId, null)
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: 'error',
        message: 'Failed to update the entry',
      },
    }
  }

  args.promotedCompanyByEntry.set(entryId, companyId)
  return {
    ok: true,
    promoted: { entry_id: entryId, list_id: entry.list_id, kind: 'company', company_id: companyId },
  }
}

/**
 * Promote one PERSON entry: parent first, then the contact, then the blob.
 */
async function promotePersonEntry(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    entry: ProspectListEntryRow
    includeUnverified: boolean
    promotedCompanyByEntry: Map<string, string | null>
    purposeByList: Map<string, ProspectListPurpose>
    createdByMemberId: string | null
  },
): Promise<EntryOutcome> {
  const { entry } = args
  const entryId = entry.id

  if (entry.contact_id && entry.stage === 'saved') {
    // The address comes from the CRM ROW, never from the pre-save candidate
    // blob. `email` on this response is what Add-to-sequence filters on, and
    // the record is the authority: a contact matched by `findOrCreateContact`
    // may hold an address the discovered candidate never carried, and a
    // candidate may carry one the CRM row does not. Guessing from the blob
    // hands the dialog a contact whose `contact.email` is NULL, which it
    // swallows as `no_email` — exactly the report §8 forbids burying.
    const { data, error } = await supabase
      .from('contact')
      .select('id, email')
      .eq('id', entry.contact_id)
      .eq('workspace_id', args.workspaceId)
      .maybeSingle()
    if (error) {
      console.error('[prospecting] saved contact email read failed:', error.message)
      return {
        ok: false,
        skipped: {
          entry_id: entryId,
          list_id: entry.list_id,
          reason: 'error',
          message: 'Failed to read the contact',
        },
      }
    }
    // The contact was deleted out from under the entry. Reporting the stale
    // `contact_id` would send a dead id to enrollment.
    if (!data)
      return { ok: false, skipped: { entry_id: entryId, list_id: entry.list_id, reason: 'not_found' } }
    const email = (data as { email?: unknown }).email
    return {
      ok: true,
      promoted: {
        entry_id: entryId,
        list_id: entry.list_id,
        kind: 'person',
        contact_id: entry.contact_id,
        email: typeof email === 'string' && email.trim() ? email : null,
      },
    }
  }

  // The identity gate. `needs_review` is the namesake class — a person whose
  // fields did not survive anchoring against the account domain — and bulk
  // save refuses them by design. The UI's per-row confirm re-sends that one id
  // with `include_unverified`.
  if (entry.identity_state === 'needs_review' && !args.includeUnverified) {
    return {
      ok: false,
      skipped: { entry_id: entryId, list_id: entry.list_id, reason: 'needs_review' },
    }
  }

  // ── the parent account, promoted first ─────────────────────────────
  const parent = await resolveParentCompany(supabase, {
    workspaceId: args.workspaceId,
    entry,
    promotedCompanyByEntry: args.promotedCompanyByEntry,
  })
  if (parent.reason) {
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: parent.reason,
        message: parent.message,
      },
    }
  }

  // ── the contact ────────────────────────────────────────────────────
  const purpose = await resolveListPurpose(supabase, {
    workspaceId: args.workspaceId,
    listId: entry.list_id,
    cache: args.purposeByList,
  })
  const candidate = readPersonCandidate(entry.candidate)
  const promoted = await promotePerson(supabase, {
    workspaceId: args.workspaceId,
    candidate,
    companyId: parent.companyId,
    purpose,
    createdByMemberId: args.createdByMemberId,
  })
  if (!promoted.ok) {
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: promoted.reason === 'no_identity' ? 'no_identity' : 'error',
        message: promoted.message,
      },
    }
  }

  const merged = await mergeResearchIntoContact(supabase, {
    workspaceId: args.workspaceId,
    contactId: promoted.contactId,
    research: entry.research,
    sources: entry.sources,
    listId: entry.list_id,
    entryId,
  })
  if (!merged) {
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: 'error',
        message: 'Failed to write the contact',
      },
    }
  }

  // NEVER `company_id` on a person entry: 248's `prospect_entry_kind_target`
  // CHECK is `person ⇒ company_id IS NULL`. The account is reached through
  // `parent_entry_id`, and the CONTACT carries the company pointer.
  const { error: stageError } = await supabase
    .from('prospect_list_entry')
    .update({ contact_id: promoted.contactId, stage: 'saved' })
    .eq('id', entryId)
    .eq('workspace_id', args.workspaceId)
  if (stageError) {
    console.error('[prospecting] person entry save write failed:', stageError.message)
    return {
      ok: false,
      skipped: {
        entry_id: entryId,
        list_id: entry.list_id,
        reason: 'error',
        message: 'Failed to update the entry',
      },
    }
  }

  return {
    ok: true,
    promoted: {
      entry_id: entryId,
      list_id: entry.list_id,
      kind: 'person',
      contact_id: promoted.contactId,
      email: promoted.email,
    },
  }
}

/**
 * The company a promoted person belongs to, promoting the parent entry first
 * when it is not saved yet.
 *
 * A person with NO parent entry is not an error: hand-added people and
 * orphaned rows exist, and a contact with a null `company_id` is a perfectly
 * good CRM record. Only a parent that EXISTS and FAILS to promote produces
 * `parent_failed` — silently saving the person under no company would leave
 * the user with a contact whose account is invisible to the CRM.
 */
async function resolveParentCompany(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    entry: ProspectListEntryRow
    promotedCompanyByEntry: Map<string, string | null>
  },
): Promise<ParentResolution> {
  const parentId = args.entry.parent_entry_id
  if (!parentId) return { companyId: null, reason: null }

  // Already promoted in this batch (as a selected entry or as another
  // person's parent) — one promotion per company per call.
  if (args.promotedCompanyByEntry.has(parentId)) {
    const cached = args.promotedCompanyByEntry.get(parentId) ?? null
    if (cached) return { companyId: cached, reason: null }
    return {
      companyId: null,
      reason: 'parent_failed',
      message: 'The parent company could not be saved',
    }
  }

  const { data, error } = await supabase
    .from('prospect_list_entry')
    .select(ENTRY_COLUMNS)
    .eq('id', parentId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] parent entry load failed:', error.message)
    return { companyId: null, reason: 'error', message: 'Failed to load the parent company' }
  }
  // A parent that no longer exists (deleted, or in another workspace) is the
  // same as no parent: the person is still a real person.
  if (!data) {
    args.promotedCompanyByEntry.set(parentId, null)
    return { companyId: null, reason: null }
  }

  const parentEntry = data as unknown as ProspectListEntryRow
  if (parentEntry.company_id && parentEntry.stage === 'saved') {
    args.promotedCompanyByEntry.set(parentId, parentEntry.company_id)
    return { companyId: parentEntry.company_id, reason: null }
  }

  // A DISMISSED parent is never promoted, even implicitly. Dismissal never
  // touches the CRM (§8), and parent-first must not become the one path that
  // resurrects a company the user rejected — saving the person under it would
  // put a rejected account back in the CRM without anyone asking.
  if (parentEntry.stage === 'dismissed') {
    args.promotedCompanyByEntry.set(parentId, null)
    return {
      companyId: null,
      reason: 'parent_failed',
      message: 'The parent company was dismissed',
    }
  }

  const outcome = await promoteCompanyEntry(supabase, {
    workspaceId: args.workspaceId,
    entry: parentEntry,
    promotedCompanyByEntry: args.promotedCompanyByEntry,
  })
  if (!outcome.ok) {
    return {
      companyId: null,
      reason: 'parent_failed',
      message: outcome.skipped.message ?? 'The parent company could not be saved',
    }
  }
  return { companyId: outcome.promoted.company_id ?? null, reason: null }
}

/** The list's purpose, which decides the promoted contact's
 *  `relationship_type` (decision 2). Cached per call — a batch of 40 people is
 *  one list read, not forty. An unreadable list degrades to 'custom', whose
 *  relationship_type is the neutral 'contact'. */
async function resolveListPurpose(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string; cache: Map<string, ProspectListPurpose> },
): Promise<ProspectListPurpose> {
  const cached = args.cache.get(args.listId)
  if (cached) return cached
  const { data, error } = await supabase
    .from('prospect_list')
    .select('purpose')
    .eq('id', args.listId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error) console.error('[prospecting] list purpose read failed:', error.message)
  const raw = (data as { purpose?: unknown } | null)?.purpose
  const purpose = PROSPECT_LIST_PURPOSES.includes(raw as ProspectListPurpose)
    ? (raw as ProspectListPurpose)
    : 'custom'
  args.cache.set(args.listId, purpose)
  return purpose
}

/**
 * The saving user's `member.id`, for `contact.created_by_member_id`.
 *
 * Resolved once per `promoteEntries` call and threaded down, rather than read
 * per person: a batch of 40 people would otherwise issue 40 identical reads.
 *
 * A miss returns null rather than failing the save — the service-role lane
 * (the run engine) has no member at all, and a contact with no creator is
 * still correct there because `visibility: 'workspace'` carries the read.
 */
async function resolveMemberId(
  supabase: SupabaseClient,
  args: { workspaceId: string; userId: string },
): Promise<string | null> {
  if (!args.userId) return null
  const { data, error } = await supabase
    .from('member')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('user_id', args.userId)
    .maybeSingle()
  if (error) {
    console.error('[prospecting] member resolve failed:', error.message)
    return null
  }
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/** The person half of the candidate blob, read tolerantly. */
function readPersonCandidate(raw: unknown): ProspectCandidate {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const rec = raw as Record<string, unknown>
  const str = (k: string) => (typeof rec[k] === 'string' ? (rec[k] as string) : null)
  return {
    name: str('name'),
    email: str('email'),
    title: str('title'),
    linkedin_url: str('linkedin_url'),
    domain: str('domain'),
    company_name: str('company_name'),
  }
}

/** The candidate blob, read tolerantly (it is `unknown` on the row type by
 *  design — consumers parse rather than cast blind). */
function readCandidate(raw: unknown): { domain?: string | null; name?: string | null } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const rec = raw as Record<string, unknown>
  return {
    domain: typeof rec.domain === 'string' ? rec.domain : null,
    name: typeof rec.name === 'string' ? rec.name : null,
  }
}

/** The `research` blob has the SAME shape as `metadata.enrichment.fields`,
 *  which is what lets promotion reuse the whole write-back discipline. */
function readResearchFields(raw: unknown): Record<string, { value?: unknown; confidence?: unknown }> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, { value?: unknown; confidence?: unknown }> = {}
  for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    out[key] = entry as { value?: unknown; confidence?: unknown }
  }
  return out
}

/** The company columns the research blob can fill. Deliberately the same set
 *  `enrichCompany` writes, minus `name` (which promotion gets from
 *  `ensureCompanyForDomain` and must not fight over). */
const PROMOTABLE_COLUMNS = {
  website: 'website',
  industry: 'industry',
  description: 'description',
  employee_count: 'employee_count_range',
  annual_revenue: 'annual_revenue_range',
  headquarters_city: 'city',
  headquarters_state: 'state',
  headquarters_country: 'country',
} as const

/**
 * Fold an entry's pre-save research into the promoted company row.
 *
 * Columns go through `columnCandidates` (the high/medium gate) then
 * `computeFillEmptyPatch` (a populated column is never overwritten), and the
 * blob goes through `mergeBlobFields` (confidence-ranked, so a CRM-verified
 * fact cannot be displaced). Nothing new — this is the existing discipline
 * applied to a new source of fields.
 *
 * Returns false only on a write failure; an entry with no research at all
 * still succeeds, because the stamp is worth writing on its own.
 */
async function mergeResearchIntoCompany(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    companyId: string
    research: unknown
    sources: unknown
    listId: string
    runId: string | null
  },
): Promise<boolean> {
  const { data: row, error } = await supabase
    .from('company')
    .select(
      'id, website, industry, description, employee_count_range, annual_revenue_range, ' +
        'city, state, country, metadata',
    )
    .eq('id', args.companyId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  if (error || !row) {
    console.error('[prospecting] promote company load failed:', error?.message)
    return false
  }
  const company = row as unknown as Record<string, unknown>

  const research = readResearchFields(args.research)
  const now = new Date().toISOString()

  // ── columns ────────────────────────────────────────────────────────
  const gated = columnCandidates(
    Object.fromEntries(
      Object.entries(PROMOTABLE_COLUMNS).map(([field, column]) => [
        column,
        research[field] as never,
      ]),
    ),
  )
  const local: Record<string, unknown> = {}
  for (const column of Object.values(PROMOTABLE_COLUMNS)) local[column] = company[column]
  const patch = computeFillEmptyPatch(local, gated)

  // ── blob ───────────────────────────────────────────────────────────
  const baseMetadata =
    company.metadata && typeof company.metadata === 'object' && !Array.isArray(company.metadata)
      ? { ...(company.metadata as Record<string, unknown>) }
      : {}
  const baseEnrichment =
    baseMetadata.enrichment && typeof baseMetadata.enrichment === 'object' && !Array.isArray(baseMetadata.enrichment)
      ? { ...(baseMetadata.enrichment as Record<string, unknown>) }
      : {}
  const previousFields =
    baseEnrichment.fields && typeof baseEnrichment.fields === 'object' && !Array.isArray(baseEnrichment.fields)
      ? (baseEnrichment.fields as Record<string, Record<string, unknown>>)
      : {}

  if (Object.keys(research).length > 0) {
    baseEnrichment.fields = mergeBlobFields(previousFields, research as Record<string, unknown>, now)
    if (Array.isArray(args.sources)) {
      const seen = new Set<string>()
      const merged: unknown[] = []
      const previousSources = Array.isArray(baseEnrichment.sources) ? baseEnrichment.sources : []
      for (const s of [...args.sources, ...previousSources]) {
        const url = (s as { url?: unknown } | null)?.url
        if (typeof url !== 'string' || seen.has(url)) continue
        seen.add(url)
        merged.push(s)
        if (merged.length >= 40) break
      }
      baseEnrichment.sources = merged
    }
    baseMetadata.enrichment = baseEnrichment
  }

  // ── the prospecting stamp ──────────────────────────────────────────
  // `first_seen_at` means the FIRST time, so an existing stamp is left alone;
  // only the list/run of the first promotion is recorded.
  const existingStamp =
    baseMetadata.prospecting && typeof baseMetadata.prospecting === 'object' && !Array.isArray(baseMetadata.prospecting)
      ? (baseMetadata.prospecting as Record<string, unknown>)
      : null
  if (!existingStamp) {
    baseMetadata.prospecting = {
      list_id: args.listId,
      run_id: args.runId,
      first_seen_at: now,
    }
  }

  const { error: writeError } = await supabase
    .from('company')
    .update({ ...patch, metadata: baseMetadata, updated_at: now })
    .eq('id', args.companyId)
    .eq('workspace_id', args.workspaceId)
  if (writeError) {
    console.error('[prospecting] promote company write failed:', writeError.message)
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// exclusionCounts — the sheet's live toggle counts (§9)
// ---------------------------------------------------------------------------

/**
 * What each exclusion toggle would actually hide, right now.
 *
 * Deliberately three COUNTS, not the exclusion set itself: the sheet renders
 * "excluding 412 companies you already know" beside a switch, and building the
 * full `Map<candidate_key, …>` for a tooltip would read every email and
 * LinkedIn URL in the workspace on every keystroke. The authoritative set is
 * `buildExclusionSet` (PR 2), recomputed inside the run.
 *
 * `listId` is optional: on the New-list sheet there is no list yet, and
 * `other_lists` then means "every active list".
 */
export interface ExclusionCounts {
  crm_companies: number
  other_lists: number
  contacted_people: number
}

export async function exclusionCounts(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId?: string | null },
): Promise<Result<{ counts: ExclusionCounts }>> {
  const counts: ExclusionCounts = { crm_companies: 0, other_lists: 0, contacted_people: 0 }

  // CRM: companies with a domain. A domain-less company cannot suppress
  // anything — the exclusion set is keyed on the normalized domain — so
  // counting it would overstate what the toggle does.
  const { count: crmCount, error: crmError } = await supabase
    .from('company')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', args.workspaceId)
    .not('domain', 'is', null)
  if (crmError) {
    console.error('[prospecting] crm exclusion count failed:', crmError.message)
    return fail('DB_ERROR', 'Failed to count exclusions')
  }
  counts.crm_companies = crmCount ?? 0

  // Other lists: entries at ANY stage in every OTHER active list. Dismissed
  // entries count — a dismissal is data, not a deletion, and it suppresses.
  const { data: activeLists, error: listError } = await supabase
    .from('prospect_list')
    .select('id')
    .eq('workspace_id', args.workspaceId)
    .eq('status', 'active')
  if (listError) {
    console.error('[prospecting] active list read failed:', listError.message)
    return fail('DB_ERROR', 'Failed to count exclusions')
  }
  const otherListIds = ((activeLists ?? []) as Array<{ id: string }>)
    .map((l) => l.id)
    .filter((id) => id !== args.listId)
  if (otherListIds.length > 0) {
    const { count: otherCount, error: otherError } = await supabase
      .from('prospect_list_entry')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', args.workspaceId)
      .in('list_id', otherListIds)
    if (otherError) {
      console.error('[prospecting] other-list exclusion count failed:', otherError.message)
      return fail('DB_ERROR', 'Failed to count exclusions')
    }
    counts.other_lists = otherCount ?? 0
  }

  // Contacted: sequence enrollments, read DIRECTLY rather than shadowed in a
  // column of our own (§6). This is the 'ever' tally; the 'active' tri-state
  // narrows it inside the run, where the list's own setting is known.
  //
  // DISTINCT PEOPLE, not enrollment rows: a contact enrolled in three
  // sequences is one person the toggle would hide, and counting rows would
  // tell the user it hides three. The de-dup is on the same two keys the
  // exclusion set uses (contact_id, else the lowered email), so the number
  // beside the switch means the same thing the switch does.
  //
  // Paged: PostgREST truncates an unpaged read at 1000 rows silently.
  let enrollments: Array<{ contact_id: string | null; contact_email: string | null }>
  try {
    enrollments = await readAll<{ contact_id: string | null; contact_email: string | null }>('contacted enrollments', (from, to) =>
      supabase
        .from('sequence_enrollment')
        .select('contact_id, contact_email')
        .eq('workspace_id', args.workspaceId)
        .order('id')
        .range(from, to),
    )
  } catch (err) {
    console.error('[prospecting] contacted exclusion count failed:', err)
    return fail('DB_ERROR', 'Failed to count exclusions')
  }
  const people = new Set<string>()
  for (const row of enrollments) {
    const key = row.contact_id ?? (row.contact_email ?? '').trim().toLowerCase()
    if (key) people.add(key)
  }
  counts.contacted_people = people.size

  return { ok: true, counts }
}

// ---------------------------------------------------------------------------
// listSequencedByList — the "Sequenced" chip, DERIVED (§8)
// ---------------------------------------------------------------------------

/** One saved contact's sequence state, as the list detail renders it. */
export interface SequencedState {
  status: 'active' | 'exited'
  sequence_id: string
  sequence_name: string
}

/** Contact ids per `.in()` read in listSequencedByList (URL-length bound). */
const SEQUENCED_CONTACT_CHUNK = 100

/**
 * The sequence state of every SAVED contact on a list, keyed by `contact_id`.
 *
 * DERIVED AT READ TIME, deliberately: there is no `stage='contacted'` and no
 * column on the entry. The moment someone enrolls a contact from the CRM
 * instead of from Prospecting, a shadowed column would be wrong and nothing
 * would notice; this read cannot be wrong, because `sequence_enrollment` is
 * the only thing that decides.
 *
 * A contact in more than one sequence resolves to the ACTIVE one — that is the
 * state the chip is about. Among several active (possible: the workspace-wide
 * unique is per contact AND per email, and an email-keyed enrollment can be a
 * different row), the first wins; the chip names one sequence, not a set.
 */
export async function listSequencedByList(
  supabase: SupabaseClient,
  args: { workspaceId: string; listId: string },
): Promise<Result<{ sequenced: Record<string, SequencedState> }>> {
  const { data: entries, error: entriesError } = await supabase
    .from('prospect_list_entry')
    .select('contact_id')
    .eq('workspace_id', args.workspaceId)
    .eq('list_id', args.listId)
    .not('contact_id', 'is', null)
  if (entriesError) {
    console.error('[prospecting] sequenced entries read failed:', entriesError.message)
    return fail('DB_ERROR', 'Failed to read saved contacts')
  }

  const contactIds = Array.from(
    new Set(
      ((entries ?? []) as Array<{ contact_id: string | null }>)
        .map((r) => r.contact_id)
        .filter((id): id is string => typeof id === 'string' && id !== ''),
    ),
  )
  if (contactIds.length === 0) return { ok: true, sequenced: {} }

  // The join is a nested select rather than two round trips — one read, and
  // the sequence name comes back with the row that needs it. Chunked so a big
  // list's ids never make one oversized GET URL (the active-wins rule below
  // runs across all chunks).
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < contactIds.length; i += SEQUENCED_CONTACT_CHUNK) {
    const { data, error } = await supabase
      .from('sequence_enrollment')
      .select('contact_id, status, sequence_id, sequence:sequence_id(id, name)')
      .eq('workspace_id', args.workspaceId)
      .in('contact_id', contactIds.slice(i, i + SEQUENCED_CONTACT_CHUNK))
    if (error) {
      console.error('[prospecting] sequenced enrollment read failed:', error.message)
      return fail('DB_ERROR', 'Failed to read sequence state')
    }
    rows.push(...((data ?? []) as Array<Record<string, unknown>>))
  }

  const sequenced: Record<string, SequencedState> = {}
  for (const raw of rows) {
    const contactId = typeof raw.contact_id === 'string' ? raw.contact_id : null
    if (!contactId) continue
    const status = raw.status === 'active' ? 'active' : 'exited'
    // An ACTIVE enrollment always wins over an exited one already recorded:
    // "in a sequence" is the state the chip exists to show.
    const existing = sequenced[contactId]
    if (existing && (existing.status === 'active' || status === 'exited')) continue
    // PostgREST returns an embedded to-one either as an object or, on some
    // relationship shapes, as a one-element array. Read both.
    const embedded = Array.isArray(raw.sequence) ? raw.sequence[0] : raw.sequence
    const seq = (embedded ?? null) as { id?: unknown; name?: unknown } | null
    const sequenceId =
      typeof raw.sequence_id === 'string'
        ? raw.sequence_id
        : typeof seq?.id === 'string'
          ? seq.id
          : ''
    if (!sequenceId) continue
    sequenced[contactId] = {
      status,
      sequence_id: sequenceId,
      sequence_name: typeof seq?.name === 'string' ? seq.name : 'Sequence',
    }
  }

  return { ok: true, sequenced }
}

export type { Icp }
