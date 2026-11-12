/**
 * `work_touch` — every entity a unit of work touched (migration 280; the
 * follow-up's §C.1, Sequence step 2). One row per touch: which work item (and
 * run), which entity, which verb, which tool. The entity tab (step 10) reads it
 * by entity; the work-item panel by item.
 *
 * Writers, all FAIL-SOFT (a touch that cannot be written is logged and dropped;
 * it never fails the tool call, the finish, the verdict or the flush):
 *   - the internal tool routes → `recordToolCallTouches` (the only place a
 *     run's READS are visible: tool name + parsed input + output);
 *   - the recorder's finish → `recordDeliveredTouches` (deliverables);
 *   - the verdict apply → `recordVerdictTouches` (applied → created,
 *     carded or staged → proposed);
 *   - the extraction flush → `recordExtractionTouches` (the capture read,
 *     applied → created, staged → proposed).
 *
 * The tool → entity mapping is a small deterministic table over the input
 * field names the registry tools use (`action_id`, `capture_id`, the
 * `entity_type`/`entity_id` pairs, …) plus the ids a WRITE tool returns. It is
 * deliberately conservative: only uuid-shaped ids, only known kinds, and read
 * tools never record their (possibly hundreds of) output rows. A tool the
 * table does not know still gets its input ids recorded, with the verb from
 * its registry class.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getToolSideEffect } from '@/lib/ai/tool-registry'
import type { WorkDeliverable } from './types'
import type { VerdictLedgerEntry } from '@/lib/flows/types'
import { bareToolName } from '@/lib/mcp/tool-names'
import { canonicalEntityType } from '@/lib/knowledge/entity-registry'

export const TOUCH_VERBS = ['read', 'wrote', 'created', 'proposed', 'delivered'] as const
export type TouchVerb = (typeof TOUCH_VERBS)[number]

/** One touch, before it is stamped with the work item and workspace. */
export interface TouchRef {
  entityType: string
  entityId: string
  verb: TouchVerb
}

export interface WorkTouchInput extends TouchRef {
  workspaceId: string
  workItemId: string
  agentRunId?: string | null
  toolName?: string | null
  at?: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

/** Hard cap on touches from one tool call / one settle, so a pathological input never floods the table. */
export const TOUCHES_PER_EVENT_MAX = 40

// ── The tool → entity table ─────────────────────────────────────────────────

/** Input field name → the entity kind its uuid names. */
const INPUT_ID_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  action_id: 'action',
  parent_action_id: 'action',
  fold_target_action_id: 'action',
  project_id: 'project',
  capture_id: 'capture',
  document_id: 'document',
  contact_id: 'contact',
  company_id: 'company',
  initiative_id: 'initiative',
  cycle_id: 'cycle',
  milestone_id: 'milestone',
  claim_id: 'claim',
  package_id: 'package',
  campaign_id: 'campaign',
  sequence_id: 'sequence',
  list_id: 'prospect_list',
  proposal_id: 'proposal',
  draft_id: 'email_draft',
  email_id: 'email',
  attachment_id: 'attachment',
  conversation_id: 'conversation',
  decision_id: 'decision',
  label_id: 'label',
  flow_id: 'flow',
})

/** Plural input fields → entity kind, one touch per id. */
const INPUT_ID_LIST_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  action_ids: 'action',
  contact_ids: 'contact',
  document_ids: 'document',
  proposal_ids: 'proposal',
  capture_ids: 'capture',
  claim_ids: 'claim',
  label_ids: 'label',
  company_ids: 'company',
})

/** Polymorphic (kind, id) input pairs. */
const INPUT_POLY_PAIRS: ReadonlyArray<readonly [type: string, id: string]> = Object.freeze([
  ['entity_type', 'entity_id'],
  ['source_type', 'source_id'],
  ['target_type', 'target_id'],
  ['commentable_type', 'commentable_id'],
])

/** Output keys that carry a created/updated entity as `{ id }` (or a list of them), and the kind. */
const OUTPUT_ENTITY_KEYS: Readonly<Record<string, string>> = Object.freeze({
  action: 'action',
  actions: 'action',
  project: 'project',
  capture: 'capture',
  document: 'document',
  contact: 'contact',
  contacts: 'contact',
  company: 'company',
  initiative: 'initiative',
  cycle: 'cycle',
  milestone: 'milestone',
  claim: 'claim',
  claims: 'claim',
  package: 'package',
  campaign: 'campaign',
  sequence: 'sequence',
  list: 'prospect_list',
  decision: 'decision',
  label: 'label',
  draft: 'email_draft',
  drafts: 'email_draft',
  email_draft: 'email_draft',
  proposal: 'proposal',
  proposals: 'proposal',
  comment: 'comment',
  eval_suite: 'eval_suite',
  eval_case: 'eval_case',
})

/** Output scalar keys that carry an id of a known kind. */
const OUTPUT_ID_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  proposal_id: 'proposal',
  draft_id: 'email_draft',
  document_id: 'document',
  action_id: 'action',
  capture_id: 'capture',
  contact_id: 'contact',
  company_id: 'company',
})

const CREATE_NAME_RE = /^(create|draft|generate|ingest|save|add)_/
const PROPOSE_NAME_RE = /^(propose|stage)_|_proposal$/
/** A proposal by its name, or an MCP-prefixed `propose…` tool. */
const isProposalName = (toolName: string) => PROPOSE_NAME_RE.test(toolName) || (bareToolName(toolName) !== toolName && bareToolName(toolName).startsWith('propose'))
const READ_NAME_RE = /^(get|list|read|find|search|deep_search|traverse|download|lookup)(_|$)/

/** The verb a tool's input entities get, from its registry class (or its name when unregistered). */
function inputVerb(toolName: string): TouchVerb {
  const bare = bareToolName(toolName)
  const cls = getToolSideEffect(bare)
  if (cls === 'read') return 'read'
  if (cls === undefined && READ_NAME_RE.test(bare)) return 'read'
  return 'wrote'
}

/** The verb a write tool's OUTPUT entities get. Read tools record no outputs. */
function outputVerb(toolName: string): TouchVerb | null {
  if (inputVerb(toolName) === 'read') return null
  if (isProposalName(toolName)) return 'proposed'
  if (CREATE_NAME_RE.test(toolName)) return 'created'
  return 'wrote'
}

function push(out: TouchRef[], seen: Set<string>, entityType: string, entityId: unknown, verb: TouchVerb): void {
  if (out.length >= TOUCHES_PER_EVENT_MAX) return
  if (!isUuid(entityId)) return
  // A retired kind name (a model's `email`) is recorded under its current one.
  const type = canonicalEntityType(entityType.trim().toLowerCase())
  if (!type || type.length > 40) return
  const key = `${type}:${entityId.toLowerCase()}:${verb}`
  if (seen.has(key)) return
  seen.add(key)
  out.push({ entityType: type, entityId: entityId.toLowerCase(), verb })
}

/**
 * The touches one tool call implies — pure. Input ids get the tool's input
 * verb (read for a read tool, wrote otherwise); a write tool's returned ids get
 * created / proposed / wrote by the tool's name. Unknown fields are ignored.
 */
export function touchesForToolCall(args: { toolName: string; input: unknown; output: unknown }): TouchRef[] {
  const out: TouchRef[] = []
  const seen = new Set<string>()
  const verb = inputVerb(args.toolName)

  if (args.input && typeof args.input === 'object' && !Array.isArray(args.input)) {
    const input = args.input as Record<string, unknown>
    for (const [field, kind] of Object.entries(INPUT_ID_FIELDS)) push(out, seen, kind, input[field], verb)
    for (const [field, kind] of Object.entries(INPUT_ID_LIST_FIELDS)) {
      const list = input[field]
      if (Array.isArray(list)) for (const id of list.slice(0, TOUCHES_PER_EVENT_MAX)) push(out, seen, kind, id, verb)
    }
    for (const [typeField, idField] of INPUT_POLY_PAIRS) {
      const type = input[typeField]
      if (typeof type === 'string') push(out, seen, type, input[idField], verb)
    }
  }

  const outVerb = outputVerb(args.toolName)
  if (outVerb && args.output && typeof args.output === 'object' && !Array.isArray(args.output)) {
    const output = args.output as Record<string, unknown>
    for (const [key, kind] of Object.entries(OUTPUT_ENTITY_KEYS)) {
      const v = output[key]
      if (Array.isArray(v)) {
        for (const item of v.slice(0, TOUCHES_PER_EVENT_MAX)) {
          if (item && typeof item === 'object') push(out, seen, kind, (item as { id?: unknown }).id, outVerb)
        }
      } else if (v && typeof v === 'object') {
        push(out, seen, kind, (v as { id?: unknown }).id, outVerb)
      }
    }
    for (const [key, kind] of Object.entries(OUTPUT_ID_FIELDS)) push(out, seen, kind, output[key], outVerb)
  }

  return out
}

// ── Email threads ───────────────────────────────────────────────────────────
//
// An email thread's id in the tools is the PROVIDER's (a Gmail / Outlook
// string), not a uuid, so `touchesForToolCall` cannot record it. The entity is
// the thread's index row (`email_thread_index.id`), which the writers below
// resolve: the email tools' `thread_id` / `thread_ids` inputs by
// (workspace, provider_thread_id); a draft a tool just made (its result's
// provider `draft_id` / `thread_id`) and a delivered draft by the same ids —
// `create_email_draft` indexes the draft before it returns
// (src/lib/integrations/email.ts indexDraftInDb); and a delivered
// `email_draft` row by its `email_thread_id`. The email pane's Agents section
// reads them (plan 2.4, page 6; row 12).

const EMAIL_TOOL_RE = /(^|_)email(s)?(_|$)|_drafts?$/
const PROVIDER_THREAD_MAX = 10

/** The provider thread ids an email tool call names (input only). Pure. */
export function emailThreadRefsIn(toolName: string, input: unknown): string[] {
  const bare = bareToolName(toolName)
  if (!EMAIL_TOOL_RE.test(bare) || !input || typeof input !== 'object' || Array.isArray(input)) return []
  const rec = input as Record<string, unknown>
  const raw = [rec.thread_id, ...(Array.isArray(rec.thread_ids) ? rec.thread_ids : [])]
  const out = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const id = v.trim()
    if (id && id.length <= 200) out.add(id)
    if (out.size >= PROVIDER_THREAD_MAX) break
  }
  return [...out]
}

/** A provider id: a non-empty string that is not a uuid (those are Native Intelligence rows). */
const isProviderId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 512 && !isUuid(v)

/**
 * The provider ids of a draft an email tool's RESULT names (`create_email_draft`
 * returns the new draft's message id as `draft_id` and its `thread_id`). Pure.
 */
export function emailDraftRefsOut(toolName: string, output: unknown): { messageIds: string[]; threadIds: string[] } {
  const bare = bareToolName(toolName)
  const none = { messageIds: [], threadIds: [] }
  if (!EMAIL_TOOL_RE.test(bare) || !output || typeof output !== 'object' || Array.isArray(output)) return none
  const rec = output as Record<string, unknown>
  return {
    messageIds: isProviderId(rec.draft_id) ? [rec.draft_id.trim()] : [],
    threadIds: isProviderId(rec.thread_id) ? [rec.thread_id.trim()] : [],
  }
}

/** Provider draft (message) ids → the workspace's thread index rows. Fail-soft: [] on error. */
async function resolveProviderDrafts(supabase: SupabaseClient, workspaceId: string, messageIds: string[]): Promise<string[]> {
  if (messageIds.length === 0) return []
  try {
    const { data, error } = await supabase
      .from('email_thread_index')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('provider_message_id', messageIds)
      .limit(PROVIDER_THREAD_MAX * 2)
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<{ id: unknown }>).map((r) => r.id).filter(isUuid)
  } catch (err) {
    log('provider draft lookup', err)
    return []
  }
}

/** Provider thread ids → the workspace's thread index rows. Fail-soft: [] on error. */
async function resolveEmailThreads(supabase: SupabaseClient, workspaceId: string, providerIds: string[]): Promise<string[]> {
  if (providerIds.length === 0) return []
  try {
    const { data, error } = await supabase
      .from('email_thread_index')
      .select('id')
      .eq('workspace_id', workspaceId)
      .in('provider_thread_id', providerIds)
      .limit(PROVIDER_THREAD_MAX * 2)
    if (error) throw new Error(error.message)
    return ((data ?? []) as Array<{ id: unknown }>).map((r) => r.id).filter(isUuid)
  } catch (err) {
    log('email thread lookup', err)
    return []
  }
}

/** Delivered drafts → their threads' index rows. Fail-soft: [] on error. */
async function threadsOfDrafts(supabase: SupabaseClient, workspaceId: string, draftIds: string[]): Promise<string[]> {
  if (draftIds.length === 0) return []
  try {
    const { data, error } = await supabase
      .from('email_draft')
      .select('email_thread_id')
      .eq('workspace_id', workspaceId)
      .in('id', draftIds)
    if (error) throw new Error(error.message)
    return [...new Set(((data ?? []) as Array<{ email_thread_id: unknown }>).map((r) => r.email_thread_id).filter(isUuid))]
  } catch (err) {
    log('draft thread lookup', err)
    return []
  }
}

// ── The writers ─────────────────────────────────────────────────────────────

function log(where: string, err: unknown): void {
  console.warn(`[work-touch] ${where} dropped:`, err instanceof Error ? err.message : err)
}

/**
 * Insert touches. Never throws; returns how many rows were written (0 when the
 * insert failed or nothing was valid). Invalid rows (a non-uuid id, an unknown
 * verb) are dropped individually.
 */
export async function recordWorkTouches(supabase: SupabaseClient, touches: WorkTouchInput[]): Promise<number> {
  const rows = touches
    .filter((t) => isUuid(t.workItemId) && isUuid(t.workspaceId) && isUuid(t.entityId) && TOUCH_VERBS.includes(t.verb))
    .slice(0, TOUCHES_PER_EVENT_MAX)
    .map((t) => ({
      workspace_id: t.workspaceId,
      work_item_id: t.workItemId,
      agent_run_id: isUuid(t.agentRunId) ? t.agentRunId : null,
      entity_type: t.entityType,
      entity_id: t.entityId.toLowerCase(),
      verb: t.verb,
      tool_name: t.toolName ?? null,
      ...(t.at ? { at: t.at } : {}),
    }))
  if (rows.length === 0) return 0
  try {
    const { error } = await supabase.from('work_touch').insert(rows)
    if (error) {
      log('insert', error.message)
      return 0
    }
    return rows.length
  } catch (err) {
    log('insert', err)
    return 0
  }
}

/**
 * Which of `ids` a unit of work filed itself: its `created` / `proposed`
 * touches. What the promotion guard reads so an unattended run can't confirm
 * a suggestion it made (CreateToolsOptions.actionRules.filedByRun). FAILS
 * CLOSED: a read that errors answers every id, so the confirm is refused
 * (left for the person) rather than let through blind. Never throws.
 */
export async function entitiesFiledByWork(
  supabase: SupabaseClient,
  args: { workItemId: string; ids: readonly string[] },
): Promise<Set<string>> {
  const ids = [...new Set(args.ids.filter(isUuid).map((id) => id.toLowerCase()))]
  if (ids.length === 0) return new Set()
  try {
    const { data, error } = await supabase
      .from('work_touch')
      .select('entity_id')
      .eq('work_item_id', args.workItemId)
      .in('verb', ['created', 'proposed'])
      .in('entity_id', ids)
    if (error) {
      log('filed lookup', error.message)
      return new Set(ids)
    }
    return new Set(((data ?? []) as Array<{ entity_id: string }>).map((r) => String(r.entity_id).toLowerCase()))
  } catch (err) {
    log('filed lookup', err)
    return new Set(ids)
  }
}

/** agent_run id → its work item id (tracked_job.agent_run_id), bounded cache: one lookup per run per process. */
const workItemByRun = new Map<string, string | null>()
const WORK_ITEM_CACHE_MAX = 500

export async function resolveWorkItemIdForAgentRun(supabase: SupabaseClient, agentRunId: string): Promise<string | null> {
  const cached = workItemByRun.get(agentRunId)
  if (cached !== undefined) return cached
  let id: string | null = null
  try {
    const { data } = await supabase.from('tracked_job').select('id').eq('agent_run_id', agentRunId).limit(1).maybeSingle()
    id = isUuid(data?.id) ? (data!.id as string) : null
  } catch (err) {
    log('work item lookup', err)
    return null // not cached: a transient failure should not pin "no item"
  }
  if (workItemByRun.size >= WORK_ITEM_CACHE_MAX) workItemByRun.clear()
  workItemByRun.set(agentRunId, id)
  return id
}

/** Test seam: forget cached run → item mappings. */
export function resetWorkTouchCaches(): void {
  workItemByRun.clear()
}

/**
 * The internal tool routes' hook: record what one tool call touched. No work
 * item → nothing to record (chat and live-agent turns have none today; a
 * settled run's follow-up chat still maps to its item).
 */
export async function recordToolCallTouches(
  supabase: SupabaseClient,
  args: {
    workspaceId: string
    workItemId: string | null
    agentRunId?: string | null
    toolName: string
    input: unknown
    output: unknown
  },
): Promise<number> {
  if (!args.workItemId) return 0
  let refs: TouchRef[]
  let providerThreads: string[]
  try {
    refs = touchesForToolCall({ toolName: args.toolName, input: args.input, output: args.output })
    providerThreads = emailThreadRefsIn(args.toolName, args.input)
  } catch (err) {
    log('mapping', err)
    return 0
  }
  const inputThreads = new Set<string>()
  if (providerThreads.length > 0) {
    const verb = inputVerb(args.toolName)
    for (const id of await resolveEmailThreads(supabase, args.workspaceId, providerThreads)) {
      inputThreads.add(id.toLowerCase())
      refs.push({ entityType: 'email_thread', entityId: id.toLowerCase(), verb })
    }
  }
  // A draft the tool made: its thread, unless the input already named it.
  const made = outputVerb(args.toolName) ? emailDraftRefsOut(args.toolName, args.output) : { messageIds: [], threadIds: [] }
  if (made.messageIds.length > 0 || made.threadIds.length > 0) {
    const verb = outputVerb(args.toolName) as TouchVerb
    const ids = new Set([
      ...(await resolveProviderDrafts(supabase, args.workspaceId, made.messageIds)),
      ...(await resolveEmailThreads(supabase, args.workspaceId, made.threadIds)),
    ].map((id) => id.toLowerCase()))
    for (const id of ids) if (!inputThreads.has(id)) refs.push({ entityType: 'email_thread', entityId: id, verb })
  }
  if (refs.length === 0) return 0
  return recordWorkTouches(
    supabase,
    refs.map((r) => ({
      ...r,
      workspaceId: args.workspaceId,
      workItemId: args.workItemId!,
      agentRunId: args.agentRunId ?? null,
      toolName: args.toolName,
    })),
  )
}

/** Deliverable type → entity kind; null = not an entity with a uuid (a url, a card count). */
const DELIVERABLE_ENTITY_KIND: Readonly<Record<string, string | null>> = Object.freeze({
  email_draft: 'email_draft',
  document: 'document',
  action: 'action',
  capture: 'capture',
  contact: 'contact',
  company: 'company',
  prospect_list: 'prospect_list',
  pr: null,
  attention_cards: null,
  flow_run: null,
  url: null,
  // The Studio keeps no touch history (its kinds are outside the activity log).
  studio_video: null,
})

/**
 * The touches a finish implies: one `delivered` per deliverable that names an
 * entity. Takes the ledger's deliverable shape and the run-boundary one (whose
 * generic `entity` type carries its kind in `entity_type`). Pure.
 */
export function touchesForDeliverables(
  deliverables: ReadonlyArray<{ type: string; id: string; entity_type?: string }>,
): TouchRef[] {
  const out: TouchRef[] = []
  const seen = new Set<string>()
  for (const d of deliverables) {
    const known = DELIVERABLE_ENTITY_KIND[d.type]
    const kind = known === undefined ? d.entity_type : known
    if (!kind) continue
    push(out, seen, kind, d.id, 'delivered')
  }
  return out
}

/** The recorder's hook: what a finished item delivered. */
export async function recordDeliveredTouches(
  supabase: SupabaseClient,
  args: { workspaceId: string; workItemId: string; agentRunId?: string | null; deliverables: ReadonlyArray<WorkDeliverable> },
): Promise<number> {
  const refs = touchesForDeliverables(args.deliverables)
  // A draft the email tools made is delivered by its provider id (no
  // `email_draft` row): it is the thread it sits on that the run delivered.
  const providerDrafts = args.deliverables
    .filter((d) => d.type === 'email_draft' && isProviderId(d.id))
    .map((d) => d.id.trim())
    .slice(0, PROVIDER_THREAD_MAX)
  if (refs.length === 0 && providerDrafts.length === 0) return 0
  // A delivered draft also touches its thread (see "Email threads" above).
  const drafts = refs.filter((r) => r.entityType === 'email_draft').map((r) => r.entityId)
  const threads = new Set([
    ...(await threadsOfDrafts(supabase, args.workspaceId, drafts)),
    ...(await resolveProviderDrafts(supabase, args.workspaceId, providerDrafts)),
  ].map((id) => id.toLowerCase()))
  for (const id of threads) refs.push({ entityType: 'email_thread', entityId: id, verb: 'delivered' })
  if (refs.length === 0) return 0
  return recordWorkTouches(
    supabase,
    refs.map((r) => ({ ...r, workspaceId: args.workspaceId, workItemId: args.workItemId, agentRunId: args.agentRunId ?? null, toolName: 'finish' })),
  )
}

/**
 * The touches a verdict's ledger implies: an applied entry with an entity →
 * `created` on that entity (its type from the entry, 'action' when the entry
 * predates the field); a carded or staged entry → `proposed` on the proposal
 * (the run put it in front of the person, or left it for them in its capture);
 * a folded entry → `wrote` on the target action. Pure.
 */
export function touchesForVerdictEntries(entries: ReadonlyArray<VerdictLedgerEntry>): TouchRef[] {
  const out: TouchRef[] = []
  const seen = new Set<string>()
  for (const e of entries) {
    if (e.outcome === 'applied' && e.entity_id) push(out, seen, e.entity_type ?? 'action', e.entity_id, 'created')
    else if (e.outcome === 'carded' || e.outcome === 'staged') push(out, seen, 'proposal', e.proposal_id, 'proposed')
    else if (e.outcome === 'folded' && e.entity_id) push(out, seen, 'action', e.entity_id, 'wrote')
  }
  return out
}

/** verdict-apply's hook (called where the work item is known: the verdict delivery in run-skill.ts). */
export async function recordVerdictTouches(
  supabase: SupabaseClient,
  args: { workspaceId: string; workItemId: string | null; entries: ReadonlyArray<VerdictLedgerEntry> },
): Promise<number> {
  if (!args.workItemId) return 0
  const refs = touchesForVerdictEntries(args.entries)
  if (refs.length === 0) return 0
  return recordWorkTouches(
    supabase,
    refs.map((r) => ({ ...r, workspaceId: args.workspaceId, workItemId: args.workItemId!, toolName: 'verdict' })),
  )
}

/**
 * The extraction flush's hook: the pass READ its capture by definition, applied
 * entries created entities (their kinds looked up from the proposals, one
 * select), staged entries proposed. Fail-soft like the rest.
 */
export async function recordExtractionTouches(
  supabase: SupabaseClient,
  args: { workspaceId: string; workItemId: string; captureId: string; entries: ReadonlyArray<VerdictLedgerEntry> },
): Promise<number> {
  const refs: TouchRef[] = []
  const seen = new Set<string>()
  push(refs, seen, 'capture', args.captureId, 'read')
  const applied = args.entries.filter((e) => e.outcome === 'applied' && isUuid(e.entity_id))
  let kinds = new Map<string, string>()
  if (applied.length > 0) {
    try {
      const { data } = await supabase
        .from('proposed_change')
        .select('id, entity_type')
        .in('id', applied.map((e) => e.proposal_id).slice(0, TOUCHES_PER_EVENT_MAX))
      kinds = new Map(((data ?? []) as Array<{ id: string; entity_type: string }>).map((r) => [r.id, r.entity_type]))
    } catch (err) {
      log('proposal kinds', err)
    }
  }
  for (const e of args.entries) {
    if (e.outcome === 'applied' && e.entity_id) push(refs, seen, e.entity_type ?? kinds.get(e.proposal_id) ?? 'action', e.entity_id, 'created')
    else if (e.outcome === 'carded') push(refs, seen, 'proposal', e.proposal_id, 'proposed')
  }
  return recordWorkTouches(
    supabase,
    refs.map((r) => ({ ...r, workspaceId: args.workspaceId, workItemId: args.workItemId, toolName: 'extraction' })),
  )
}
