/**
 * One query per kind for the composer menu's search (docs/plans/slash-search.md).
 *
 * Every kind but companies is read with the CALLER's client, so the table's
 * RLS decides what they may see, exactly as the list routes do: captures and
 * documents private to their creator, contacts through can_view_contact, the
 * rest by membership. Companies go through list_companies_with_stats on the
 * service client with the caller as p_user_id, as /api/account/companies does
 * (the RPC is revoked from `authenticated`; its contact-visibility fence needs
 * the requester).
 *
 * Team chat messages (migration 561) go through team_chat_search with the
 * caller's client: the function itself reads only the channels and DMs the
 * caller may read (team_chat_can_read), never a deleted message.
 *
 * Titles and names match as you type (each typed word somewhere in the name);
 * capture, document and action bodies match through their `fts` columns, whole
 * words only, ranked under any title match. With nothing typed, a kind lists
 * its most recent rows.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CaptureListItem } from '@/app/account/(dashboard)/views/capture-utils'
import {
  BODY_MATCH_SCORE,
  IDENTIFIER_QUERY,
  bestScore,
  normalizeQuery,
  scoreIdentifier,
  scoreText,
  toMentionCompany,
  toMentionContact,
  type CompanyApiRow,
  type ContactApiRow,
  type MenuSearchKind,
  type MenuSearchRow,
} from '@/lib/search/menu-search'
import { searchRecipes, type SupabaseLike } from './recipe-search'

export interface MenuQueryContext {
  /** The caller's client (RLS applies). */
  supabase: SupabaseClient
  /** The service client: companies only (see above). */
  service: SupabaseClient
  workspaceId: string
  userId: string
  /** What's typed, as typed. */
  query: string
  /** Rows to return. */
  limit: number
  /** System skills/agents whose feature is off here (agents only). */
  excludedRecipeIds: readonly string[]
}

/** Title matches read this many rows to rank, so a good match past the most recent few still makes it. */
const FETCH = 40
/** A body (full-text) search only once a word is this long: shorter ones match whole words that rarely help. */
const BODY_MIN_QUERY = 3
/** Words a name is matched on (each must be in it). */
const MAX_WORDS = 4

/**
 * The words to match names on: what's typed, with the characters PostgREST
 * reads as filter grammar (`,()"`), LIKE wildcards and escapes taken out.
 */
export function matchWords(query: string): string[] {
  return normalizeQuery(query.replace(/[,()"'`\\%_*:]/g, ' '))
    .split(' ')
    .filter(Boolean)
    .slice(0, MAX_WORDS)
}

/** Best first; equal scores keep the query's own order (most recent first). */
function rank<T extends MenuSearchRow>(rows: T[], limit: number): T[] {
  return rows
    .map((row, i) => ({ row, i }))
    .sort((a, b) => b.row.score - a.row.score || a.i - b.i)
    .slice(0, limit)
    .map(({ row }) => row)
}

/** Title hits, then body hits not already in them (by id), each once. */
function mergeById<T extends { id: string }>(title: readonly T[], body: readonly T[]): T[] {
  const seen = new Set(title.map((r) => r.id))
  return [...title, ...body.filter((r) => !seen.has(r.id))]
}

/** A query that failed is no rows (the other kinds still answer); logged once. */
async function rowsOf<T>(kind: string, q: PromiseLike<{ data: unknown; error: unknown }>): Promise<T[]> {
  const { data, error } = await q
  if (error) {
    console.error(`[menu-search] ${kind} failed:`, error)
    return []
  }
  return Array.isArray(data) ? (data as T[]) : []
}

// ── Actions ──────────────────────────────────────────────────────────────────

interface ActionRow {
  id: string
  title: string
  identifier: string | null
  previous_identifier: string | null
  workflow_state: { name: string | null } | null
}
const ACTION_COLUMNS = 'id, title, identifier, previous_identifier, workflow_state:workflow_state!status_id(name)'

async function searchActions(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const q = normalizeQuery(query)
  const base = () =>
    supabase
      .from('actions')
      .select(ACTION_COLUMNS)
      .eq('workspace_id', workspaceId)
      .not('is_dismissed', 'is', true)

  if (!words.length) {
    const rows = await rowsOf<ActionRow>('action', base().order('updated_at', { ascending: false }).limit(limit))
    return rows.map((a) => actionRow(a, 0))
  }

  const byTitle = words.reduce((b, w) => b.ilike('title', `%${w}%`), base())
  const isIdentifier = IDENTIFIER_QUERY.test(q)
  const [title, ident, body] = await Promise.all([
    rowsOf<ActionRow>('action', byTitle.order('updated_at', { ascending: false }).limit(FETCH)),
    // The identifier itself, then the ones it starts (`GEN-4` → GEN-42): the
    // exact one read on its own, so forty newer prefix matches can't hide it.
    isIdentifier
      ? Promise.all([
          rowsOf<ActionRow>('action', base().or(`identifier.ilike.${q},previous_identifier.ilike.${q}`).limit(2)),
          rowsOf<ActionRow>(
            'action',
            base().or(`identifier.ilike.${q}%,previous_identifier.ilike.${q}%`).order('updated_at', { ascending: false }).limit(FETCH),
          ),
        ]).then(([exact, prefix]) => mergeById(exact, prefix))
      : Promise.resolve([] as ActionRow[]),
    q.length >= BODY_MIN_QUERY && !isIdentifier
      ? rowsOf<ActionRow>(
          'action',
          base().textSearch('fts', query.trim(), { type: 'websearch', config: 'english' }).order('updated_at', { ascending: false }).limit(FETCH),
        )
      : Promise.resolve([] as ActionRow[]),
  ])
  const scored = mergeById(mergeById(ident, title), body).map((a) =>
    actionRow(
      a,
      bestScore(scoreIdentifier(a.identifier, q), scoreIdentifier(a.previous_identifier, q), scoreText(a.title, q)) ||
        BODY_MATCH_SCORE,
    ),
  )
  return rank(scored, limit)
}

function actionRow(a: ActionRow, score: number): MenuSearchRow {
  return { kind: 'action', id: a.id, title: a.title, identifier: a.identifier, status: a.workflow_state?.name ?? null, score }
}

// ── Documents ────────────────────────────────────────────────────────────────

interface DocumentRow {
  id: string
  title: string | null
  updated_at: string | null
}

async function searchDocuments(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const q = normalizeQuery(query)
  // The person's Now file (kind 'now', migration 440) stays out: edited all
  // day, it would top every list.
  const base = () =>
    supabase.from('document').select('id, title, updated_at').eq('workspace_id', workspaceId).neq('status', 'archived').neq('kind', 'now')
  const toRow = (d: DocumentRow, score: number): MenuSearchRow => ({
    kind: 'document',
    id: d.id,
    title: d.title || 'Untitled',
    updatedAt: d.updated_at,
    score,
  })

  if (!words.length) {
    const rows = await rowsOf<DocumentRow>('document', base().order('updated_at', { ascending: false }).limit(limit))
    return rows.map((d) => toRow(d, 0))
  }
  const [title, body] = await Promise.all([
    rowsOf<DocumentRow>(
      'document',
      words.reduce((b, w) => b.ilike('title', `%${w}%`), base()).order('updated_at', { ascending: false }).limit(FETCH),
    ),
    q.length >= BODY_MIN_QUERY
      ? rowsOf<DocumentRow>(
          'document',
          base().textSearch('fts', query.trim(), { type: 'websearch', config: 'english' }).order('updated_at', { ascending: false }).limit(FETCH),
        )
      : Promise.resolve([] as DocumentRow[]),
  ])
  return rank(
    mergeById(title, body).map((d) => toRow(d, scoreText(d.title, q) || BODY_MATCH_SCORE)),
    limit,
  )
}

// ── Projects and initiatives (names only) ────────────────────────────────────

interface NamedRow {
  id: string
  name: string | null
  status: string | null
}

async function searchProjects(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const base = supabase.from('projects').select('id, name, status').eq('workspace_id', workspaceId).eq('is_archived', false)
  const rows = await rowsOf<NamedRow>(
    'project',
    words.reduce((b, w) => b.ilike('name', `%${w}%`), base).order('updated_at', { ascending: false }).limit(words.length ? FETCH : limit),
  )
  return rank(
    rows.map((p) => ({ kind: 'project', id: p.id, title: p.name || 'Untitled project', status: p.status, score: scoreText(p.name, query) })),
    limit,
  )
}

async function searchInitiatives(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const base = supabase.from('initiative').select('id, name, status').eq('workspace_id', workspaceId).neq('status', 'archived')
  const rows = await rowsOf<NamedRow>(
    'initiative',
    words.reduce((b, w) => b.ilike('name', `%${w}%`), base).order('updated_at', { ascending: false }).limit(words.length ? FETCH : limit),
  )
  return rank(
    rows.map((i) => ({ kind: 'initiative', id: i.id, title: i.name || 'Untitled initiative', status: i.status, score: scoreText(i.name, query) })),
    limit,
  )
}

// ── Captures ─────────────────────────────────────────────────────────────────

const CAPTURE_COLUMNS =
  'id, title, summary, recorded_at, created_at, status, is_pinned, participants, duration_seconds, started_at, ended_at, ai_processed'

type CaptureRow = Omit<CaptureListItem, 'type'>

async function searchCaptures(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, userId, query, limit } = ctx
  const words = matchWords(query)
  const q = normalizeQuery(query)
  // The Captures page's rule: no archived ones, no eval mocks, no skipped auto-captures.
  const base = () =>
    supabase
      .from('captures')
      .select(CAPTURE_COLUMNS)
      .eq('workspace_id', workspaceId)
      .neq('status', 'archived')
      .neq('is_eval', true)
      .or('auto_capture_status.is.null,auto_capture_status.neq.skipped')
  const toRow = (c: CaptureRow, score: number): MenuSearchRow => ({
    kind: 'capture',
    capture: { ...c, type: 'capture', ai_processed: c.ai_processed ?? false },
    score,
  })

  // Nothing typed: your own recent captures (as the @ menu always listed).
  if (!words.length) {
    const rows = await rowsOf<CaptureRow>(
      'capture',
      base().eq('user_id', userId).order('recorded_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false }).limit(limit),
    )
    return rows.map((c) => toRow(c, 0))
  }
  // Typed: every capture you may see (RLS; the visibility rule kept explicit, as the list route does).
  const visible = () => base().or(`visibility.eq.workspace,user_id.eq.${userId}`)
  const [title, body] = await Promise.all([
    rowsOf<CaptureRow>(
      'capture',
      words
        .reduce((b, w) => b.ilike('title', `%${w}%`), visible())
        .order('recorded_at', { ascending: false, nullsFirst: false })
        .limit(FETCH),
    ),
    q.length >= BODY_MIN_QUERY
      ? rowsOf<CaptureRow>(
          'capture',
          visible()
            .textSearch('fts', query.trim(), { type: 'websearch', config: 'english' })
            .order('recorded_at', { ascending: false, nullsFirst: false })
            .limit(FETCH),
        )
      : Promise.resolve([] as CaptureRow[]),
  ])
  return rank(
    mergeById(title, body).map((c) => toRow(c, scoreText(c.title, q) || BODY_MATCH_SCORE)),
    limit,
  )
}

// ── People ───────────────────────────────────────────────────────────────────

async function searchContacts(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const base = supabase
    .from('contact')
    .select('id, full_name, email, job_title, member_id, company:company_id(id, name)')
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
  const rows = await rowsOf<ContactApiRow>(
    'contact',
    words
      .reduce((b, w) => b.or(`full_name.ilike.%${w}%,email.ilike.%${w}%`), base)
      .order('last_interaction_at', { ascending: false, nullsFirst: false })
      .limit(words.length ? FETCH : limit),
  )
  return rank(
    rows.map((row) => {
      // A name match is the match; an email-only one ("acme" in maya@acme.com)
      // is incidental, so it never outranks a company actually named that.
      const byName = scoreText(row.full_name, query)
      const byEmail = scoreText(row.email, query)
      return { kind: 'contact' as const, contact: toMentionContact(row), score: byName || (byEmail ? Math.min(byEmail, 0.4) : 0) }
    }),
    limit,
  )
}

// ── Companies ────────────────────────────────────────────────────────────────

async function searchCompanies(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { service, workspaceId, userId, query, limit } = ctx
  const term = matchWords(query).join(' ')
  const { data, error } = await service.rpc('list_companies_with_stats', {
    p_workspace_id: workspaceId,
    p_search: term || null,
    p_limit: term ? FETCH : limit,
    p_offset: 0,
    p_user_id: userId,
  })
  if (error) {
    console.error('[menu-search] company failed:', error)
    return []
  }
  return rank(
    ((data ?? []) as CompanyApiRow[]).map((row) => ({
      kind: 'company' as const,
      company: toMentionCompany(row),
      score: bestScore(scoreText(row.name, query), scoreText(row.domain, query) ? 0.4 : 0),
    })),
    limit,
  )
}

// ── Deals and flows (names only) ─────────────────────────────────────────────

interface DealRow {
  id: string
  title: string | null
  table_id: string
  stage: string | null
}

/** Deals: a pipeline's rows (Tables, phase 7), as RLS lets the person read their pipelines. */
async function searchDeals(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const base = supabase
    .from('data_row')
    .select('id, title, table_id, stage:custom_fields->>stage, data_table!inner(kind)')
    .eq('workspace_id', workspaceId)
    .eq('data_table.kind', 'pipeline')
    .is('archived_at', null)
  const rows = await rowsOf<DealRow>(
    'deal',
    words.reduce((b, w) => b.ilike('title', `%${w}%`), base).order('updated_at', { ascending: false }).limit(words.length ? FETCH : limit),
  )
  return rank(
    rows.map((d) => ({ kind: 'deal', id: d.id, pipelineId: d.table_id, title: d.title || 'Untitled deal', status: d.stage ?? null, score: scoreText(d.title, query) })),
    limit,
  )
}

interface FlowRow {
  id: string
  name: string | null
  enabled: boolean | null
}

async function searchFlows(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  const words = matchWords(query)
  const base = supabase.from('flow').select('id, name, enabled').eq('workspace_id', workspaceId)
  const rows = await rowsOf<FlowRow>(
    'flow',
    words.reduce((b, w) => b.ilike('name', `%${w}%`), base).order('updated_at', { ascending: false }).limit(words.length ? FETCH : limit),
  )
  return rank(
    rows.map((f) => ({ kind: 'flow', id: f.id, title: f.name || 'Untitled flow', status: f.enabled ? 'On' : 'Off', score: scoreText(f.name, query) })),
    limit,
  )
}

// ── Agents ───────────────────────────────────────────────────────────────────

async function searchAgents(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit, excludedRecipeIds } = ctx
  // Nothing typed: none (the Agents & skills page lists them).
  if (!query.trim()) return []
  const rows = await searchRecipes(supabase as unknown as SupabaseLike, {
    workspaceId,
    query,
    categories: ['agent'],
    limit,
    excludeIds: excludedRecipeIds,
  })
  return rows.map((r) => ({
    kind: 'agent' as const,
    id: r.result_id,
    title: r.title,
    description: r.subtitle || null,
    icon: null,
    score: r.rank,
  }))
}

// ── Team chat messages ───────────────────────────────────────────────────────

interface TeamChatHitRow {
  id: string
  channel_id: string
  thread_root_id: string | null
  place: string | null
  author_name: string | null
  snippet: string | null
  created_at: string
}

/** A message matches by its words only, under any record's title match (a message is seldom what's looked for first). */
export const MESSAGE_MATCH_SCORE = BODY_MATCH_SCORE

async function searchTeamChatMessages(ctx: MenuQueryContext): Promise<MenuSearchRow[]> {
  const { supabase, workspaceId, query, limit } = ctx
  // Nothing typed, or too little to be a word: none (team chat lists its own).
  if (normalizeQuery(query).length < 2) return []
  const rows = await rowsOf<TeamChatHitRow>('team_chat_message', supabase.rpc('team_chat_search', { ws: workspaceId, q: query.slice(0, 200), lim: limit }))
  return rows.map((r) => ({
    kind: 'team_chat_message' as const,
    id: r.id,
    title: (r.snippet ?? '').replace(/\s+/g, ' ').trim() || 'A message',
    place: r.place ?? 'Team chat',
    author: r.author_name ?? 'A teammate',
    channelId: r.channel_id,
    threadRootId: r.thread_root_id,
    createdAt: r.created_at,
    score: MESSAGE_MATCH_SCORE,
  }))
}

export const MENU_QUERIES: Record<MenuSearchKind, (ctx: MenuQueryContext) => Promise<MenuSearchRow[]>> = {
  action: searchActions,
  document: searchDocuments,
  project: searchProjects,
  initiative: searchInitiatives,
  capture: searchCaptures,
  contact: searchContacts,
  company: searchCompanies,
  deal: searchDeals,
  flow: searchFlows,
  agent: searchAgents,
  team_chat_message: searchTeamChatMessages,
}
