/**
 * The server half of a card: `show` checks the spec and runs it once, so the
 * agent's words match what the card shows ("12 actions, 3 overdue"), and
 * `read_card` re-runs a card's current spec.
 *
 * Both go through the views query engine (src/lib/views/query-engine.ts), on
 * the same path POST /api/account/views/query takes for the page itself:
 * buildEntityQuery → applyFilters (a filter that provably matches nothing is
 * an empty page, not an error) → applyEntityDefaults → applySearch →
 * applyCompletedFilter → applyOrdering → one page. A card is always the active
 * workspace's (the "show all workspaces" switch is the page's, not the agent's).
 *
 * ── Visibility ──────────────────────────────────────────────────────────────
 * The chat's tool route runs on a SERVICE-ROLE client, where RLS does not
 * apply. Every read here goes through the visibility fence
 * (src/lib/views/visibility-fence.ts): the list query itself (so the count is
 * right), the record a record card opens, and the names a filter is resolved
 * from, refusals included. A card never shows, counts or names what the
 * person's own page would hide.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyCompletedFilter,
  applyEntityDefaults,
  applyFilters,
  applyOrdering,
  customFieldTypesFor,
  viewFieldsOf,
  applyPagination,
  applySearch,
  buildEntityQuery,
  NoMatchSignal,
} from '@/lib/views/query-engine'
import { FILTERABLE_FIELDS, defaultOrdering, type ViewFilter } from '@/lib/views/types'
import {
  actionVisible,
  applyVisibilityFence,
  companyNeedsFenceEmbed,
  COMPANY_FENCE_SELECT,
  documentVisible,
  redactHiddenTeams,
  resolveVisibilityFence,
  stripFenceEmbed,
  visibleCompanyIds,
  visibleContactIds,
  type VisibilityFence,
} from '@/lib/views/visibility-fence'
import {
  CARD_SEARCHABLE_ENTITIES,
  type CalendarCardSpec,
  type MailCardSpec,
  type CardFilter,
  type CardListEntity,
  type CardQuery,
  type CardRecordType,
  type ListCardSpec,
  type RecordCardSpec,
} from './kinds'
import { isIdField, isUuid, type Checked } from './validate'
import { rowLabel, type RowLabel } from './rows'
import { showCalendar, type CalendarItem } from './server-calendar'
import { showMail, type MailItem } from './server-mail'

export interface CardScope {
  supabase: SupabaseClient
  workspaceId: string
  userId: string
  /** The browser's IANA zone this turn, checked (calendar cards count its local days). */
  timeZone?: string | null
  /** The person's visibility fence, read once per scope (fenceOf). */
  fence?: Promise<VisibilityFence>
  /** false on a guest's or a linked agent's turn: a table shared with the person by a grant doesn't show (519). */
  grants?: boolean
}

/**
 * The scope's visibility fence, read on first use and kept for the scope's
 * life. Every card read below takes the fence as a REQUIRED argument, so none
 * can run unfenced: a caller gets one here first.
 */
export function fenceOf(scope: CardScope): Promise<VisibilityFence> {
  if (!scope.fence) scope.fence = resolveVisibilityFence(scope.supabase, scope.workspaceId, scope.userId)
  return scope.fence
}

// ── Names → ids ───────────────────────────────────────────────────────────────

/**
 * Where a name for each id-typed field is looked up: table and name column.
 * `listable`: a refusal may name a few that exist (nothing private there);
 * contacts, companies and actions are fenced per person, so a refusal never
 * lists them.
 */
const NAME_LOOKUP: Record<string, { table: string; column: string; noun: string; listable: boolean }> = {
  member: { table: 'member', column: 'display_name', noun: 'teammate', listable: true },
  project: { table: 'projects', column: 'name', noun: 'project', listable: true },
  team: { table: 'team', column: 'name', noun: 'team', listable: true },
  label: { table: 'label', column: 'name', noun: 'label', listable: true },
  initiative: { table: 'initiative', column: 'name', noun: 'initiative', listable: true },
  contact: { table: 'contact', column: 'full_name', noun: 'contact', listable: false },
  company: { table: 'company', column: 'name', noun: 'company', listable: false },
  action: { table: 'actions', column: 'identifier', noun: 'action identifier', listable: false },
}

/** What to call for the id when a name cannot be looked up here. */
const ID_SOURCE: Record<string, string> = {
  cycle: 'list_cycles',
  milestone: 'list_milestones',
  capture: 'list_recent_captures or find',
}

/** How many rows a name may match before it counts as too vague. */
const NAME_CANDIDATES = 20

/** Escape ILIKE's wildcards, so a name matches as written. */
function likeLiteral(name: string): string {
  return name.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** The candidate rows of one kind the person can see, matched by name in the query. */
async function nameCandidates(
  scope: CardScope,
  fence: VisibilityFence,
  fieldType: string,
  name: string,
  idColumn: 'id' | 'user_id',
): Promise<Array<{ id: string; name: string }>> {
  const lookup = NAME_LOOKUP[fieldType]
  if (!fence.memberId) return []
  // A fenced company carries the contacts it is fenced on (inner), so the
  // fence runs in the query, before the candidate cap.
  const fenceEmbed = fieldType === 'company' && companyNeedsFenceEmbed(fence) ? `, ${COMPANY_FENCE_SELECT}` : ''
  const columns = idColumn === 'user_id' ? `id, user_id, ${lookup.column}` : `id, ${lookup.column}`
  const q = scope.supabase
    .from(lookup.table)
    .select(`${columns}${fenceEmbed}`)
    .eq('workspace_id', scope.workspaceId)
    .ilike(lookup.column, `%${likeLiteral(name)}%`)
  // Every fenced kind is fenced in the query, before the cap.
  if (fieldType === 'team') q.in('id', fence.visibleTeamIds)
  if (fieldType === 'action' || fieldType === 'contact' || fieldType === 'company') applyVisibilityFence(q, fieldType, fence)
  const { data, error } = await q.order(lookup.column, { ascending: true }).limit(NAME_CANDIDATES)
  if (error) throw new Error(`could not look up ${lookup.noun} names: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<Record<string, unknown>>
  return rows
    .map((r) => ({ id: String(r[idColumn] ?? ''), name: String(r[lookup.column] ?? '') }))
    .filter((r) => r.id && r.name)
}

/** A few that exist, for a refusal: only of the kinds that hold nothing private. */
async function someNames(scope: CardScope, fence: VisibilityFence, fieldType: string): Promise<string[]> {
  const lookup = NAME_LOOKUP[fieldType]
  if (!lookup?.listable) return []
  if (!fence.memberId) return []
  const q = scope.supabase.from(lookup.table).select(lookup.column).eq('workspace_id', scope.workspaceId)
  if (fieldType === 'team') q.in('id', fence.visibleTeamIds)
  const { data } = await q.order(lookup.column, { ascending: true }).limit(12)
  return ((data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => String(r[lookup.column] ?? '')).filter(Boolean)
}

async function lookupNames(
  scope: CardScope,
  fence: VisibilityFence,
  fieldType: string,
  names: string[],
  idColumn: 'id' | 'user_id',
): Promise<Checked<Map<string, string[]>>> {
  const lookup = NAME_LOOKUP[fieldType]
  if (!lookup) {
    const source = ID_SOURCE[fieldType] ?? 'the matching list tool'
    return { ok: false, error: `'${names[0]}' is not an id. Use the ${fieldType}'s id from ${source}` }
  }
  const byName = new Map<string, string[]>()
  for (const name of names) {
    const candidates = await nameCandidates(scope, fence, fieldType, name, idColumn)
    const want = name.toLowerCase()
    const exact = candidates.filter((c) => c.name.toLowerCase() === want)
    const hits = exact.length ? exact : candidates
    if (hits.length === 0) {
      const known = await someNames(scope, fence, fieldType)
      const hint = lookup.listable
        ? known.length ? ` Some there: ${known.join(', ')}` : ''
        : ` Find it first (find, or the ${lookup.noun} list tool) and use its id`
      return { ok: false, error: `no ${lookup.noun} named '${name}' in this workspace.${hint}` }
    }
    if (exact.length === 0 && hits.length > 1) {
      return { ok: false, error: `'${name}' matches several ${lookup.noun}s: ${hits.slice(0, 8).map((c) => c.name).join(', ')}. Use the full name` }
    }
    byName.set(name, [...new Set(hits.map((c) => c.id))])
  }
  return { ok: true, value: byName }
}

/** Workflow state names → ids across the teams the person can see (several share "In Progress"). */
/** Deal stages by name (every pipeline's stage of that name), for a deals card's stage filter. */
async function lookupDealStages(scope: CardScope, names: string[]): Promise<Checked<Map<string, string[]>>> {
  const { data, error } = await scope.supabase.from('deal_stage').select('id, name').eq('workspace_id', scope.workspaceId).limit(200)
  if (error) throw new Error(`could not look up stages: ${error.message}`)
  const stages = (data ?? []) as Array<{ id: string; name: string }>
  const byName = new Map<string, string[]>()
  for (const name of names) {
    const ids = stages.filter((s) => s.name.toLowerCase() === name.trim().toLowerCase()).map((s) => s.id)
    if (ids.length === 0) {
      const known = [...new Set(stages.map((s) => s.name))].slice(0, 15)
      return { ok: false, error: `no stage named '${name}'.${known.length ? ` Stages here: ${known.join(', ')}.` : ''}` }
    }
    byName.set(name, ids)
  }
  return { ok: true, value: byName }
}

async function lookupStates(scope: CardScope, fence: VisibilityFence, names: string[]): Promise<Checked<Map<string, string[]>>> {
  const byName = new Map<string, string[]>()
  for (const name of names) {
    const { data, error } = await scope.supabase
      .from('workflow_state')
      .select('id, name, team_id')
      .in('team_id', fence.visibleTeamIds)
      // The name whole, case aside: ILIKE with no wildcard.
      .ilike('name', likeLiteral(name))
      .limit(200)
    if (error) throw new Error(`could not look up statuses: ${error.message}`)
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id)
    if (ids.length === 0) {
      const { data: some } = await scope.supabase
        .from('workflow_state')
        .select('name')
        .in('team_id', fence.visibleTeamIds)
        .order('name', { ascending: true })
        .limit(60)
      const known = [...new Set(((some ?? []) as Array<{ name: string }>).map((r) => r.name))].slice(0, 15)
      return {
        ok: false,
        error: `no status named '${name}'.${known.length ? ` Statuses here: ${known.join(', ')}.` : ''} For a kind of status (done, started…) filter status_type instead`,
      }
    }
    byName.set(name, ids)
  }
  return { ok: true, value: byName }
}

/**
 * Turn names in id fields into ids: "Atlas" for project_id, "Kenan" for
 * assignee_id, "In Progress" for status_id, GEN-42 for an action. A name that
 * matches several rows of one kind (a status shared by teams) widens `is` to
 * `is_any_of`. A refusal names the field and, where nothing is private, what
 * exists.
 */
export async function resolveNamedValues(
  scope: CardScope,
  fence: VisibilityFence,
  entity: CardListEntity,
  filters: CardFilter[],
): Promise<Checked<CardFilter[]>> {
  const out: CardFilter[] = []
  for (const [i, f] of filters.entries()) {
    const def = FILTERABLE_FIELDS[entity].find((d) => d.field === f.field)
    const values = Array.isArray(f.value) ? f.value : typeof f.value === 'string' ? [f.value] : null
    // is_empty / is_not_empty carry the placeholder value '' (validate.ts):
    // there is no name to look up, and '' as one would ilike-match every row.
    if (!def || !isIdField(def) || !values || f.operator === 'is_empty' || f.operator === 'is_not_empty') {
      out.push(f)
      continue
    }
    const names = values.filter((v): v is string => typeof v === 'string' && v !== '@me' && !isUuid(v))
    if (names.length === 0) {
      out.push(f)
      continue
    }
    const resolved =
      def.options === 'workflow_states'
        ? await lookupStates(scope, fence, names)
        : def.options === 'deal_stages'
        ? await lookupDealStages(scope, names)
        : await lookupNames(scope, fence, def.type, names, f.field === 'user_id' ? 'user_id' : 'id')
    if (!resolved.ok) return { ok: false, error: `filters[${i}] (${f.field}): ${resolved.error}` }
    const ids = values.flatMap((v) => (typeof v === 'string' && resolved.value.has(v) ? resolved.value.get(v)! : [v]))
    const unique = [...new Set(ids)]
    if (Array.isArray(f.value)) out.push({ ...f, value: unique })
    else if (unique.length === 1) out.push({ ...f, value: unique[0] })
    else if (f.operator === 'is') out.push({ ...f, operator: 'is_any_of', value: unique })
    else if (f.operator === 'is_not') out.push({ ...f, operator: 'is_none_of', value: unique })
    else out.push({ ...f, value: unique[0] })
  }
  return { ok: true, value: out }
}

async function redactHiddenDealCompanies(scope: CardScope, fence: VisibilityFence, rows: Record<string, unknown>[]): Promise<void> {
  const ids = [...new Set(rows.map((r) => r.company_id).filter((x): x is string => typeof x === 'string'))]
  if (!ids.length) return
  const visible = await visibleCompanyIds(scope.supabase, fence, ids)
  for (const r of rows) {
    if (typeof r.company_id === 'string' && !visible.has(r.company_id)) r.company = null
  }
}

// ── Running a list ────────────────────────────────────────────────────────────

export interface ListPage {
  count: number
  rows: Record<string, unknown>[]
}

/** One page of a list card's rows and its total count, as the person's own page would load them. */
export async function runListQuery(
  scope: CardScope,
  fence: VisibilityFence,
  entity: CardListEntity,
  query: CardQuery,
  limit: number,
): Promise<ListPage> {
  if (!fence.memberId) return { count: 0, rows: [] }
  const memberId = fence.memberId
  const q = buildEntityQuery(scope.supabase, entity, scope.workspaceId, scope.userId, {
    memberId,
    workspaceScope: 'workspace',
    visibility: fence,
  })
  const filters: ViewFilter[] = query.filters.map((f, i) => ({ id: `card-${i}`, ...f }))
  const ordering = query.ordering?.length ? query.ordering : defaultOrdering(entity)
  const fieldTypes = await customFieldTypesFor(scope.supabase, scope.workspaceId, entity, viewFieldsOf(filters, ordering))
  try {
    await applyFilters(q, entity, filters, scope.supabase, scope.workspaceId, { memberId, userId: scope.userId }, { fieldTypes })
  } catch (err) {
    if (err instanceof NoMatchSignal) return { count: 0, rows: [] }
    throw err
  }
  applyEntityDefaults(q, entity, filters)
  if (query.search && CARD_SEARCHABLE_ENTITIES.has(entity)) applySearch(q, entity, query.search)
  if (entity === 'action') {
    await applyCompletedFilter(scope.supabase, q, query.completed_filter ?? 'all', query.show_completed ?? true, scope.workspaceId)
  }
  applyOrdering(q, ordering, entity, { fieldTypes })
  applyPagination(q, 1, limit)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  // A row's embedded team (a document's) is named only when the person can see that team.
  const rows = redactHiddenTeams(stripFenceEmbed((data ?? []) as unknown as Record<string, unknown>[]), fence)
  // A deal's company is named only when the person can see that company (its
  // embed reads on this service-role client, past the company RLS).
  if (entity === 'deal') await redactHiddenDealCompanies(scope, fence, rows)
  return { count: count ?? 0, rows }
}

// ── Records ───────────────────────────────────────────────────────────────────

const RECORD_TABLE: Record<CardRecordType, { table: string; select: string }> = {
  action: { table: 'actions', select: 'id, identifier, title, team_id' },
  capture: { table: 'captures', select: 'id, title, visibility, user_id, is_eval' },
  document: { table: 'document', select: 'id, title, visibility, created_by' },
  initiative: { table: 'initiative', select: 'id, name' },
  project: { table: 'projects', select: 'id, name' },
  contact: { table: 'contact', select: 'id, full_name' },
  company: { table: 'company', select: 'id, name' },
  deal: { table: 'deal', select: 'id, name' },
}

/** Can the person see this record (the same rules as their own page)? */
async function recordVisible(scope: CardScope, fence: VisibilityFence, type: CardRecordType, row: Record<string, unknown>): Promise<boolean> {
  if (!fence.memberId) return false
  const id = String(row.id)
  switch (type) {
    case 'action':
      return actionVisible(fence, row)
    case 'capture':
      // Private captures are their creator's alone; eval captures belong to the Evals surface.
      return row.is_eval !== true && (row.visibility !== 'private' || row.user_id === scope.userId)
    case 'contact':
      return (await visibleContactIds(scope.supabase, fence, [id])).has(id)
    case 'company':
      return (await visibleCompanyIds(scope.supabase, fence, [id])).has(id)
    case 'document':
      // A private document is its creator's alone (migration 369).
      return documentVisible(fence, row)
    default:
      // Projects and initiatives: every member sees them.
      return true
  }
}

/** The record a record card opens, found by id (or an action's identifier) in this workspace, if the person can see it. */
export async function loadRecord(
  scope: CardScope,
  fence: VisibilityFence,
  type: CardRecordType,
  idOrIdentifier: string,
): Promise<Checked<RowLabel>> {
  const { table, select } = RECORD_TABLE[type]
  const byIdentifier = type === 'action' && !isUuid(idOrIdentifier)
  if (!byIdentifier && !isUuid(idOrIdentifier)) {
    return { ok: false, error: `record.id: '${idOrIdentifier}' is not a ${type} id. Find it first (find, or the ${type} list tool), then show it by its id` }
  }
  const { data, error } = await scope.supabase
    .from(table)
    .select(select)
    .eq('workspace_id', scope.workspaceId)
    .eq(byIdentifier ? 'identifier' : 'id', byIdentifier ? idOrIdentifier.toUpperCase() : idOrIdentifier)
    .maybeSingle()
  if (error) throw new Error(error.message)
  const row = data as Record<string, unknown> | null
  // Not found and hidden read the same: a card never confirms a hidden record exists.
  if (!row || !(await recordVisible(scope, fence, type, row))) {
    return { ok: false, error: `record.id: no ${type} '${idOrIdentifier}' in this workspace` }
  }
  return { ok: true, value: rowLabel(row) }
}

// ── The kinds `show` takes ────────────────────────────────────────────────────

/** What a kind's `show` returns besides the spec. */
export interface ShownCard {
  card: ListCardSpec | RecordCardSpec | CalendarCardSpec | MailCardSpec
  count?: number
  items?: RowLabel[] | CalendarItem[] | MailItem[]
  item?: RowLabel | MailItem
}

/**
 * The server side of each kind: check what only the workspace can answer, run
 * it once. One entry per kind (see ./kinds.ts for the other halves).
 */
export const SHOW_KINDS: {
  list: (scope: CardScope, fence: VisibilityFence, spec: ListCardSpec) => Promise<Checked<ShownCard>>
  record: (scope: CardScope, fence: VisibilityFence, spec: RecordCardSpec) => Promise<Checked<ShownCard>>
  // Calendar and mail are per person: their own fences (the person's own
  // calendars and readable mailboxes, in ./server-calendar.ts and
  // ./server-mail.ts) stand in for the workspace fence, which they take only
  // to keep one signature.
  calendar: (scope: CardScope, fence: VisibilityFence, spec: CalendarCardSpec) => Promise<Checked<ShownCard>>
  mail: (scope: CardScope, fence: VisibilityFence, spec: MailCardSpec) => Promise<Checked<ShownCard>>
} = {
  list: async (scope, fence, spec) => {
    const filters = await resolveNamedValues(scope, fence, spec.entity_type, spec.filters)
    if (!filters.ok) return filters
    const card: ListCardSpec = { ...spec, filters: filters.value }
    const page = await runListQuery(scope, fence, card.entity_type, card, SHOW_PREVIEW_ROWS)
    return { ok: true, value: { card, count: page.count, items: page.rows.map(rowLabel) } }
  },
  record: async (scope, fence, spec) => {
    const found = await loadRecord(scope, fence, spec.record.type, spec.record.id)
    if (!found.ok) return found
    // The card holds the record's real id, so it opens however it was named.
    return { ok: true, value: { card: { ...spec, record: { type: spec.record.type, id: found.value.id } }, item: found.value } }
  },
  // The person's own calendars, as get_calendar_events reads them (./server-calendar.ts).
  calendar: (scope, _fence, spec) => showCalendar(scope, spec, SHOW_PREVIEW_ROWS),
  // The person's own readable mailboxes, as list_emails reads them (./server-mail.ts).
  mail: (scope, _fence, spec) => showMail(scope, spec, SHOW_PREVIEW_ROWS),
}

/** How many rows `show` hands back with the count. */
export const SHOW_PREVIEW_ROWS = 10
