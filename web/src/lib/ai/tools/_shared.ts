import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { grantedEntityIds, grantedIdsIn, withGrantedIds } from '@/lib/entity-access/grants'

/**
 * Standard time-window preset vocabulary, shared across all list_* tools.
 *
 * Use the same set of presets for any tool that accepts `since` / `until`
 * so agents can rely on a single naming convention.
 *
 * Calendar windows (anchored to date boundaries):
 *   today, yesterday, tomorrow
 *   this_week, last_week, next_week        (Monday-anchored)
 *   this_month, last_month, next_month
 *   this_year
 *
 * Sliding windows:
 *   past_7_days, past_30_days, past_90_days   — N days ending at end-of-today
 *                                                (since = start-of-today − N days)
 *   next_7_days, next_30_days                 — N days starting from now,
 *                                                inclusive of today as day 1
 *                                                (since = now, until = end-of-day +N−1)
 */
const TIME_PRESETS = [
  'today',
  'yesterday',
  'tomorrow',
  'this_week',
  'last_week',
  'next_week',
  'this_month',
  'last_month',
  'next_month',
  'this_year',
  'past_7_days',
  'past_30_days',
  'past_90_days',
  'next_7_days',
  'next_30_days',
] as const

export type TimePreset = (typeof TIME_PRESETS)[number]

function startOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

function endOfToday(now: Date): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
}

/** Monday=1, Sunday=7 */
function isoDay(d: Date): number {
  return d.getDay() || 7
}

/**
 * Add `n` days to `d` using local-date arithmetic.
 *
 * Returns a new Date — does not mutate the input. Critical: we use
 * `setDate(getDate() + n)` rather than millisecond arithmetic so that
 * DST transitions don't shift the result by an hour. Adding `86_400_000`
 * to a local-midnight on the day of a DST change lands at 23:00 or 01:00
 * local instead of midnight.
 */
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

/**
 * Resolve a `since` preset or ISO date to a UTC ISO timestamp.
 * Presets resolve to the START of the period (e.g. "today" → 00:00:00 local).
 * Returns null for invalid input — callers treat this as "no lower bound".
 */
export function resolveSince(value: string | undefined): string | null {
  if (!value) return null
  const now = new Date()
  const sod = startOfToday(now)

  switch (value) {
    case 'today':
      return sod.toISOString()
    case 'yesterday':
      return addDays(sod, -1).toISOString()
    case 'tomorrow':
      return addDays(sod, 1).toISOString()
    case 'this_week':
      return addDays(sod, -(isoDay(sod) - 1)).toISOString()
    case 'last_week':
      return addDays(sod, -(isoDay(sod) - 1 + 7)).toISOString()
    case 'next_week':
      return addDays(sod, 8 - isoDay(sod)).toISOString()
    case 'this_month':
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString()
    case 'last_month':
      return new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString()
    case 'next_month':
      return new Date(now.getFullYear(), now.getMonth() + 1, 1).toISOString()
    case 'this_year':
      return new Date(now.getFullYear(), 0, 1).toISOString()
    case 'past_7_days':
      return addDays(sod, -7).toISOString()
    case 'past_30_days':
      return addDays(sod, -30).toISOString()
    case 'past_90_days':
      return addDays(sod, -90).toISOString()
    // For forward-looking sliding windows, anchor the lower bound at "now"
    // (not start-of-today) so the window covers exactly N days from this moment.
    // Paired with `until` returning end-of-day +N, the total span is N days inclusive.
    case 'next_7_days':
    case 'next_30_days':
      return now.toISOString()
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Resolve an `until` preset or ISO date to a UTC ISO timestamp.
 * Presets resolve to the END of the period (e.g. "today" → 23:59:59.999 local).
 * Returns null for invalid input — callers treat this as "no upper bound".
 */
export function resolveUntil(value: string | undefined): string | null {
  if (!value) return null
  const now = new Date()
  const eod = endOfToday(now)

  switch (value) {
    case 'today':
      return eod.toISOString()
    case 'yesterday':
      return addDays(eod, -1).toISOString()
    case 'tomorrow':
      return addDays(eod, 1).toISOString()
    case 'this_week':
      return addDays(eod, 7 - isoDay(eod)).toISOString()
    case 'last_week':
      return addDays(eod, -isoDay(eod)).toISOString()
    case 'next_week':
      return addDays(eod, 14 - isoDay(eod)).toISOString()
    case 'this_month':
      return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).toISOString()
    case 'last_month':
      return new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999).toISOString()
    case 'next_month':
      return new Date(now.getFullYear(), now.getMonth() + 2, 0, 23, 59, 59, 999).toISOString()
    case 'this_year':
      return new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).toISOString()
    case 'past_7_days':
    case 'past_30_days':
    case 'past_90_days':
      return eod.toISOString()
    // Forward-looking sliding windows: `next_7_days` should span exactly 7 days
    // counting today as day 1. So the upper bound is end-of-day +6 (today + 6 = 7 days).
    case 'next_7_days':
      return addDays(eod, 6).toISOString()
    case 'next_30_days':
      return addDays(eod, 29).toISOString()
  }

  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

/**
 * Reusable Zod fragment for time-window params. Spread into any list_* tool's
 * inputSchema so the agent sees a consistent shape across tools.
 *
 * Example:
 *   inputSchema: z.object({
 *     ...timeWindowParams,
 *     time_field: z.enum(['due_at', 'created_at']).optional(),
 *     ...
 *   })
 */
export const timeWindowParams = {
  since: z
    .string()
    .optional()
    .describe(
      'Lower-bound time filter. Accepts a preset (today, yesterday, tomorrow, this_week, last_week, next_week, this_month, last_month, next_month, this_year, past_7_days, past_30_days, past_90_days, next_7_days, next_30_days) or an ISO date.',
    ),
  until: z
    .string()
    .optional()
    .describe(
      'Upper-bound time filter. Accepts the same presets as `since` or an ISO date.',
    ),
} as const

/**
 * Return a friendly display label for an entity whose `name` column may be
 * empty or null in the DB (one-off bad data, race during creation, etc.).
 *
 * Why: agents that render names verbatim into responses produce output like
 * `Move to ""` or `Sprint 3 ()` when the underlying row has an empty name.
 * Fall back through provided alternates (slug, identifier, prefix), then to
 * a generic placeholder so the agent always has SOMETHING to say.
 *
 * The function does NOT mutate the underlying row — callers should still
 * surface the raw `name` field separately so the agent can detect the
 * problem if it cares.
 */
export function displayName(
  name: string | null | undefined,
  ...fallbacks: Array<string | null | undefined>
): string {
  const candidates = [name, ...fallbacks]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c.trim()
  }
  return '(unnamed)'
}

/** How many rows a fuzzy name or title lookup reads to tell one match from several. */
export const FUZZY_MATCH_LIMIT = 10

/**
 * The one row a fuzzy name or title lookup (`ilike '%x%'`) means, or null when
 * it can't tell. These lookups search everyone's rows in the workspace, so
 * "follow up" can match a teammate's action or a finished one: a row is taken
 * only when it is the only match, or the only one whose text is exactly the
 * needle (ignoring case and outer spaces). Callers refuse with the matches
 * otherwise, never acting on whichever row came first.
 */
export function soleMatch<T>(rows: readonly T[], text: (row: T) => string | null | undefined, needle: string): T | null {
  if (rows.length === 1) return rows[0]
  const want = needle.trim().toLowerCase()
  const exact = rows.filter((r) => (text(r) ?? '').trim().toLowerCase() === want)
  return exact.length === 1 ? exact[0] : null
}

/** "ENG-1 "Ship it", ENG-7 "Ship it now"": the matches, for an ambiguity refusal. */
export function listMatches(labels: readonly string[]): string {
  const shown = labels.slice(0, FUZZY_MATCH_LIMIT).join(', ')
  return labels.length >= FUZZY_MATCH_LIMIT ? `${shown}, and maybe more` : shown
}

/**
 * Effective capture-visibility requester for a tool factory.
 *
 * `null` means "no requester" — only `visibility = 'workspace'` captures are
 * reachable. Unattended runs (skills/loops/work-runs) pass null even though
 * they run "as" a user, because their outputs land in workspace-readable
 * tables. See docs/design-capture-visibility.md.
 *
 * NOTE: this stays `string | null` because the value is threaded verbatim into
 * the visibility-aware SECURITY DEFINER RPCs as `p_requesting_user_id`
 * (search.ts, claims.ts). The eval fence is a SEPARATE, orthogonal axis — see
 * {@link applyCaptureVisibility}'s `includeEvalCaptures`.
 */
export type CaptureRequester = string | null

/** Resolve the requester for a capture filter: null when private captures are omitted. */
export function captureRequester(userId: string, omitPrivateCaptures?: boolean): CaptureRequester {
  return omitPrivateCaptures ? null : userId
}

/**
 * EVAL captures (`captures.is_eval`, migration 252) are synthetic mock meetings
 * authored by the Evals surface. They are real `captures` rows — that is what
 * lets the unmodified live-agent engine run against them — so every read path
 * has to fence them out or a mock sales call surfaces in the Captures list, a
 * CRM company card, an outreach draft, or the knowledge graph.
 *
 * DEFAULT-EXCLUDE, and deliberately so: a forgotten flag then fails CLOSED (an
 * Evals screen shows nothing, which is loud) rather than open (a synthetic
 * meeting leaks into the product, which is silent). Only the Evals surface
 * passes `includeEvalCaptures: true`.
 *
 * This predicate — not RLS — is the enforcement. RLS on `captures` stays
 * untouched: three things the feature itself depends on (the nudge channel's
 * subscribe policy, the SECURITY INVOKER transcript-append RPC, and the Evals
 * screens) run as the caller's `authenticated` role, and Postgres permissive
 * policies OR together, so a companion allow-policy would re-admit eval rows
 * everywhere. See docs/plans/evals.md §5.2.
 */
export type EvalCaptureScope = boolean | undefined

/**
 * Constrain a `captures` query to rows the requester may see.
 *
 * These tools run on SERVICE-ROLE clients (RLS bypassed), so this predicate —
 * not RLS — is the real enforcement. Fails closed twice over: a null requester
 * sees only workspace-visible captures, and eval captures are excluded unless
 * `includeEvalCaptures` is explicitly true (see {@link EvalCaptureScope}).
 *
 * `granted`: for a READ, the capture ids a per-item grant opens to the
 * requester ({@link readGrants}, migration 506): another member's private
 * capture shared with them. Never for a write gate: a grant is view-only.
 * Ignored without a requester (an unattended run reads no grant).
 */
export function applyCaptureVisibility<T>(
  query: T,
  requester: CaptureRequester,
  includeEvalCaptures?: EvalCaptureScope,
  granted?: readonly string[],
): T {
  type Q = {
    or: (f: string) => T
    eq: (col: string, val: unknown) => T
    neq: (col: string, val: unknown) => T
  }
  // `neq.true` rather than `eq.false`: identical for the NOT NULL boolean the
  // migration adds, but it also passes a NULL — so a row written before the
  // column landed can never disappear from a product surface.
  const q = query as unknown as Q
  const scoped = (includeEvalCaptures ? query : q.neq('is_eval', true)) as unknown as Q
  return requester
    ? scoped.or(`visibility.eq.workspace,user_id.eq.${requester}${grantArm(granted)}`)
    : scoped.eq('visibility', 'workspace')
}

const GRANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The `,id.in.(…)` arm a grant adds to a visibility `or`, or nothing. Only well-formed uuids reach the filter. */
function grantArm(granted: readonly string[] | undefined): string {
  const ids = [...new Set((granted ?? []).filter((id) => typeof id === 'string' && GRANT_ID_RE.test(id)))]
  return ids.length ? `,id.in.(${ids.join(',')})` : ''
}

/**
 * Same predicate, applied to an embedded `captures` relation on another table's
 * query (e.g. `proposed_change` with `capture:captures!capture_id!inner(...)`).
 * `alias` is the embed alias as it appears in the select string.
 */
export function applyEmbeddedCaptureVisibility<T>(
  query: T,
  requester: CaptureRequester,
  alias: string,
  includeEvalCaptures?: EvalCaptureScope,
  /** For a READ only, as applyCaptureVisibility's. */
  granted?: readonly string[],
): T {
  type Q = {
    or: (f: string, opts: { referencedTable: string }) => T
    eq: (col: string, val: unknown) => T
    neq: (col: string, val: unknown) => T
  }
  const q = query as unknown as Q
  const scoped = (includeEvalCaptures ? query : q.neq(`${alias}.is_eval`, true)) as unknown as Q
  return requester
    ? scoped.or(`visibility.eq.workspace,user_id.eq.${requester}${grantArm(granted)}`, { referencedTable: alias })
    : scoped.eq(`${alias}.visibility`, 'workspace')
}

/**
 * Is this capture row visible to the requester? Fails closed on a missing row,
 * and on an eval capture unless `includeEvalCaptures` is explicitly true.
 *
 * Callers must SELECT `is_eval` alongside `visibility, user_id` for the eval
 * fence to bite — an absent column reads as `undefined`, which is not `true`,
 * so the row passes. That is the same posture the `visibility` re-check has
 * always had: this is a defence-in-depth re-check of a predicate the query
 * already applied, not the primary fence.
 */
export function isCaptureVisible(
  capture:
    | { id?: string | null; visibility?: string | null; user_id?: string | null; is_eval?: boolean | null }
    | null
    | undefined,
  requester: CaptureRequester,
  includeEvalCaptures?: EvalCaptureScope,
  /** For a READ only: capture ids a grant opens to the requester (select `id` too). */
  granted?: ReadonlySet<string>,
): boolean {
  if (!capture) return false
  if (!includeEvalCaptures && capture.is_eval === true) return false
  if (capture.visibility !== 'private') return true
  if (requester === null) return false
  return capture.user_id === requester || (!!capture.id && !!granted?.has(capture.id))
}

/**
 * Fetch a capture's visibility columns and decide whether the requester may see
 * it. Used by ID-based tools AFTER resolveEntityWorkspace, so an invisible
 * capture returns the tool's normal not-found error (never leaks existence).
 */
export async function captureVisibleToRequester(
  supabase: SupabaseClient,
  captureId: string,
  workspaceId: string,
  requester: CaptureRequester,
  includeEvalCaptures?: EvalCaptureScope,
): Promise<boolean> {
  const { data } = await supabase
    .from('captures')
    .select('visibility, user_id, is_eval')
    .eq('id', captureId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return isCaptureVisible(
    data as { visibility?: string | null; user_id?: string | null; is_eval?: boolean | null } | null,
    requester,
    includeEvalCaptures,
  )
}

/**
 * READ ACCESS, the agent's twin of the read policies (493): what a tool that
 * only READS may show the requester. Everything captureVisibleToRequester /
 * documentVisibleToRequester let through, plus another member's private
 * record a per-item grant (492) opens to them: as the member, through a team
 * they are in, or through a channel they can read (src/lib/entity-access/
 * grants.ts, the TypeScript mirror of has_entity_grant).
 *
 * Never a WRITE gate. A grant is view-only (492, 494): every tool that
 * changes a capture or a document keeps asking the ungranted rule, so a
 * shared record reads like the person's own and changes like someone
 * else's. An unattended run (no requester, `omitPrivate`) reads no grant,
 * as it reads no private record at all.
 *
 * The answer says how: 'rule' (its own rule lets them, as before), 'grant'
 * (only a grant does: a view-only read, which a tool may say so), or null
 * (not at all, indistinguishable from a missing row).
 *
 * Fails CLOSED: a failed grant read is "no grant".
 */
export type ReadAccess = 'rule' | 'grant' | null

export async function captureReadAccess(
  supabase: SupabaseClient,
  captureId: string,
  workspaceId: string,
  requester: CaptureRequester,
  includeEvalCaptures?: EvalCaptureScope,
  /** False on a turn that reads no grant (see grantReader): the ungranted rule only. */
  grants = true,
): Promise<ReadAccess> {
  if (await captureVisibleToRequester(supabase, captureId, workspaceId, requester, includeEvalCaptures)) return 'rule'
  if (!requester || !grants) return null
  // withGrantedIds re-reads the row in this workspace and leaves an eval capture out.
  const granted = await withGrantedIds(supabase, { userId: requester, workspaceId }, 'capture', [captureId], [])
  return granted.has(captureId) ? 'grant' : null
}

/**
 * WHO A TURN'S GRANTS ARE FOR. A grant shares a record with a person, not
 * with whoever their agent talks to: a guest's turn and a linked agent's
 * turn run the owner's tools (src/lib/guests/guest-tools.ts) and must not
 * pass on what was shared with the owner. Those turns build their tools with
 * `omitGrants` (CreateToolsOptions), and every grant read then reads
 * nothing: grantReader hands back null for readGrants and grantedReadIds,
 * and captureReadAccess / documentReadAccess take `grants: false`.
 */
export function grantReader(userId: string | null, omitGrants: boolean | undefined): string | null {
  return omitGrants ? null : userId
}

/**
 * What a list READ adds to its visibility predicate: every capture and
 * document id in `workspaceId` a grant opens to `userId`, one call per kind
 * (migration 506's entity_grant_ids_for; at most LIST_GRANT_CAP each). For
 * applyCaptureVisibility / applyDocumentVisibility's `granted`, and
 * isCaptureVisible / isDocumentVisible's. Empty for an unattended run or a
 * turn that reads no grant (`userId` null, grantReader) or a failed read.
 * Never for a write gate. `truncated`: more were shared than a list names,
 * which the tool says (GRANTS_TRUNCATED_NOTE).
 */
export async function readGrants(
  supabase: SupabaseClient,
  userId: string | null,
  workspaceId: string,
  kinds: ReadonlyArray<'capture' | 'document'> = ['capture', 'document'],
): Promise<{ capture: string[]; document: string[]; truncated: boolean }> {
  if (!userId) return { capture: [], document: [], truncated: false }
  const none = { ids: [] as string[], truncated: false }
  const [capture, document] = await Promise.all([
    kinds.includes('capture') ? grantedIdsIn(supabase, { userId, workspaceId }, 'capture') : Promise.resolve(none),
    kinds.includes('document') ? grantedIdsIn(supabase, { userId, workspaceId }, 'document') : Promise.resolve(none),
  ])
  return { capture: capture.ids, document: document.ids, truncated: capture.truncated || document.truncated }
}

/** What a list says when more records were shared with the person than it can name. */
export const GRANTS_TRUNCATED_NOTE =
  'More records are shared with you than one list includes: only the most recently shared are here. Open an older one by its id.'


/** Ids among `ids` (records of `type` in `workspaceId`) a grant opens to `userId`; none for an unattended run. For a READ only. */
export async function grantedReadIds(
  supabase: SupabaseClient,
  userId: string | null,
  workspaceId: string,
  type: 'capture' | 'document',
  ids: readonly string[],
): Promise<Set<string>> {
  if (!userId || ids.length === 0) return new Set()
  return grantedEntityIds(supabase, { userId, workspaceId }, type, ids)
}

/**
 * Private documents (migration 369), the twin of the capture rule above: a
 * 'private' document is visible only to its creator, and a document's creator
 * is a MEMBER row (document.created_by), not an auth uid. So the requester for
 * a document filter is the caller's member row in the document's workspace,
 * or null when private documents are omitted (an unattended run: its output
 * lands in workspace-readable tables, so it reads no private document, not
 * even its run-as person's own) or the caller isn't a member there. A null
 * requester sees workspace documents only (fail closed).
 */
export type DocumentRequester = string | null

/** The caller's member row in `workspaceId` for the document rule, or null. */
export async function documentRequesterMember(
  supabase: SupabaseClient,
  userId: string,
  workspaceId: string,
  omitPrivate?: boolean,
): Promise<DocumentRequester> {
  if (omitPrivate) return null
  const { data } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return ((data as { id?: string } | null)?.id as string | undefined) ?? null
}

/**
 * Constrain a `document` query to rows the requester may see: workspace
 * documents, plus their own private ones. These tools run on SERVICE-ROLE
 * clients, so this predicate (not RLS) is the enforcement.
 */
export function applyDocumentVisibility<T>(query: T, requester: DocumentRequester, granted?: readonly string[]): T {
  type Q = { or: (f: string) => T; eq: (col: string, val: unknown) => T }
  const q = query as unknown as Q
  // `granted` (a READ only, readGrants): private documents a grant opens to the requester.
  return requester ? q.or(`visibility.eq.workspace,created_by.eq.${requester}${grantArm(granted)}`) : q.eq('visibility', 'workspace')
}

/** Is this document row visible to the requester? Fails closed on a missing row. Select `visibility, created_by`. */
export function isDocumentVisible(
  doc: { id?: string | null; visibility?: string | null; created_by?: string | null } | null | undefined,
  requester: DocumentRequester,
  /** For a READ only: document ids a grant opens to the requester (select `id` too). */
  granted?: ReadonlySet<string>,
): boolean {
  if (!doc) return false
  if ((doc.visibility ?? 'workspace') !== 'private') return true
  if (requester === null) return false
  return (doc.created_by != null && doc.created_by === requester) || (!!doc.id && !!granted?.has(doc.id))
}

/**
 * captureVisibleToRequester's document twin (migration 369): can `userId` see
 * this document in `workspaceId`? A workspace document, or their own private
 * one; under `omitPrivate` (an unattended run) no private document at all.
 * False for a missing document.
 */
export async function documentVisibleToRequester(
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
  userId: string,
  omitPrivate?: boolean,
): Promise<boolean> {
  const { data } = await supabase
    .from('document')
    .select('visibility, created_by')
    .eq('id', documentId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  const doc = data as { visibility?: string | null; created_by?: string | null } | null
  if (!doc) return false
  if ((doc.visibility ?? 'workspace') !== 'private') return true
  return isDocumentVisible(doc, await documentRequesterMember(supabase, userId, workspaceId, omitPrivate))
}

/**
 * documentVisibleToRequester for a READ (see captureReadAccess): plus a
 * private document a grant opens to `userId` ('grant'). Under `omitPrivate`
 * (an unattended run) no grant. Never a write gate.
 */
export async function documentReadAccess(
  supabase: SupabaseClient,
  documentId: string,
  workspaceId: string,
  userId: string,
  omitPrivate?: boolean,
  /** False on a turn that reads no grant (grantReader): the ungranted rule only. */
  grants = true,
): Promise<ReadAccess> {
  if (await documentVisibleToRequester(supabase, documentId, workspaceId, userId, omitPrivate)) return 'rule'
  if (omitPrivate || !grants) return null
  const granted = await withGrantedIds(supabase, { userId, workspaceId }, 'document', [documentId], [])
  return granted.has(documentId) ? 'grant' : null
}

/**
 * Resolve every workspace this user is a member of.
 *
 * IMPORTANT: The MCP server uses a service-role Supabase client (RLS-bypassed),
 * so callers MUST use this list to constrain workspace_id filters in their
 * subsequent queries. Do not pass user-supplied workspace IDs through unchecked.
 */
export async function getUserWorkspaces(
  supabase: SupabaseClient,
  userId: string,
): Promise<Array<{ id: string; name: string }>> {
  const { data } = await supabase
    .from('member')
    .select('workspace:workspace_id(id, name)')
    .eq('user_id', userId)
  return (data || [])
    .map((m) => m.workspace as unknown as { id: string; name: string } | null)
    .filter((w): w is { id: string; name: string } => Boolean(w))
}

/**
 * Resolve the effective workspace for an entity lookup that may not live in
 * the session's current workspace.
 *
 * Why this exists: ID-based tools (`get_document`, `update_action`, etc.)
 * historically required the caller to set the active workspace first. But
 * users now copy entity IDs from the UI into AI prompts — by the time the
 * agent runs the tool, the session workspace may be different.
 *
 * Behavior:
 *   1. If the row exists in `currentWorkspaceId`, return that — fast path,
 *      no behavior change for in-workspace lookups.
 *   2. Otherwise, look up the row's actual workspace and verify the user
 *      is a member there.
 *   3. If the user is a member of the row's workspace, return that
 *      workspace_id so the caller can re-scope the query.
 *   4. If not found anywhere accessible, return null.
 *
 * Returns the resolved workspace_id (or null) plus a flag indicating whether
 * a cross-workspace resolution happened, so tools can surface a hint to the
 * agent ("this lives in workspace X, not the active one").
 *
 * `strictWorkspace` (default false — chat behavior byte-identical) HARD-FENCES the
 * lookup to `currentWorkspaceId`: the cross-workspace slow path is skipped entirely,
 * so an entity that lives in a DIFFERENT workspace resolves to `null` (the same
 * not-found shape as a nonexistent id — it never leaks that the id exists elsewhere).
 * Unattended runs (work-run / skill-run) that build tools with a service-role client
 * MUST pass true: the run is fenced to exactly one workspace, and a model-authored id
 * for another workspace the user happens to belong to must not be reachable.
 */
export async function resolveEntityWorkspace(
  supabase: SupabaseClient,
  userId: string,
  table: string,
  id: string,
  currentWorkspaceId: string,
  strictWorkspace = false,
): Promise<{ workspaceId: string; crossWorkspace: boolean } | null> {
  // Fast path: row in the current workspace.
  const { data: inCurrent } = await supabase
    .from(table)
    .select('workspace_id')
    .eq('id', id)
    .eq('workspace_id', currentWorkspaceId)
    .maybeSingle()

  if (inCurrent) {
    return { workspaceId: currentWorkspaceId, crossWorkspace: false }
  }

  // Strict: never leave the bound workspace. A row in another workspace is treated
  // as not-found, exactly as a nonexistent id would be.
  if (strictWorkspace) return null

  // Slow path: find the row anywhere, then verify membership.
  const { data: anywhere } = await supabase
    .from(table)
    .select('workspace_id')
    .eq('id', id)
    .maybeSingle()

  if (!anywhere?.workspace_id) return null

  const { data: membership } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', userId)
    .eq('workspace_id', anywhere.workspace_id)
    .maybeSingle()

  if (!membership) return null

  return { workspaceId: anywhere.workspace_id as string, crossWorkspace: true }
}

/* ───────────────────────────────────────────────────────────────────────────
 * CREATE-TIME WORKSPACE ROUTING
 * ───────────────────────────────────────────────────────────────────────────
 *
 * {@link resolveEntityWorkspace} routes everything that already EXISTS: the row
 * names its own workspace, so an update / complete / delete can follow the id
 * wherever it lives and the session's "active workspace" is demoted from a fence
 * to a default. A CREATE has no such target — there is nothing to route BY — so
 * it silently landed in whichever workspace the session happened to point at.
 *
 * That default IS the original bug. An agent reads ENG-42 out of Engineering (a
 * row that plainly carries `workspace_id: engineering`), is told "file a
 * follow-up for that", and the follow-up is written into Native Intelligence Marketing —
 * because the CONNECTOR was pointed there. Nothing in the turn says otherwise,
 * so the user finds out days later, on the wrong board.
 *
 * The fix is a protocol, not a new fence:
 *   1. every create tool takes an optional `workspace_id`;
 *   2. an explicit id wins, after a membership check;
 *   3. with no explicit id, {@link CreateWorkspacePolicy} decides whether to
 *      default to the session workspace or to REFUSE and ask;
 *   4. every create result echoes {@link workspaceEcho} so a mis-route is
 *      visible in the same turn rather than days later.
 */

/**
 * What a create tool does when the caller passes no `workspace_id`.
 *
 *   'session'  — DEFAULT, and byte-identical to today: fall back to the
 *                session workspace. Correct for surfaces where the session
 *                workspace is something the HUMAN just chose and can see:
 *                in-app chat (the workspace switcher), the live agent, the
 *                device ask route, and unattended work-/skill-runs (which are
 *                additionally fenced by `strictWorkspace`).
 *
 *   'explicit' — the MCP bridge. Fall back only when the fallback cannot be
 *                wrong (the user belongs to exactly ONE workspace); otherwise
 *                return {@link NeedsWorkspaceError} listing the candidates.
 *                An MCP connector's "active workspace" is a months-old OAuth
 *                artifact that no human looked at this turn, so defaulting to
 *                it is precisely how the wrong-workspace bug happens. One
 *                cheap refusal beats a silent write into another tenant.
 *
 * Plumbed through `CreateToolsOptions.createWorkspacePolicy` (see ./index.ts).
 */
export type CreateWorkspacePolicy = 'session' | 'explicit'

/**
 * Structured refusal: the create cannot proceed because the target is genuinely
 * ambiguous. NOT an error the agent should retry verbatim — it is a question,
 * and `candidates` is the answer sheet, so the retry costs one turn and no
 * extra tool call.
 *
 * `error_type` is the machine-readable hook (`'needs_workspace'`); the prose in
 * `error` names the workspaces inline because plenty of clients surface only
 * the message string.
 */
export interface NeedsWorkspaceError {
  success: false
  error: string
  error_type: 'needs_workspace'
  candidates: Array<{ id: string; name: string; is_active: boolean }>
}

/** Not-found shape for a workspace the user may not write to. */
type WorkspaceNotFound = { success: false; error: string }

/**
 * The outcome of {@link resolveCreateWorkspace}. `workspaceName` is present
 * only when resolution already had to read it (the membership probe on an
 * explicit id, or the candidate list) — the session fast path deliberately does
 * NOT spend a round-trip on a name the in-app UI already displays. Feed it to
 * {@link workspaceEcho}; a null name is fine there.
 */
export type CreateWorkspaceResolution =
  | { ok: true; workspaceId: string; workspaceName: string | null; crossWorkspace: boolean }
  | { ok: false; error: NeedsWorkspaceError | WorkspaceNotFound }

/**
 * Decide which workspace a CREATE lands in.
 *
 * Resolution order — explicit id → policy → refusal:
 *
 *   1. `explicitWorkspaceId` === the session workspace → that, no probe.
 *   2. `explicitWorkspaceId` elsewhere → membership probe on `member`; a
 *      non-member gets the flat not-found shape. Under `strictWorkspace` the
 *      probe is SKIPPED and any foreign id is not-found — the same posture
 *      resolveEntityWorkspace takes, and for the same reason: for a run fenced
 *      to one workspace, even the timing of the refusal would be an existence
 *      oracle for other tenants.
 *   3. No explicit id, policy 'session' → the session workspace.
 *   4. No explicit id, policy 'explicit' → the user's one workspace if they
 *      have exactly one, otherwise {@link NeedsWorkspaceError}.
 *
 * Both failure modes return the tool's own refusal payload verbatim, so a
 * caller never has to re-shape them (see the snippet below).
 *
 * WHY the not-found shape never says which: "Workspace not found" is returned
 * both for an id that does not exist and for one the user is not a member of.
 * Distinguishing them would turn every create tool into a workspace-existence
 * oracle for the whole install.
 *
 * ── HOW TO APPLY IN A CREATE TOOL ───────────────────────────────────────────
 * Add `workspace_id: z.string().optional().describe('Workspace to create in.
 * Defaults to the active workspace. Copy it from the workspace_id on rows you
 * read, or from active_workspace.')` to the schema, then:
 *
 *     const ws = await resolveCreateWorkspace(supabase, userId, workspaceId, workspace_id, {
 *       strictWorkspace,
 *       policy: createWorkspacePolicy,
 *     })
 *     if (!ws.ok) return ws.error
 *     const targetWs = ws.workspaceId
 *     // re-point EVERY lookup this create does — team, workflow state, assignee,
 *     // label, project, cycle, milestone — at `targetWs`, never at `workspaceId`.
 *     // A default team or "Todo" state resolved in the session workspace and
 *     // written onto a row in `targetWs` is a cross-tenant foreign key.
 *     …
 *     return { success: true, …, ...workspaceEcho(targetWs, ws.workspaceName) }
 *
 * The echo is not optional: it is the only thing that makes a mis-route visible
 * in the same turn (compare it against `active_workspace` on the same result).
 */
export async function resolveCreateWorkspace(
  supabase: SupabaseClient,
  userId: string,
  sessionWorkspaceId: string,
  explicitWorkspaceId: string | undefined,
  opts: { strictWorkspace: boolean; policy: CreateWorkspacePolicy },
): Promise<CreateWorkspaceResolution> {
  const notFound = { ok: false as const, error: { success: false as const, error: 'Workspace not found' } }

  // ── 1/2. An explicit target wins, in every policy ─────────────────────────
  if (explicitWorkspaceId) {
    if (explicitWorkspaceId === sessionWorkspaceId) {
      return { ok: true, workspaceId: sessionWorkspaceId, workspaceName: null, crossWorkspace: false }
    }
    // Fenced run: no probe at all, so the refusal carries no timing signal.
    if (opts.strictWorkspace) return notFound

    const { data: membership } = await supabase
      .from('member')
      .select('id, workspace:workspace_id(name)')
      .eq('user_id', userId)
      .eq('workspace_id', explicitWorkspaceId)
      .maybeSingle()

    if (!membership) return notFound
    const name = (membership as { workspace?: { name?: string | null } | null }).workspace?.name ?? null
    return { ok: true, workspaceId: explicitWorkspaceId, workspaceName: name, crossWorkspace: true }
  }

  // ── 3. No target, and the session workspace is an answer we trust ─────────
  // `strictWorkspace` short-circuits here even under 'explicit': the run is
  // bound to exactly one workspace, so there is nothing to disambiguate and a
  // needs_workspace refusal would just be an unanswerable question.
  if (opts.policy === 'session' || opts.strictWorkspace) {
    return { ok: true, workspaceId: sessionWorkspaceId, workspaceName: null, crossWorkspace: false }
  }

  // ── 4. No target, and defaulting could silently pick the wrong tenant ─────
  const workspaces = await getUserWorkspaces(supabase, userId)

  // Zero rows means the membership read failed or raced, not that the user is
  // homeless — they are mid-call in `sessionWorkspaceId`. Fail SOFT to today's
  // behaviour rather than blocking a create on a transient read.
  if (workspaces.length === 0) {
    return { ok: true, workspaceId: sessionWorkspaceId, workspaceName: null, crossWorkspace: false }
  }

  if (workspaces.length === 1) {
    const only = workspaces[0]
    return {
      ok: true,
      workspaceId: only.id,
      workspaceName: only.name ?? null,
      crossWorkspace: only.id !== sessionWorkspaceId,
    }
  }

  // Active first, then membership order — deterministic, and it puts the most
  // likely answer where a truncating client will still show it.
  const candidates = workspaces
    .map((w) => ({
      id: w.id,
      name: displayName(w.name, w.id),
      is_active: w.id === sessionWorkspaceId,
    }))
    .sort((a, b) => Number(b.is_active) - Number(a.is_active))

  const listed = candidates.map((c) => (c.is_active ? `${c.name} [active]` : c.name)).join(', ')

  return {
    ok: false,
    error: {
      success: false,
      error:
        `Specify workspace_id: you belong to ${candidates.length} workspaces (${listed}). ` +
        'Use the workspace_id from the rows you read, or active_workspace.',
      error_type: 'needs_workspace',
      candidates,
    },
  }
}

/**
 * The `workspace: { id, name }` block every create result carries.
 *
 * Spreadable by design — `{ success: true, action, ...workspaceEcho(targetWs) }`
 * — so adding it to a create tool is one token at the end of the return, not a
 * restructure of the payload.
 *
 * Why an echo at all: the MCP envelope already stamps `active_workspace` on
 * every result, so `workspace.id !== active_workspace.id` is the agent's (and
 * the user's) in-band proof that the create was ROUTED rather than defaulted.
 * Without it a cross-workspace create is indistinguishable from a mis-route
 * until someone opens the wrong board.
 *
 * `name` is nullable on purpose: unlike {@link displayName} this does NOT
 * substitute '(unnamed)', because a null here means "the resolver never had to
 * read the name" (session fast path) — a real, different fact from a workspace
 * row whose name is blank. Pass `resolution.workspaceName` when you have it.
 */
export function workspaceEcho(
  workspaceId: string,
  name?: string | null,
): { workspace: { id: string; name: string | null } } {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  return { workspace: { id: workspaceId, name: trimmed.length > 0 ? trimmed : null } }
}
