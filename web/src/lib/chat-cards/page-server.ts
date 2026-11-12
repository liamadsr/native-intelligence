/**
 * The server half of the page cards (./pages.ts): `show` gates the page, finds
 * its target and reads its first rows once, so the agent's words match what
 * the card opens on; `read_card` reads what a page card shows the person now,
 * wherever in the page they went.
 *
 * Every read here is on the service client, so each one applies the page's
 * own visibility by hand (./page-fences.ts): a private team's board, a
 * private eval case, a package not shared with the person and a personal
 * skill of someone else's are not there for the agent either, and a name
 * lookup's refusal lists only what the person could open.
 *
 * Lists drawn by the views system (sequences, prospect lists and entries,
 * flows, eval suites, cases and runs, claims, a team board's actions) go
 * through its query engine on the same path the page takes, with the place's
 * scope (the team, the list, the suite) added on top.
 */
import {
  applyEntityDefaults,
  applyFilters,
  applyOrdering,
  customFieldTypesFor,
  viewFieldsOf,
  applyPagination,
  applySearch,
  applyCompletedFilter,
  applyTeamScope,
  buildEntityQuery,
  NoMatchSignal,
} from '@/lib/views/query-engine'
import { redactHiddenTeams, stripFenceEmbed, type VisibilityFence } from '@/lib/views/visibility-fence'
import { claimIdsHiddenFrom } from '@/lib/knowledge/claim-visibility'
import { defaultOrdering, type ViewEntityType, type ViewFilter } from '@/lib/views/types'
import { resolveWorkspaceEdition, type ResolvedEdition } from '@/lib/editions/resolve'
import { featureGatedRecipeExclusions, isViewAllowed } from '@/lib/editions/manifest'
import { CARD_SEARCHABLE_ENTITIES, type CardQuery } from './kinds'
import type { CardContextEntry } from './context'
import {
  PAGE_KINDS,
  PLACE_NOUN,
  pageBaseQuery,
  pageListEntity,
  pageTab,
  type PageCardSpec,
  type PageKind,
  type PagePlace,
  type PagePlaceType,
} from './pages'
import { TARGET_SOURCE, type CheckedPageInput } from './page-validate'
import { evalCaseFence, recipeVisible, scrubHiddenBots, visiblePackages, visibleTeams, type FenceScope } from './page-fences'
import { compactValue, rowLabel, type RowLabel } from './rows'
import { resolveNamedValues } from './server'
import { isUuid, type Checked } from './validate'
import { visiblePrivateKindIds } from '@/lib/knowledge/entity-fences'
import { listRows, listTables } from '@/lib/tables/store'
import { readStudioOverview, readStudioProject, readStudioVideoBrief } from '@/lib/studio/agent/reads'
import { isRefusal, studioContext } from '@/lib/studio/agent/access'

export type PageScope = FenceScope

/** How many rows `show` hands back with a page card's count. */
export const PAGE_PREVIEW_ROWS = 10
/** The most rows read_card returns for a page card. */
export const PAGE_READ_MAX_ROWS = 50

// ── The gate ──────────────────────────────────────────────────────────────────

/**
 * Is the page on in this workspace? The same answer the nav rail gives: the
 * edition's composed surface, with the workspace's own feature switches.
 */
export async function gatePage(scope: PageScope, kind: PageKind): Promise<Checked<ResolvedEdition>> {
  const resolved = await resolveWorkspaceEdition(scope.supabase, scope.workspaceId)
  const def = PAGE_KINDS[kind]
  if (def.view && !isViewAllowed(resolved.edition, def.view)) {
    return {
      ok: false,
      error: `${def.label} is off in this workspace, so it can't be shown. A workspace owner turns it on in Settings → Workspace → Features; until then, answer without it`,
    }
  }
  return { ok: true, value: resolved }
}

// ── Places: the things a page opens on ────────────────────────────────────────

interface Candidate {
  id: string
  name: string
  type: PagePlaceType
}

/** Everything of one place type the person can see in the workspace, by name. */
async function candidates(scope: PageScope, type: PagePlaceType, resolved: ResolvedEdition): Promise<Candidate[]> {
  const ws = scope.workspaceId
  const named = (rows: unknown, t: PagePlaceType = type): Candidate[] =>
    ((rows ?? []) as Array<{ id: string; name: string | null }>).map((r) => ({ id: r.id, name: r.name ?? '', type: t }))
  switch (type) {
    case 'team':
      return (await visibleTeams(scope)).map((t) => ({ id: t.id, name: t.name, type }))
    case 'sequence':
    case 'prospect_list':
    case 'eval_suite': {
      const { data, error } = await scope.supabase.from(type === 'sequence' ? 'sequence' : type).select('id, name').eq('workspace_id', ws).limit(500)
      if (error) throw new Error(`could not read ${PLACE_NOUN[type]}s: ${error.message}`)
      return named(data)
    }
    case 'package': {
      const { data, error } = await scope.supabase
        .from('knowledge_package')
        .select('id, name, visibility, team_id, created_by')
        .eq('workspace_id', ws)
        .limit(500)
      if (error) throw new Error(`could not read knowledge packages: ${error.message}`)
      return named(await visiblePackages(scope, (data ?? []) as Array<{ id: string; name: string; visibility: string; team_id: string | null; created_by: string }>))
    }
    case 'agent':
    case 'skill': {
      const gated = new Set(featureGatedRecipeExclusions(resolved))
      const { data, error } = await scope.supabase
        .from('recipe')
        .select('id, name, slug, category, is_system, visibility, workspace_id, created_by')
        .or(`is_system.eq.true,workspace_id.eq.${ws}`)
        .eq('category', type)
        .limit(500)
      if (error) throw new Error(`could not read ${type}s: ${error.message}`)
      return ((data ?? []) as Array<Record<string, unknown>>)
        .filter((r) => recipeVisible(r, scope) && !gated.has(String(r.id)))
        .map((r) => ({ id: String(r.id), name: String(r.name ?? r.slug ?? ''), type }))
    }
    case 'data_table':
      return (await visibleTables(scope)).map((t) => ({ id: t.id, name: t.name, type }))
    case 'data_row':
      // A row is named by its id alone (findTableTarget).
      return []
    case 'studio_project':
    case 'studio_video': {
      // The workspace's own, out of the trash, by title (Studio, migration 620).
      const { data, error } = await scope.supabase
        .from(type)
        .select('id, title')
        .eq('workspace_id', ws)
        .is('archived_at', null)
        .order('updated_at', { ascending: false })
        .limit(500)
      if (error) throw new Error(`could not read ${PLACE_NOUN[type]}s: ${error.message}`)
      return ((data ?? []) as Array<{ id: string; title: string | null }>).map((r) => ({ id: r.id, name: r.title ?? '', type }))
    }
    case 'eval_case':
    case 'eval_run':
    case 'bot':
    case 'work_item':
    case 'guest':
    case 'guest_message':
    case 'agent_link':
    case 'agent_link_exchange':
    case 'team_chat_channel':
    case 'team_chat_message':
      // Only ever opened by the person (inside a suite, on a bot's page, from a guest's or a link's card, team chat), never named by the agent.
      return []
  }
}

/** The workspace's live tables the person can read (without grants on a guest's turn), in their order. */
async function visibleTables(scope: PageScope, opts: { pipelines?: boolean } = {}): Promise<Array<{ id: string; name: string }>> {
  const all = await listTables(scope.supabase, scope.workspaceId, opts.pipelines ? { kind: 'pipeline' } : {})
  const seen = await visiblePrivateKindIds(scope.supabase, 'data_table', scope.userId, all.map((t) => t.id), scope.workspaceId, scope.grants === false ? { grants: false } : {})
  return all.filter((t) => seen.has(t.id)).map((t) => ({ id: t.id, name: t.name }))
}

/** A row's place on the Deals page: only a pipeline's row is a deal. */
async function visibleDealRow(scope: PageScope, rowId: string): Promise<PagePlace | null> {
  const row = await visibleRow(scope, rowId)
  if (!row?.in) return null
  return (await visibleTables(scope, { pipelines: true })).some((t) => t.id === row.in) ? row : null
}

/** One row the person can read, with its table: a row card's place. */
async function visibleRow(scope: PageScope, rowId: string): Promise<PagePlace | null> {
  if (!isUuid(rowId)) return null
  const { data } = await scope.supabase
    .from('data_row')
    .select('id, title, table_id')
    .eq('workspace_id', scope.workspaceId)
    .eq('id', rowId)
    .is('archived_at', null)
    .maybeSingle()
  const row = data as { id: string; title: string | null; table_id: string } | null
  if (!row) return null
  const seen = await visiblePrivateKindIds(scope.supabase, 'data_table', scope.userId, [row.table_id], scope.workspaceId, scope.grants === false ? { grants: false } : {})
  return seen.has(row.table_id) ? { type: 'data_row', id: row.id, label: row.title || 'Untitled', in: row.table_id } : null
}

/** One place by id or name among what the person can see; a refusal lists only those. */
function pick(kind: PageKind, text: string, found: Candidate[]): Checked<PagePlace> {
  const noun = (PAGE_KINDS[kind].target?.types ?? []).map((t) => PLACE_NOUN[t]).join(' or ')
  const byId = found.find((c) => c.id === text)
  if (byId) return { ok: true, value: { type: byId.type, id: byId.id, label: byId.name } }
  const want = text.toLowerCase()
  const exact = found.filter((c) => c.name.toLowerCase() === want)
  const partial = exact.length ? exact : found.filter((c) => c.name.toLowerCase().includes(want))
  if (partial.length === 1 || (exact.length >= 1 && exact.every((c) => c.id === exact[0].id))) {
    const c = partial[0]
    return { ok: true, value: { type: c.type, id: c.id, label: c.name } }
  }
  if (partial.length > 1) {
    return { ok: false, error: `target: '${text}' matches several: ${partial.slice(0, 8).map((c) => c.name).join(', ')}. Use the full name or the id` }
  }
  const some = found.slice(0, 12).map((c) => c.name).filter(Boolean)
  const source = TARGET_SOURCE[kind]
  return {
    ok: false,
    error: isUuid(text)
      ? `target: no ${noun} with id ${text} that you can open here.${source ? ` ${source}` : ''}`
      : `target: no ${noun} named '${text}' that you can open here.${some.length ? ` Some there: ${some.join(', ')}` : ` There are none you can open.`}`,
  }
}

/** The page card's target, found among what the person can see. */
async function findTarget(scope: PageScope, input: CheckedPageInput, resolved: ResolvedEdition): Promise<Checked<PagePlace>> {
  const def = PAGE_KINDS[input.kind]
  let types = def.target?.types ?? []
  // The library's tab says which of agent and skill is meant.
  if (input.kind === 'library' && input.tab) types = [input.tab === 'skills' ? 'skill' : 'agent']
  let found = (await Promise.all(types.map((t) => candidates(scope, t, resolved)))).flat()
  // The Deals page opens on a pipeline (Tables, phase 7: a pipeline is a table).
  if (input.kind === 'pipelines') {
    const pipelines = new Set((await visibleTables(scope, { pipelines: true })).map((t) => t.id))
    found = found.filter((c) => pipelines.has(c.id))
  }
  // A table's row: by its id, when no table has it.
  if ((input.kind === 'tables' || input.kind === 'pipelines') && input.target && isUuid(input.target) && !found.some((c) => c.id === input.target)) {
    const row = input.kind === 'pipelines' ? await visibleDealRow(scope, input.target) : await visibleRow(scope, input.target)
    if (row) return { ok: true, value: row }
  }
  return pick(input.kind, input.target ?? '', found)
}

/**
 * A place the client says the person opened, checked again: it must be one
 * this page has and one they can see. Null when it is not, and the read falls
 * back to the page's top level.
 */
async function checkPlace(scope: PageScope, kind: PageKind, place: PagePlace): Promise<PagePlace | null> {
  const ws = scope.workspaceId
  const ok = (label?: string | null): PagePlace => ({ ...place, ...(label ? { label } : {}) })
  switch (place.type) {
    case 'team': {
      if (kind !== 'team_board' && kind !== 'teams') return null
      const team = (await visibleTeams(scope)).find((t) => t.id === place.id)
      return team ? ok(team.name) : null
    }
    case 'sequence':
    case 'prospect_list':
    case 'eval_suite': {
      const want: Record<string, PageKind> = { sequence: 'sequences', prospect_list: 'prospecting', eval_suite: 'evals' }
      if (want[place.type] !== kind || !isUuid(place.id)) return null
      const { data } = await scope.supabase.from(place.type).select('id, name').eq('workspace_id', ws).eq('id', place.id).maybeSingle()
      const row = data as { name?: string } | null
      return row ? ok(row.name) : null
    }
    case 'eval_case':
    case 'eval_run': {
      if (kind !== 'evals' || !isUuid(place.id)) return null
      const q = scope.supabase.from(place.type).select(place.type === 'eval_case' ? 'id, name' : 'id').eq('workspace_id', ws).eq('id', place.id)
      if (place.type === 'eval_case') q.or(evalCaseFence(scope.userId))
      const { data } = await q.maybeSingle()
      // The label is the record's own, never the client's.
      return data ? { type: place.type, id: place.id, ...((data as unknown as { name?: string }).name ? { label: (data as unknown as { name: string }).name } : {}) } : null
    }
    case 'package':
    case 'agent':
    case 'skill': {
      const want: Record<string, PageKind> = { package: 'knowledge', agent: 'library', skill: 'library' }
      if (want[place.type] !== kind) return null
      const resolved = await resolveWorkspaceEdition(scope.supabase, ws)
      const hit = (await candidates(scope, place.type, resolved)).find((c) => c.id === place.id)
      return hit ? ok(hit.name) : null
    }
    case 'data_table': {
      if (kind !== 'tables' && kind !== 'pipelines') return null
      const table = (await visibleTables(scope, { pipelines: kind === 'pipelines' })).find((t) => t.id === place.id)
      return table ? ok(table.name) : null
    }
    case 'data_row':
      return kind === 'tables' ? visibleRow(scope, place.id) : kind === 'pipelines' ? visibleDealRow(scope, place.id) : null
    case 'studio_project':
    case 'studio_video': {
      // Read on the service client, so fenced here by the workspace: a video or
      // Studio project of another workspace, or in the trash, is not there.
      if (kind !== 'studio' || !isUuid(place.id)) return null
      const { data } = await scope.supabase.from(place.type).select('id, title').eq('workspace_id', ws).eq('id', place.id).is('archived_at', null).maybeSingle()
      const row = data as { title?: string | null } | null
      return row ? ok(row.title) : null
    }
    case 'bot':
    case 'work_item':
    case 'guest':
    case 'guest_message':
    case 'agent_link':
    case 'agent_link_exchange':
    case 'team_chat_channel':
    case 'team_chat_message':
      // A bot's page, a work item's panel, a guest's or a link's conversation, team chat: read_card answers them before reading any place.
      return null
  }
}

// ── Rows ──────────────────────────────────────────────────────────────────────

export interface PageRows {
  count: number
  rows: Record<string, unknown>[]
  /** The views-system list the rows came from, when they did. */
  entity?: ViewEntityType
  /** What the rows are, plural. */
  noun: string
}

/** A row's name where its entity keeps it somewhere rowLabel does not look. */
function titled(entity: ViewEntityType | null, row: Record<string, unknown>): Record<string, unknown> {
  if (entity === 'claim' && typeof row.text === 'string') return { ...row, title: row.text }
  if (entity === 'prospect_list_entry') {
    const c = (row.candidate ?? {}) as Record<string, unknown>
    const name = c.name ?? c.full_name ?? c.company_name ?? c.domain
    if (typeof name === 'string') return { ...row, title: name }
  }
  if (entity === 'eval_run') {
    const when = typeof row.started_at === 'string' ? ` · ${row.started_at.slice(0, 10)}` : ''
    return { ...row, title: `${row.mode ?? 'eval'} run · ${row.outcome ?? row.status ?? ''}${when}` }
  }
  return row
}

/** One page of a views-system list at a place, as the page would load it, fenced. */
async function runPageList(
  scope: PageScope,
  fence: VisibilityFence,
  entity: ViewEntityType,
  place: PagePlace | null,
  query: CardQuery,
  limit: number,
): Promise<{ count: number; rows: Record<string, unknown>[] }> {
  if (!fence.memberId) return { count: 0, rows: [] }
  const member = { id: fence.memberId }
  // The shared fence: a team board's actions are a visible team's, as under RLS.
  const q = buildEntityQuery(scope.supabase, entity, scope.workspaceId, scope.userId, {
    memberId: member.id,
    workspaceScope: 'workspace',
    visibility: fence,
  })
  // The place's scope, as the page passes it (scopeFilters / teamId).
  if (place?.type === 'team') applyTeamScope(q, entity, place.id)
  if (place?.type === 'prospect_list') q.eq('list_id', place.id)
  if (place?.type === 'eval_suite') q.eq('suite_id', place.id)
  if (entity === 'eval_case') q.or(evalCaseFence(scope.userId))
  const filters: ViewFilter[] = query.filters.map((f, i) => ({ id: `card-${i}`, ...f }))
  const ordering = query.ordering?.length ? query.ordering : defaultOrdering(entity)
  const fieldTypes = await customFieldTypesFor(scope.supabase, scope.workspaceId, entity, viewFieldsOf(filters, ordering))
  try {
    await applyFilters(q, entity, filters, scope.supabase, scope.workspaceId, { memberId: member.id, userId: scope.userId }, { fieldTypes })
  } catch (err) {
    if (err instanceof NoMatchSignal) return { count: 0, rows: [] }
    throw err
  }
  applyEntityDefaults(q, entity, filters)
  if (query.search && (CARD_SEARCHABLE_ENTITIES.has(entity) || entity === 'claim')) applySearch(q, entity, query.search)
  if (entity === 'action') {
    await applyCompletedFilter(scope.supabase, q, query.completed_filter ?? 'all', query.show_completed ?? true, scope.workspaceId)
  }
  applyOrdering(q, ordering, entity, { fieldTypes })
  applyPagination(q, 1, limit)
  const { data, count, error } = await q
  if (error) throw new Error(error.message)
  let rows = stripFenceEmbed((data ?? []) as unknown as Record<string, unknown>[])
  // A flow's team embed is null under RLS for a private team the person is not in.
  // A flow's team and bot embeds come back empty under RLS for a private team
  // the person is not on (and a bot on one): blank them here too.
  if (entity === 'flow') {
    rows = redactHiddenTeams(rows, fence)
    rows = await scrubHiddenBots(scope, rows, fence.visibleTeamIds)
  }
  // A claim shows only where one of its sources does (no mail, another
  // person's private capture or chat: migrations 341 and 353). This read runs
  // as the service role, so RLS doesn't do it: drop them, failing closed.
  let total = count ?? 0
  if (entity === 'claim' && rows.length > 0) {
    const hidden = await claimIdsHiddenFrom(scope.supabase, rows.map((r) => String(r.id)), scope.userId)
    if (!hidden) return { count: 0, rows: [] }
    if (hidden.size > 0) {
      rows = rows.filter((r) => !hidden.has(String(r.id)))
      total = Math.max(rows.length, total - hidden.size)
    }
  }
  return { count: total, rows: rows.map((r) => titled(entity, r)) }
}

/** What a page shows at a place and tab, read the page's way, fenced. */
export async function readPageRows(
  scope: PageScope,
  fence: VisibilityFence,
  kind: PageKind,
  at: { place: PagePlace | null; tab?: string; query?: CardQuery },
  limit: number,
): Promise<PageRows> {
  const tab = pageTab(kind, at.tab)
  const place = at.place
  // An eval suite's overview reads as its cases.
  const entity = kind === 'evals' && place?.type === 'eval_suite' && tab !== 'runs' ? 'eval_case' : pageListEntity(kind, place, tab)
  if (entity) {
    const page = await runPageList(scope, fence, entity, place, at.query ?? { filters: [] }, limit)
    return { ...page, entity, noun: entity === 'action' ? 'actions' : PAGE_ROWS_NOUN[entity] ?? `${entity.replace(/_/g, ' ')}s` }
  }

  const ws = scope.workspaceId
  const exact = { count: 'exact' as const }
  switch (kind) {
    case 'campaigns': {
      const { data, count, error } = await scope.supabase
        .from('campaign')
        .select('id, name, status, objective, channels, starts_on, ends_on, updated_at', exact)
        .eq('workspace_id', ws)
        .order('updated_at', { ascending: false })
        .limit(limit)
      if (error) throw new Error(error.message)
      return { count: count ?? 0, rows: (data ?? []) as Record<string, unknown>[], noun: 'campaigns' }
    }
    case 'teams': {
      if (place?.type === 'team') {
        const { data, error } = await scope.supabase
          .from('team_member')
          .select('member:member!member_id(id, display_name, role)')
          .eq('team_id', place.id)
          .limit(limit)
        if (error) throw new Error(error.message)
        const rows = ((data ?? []) as unknown as Array<{ member: Record<string, unknown> | null }>)
          .map((r) => r.member)
          .filter((m): m is Record<string, unknown> => !!m)
          .map((m) => ({ id: m.id, name: m.display_name, role: m.role }))
        return { count: rows.length, rows, noun: 'members' }
      }
      const teams = await visibleTeams(scope)
      return { count: teams.length, rows: teams.slice(0, limit) as unknown as Record<string, unknown>[], noun: 'teams' }
    }
    case 'library': {
      if (place?.type === 'agent' || place?.type === 'skill') {
        const { data } = await scope.supabase.from('recipe').select('id, name, description, category').eq('id', place.id).maybeSingle()
        return { count: data ? 1 : 0, rows: data ? [data as Record<string, unknown>] : [], noun: `${place.type}s` }
      }
      const type: PagePlaceType = tab === 'skills' ? 'skill' : 'agent'
      const resolved = await resolveWorkspaceEdition(scope.supabase, ws)
      const all = await candidates(scope, type, resolved)
      return { count: all.length, rows: all.slice(0, limit).map((c) => ({ id: c.id, name: c.name })), noun: `${type}s` }
    }
    case 'knowledge': {
      if (place?.type === 'package') {
        const { data, error } = await scope.supabase.from('knowledge_package_item').select('entity_type, entity_id').eq('package_id', place.id).limit(1000)
        if (error) throw new Error(error.message)
        const byType = new Map<string, number>()
        for (const r of (data ?? []) as Array<{ entity_type: string }>) byType.set(r.entity_type, (byType.get(r.entity_type) ?? 0) + 1)
        const rows = [...byType].map(([type, n]) => ({ id: type, name: `${n} pinned ${type}${n === 1 ? '' : 's'}` }))
        return { count: rows.length, rows, noun: 'kinds of pinned items' }
      }
      // The library tab: the packages the person can see.
      const resolved = await resolveWorkspaceEdition(scope.supabase, ws)
      const all = await candidates(scope, 'package', resolved)
      return { count: all.length, rows: all.slice(0, limit).map((c) => ({ id: c.id, name: c.name })), noun: 'knowledge packages' }
    }
    case 'sequences': {
      if (place?.type === 'sequence') {
        // One sequence: its steps. Its enrollments are people, each behind the
        // CRM's own visibility; get_sequence and the card show those.
        const { data, error } = await scope.supabase
          .from('sequence_step')
          .select('id, step_order, subject, delay_days, is_active')
          .eq('sequence_id', place.id)
          .order('step_order', { ascending: true })
          .limit(limit)
        if (error) throw new Error(error.message)
        const rows = ((data ?? []) as Array<Record<string, unknown>>).map((s) => ({ ...s, title: `Step ${s.step_order}${s.subject ? `: ${s.subject}` : ''}` }))
        return { count: rows.length, rows, noun: 'steps' }
      }
      break
    }
    case 'tables':
    case 'pipelines': {
      // Every place is checked as the person's by now (findTarget, checkPlace).
      if (place?.type === 'data_table' || place?.type === 'data_row') {
        const tableId = place.type === 'data_row' ? place.in : place.id
        if (!tableId) break
        const page = await listRows(scope.supabase, ws, tableId, { limit, ...(place.type === 'data_row' ? { ids: [place.id] } : {}) })
        const rows = page.rows.map((r) => ({ id: r.id, title: r.title || 'Untitled', ...r.custom_fields }))
        if (place.type === 'data_row') return { count: rows.length, rows, noun: 'rows' }
        const { count } = await scope.supabase.from('data_row').select('id', { count: 'exact', head: true }).eq('table_id', tableId).is('archived_at', null)
        return { count: typeof count === 'number' ? count : rows.length, rows, noun: 'rows' }
      }
      const tables = await visibleTables(scope, { pipelines: kind === 'pipelines' })
      return { count: tables.length, rows: tables.slice(0, limit), noun: kind === 'pipelines' ? 'pipelines' : 'tables' }
    }
    case 'studio': {
      // One video: itself. One Studio project: its videos. The top level: the
      // Studio projects, and the videos in none as one row of their own.
      if (place?.type === 'studio_video') {
        const brief = await readStudioVideoBrief(scope.supabase, ws, place.id)
        const rows = brief ? [{ id: brief.id, title: brief.title, status: brief.status, seconds: brief.seconds, format: brief.format }] : []
        return { count: rows.length, rows, noun: 'videos' }
      }
      if (place?.type === 'studio_project') {
        const project = await readStudioProject(scope.supabase, ws, place.id)
        const videos = project?.videos ?? []
        return { count: videos.length, rows: videos.slice(0, limit) as unknown as Record<string, unknown>[], noun: 'videos' }
      }
      const overview = await readStudioOverview(scope.supabase, ws)
      const rows: Record<string, unknown>[] = overview.projects.map((p) => ({ id: p.id, title: p.title, videos: p.videos.length }))
      if (overview.unfiled.length) rows.push({ id: 'unfiled', title: `Videos in no Studio project (${overview.unfiled.length})`, videos: overview.unfiled.length })
      return { count: overview.projects.length, rows: rows.slice(0, limit), noun: 'Studio projects' }
    }
    case 'evals': {
      if (place?.type === 'eval_case' || place?.type === 'eval_run') {
        const select = place.type === 'eval_case' ? 'id, name, polarity, last_outcome, last_run_at' : 'id, mode, status, outcome, started_at, ended_at, cost_usd'
        const q = scope.supabase.from(place.type).select(select).eq('workspace_id', ws).eq('id', place.id)
        if (place.type === 'eval_case') q.or(evalCaseFence(scope.userId))
        const { data } = await q.maybeSingle()
        const row = data ? titled(place.type === 'eval_run' ? 'eval_run' : 'eval_case', data as unknown as Record<string, unknown>) : null
        return { count: row ? 1 : 0, rows: row ? [row] : [], noun: place.type === 'eval_case' ? 'eval cases' : 'eval runs' }
      }
      break
    }
  }
  return { count: 0, rows: [], noun: PAGE_KINDS[kind].rows }
}

const PAGE_ROWS_NOUN: Partial<Record<ViewEntityType, string>> = {
  sequence: 'sequences',
  prospect_list: 'prospect lists',
  prospect_list_entry: 'entries',
  flow: 'flows',
  eval_suite: 'eval suites',
  eval_case: 'eval cases',
  eval_run: 'eval runs',
  claim: 'claims',
}

// ── show ──────────────────────────────────────────────────────────────────────

export interface ShownPage {
  card: PageCardSpec
  count?: number
  items?: RowLabel[]
  item?: RowLabel
}

/** `show` for a page kind: gate it, find its target, read its first rows. */
export async function showPage(scope: PageScope, fence: VisibilityFence, input: CheckedPageInput): Promise<Checked<ShownPage>> {
  const gate = await gatePage(scope, input.kind)
  if (!gate.ok) return gate
  // The Studio is a member's: a workspace guest is refused, as by every Studio tool.
  if (input.kind === 'studio') {
    const member = await studioContext(scope.supabase, scope.userId, scope.workspaceId)
    if (isRefusal(member)) return { ok: false, error: member.error }
  }
  let target: PagePlace | undefined
  if (input.target) {
    const found = await findTarget(scope, input, gate.value)
    if (!found.ok) return found
    target = found.value
  }
  let filters = input.filters
  if (filters?.length) {
    const named = await resolveNamedValues(scope, fence, 'action', filters)
    if (!named.ok) return named
    filters = named.value
  }
  // The library's tab follows what its target turned out to be.
  const tab = input.kind === 'library' && target ? (target.type === 'skill' ? 'skills' : 'agents') : input.tab
  const card: PageCardSpec = {
    kind: input.kind,
    title: input.title,
    ...(target ? { target } : {}),
    ...(tab ? { tab } : {}),
    ...(filters?.length ? { filters } : {}),
  }
  // The chat-agent's show proxy loads the page's area pack from this card's
  // kind (attachCardExpertise → cardRefOf, src/lib/packs/registry.ts cardKinds).
  const page = await readPageRows(scope, fence, input.kind, { place: target ?? null, tab, query: pageBaseQuery(card) }, PAGE_PREVIEW_ROWS)
  return {
    ok: true,
    value: {
      card,
      count: page.count,
      items: page.rows.map(rowLabel),
      ...(target ? { item: { id: target.id, title: target.label ?? '' } } : {}),
    },
  }
}

// ── read_card ─────────────────────────────────────────────────────────────────

/** read_card for a page card: the rows at the place the person is on now. */
export async function readPageCard(
  scope: PageScope,
  fence: VisibilityFence,
  entry: CardContextEntry,
  fields: string[],
  max = PAGE_READ_MAX_ROWS,
): Promise<Record<string, unknown>> {
  const kind = entry.kind as PageKind
  const gate = await gatePage(scope, kind)
  if (!gate.ok) return { success: false, code: 'PAGE_OFF', error: gate.error }
  if (kind === 'bot') {
    return {
      success: true,
      card: entry.n,
      title: entry.title,
      note: 'This card is one agent\'s page: its chat and its work. Read its work with list_bot_work (and get_bot_item for one item).',
    }
  }
  // One work item's panel (a work item with no bot's page to open on):
  // read_card answers it here, as it does a bot's page, never as a place.
  if (kind === 'work_item') {
    return {
      success: true,
      card: entry.n,
      title: entry.title,
      ...(entry.at?.type === 'work_item' ? { item: entry.at.id } : {}),
      note: 'This card is one work item\'s panel. Read the item in full with get_bot_item (its id above).',
    }
  }
  // A guest's conversation (guest access): read with read_guest_conversation, on the person's own turn.
  if (kind === 'guest') {
    return {
      success: true,
      card: entry.n,
      title: entry.title,
      ...(entry.at?.type === 'guest' ? { guest_id: entry.at.id } : {}),
      note: 'This card is one guest\'s conversation with the agent made for them. Read its messages, and the calls it held for the person, with read_guest_conversation (by guest_id, or the guest\'s name).',
    }
  }
  // The two agents' conversation over a link (agent links): the person's to read, not the agent's.
  if (kind === 'agent_link') {
    return {
      success: true,
      card: entry.n,
      title: entry.title,
      note: 'This card is the conversation between your agent and another person\'s agent, open for the person to read. Its messages are not readable from here.',
    }
  }
  // The Files page (Liam, 11-11): the person's view of the workspace's files, read on their own session (its fences are RLS's), not from here.
  if (kind === 'files') {
    return {
      success: true,
      card: entry.n,
      title: entry.title,
      note: 'This card is the Files page: every file attached to a capture, action or project the person can see. Read one record\'s files with list_attachments (capture_id, action_id or project_id), and a file\'s text with get_attachment_content.',
    }
  }
  // The Studio: what the person is on, as the Studio tools read it (never the whole edit).
  if (kind === 'studio') return readStudioCard(scope, entry)
  if (entry.entity && !entry.cur) {
    return { success: false, code: 'CARD_TOO_BIG', error: `card ${entry.n} is too big to read back. Show it again, then read that card` }
  }
  const place = entry.at ? await checkPlace(scope, kind, entry.at) : null
  if (PAGE_KINDS[kind].target?.required && !place) {
    return { success: false, error: `card ${entry.n} shows a ${PAGE_KINDS[kind].label.toLowerCase()} you can't open any more` }
  }
  const page = await readPageRows(scope, fence, kind, { place, tab: entry.tab, query: entry.entity ? entry.cur : undefined }, max)
  const offered = page.rows[0] ? Object.keys(page.rows[0]).filter((k) => k !== 'workspace_id') : []
  const unknown = page.rows.length ? fields.filter((f) => !offered.includes(f)) : []
  if (unknown.length) {
    return { success: false, code: 'INPUT_INVALID', error: `${page.noun} rows have no ${unknown.join(', ')}. Fields: ${offered.join(', ')}` }
  }
  const rows = page.rows.map((row) => {
    const out: Record<string, unknown> = { ...rowLabel(row) }
    for (const f of fields) out[f] = compactValue(row[f])
    return out
  })
  return {
    success: true,
    card: entry.n,
    title: entry.title,
    ...(place ? { at: `${PLACE_NOUN[place.type]} ${place.label ?? place.id}` } : {}),
    ...(entry.tab ? { tab: entry.tab } : {}),
    showing: page.noun,
    total: page.count,
    ...(page.count > rows.length ? { first: rows.length } : {}),
    rows,
  }
}

/**
 * read_card for the Studio: on a video, the summary get_studio_video returns;
 * on a Studio project, it with its videos; at the top level, every Studio
 * project with its videos, and the videos in none. Compact: no edit document.
 */
async function readStudioCard(scope: PageScope, entry: CardContextEntry): Promise<Record<string, unknown>> {
  const ws = scope.workspaceId
  const member = await studioContext(scope.supabase, scope.userId, ws)
  if (isRefusal(member)) return { ...member }
  const place = entry.at ? await checkPlace(scope, 'studio', entry.at) : null
  const head = { success: true, card: entry.n, title: entry.title, ...(entry.tab ? { tab: entry.tab } : {}) }
  if (place?.type === 'studio_video') {
    const video = await readStudioVideoBrief(scope.supabase, ws, place.id)
    if (video) return { ...head, at: `video ${video.title}`, video }
  }
  if (place?.type === 'studio_project') {
    const project = await readStudioProject(scope.supabase, ws, place.id)
    if (project) return { ...head, at: `Studio project ${project.title}`, studio_project: project }
  }
  const overview = await readStudioOverview(scope.supabase, ws)
  return {
    ...head,
    showing: 'Studio projects',
    total: overview.projects.length,
    studio_projects: overview.projects,
    videos_in_no_studio_project: overview.unfiled,
    note: 'Open one video with get_studio_video (its id above) to read its edit; edit_studio_video changes it.',
  }
}
