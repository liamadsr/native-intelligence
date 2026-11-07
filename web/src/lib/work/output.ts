/**
 * What a work item actually produced (ACTIVITY-AND-REVIEW-DESIGN §4.2).
 *
 * The ledger row is the receipt: a title, a status, a one-line summary and
 * typed deliverable refs. The substance — the run's own account of what it
 * did, the cards it put in front of the user, what it decided about everything
 * else it looked at, the drafts it wrote, the agent's task and log — lives on
 * the execution rows each kind writes (flow_run.action_results, attention_item,
 * extraction_pass, email_draft, agent_run). This module reads those rows for
 * ONE item and folds them into one shape every kind fills a subset of, so the
 * panel renders the same sections for a triage loop, a work run, the email
 * assistant and an extraction pass, and a new kind only has to fill blocks:
 *
 *   narrative  — the run's own words ("One real commitment came out of…")
 *   error      — why it failed, from the execution row (more specific than
 *                the ledger's line)
 *   cards      — what it put in front of the user, with each card's status now
 *   decisions  — everything it looked at and what it did with each, by name
 *   drafts     — the replies it wrote (subject, to, first lines, status)
 *   run        — an agent run's task, resources and log
 *   context    — what it acted on, with titles (capture, loop, action)
 *   labels     — deliverable ids → their current titles
 *
 * Every loader runs on the SESSION client (RLS proves visibility) and is
 * best-effort: a failed read degrades to an empty block, never to a failed
 * panel. Pure folds are exported for the unit tests.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ActionResult, VerdictLedger, VerdictLedgerEntry } from '@/lib/flows/types'
import type { WorkResourceRef } from '@/lib/agent-run/types'
import type { WorkItem } from './types'

export type WorkOutputRefType = 'capture' | 'flow' | 'action'

/** Something the item acted on, resolved to a title the panel can link. */
export interface WorkOutputRef {
  type: WorkOutputRefType
  id: string
  label: string
  identifier?: string | null
}

/** One card the run surfaced, as it stands now. */
export interface WorkOutputCard {
  id: string
  kind: string
  title: string
  why: string | null
  status: string
  created_at: string
  resolved_at: string | null
  expires_at: string | null
  proposal_id: string | null
  /** What the card proposes, beyond its title (description, task, context). */
  detail: string | null
  priority: string | null
  due_date: string | null
  entity_type: string | null
  change_type: string | null
  email_to: string | null
  email_subject: string | null
}

/** One proposal the run looked at: what it decided and what the engine did. */
export interface WorkOutputDecision {
  proposal_id: string
  title: string
  decision: string
  outcome: string
  reason: string
  detail: string | null
  entity_id: string | null
  entity_type: string | null
  change_type: string | null
  /** The proposal's own status now (a carded one may since have been applied). */
  proposal_status: string | null
}

export interface WorkOutputDraft {
  id: string
  subject: string | null
  to: string[]
  snippet: string | null
  status: string | null
}

/** An agent run's execution detail. */
export interface WorkOutputRun {
  id: string
  status: string
  kind: string | null
  task: string | null
  resources: WorkResourceRef[]
  log_tail: string | null
  sandbox_id: string | null
  pr_url: string | null
  branch: string | null
  repo_full_name: string | null
  started_at: string | null
  finished_at: string | null
}

export interface WorkOutput {
  narrative: string | null
  error: string | null
  cards: WorkOutputCard[]
  decisions: WorkOutputDecision[]
  drafts: WorkOutputDraft[]
  run: WorkOutputRun | null
  context: WorkOutputRef[]
  labels: Record<string, string>
  /** Verdict runs: candidates left in the capture beyond the card cap. */
  cards_overflow: number
  /** Verdict runs: the model never submitted a verdict (ran out of steps). */
  verdict_missing: boolean
}

export function emptyOutput(): WorkOutput {
  return {
    narrative: null,
    error: null,
    cards: [],
    decisions: [],
    drafts: [],
    run: null,
    context: [],
    labels: {},
    cards_overflow: 0,
    verdict_missing: false,
  }
}

/** `labels` key for a deliverable. */
export function labelKey(d: { type: string; id: string }): string {
  return `${d.type}:${d.id}`
}

// ─── Row shapes the loaders read ─────────────────────────────────────────

export const AGENT_RUN_SELECT =
  'id, status, kind, action_id, pr_url, branch, repo_full_name, sandbox_id, error_message, log_tail, task_prompt, result_summary, resources, pending_input, started_at, finished_at'

export interface AgentRunRow {
  id: string
  status: string
  kind: string | null
  action_id: string | null
  pr_url: string | null
  branch: string | null
  repo_full_name: string | null
  sandbox_id: string | null
  error_message: string | null
  log_tail: string | null
  task_prompt: string | null
  result_summary: string | null
  resources: unknown
  pending_input: unknown | null
  started_at: string | null
  finished_at: string | null
}

export const DRAFT_SELECT = 'id, provider_thread_id, provider_draft_id, status, subject, to_emails, body_text, email_thread:email_thread_id(folder)'

export interface DraftRow {
  id: string
  provider_thread_id: string | null
  /** The draft message's id in the mailbox (the thread view's message id), or null. */
  provider_draft_id?: string | null
  status: string | null
  subject: string | null
  to_emails: unknown
  body_text: string | null
  email_thread: { folder?: string | null } | Array<{ folder?: string | null }> | null
}

/** Where a draft deliverable lives in Mail (the item route's `drafts`). */
export interface WorkItemDraftRef {
  provider_thread_id: string | null
  /** The draft in that thread, as the thread view names it: "Review draft" opens on it. */
  provider_draft_id: string | null
  folder: string | null
  status: string | null
}

/** Draft rows → where each opens in Mail, keyed by the deliverable id ("Review draft"). */
export function draftRefsFrom(rows: readonly DraftRow[]): Record<string, WorkItemDraftRef> {
  const out: Record<string, WorkItemDraftRef> = {}
  for (const row of rows) {
    const thread = Array.isArray(row.email_thread) ? row.email_thread[0] : row.email_thread
    out[row.id] = {
      provider_thread_id: row.provider_thread_id ?? null,
      provider_draft_id: row.provider_draft_id ?? null,
      folder: thread?.folder ?? null,
      status: row.status ?? null,
    }
  }
  return out
}

/**
 * A draft the email tools made (`create_email_draft`) is delivered by the
 * provider's message id (a Gmail / Graph string, never a uuid). Its review row
 * is the `email_draft` naming it (`provider_draft_id`, src/lib/email/tool-drafts.ts);
 * an older one with no row falls back to its thread's index row, which holds
 * ids and the folder only (no stored mail: no subject, no preview).
 */
const PROVIDER_DRAFT_SELECT = 'workspace_id, provider_thread_id, provider_message_id, folder'
const PROVIDER_DRAFT_ROW_SELECT = `${DRAFT_SELECT}, workspace_id`
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const isUuid = (v: string): boolean => UUID_RE.test(v)

interface CardRow {
  id: string
  kind: string
  title: string
  why: string | null
  payload: unknown
  proposal_id: string | null
  status: string
  expires_at: string | null
  created_at: string
  resolved_at: string | null
}

interface ProposalLite {
  id: string
  display_text: string | null
  title: string | null
  entity_type: string | null
  change_type: string | null
  status: string | null
}

interface PassRow {
  id: string
  mode: string | null
  fired_at: string
  ledger: { entries?: VerdictLedgerEntry[] } | null
}

const PROPOSAL_JOIN_CAP = 200
const CARD_CAP = 50
const DETAIL_CHARS = 600
const SNIPPET_CHARS = 280
/** An extraction item written without its pass id: the pass fired within this
 *  much of the row (the flush writes both back to back). */
export const PASS_WINDOW_MS = 15 * 60 * 1000

// ─── Pure folds ──────────────────────────────────────────────────────────

function text(v: unknown, max = Infinity): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  if (!t) return null
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function stringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
}

/** The verdict-class blocks of a fire: the model's summary, the ledger entries,
 *  the first action-level error (the ledger row often only says "1 action fired"). */
export function verdictBlocks(results: ActionResult[], fallbackError: string | null = null) {
  const verdict: VerdictLedger | null = results.map((r) => r.verdict ?? null).find((v): v is VerdictLedger => !!v) ?? null
  const entries = results.flatMap((r) => r.verdict?.entries ?? [])
  const failed = results.find((r) => !r.skipped && r.status === 'failed')
  return {
    narrative: verdict && !verdict.verdict_missing ? text(verdict.summary) : null,
    error: text(failed?.error_message) ?? text(fallbackError),
    entries,
    cards_overflow: verdict?.cards_overflow ?? 0,
    verdict_missing: !!verdict?.verdict_missing,
  }
}

export function decisionsFrom(
  entries: readonly VerdictLedgerEntry[],
  proposals: ReadonlyMap<string, ProposalLite>,
): WorkOutputDecision[] {
  return entries.map((e) => {
    const p = proposals.get(e.proposal_id)
    return {
      proposal_id: e.proposal_id,
      title: text(p?.display_text) ?? text(p?.title) ?? 'Proposal',
      decision: e.decision,
      outcome: e.outcome,
      reason: text(e.reason) ?? '',
      detail: text(e.detail),
      entity_id: e.entity_id ?? null,
      entity_type: p?.entity_type ?? null,
      change_type: p?.change_type ?? null,
      proposal_status: p?.status ?? null,
    }
  })
}

export function cardFrom(row: CardRow): WorkOutputCard {
  const p = (row.payload && typeof row.payload === 'object' ? row.payload : {}) as Record<string, unknown>
  const displayText = text(p.display_text)
  const detail =
    text(p.description, DETAIL_CHARS) ??
    text(p.task, DETAIL_CHARS) ??
    text(p.email_context, DETAIL_CHARS) ??
    (displayText && displayText !== row.title ? text(displayText, DETAIL_CHARS) : null)
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    why: text(row.why),
    status: row.status,
    created_at: row.created_at,
    resolved_at: row.resolved_at ?? null,
    expires_at: row.expires_at ?? null,
    proposal_id: row.proposal_id ?? null,
    detail,
    priority: text(p.priority),
    due_date: text(p.due_date),
    entity_type: text(p.entity_type),
    change_type: text(p.change_type),
    email_to: text(p.email_to_name) ?? text(p.email_to_address),
    email_subject: text(p.email_subject),
  }
}

/** Pending first (what still needs the user), then everything in the order it
 *  was surfaced. */
export function orderCards(cards: readonly WorkOutputCard[]): WorkOutputCard[] {
  const rank = (c: WorkOutputCard) => (c.status === 'pending' ? 0 : 1)
  return [...cards].sort((a, b) => rank(a) - rank(b) || (a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0))
}

export function draftFrom(row: DraftRow): WorkOutputDraft {
  const body = text(row.body_text)
  return {
    id: row.id,
    subject: text(row.subject),
    to: stringList(row.to_emails),
    snippet: body ? text(body.replace(/\s+/g, ' '), SNIPPET_CHARS) : null,
    status: row.status ?? null,
  }
}

/** The pass an extraction item recorded: the one it names, else the pass on the
 *  same capture that fired nearest the row (older rows carry no pass id). */
export function pickPass(passes: readonly PassRow[], item: Pick<WorkItem, 'created_at' | 'source'>): PassRow | null {
  const named = typeof item.source?.extraction_pass_id === 'string' ? item.source.extraction_pass_id : null
  if (named) return passes.find((p) => p.id === named) ?? null
  const mode = typeof item.source?.mode === 'string' ? item.source.mode : null
  const at = Date.parse(item.created_at)
  let best: PassRow | null = null
  let bestGap = Infinity
  for (const p of passes) {
    if (mode && p.mode && p.mode !== mode) continue
    const gap = Math.abs(Date.parse(p.fired_at) - at)
    if (!Number.isFinite(gap) || gap > PASS_WINDOW_MS) continue
    if (gap < bestGap) {
      best = p
      bestGap = gap
    }
  }
  return best
}

export function runFrom(row: AgentRunRow): WorkOutputRun {
  return {
    id: row.id,
    status: row.status,
    kind: row.kind ?? null,
    task: text(row.task_prompt),
    resources: Array.isArray(row.resources)
      ? (row.resources as unknown[]).filter(
          (r): r is WorkResourceRef => !!r && typeof r === 'object' && typeof (r as WorkResourceRef).label === 'string',
        )
      : [],
    log_tail: row.log_tail ?? null,
    sandbox_id: row.sandbox_id ?? null,
    pr_url: row.pr_url ?? null,
    branch: row.branch ?? null,
    repo_full_name: row.repo_full_name ?? null,
    started_at: row.started_at ?? null,
    finished_at: row.finished_at ?? null,
  }
}

// ─── Loaders ─────────────────────────────────────────────────────────────

async function safe<T>(what: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (err) {
    console.warn(`[work] output ${what} failed:`, err instanceof Error ? err.message : err)
    return fallback
  }
}

function fail(error: { message: string } | null): void {
  if (error) throw new Error(error.message)
}

export async function loadAgentRunRow(supabase: SupabaseClient, agentRunId: string | null): Promise<AgentRunRow | null> {
  if (!agentRunId) return null
  const { data, error } = await supabase.from('agent_run').select(AGENT_RUN_SELECT).eq('id', agentRunId).maybeSingle()
  fail(error)
  return (data as AgentRunRow | null) ?? null
}

/**
 * The item's email drafts, in its order. `userId` fences both reads on the
 * mailbox owner explicitly, for a caller on a SERVICE client (the main agent's
 * get_bot_item, through narration-server.ts); a session client's RLS already
 * keeps them to the caller's own.
 */
export async function loadDraftRows(
  supabase: SupabaseClient,
  item: Pick<WorkItem, 'deliverables'> & { workspace_id?: string },
  opts: { userId?: string } = {},
): Promise<DraftRow[]> {
  const ids = (item.deliverables ?? []).filter((d) => d.type === 'email_draft').map((d) => d.id)
  if (ids.length === 0) return []
  // An `email_draft` row (the drafting pass) has a uuid; anything else is a
  // provider draft id (the email tools). A uuid column never sees the latter.
  const rowIds = ids.filter(isUuid)
  const providerIds = ids.filter((id) => !isUuid(id))
  const byId = new Map<string, DraftRow>()
  if (rowIds.length > 0) {
    let q = supabase.from('email_draft').select(DRAFT_SELECT).in('id', rowIds)
    if (opts.userId) q = q.eq('user_id', opts.userId)
    const { data, error } = await q
    fail(error)
    for (const r of (data ?? []) as DraftRow[]) byId.set(r.id, r)
  }
  if (providerIds.length > 0) {
    for (const [id, row] of await loadProviderDrafts(supabase, providerIds, item.workspace_id ?? null, opts.userId ?? null)) byId.set(id, row)
  }
  // The item's order: the drafts as the pass wrote them.
  return ids.map((id) => byId.get(id)).filter((r): r is DraftRow => !!r)
}

/**
 * Provider draft ids → their thread's index row, read as a DraftRow keyed by
 * the provider id. The row in the item's workspace wins; else any of the
 * caller's rows for it (the sync may have indexed it under another workspace
 * that lists the same mailbox). The caller's own rows only (RLS on the
 * session client; `userId`, explicitly, on a service client).
 */
async function loadProviderDrafts(
  supabase: SupabaseClient,
  providerIds: readonly string[],
  workspaceId: string | null,
  userId: string | null,
): Promise<Map<string, DraftRow>> {
  const out = new Map<string, DraftRow>()
  // The review row first: the agent's draft as it was written, and its status.
  let rq = supabase.from('email_draft').select(PROVIDER_DRAFT_ROW_SELECT).in('provider_draft_id', providerIds as string[])
  if (userId) rq = rq.eq('user_id', userId)
  const { data: rows, error: rowError } = await rq.limit(providerIds.length * 2)
  fail(rowError)
  for (const r of (rows ?? []) as Array<DraftRow & { provider_draft_id: string; workspace_id: string | null }>) {
    if (out.has(r.provider_draft_id) && (!workspaceId || r.workspace_id !== workspaceId)) continue
    out.set(r.provider_draft_id, { ...r, id: r.provider_draft_id })
  }
  const rest = providerIds.filter((id) => !out.has(id))
  if (rest.length === 0) return out
  let q = supabase.from('email_thread_index').select(PROVIDER_DRAFT_SELECT).in('provider_message_id', rest)
  if (userId) q = q.eq('user_id', userId)
  const { data, error } = await q.limit(rest.length * 5)
  fail(error)
  type IndexRow = {
    workspace_id: string | null
    provider_thread_id: string | null
    provider_message_id: string
    folder: string | null
  }
  const fromIndex = new Map<string, DraftRow>()
  for (const r of (data ?? []) as IndexRow[]) {
    const have = fromIndex.get(r.provider_message_id)
    if (have && (!workspaceId || r.workspace_id !== workspaceId)) continue
    fromIndex.set(r.provider_message_id, {
      id: r.provider_message_id,
      provider_thread_id: r.provider_thread_id,
      provider_draft_id: r.provider_message_id,
      status: null,
      subject: null,
      to_emails: [],
      body_text: null,
      email_thread: { folder: r.folder },
    })
  }
  for (const [id, row] of fromIndex) out.set(id, row)
  return out
}

async function loadProposals(supabase: SupabaseClient, ids: readonly string[]): Promise<Map<string, ProposalLite>> {
  const unique = [...new Set(ids.filter(Boolean))].slice(0, PROPOSAL_JOIN_CAP)
  if (unique.length === 0) return new Map()
  const { data, error } = await supabase
    .from('proposed_change')
    .select('id, display_text, title, entity_type, change_type, status')
    .in('id', unique)
  fail(error)
  return new Map(((data ?? []) as ProposalLite[]).map((p) => [p.id, p]))
}

async function loadFlowRunBlocks(supabase: SupabaseClient, item: WorkItem): Promise<Partial<WorkOutput>> {
  if (!item.flow_run_id) return {}
  const { data, error } = await supabase
    .from('flow_run')
    .select('id, status, action_results, error_message')
    .eq('id', item.flow_run_id)
    .maybeSingle()
  fail(error)
  if (!data) return {}
  const row = data as { action_results: unknown; error_message: string | null }
  const results = (Array.isArray(row.action_results) ? row.action_results : []) as ActionResult[]
  const v = verdictBlocks(results, row.error_message)
  const proposals = await loadProposals(
    supabase,
    v.entries.map((e) => e.proposal_id),
  )
  return {
    narrative: v.narrative,
    error: item.status === 'failed' || item.status === 'canceled' ? v.error : null,
    decisions: decisionsFrom(v.entries, proposals),
    cards_overflow: v.cards_overflow,
    verdict_missing: v.verdict_missing,
  }
}

async function loadCards(supabase: SupabaseClient, flowRunId: string): Promise<WorkOutputCard[]> {
  const { data, error } = await supabase
    .from('attention_item')
    .select('id, kind, title, why, payload, proposal_id, status, expires_at, created_at, resolved_at')
    .eq('source_flow_run_id', flowRunId)
    .order('created_at', { ascending: true })
    .limit(CARD_CAP)
  fail(error)
  return orderCards(((data ?? []) as CardRow[]).map(cardFrom))
}

async function loadExtractionBlocks(supabase: SupabaseClient, item: WorkItem): Promise<Partial<WorkOutput>> {
  const captureId = typeof item.source?.capture_id === 'string' ? item.source.capture_id : null
  const passId = typeof item.source?.extraction_pass_id === 'string' ? item.source.extraction_pass_id : null
  let passes: PassRow[] = []
  if (passId) {
    const { data, error } = await supabase.from('extraction_pass').select('id, mode, fired_at, ledger').eq('id', passId).maybeSingle()
    fail(error)
    passes = data ? [data as PassRow] : []
  } else if (captureId) {
    const at = Date.parse(item.created_at)
    if (!Number.isFinite(at)) return {}
    const { data, error } = await supabase
      .from('extraction_pass')
      .select('id, mode, fired_at, ledger')
      .eq('capture_id', captureId)
      .gte('fired_at', new Date(at - PASS_WINDOW_MS).toISOString())
      .lt('fired_at', new Date(at + PASS_WINDOW_MS).toISOString())
      .order('fired_at', { ascending: false })
      .limit(10)
    fail(error)
    passes = (data ?? []) as PassRow[]
  }
  const pass = pickPass(passes, item)
  const entries = pass?.ledger?.entries ?? []
  if (entries.length === 0) return {}
  const proposals = await loadProposals(
    supabase,
    entries.map((e) => e.proposal_id),
  )
  return { decisions: decisionsFrom(entries, proposals) }
}

function agentRunBlocks(row: AgentRunRow | null): Partial<WorkOutput> {
  if (!row) return {}
  return {
    narrative: text(row.result_summary),
    error: text(row.error_message),
    run: runFrom(row),
  }
}

async function one<T>(supabase: SupabaseClient, table: string, select: string, id: string): Promise<T | null> {
  const { data, error } = await supabase.from(table).select(select).eq('id', id).maybeSingle()
  fail(error)
  return (data as T | null) ?? null
}

async function loadContext(supabase: SupabaseClient, item: WorkItem): Promise<WorkOutputRef[]> {
  const src = item.source ?? {}
  const captureId = typeof src.capture_id === 'string' ? src.capture_id : null
  const flowId = typeof src.flow_id === 'string' ? src.flow_id : null
  const actionId =
    typeof src.action_id === 'string'
      ? src.action_id
      : src.entity_type === 'action' && typeof src.entity_id === 'string'
        ? src.entity_id
        : null
  // The capture read is spelled out (not routed through `one`) so the eval
  // isolation guard can see it is id-addressed (src/lib/evals/__tests__).
  const [capture, flow, action] = await Promise.all([
    captureId
      ? supabase
          .from('captures')
          .select('id, title')
          .eq('id', captureId)
          .maybeSingle()
          .then(({ data, error }: { data: unknown; error: { message: string } | null }) => {
            fail(error)
            return (data as { title: string | null } | null) ?? null
          })
      : null,
    flowId ? one<{ name: string | null }>(supabase, 'flow', 'id, name', flowId) : null,
    actionId ? one<{ identifier: string | null; title: string | null }>(supabase, 'actions', 'id, identifier, title', actionId) : null,
  ])
  const refs: WorkOutputRef[] = []
  if (captureId) refs.push({ type: 'capture', id: captureId, label: text(capture?.title) ?? 'Capture' })
  if (flowId) refs.push({ type: 'flow', id: flowId, label: text(flow?.name) ?? 'Loop' })
  if (actionId) {
    refs.push({ type: 'action', id: actionId, label: text(action?.title) ?? 'Action', identifier: action?.identifier ?? null })
  }
  return refs
}

/** Deliverables are written with generic labels ("Output document", "Filed
 *  action"); the panel shows the entity's current title instead. */
async function loadLabels(supabase: SupabaseClient, item: WorkItem): Promise<Record<string, string>> {
  const ids = (type: string) => [...new Set((item.deliverables ?? []).filter((d) => d.type === type).map((d) => d.id))]
  const docIds = ids('document')
  const actionIds = ids('action')
  const captureIds = ids('capture')
  const labels: Record<string, string> = {}
  const [docs, actions, captures] = await Promise.all([
    docIds.length ? supabase.from('document').select('id, title').in('id', docIds) : null,
    actionIds.length ? supabase.from('actions').select('id, identifier, title').in('id', actionIds) : null,
    // Deliverable ids come from the caller's own ledger row, but the read is
    // still broad by shape, so it carries the eval fence every capture list does;
    // an eval capture keeps the label the row stored.
    captureIds.length ? supabase.from('captures').select('id, title').in('id', captureIds).neq('is_eval', true) : null,
  ])
  for (const r of ((docs?.data ?? []) as Array<{ id: string; title: string | null }>)) {
    const t = text(r.title)
    if (t) labels[labelKey({ type: 'document', id: r.id })] = t
  }
  for (const r of ((actions?.data ?? []) as Array<{ id: string; identifier: string | null; title: string | null }>)) {
    const t = text(r.title)
    const ident = text(r.identifier)
    const label = t && ident ? `${ident} · ${t}` : (t ?? ident)
    if (label) labels[labelKey({ type: 'action', id: r.id })] = label
  }
  for (const r of ((captures?.data ?? []) as Array<{ id: string; title: string | null }>)) {
    const t = text(r.title)
    if (t) labels[labelKey({ type: 'capture', id: r.id })] = t
  }
  return labels
}

export interface Preloaded {
  /** The item's agent_run row when the caller already read it. */
  agentRun?: AgentRunRow | null
  /** The item's email_draft rows when the caller already read them. */
  draftRows?: DraftRow[]
}

// ─── Mirrored run types (Sequence row 6) ─────────────────────────────────
// Their own rows stay the source of truth; "What happened" reads them.

const MIRRORED_KINDS = new Set([
  'prospecting',
  'eval',
  'onboarding_research',
  // Row 11 (wave 2).
  'sequence_enrolment',
  'crm_enrichment',
  'crm_import',
  'email_import',
])

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** An import's sync state holds only its latest run; the row reads it only
 *  when that run is this row's (its run key ends in the run's start). */
function isLatestRun(runKey: string | null, prefix: string, startedAt: string | null | undefined): boolean {
  if (!runKey?.startsWith(prefix) || !startedAt) return false
  const mine = Date.parse(runKey.slice(prefix.length))
  return !Number.isNaN(mine) && mine === Date.parse(startedAt)
}

function shortDate(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
}

function money(n: unknown): string | null {
  const v = typeof n === 'number' ? n : Number(n)
  return Number.isFinite(v) && v > 0 ? `$${v.toFixed(2)}` : null
}

const EVAL_VERDICTS: Record<string, string> = {
  passed: 'every check passed',
  scored: 'some soft checks missed',
  failed: 'some trials failed',
}

const PROSPECTING_ERRORS: Record<string, string> = {
  monthly_cap: 'The workspace reached its monthly prospecting budget before this run spent anything.',
  run_cap: 'The run stopped at its own budget; what it found is kept.',
}

async function loadMirroredRunBlocks(supabase: SupabaseClient, item: WorkItem): Promise<Partial<WorkOutput>> {
  const src = (item.source ?? {}) as Record<string, unknown>
  if (item.kind === 'prospecting' && typeof src.prospecting_run_id === 'string') {
    const { data, error } = await supabase
      .from('prospecting_run')
      .select('kind, status, error, progress, spent_dollars, exa_calls')
      .eq('id', src.prospecting_run_id)
      .maybeSingle()
    fail(error)
    if (!data) return {}
    const run = data as {
      kind: string
      status: string
      error: string | null
      progress: Record<string, number> | null
      spent_dollars: unknown
      exa_calls: number | null
    }
    const p = run.progress ?? {}
    const parts: string[] = []
    // A run stopped before its first unit of work has nothing to count.
    if (run.kind === 'discover' && (p.round ?? 0) > 0) {
      const rounds = `${p.round} round${p.round === 1 ? '' : 's'}`
      parts.push(`Found ${p.found ?? 0} companies over ${rounds}: ${p.new ?? 0} new, ${p.suppressed ?? 0} already known.`)
    } else if (run.kind === 'people' && (p.accounts_total ?? 0) > 0) {
      parts.push(`Looked at ${p.accounts_done ?? 0} of ${p.accounts_total} companies and found ${p.people_found ?? 0} people.`)
    } else if (run.kind === 'account_card' && (p.accounts_total ?? 0) > 0) {
      parts.push(`Researched ${p.accounts_done ?? 0} of ${p.accounts_total} companies.`)
    }
    const spent = money(run.spent_dollars)
    if (spent) parts.push(`Spent ${spent} on ${run.exa_calls ?? 0} searches.`)
    const err = run.error ? (PROSPECTING_ERRORS[run.error] ?? run.error) : null
    return { narrative: parts.join(' ') || null, error: run.status === 'completed' ? null : err }
  }
  if (item.kind === 'eval' && typeof src.eval_run_id === 'string') {
    const { data, error } = await supabase
      .from('eval_run')
      .select('status, outcome, progress, cost_usd, error_code, error_message')
      .eq('id', src.eval_run_id)
      .maybeSingle()
    fail(error)
    if (!data) return {}
    const run = data as {
      status: string
      outcome: string | null
      progress: { trials_done?: number; trials_total?: number } | null
      cost_usd: unknown
      error_code: string | null
      error_message: string | null
    }
    const done = run.progress?.trials_done ?? 0
    const total = run.progress?.trials_total ?? done
    const verdict = run.outcome ? (EVAL_VERDICTS[run.outcome] ?? null) : null
    const parts: string[] = []
    // A run stopped before its first trial has nothing to count.
    if (done > 0) parts.push(`Ran ${done} of ${total} trial${total === 1 ? '' : 's'}${verdict ? `: ${verdict}` : ''}.`)
    const cost = money(run.cost_usd)
    if (cost) parts.push(`Cost ${cost}.`)
    // A user cancel is not an error; a budget stop or a failure says why.
    const errored = run.status === 'failed' || (run.status === 'cancelled' && run.error_code !== 'cancelled')
    return { narrative: parts.join(' ') || null, error: errored ? (run.error_message ?? run.error_code) : null }
  }
  if (item.kind === 'sequence_enrolment' && typeof src.enrollment_id === 'string') {
    const [enrolmentRes, sendsRes] = await Promise.all([
      supabase
        .from('sequence_enrollment')
        .select('status, exit_reason, contact_email, next_send_at')
        .eq('id', src.enrollment_id)
        .maybeSingle(),
      supabase
        .from('sequence_send')
        .select('status, error, sent_at, updated_at')
        .eq('enrollment_id', src.enrollment_id)
        .order('updated_at', { ascending: false }),
    ])
    fail(enrolmentRes.error)
    fail(sendsRes.error)
    const e = enrolmentRes.data as { status: string; exit_reason: string | null; contact_email: string; next_send_at: string | null } | null
    if (!e) return {}
    const sends = (sendsRes.data ?? []) as Array<{ status: string; error: string | null; sent_at: string | null }>
    const sent = sends.filter((x) => x.status === 'sent')
    const last = shortDate(sent[0]?.sent_at)
    const parts = [`Sent ${count(sent.length, 'email', 'emails')} to ${e.contact_email}${last ? `, the last on ${last}` : ''}.`]
    const next = e.status === 'active' ? shortDate(e.next_send_at) : null
    if (next) parts.push(`The next is due ${next}.`)
    const failedSend = sends.find((x) => x.status === 'failed')
    return {
      narrative: parts.join(' '),
      error: e.exit_reason === 'failed' ? (failedSend?.error ?? 'A send failed, so the drip stopped.') : null,
    }
  }
  if (item.kind === 'crm_enrichment') {
    const ids = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
    if (src.sweep === true) {
      const contacts = ids(src.contact_ids).length
      const companies = ids(src.company_ids).length
      const what = [contacts ? count(contacts, 'contact', 'contacts') : null, companies ? count(companies, 'company', 'companies') : null]
        .filter(Boolean)
        .join(' and ')
      return { narrative: `The background sweep searched the web for ${what || 'no records'}, one paid search each, and filled only empty fields.` }
    }
    if ((src.table === 'contact' || src.table === 'company') && typeof src.record_id === 'string') {
      const { data, error } = await supabase
        .from(src.table)
        .select('enrichment_status, metadata')
        .eq('id', src.record_id)
        .maybeSingle()
      fail(error)
      const row = data as { enrichment_status: string | null; metadata: { enrichment?: { error?: string } } | null } | null
      if (!row) return {}
      return {
        narrative: `Searched the web for this ${src.table} and filled only empty fields; nothing anyone typed was overwritten.`,
        error: row.enrichment_status === 'failed' ? (row.metadata?.enrichment?.error ?? null) : null,
      }
    }
    return {}
  }
  if (item.kind === 'crm_import' && typeof src.account_id === 'string') {
    const { data, error } = await supabase
      .from('crm_sync_state')
      .select('initial_import_status, initial_import_started_at, total_companies_synced, total_contacts_synced, last_sync_error')
      .eq('account_id', src.account_id)
      .maybeSingle()
    fail(error)
    const st = data as {
      initial_import_status: string
      initial_import_started_at: string | null
      total_companies_synced: number | null
      total_contacts_synced: number | null
      last_sync_error: string | null
    } | null
    if (!st || !isLatestRun(item.run_key, `hubspot:${src.account_id}:`, st.initial_import_started_at)) return {}
    // A finished import's summary already says it all.
    if (st.initial_import_status === 'complete') return {}
    const totals = `${count(st.total_companies_synced ?? 0, 'company', 'companies')} and ${count(st.total_contacts_synced ?? 0, 'contact', 'contacts')}`
    if (st.initial_import_status === 'failed') {
      return { narrative: `Imported ${totals} from HubSpot before it stopped.`, error: st.last_sync_error }
    }
    return { narrative: `Imported ${totals} from HubSpot so far.` }
  }
  if (item.kind === 'email_import' && typeof src.account_key === 'string') {
    const query = supabase
      .from('email_sync_state')
      .select('initial_import_started_at, total_messages_synced, oldest_message_synced_at')
    const scoped =
      typeof src.account_id === 'string' && src.account_id
        ? query.eq('account_id', src.account_id)
        : query.eq('user_id', src.account_key.split(':')[0]).eq('provider', String(src.provider ?? ''))
    const { data, error } = await scoped.maybeSingle()
    fail(error)
    const st = data as {
      initial_import_started_at: string | null
      total_messages_synced: number | null
      oldest_message_synced_at: string | null
    } | null
    if (!st || !isLatestRun(item.run_key, `email:${src.account_key}:`, st.initial_import_started_at)) return {}
    const back = shortDate(st.oldest_message_synced_at)
    return { narrative: `Imported ${count(st.total_messages_synced ?? 0, 'message', 'messages')}${back ? `, back to ${back}` : ''}.` }
  }
  if (item.kind === 'onboarding_research') {
    const { data, error } = await supabase
      .from('member')
      .select('onboarding_progress')
      .eq('id', item.member_id)
      .maybeSingle()
    fail(error)
    type Stored = { onboarding_progress?: { research?: { sessionId?: string; brief?: string } } | null }
    const research = (data as Stored | null)?.onboarding_progress?.research
    if (!research || research.sessionId !== src.eve_session_id) return {}
    return { narrative: research.brief?.trim() || null }
  }
  return {}
}

/** Everything the panel shows for one item beyond the ledger row itself. */
export async function loadWorkOutput(supabase: SupabaseClient, item: WorkItem, pre: Preloaded = {}): Promise<WorkOutput> {
  const [context, labels, cards, flow, extraction, agentRun, draftRows, mirrored] = await Promise.all([
    safe('context', [] as WorkOutputRef[], () => loadContext(supabase, item)),
    safe('labels', {} as Record<string, string>, () => loadLabels(supabase, item)),
    item.flow_run_id ? safe('cards', [] as WorkOutputCard[], () => loadCards(supabase, item.flow_run_id as string)) : [],
    safe('flow run', {} as Partial<WorkOutput>, () => loadFlowRunBlocks(supabase, item)),
    item.kind === 'extraction'
      ? safe('extraction', {} as Partial<WorkOutput>, () => loadExtractionBlocks(supabase, item))
      : ({} as Partial<WorkOutput>),
    pre.agentRun !== undefined ? pre.agentRun : safe('agent run', null, () => loadAgentRunRow(supabase, item.agent_run_id)),
    pre.draftRows ?? safe('drafts', [] as DraftRow[], () => loadDraftRows(supabase, item)),
    MIRRORED_KINDS.has(item.kind)
      ? safe('mirrored run', {} as Partial<WorkOutput>, () => loadMirroredRunBlocks(supabase, item))
      : ({} as Partial<WorkOutput>),
  ])
  const agent = agentRunBlocks(agentRun)
  return {
    ...emptyOutput(),
    narrative: flow.narrative ?? agent.narrative ?? mirrored.narrative ?? null,
    error: flow.error ?? agent.error ?? mirrored.error ?? null,
    cards,
    decisions: [...(flow.decisions ?? []), ...(extraction.decisions ?? [])],
    drafts: draftRows.map(draftFrom),
    run: agent.run ?? null,
    context,
    labels,
    cards_overflow: flow.cards_overflow ?? 0,
    verdict_missing: flow.verdict_missing ?? false,
  }
}
