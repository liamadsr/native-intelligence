/**
 * Deals (roadmap #8, migration 473): what a workspace is trying to win, with
 * a value, a pipeline stage, an expected close date, an owner, a company and
 * the contacts it involves.
 *
 * Every write goes through here and logs a `deal_event` with each field's
 * before and after, who or what made it (the person, the agent, an email, a
 * meeting, a text) and why. That log is the undo: `undoDealEvent` writes the
 * `from` values back, field by field, unless the field has moved on since
 * (then the newer value stays). Liam's rule is apply with undo, never an
 * accept/dismiss queue: the agent updates a deal directly and says so, and
 * the person undoes it if it was wrong.
 *
 * The default pipeline (Lead, Qualified, Proposal, Won, Lost) is seeded on
 * first use by `ensure_default_deal_pipeline` (473), from any read or write
 * here, so a workspace never sees an empty pipeline.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  listCustomFieldDefinitions,
  mergeCustomFields,
  resolveCustomValues,
  isIsoDate,
  type CustomFieldValue,
} from './custom-fields'
import { toIlikeSearchTerm } from './ilike-search-term'
import { formatDealValue } from './deal-format'
import { filterVisibleCompanies, filterVisibleContacts, isCompanyVisibleTo } from './contact-visibility'

export type DealStageKind = 'open' | 'won' | 'lost'
export type DealChangeSource = 'person' | 'agent' | 'email' | 'capture' | 'sms'

export interface DealStage {
  id: string
  pipeline_id: string
  name: string
  position: number
  kind: DealStageKind
  color: string | null
}

export interface DealPipeline {
  id: string
  name: string
  is_default: boolean
  position: number
  stages: DealStage[]
}

export interface Deal {
  id: string
  workspace_id: string
  name: string
  value: number | null
  currency: string
  pipeline_id: string
  stage_id: string
  expected_close_date: string | null
  owner_id: string | null
  company_id: string | null
  contact_ids: string[]
  notes: string | null
  custom_fields: Record<string, CustomFieldValue>
  source: string
  stage_changed_at: string
  closed_at: string | null
  created_at: string
  updated_at: string
}

/** Who or what is making a change, for the log and the undo. */
export interface DealActor {
  userId: string | null
  source: DealChangeSource
  /** The email thread, capture or text it came from. */
  sourceRef?: string | null
  /** Why, in a sentence: "Signed contract in Dana's email of Nov 3". */
  reason?: string | null
}

/** The fields a change can touch, as the log names them. Custom fields are `custom_fields.<key>`. */
export const DEAL_FIELDS = [
  'name',
  'value',
  'currency',
  'pipeline_id',
  'stage_id',
  'expected_close_date',
  'owner_id',
  'company_id',
  'contact_ids',
  'notes',
] as const
export type DealField = (typeof DEAL_FIELDS)[number]

export type DealChanges = Record<string, { from: unknown; to: unknown }>

export const DEAL_SELECT =
  'id, workspace_id, name, value, currency, pipeline_id, stage_id, expected_close_date, owner_id, company_id, contact_ids, notes, custom_fields, source, stage_changed_at, closed_at, created_at, updated_at'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)
const CUSTOM_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

const CURRENCY_RE = /^[A-Z]{3}$/

function normalizeDeal(row: Record<string, unknown>): Deal {
  const value = row.value === null || row.value === undefined ? null : Number(row.value)
  return {
    ...(row as unknown as Deal),
    value: value === null || Number.isNaN(value) ? null : value,
    contact_ids: Array.isArray(row.contact_ids) ? (row.contact_ids as string[]) : [],
    custom_fields: (row.custom_fields as Record<string, CustomFieldValue>) ?? {},
  }
}

// ── Pipelines and stages ────────────────────────────────────────────────────

/** The workspace's default pipeline id, seeding it (and its five stages) the first time. */
export async function ensureDefaultPipeline(db: SupabaseClient, workspaceId: string): Promise<string> {
  const { data, error } = await db.rpc('ensure_default_deal_pipeline', { p_workspace_id: workspaceId })
  if (error) throw new Error(error.message)
  if (!data) throw new Error('Could not set up the pipeline')
  return data as string
}

/** Every pipeline with its stages in order, the default first. Seeds the default on first use. */
export async function listPipelines(db: SupabaseClient, workspaceId: string): Promise<DealPipeline[]> {
  await ensureDefaultPipeline(db, workspaceId)
  const [{ data: pipelines, error: pErr }, { data: stages, error: sErr }] = await Promise.all([
    db.from('deal_pipeline').select('id, name, is_default, position').eq('workspace_id', workspaceId).order('position').order('created_at'),
    db.from('deal_stage').select('id, pipeline_id, name, position, kind, color').eq('workspace_id', workspaceId).order('position').order('created_at'),
  ])
  if (pErr) throw new Error(pErr.message)
  if (sErr) throw new Error(sErr.message)
  const byPipeline = new Map<string, DealStage[]>()
  for (const s of (stages ?? []) as DealStage[]) {
    const list = byPipeline.get(s.pipeline_id) ?? []
    list.push(s)
    byPipeline.set(s.pipeline_id, list)
  }
  return ((pipelines ?? []) as Omit<DealPipeline, 'stages'>[])
    .map((p) => ({ ...p, stages: byPipeline.get(p.id) ?? [] }))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.position - b.position)
}

/**
 * A stage named the way a person or the agent would ("won", "Proposal", a
 * stage id), within one pipeline (default: the deal's, else the default).
 * Exact name first, then a prefix; `won`/`lost` also match the stage of that
 * kind ("closed won" → the Won stage).
 */
export function matchStage(stages: readonly DealStage[], name: string): DealStage | null {
  const raw = name.trim()
  if (!raw) return null
  const byId = stages.find((s) => s.id === raw)
  if (byId) return byId
  if (UUID_RE.test(raw)) return null
  const n = raw.toLowerCase()
  const exact = stages.find((s) => s.name.toLowerCase() === n)
  if (exact) return exact
  const prefix = stages.filter((s) => s.name.toLowerCase().startsWith(n))
  if (prefix.length === 1) return prefix[0]
  const kind: DealStageKind | null = /\bwon\b|\bwin\b|closed[- ]?won|signed/.test(n) ? 'won' : /\blost\b|closed[- ]?lost|\bdead\b/.test(n) ? 'lost' : null
  if (kind) {
    const ofKind = stages.filter((s) => s.kind === kind)
    if (ofKind.length === 1) return ofKind[0]
  }
  return null
}

function stageList(pipeline: DealPipeline): string {
  return pipeline.stages.map((s) => s.name).join(', ')
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function getDeal(db: SupabaseClient, workspaceId: string, dealId: string): Promise<Deal | null> {
  if (!isUuid(dealId)) return null
  const { data, error } = await db.from('deal').select(DEAL_SELECT).eq('id', dealId).eq('workspace_id', workspaceId).maybeSingle()
  if (error) throw new Error(error.message)
  return data ? normalizeDeal(data as Record<string, unknown>) : null
}

export interface FindDealsInput {
  search?: string
  stage?: string
  status?: 'open' | 'won' | 'lost' | 'all'
  company_id?: string
  contact_id?: string
  owner_id?: string
  limit?: number
}

/** Deals matching a search, newest activity first. `status` defaults to every deal. */
export async function findDeals(db: SupabaseClient, workspaceId: string, input: FindDealsInput = {}): Promise<{ deals: Deal[]; pipelines: DealPipeline[] }> {
  const pipelines = await listPipelines(db, workspaceId)
  const stages = pipelines.flatMap((p) => p.stages)
  let q = db.from('deal').select(DEAL_SELECT).eq('workspace_id', workspaceId)
  if (input.search) {
    const term = toIlikeSearchTerm(input.search)
    if (term) q = q.ilike('name', `%${term}%`)
  }
  if (input.stage) {
    const matched = pipelines.map((p) => matchStage(p.stages, input.stage!)).filter((s): s is DealStage => !!s)
    if (!matched.length) return { deals: [], pipelines }
    q = q.in('stage_id', matched.map((s) => s.id))
  }
  if (input.status && input.status !== 'all') {
    const ids = stages.filter((s) => s.kind === input.status).map((s) => s.id)
    if (!ids.length) return { deals: [], pipelines }
    q = q.in('stage_id', ids)
  }
  if (input.company_id && isUuid(input.company_id)) q = q.eq('company_id', input.company_id)
  if (input.contact_id && isUuid(input.contact_id)) q = q.contains('contact_ids', [input.contact_id])
  if (input.owner_id && isUuid(input.owner_id)) q = q.eq('owner_id', input.owner_id)
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(Math.min(Math.max(input.limit ?? 25, 1), 100))
  if (error) throw new Error(error.message)
  return { deals: ((data ?? []) as Record<string, unknown>[]).map(normalizeDeal), pipelines }
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface DealInput {
  name?: string
  value?: number | null
  currency?: string
  /** A pipeline id or name. Default: the deal's own, else the default pipeline. */
  pipeline?: string
  /** A stage id or name in that pipeline. Default on create: the first stage. */
  stage?: string
  expected_close_date?: string | null
  owner_id?: string | null
  company_id?: string | null
  contact_ids?: string[]
  /** Contacts to add to the ones already on the deal. */
  add_contact_ids?: string[]
  notes?: string | null
  /** Custom field values by key or label; null clears one. */
  custom_fields?: Record<string, unknown>
}

type Resolved = { ok: true; row: Record<string, unknown> } | { ok: false; error: string }

/** Turns a DealInput into column values, checking every reference belongs to the workspace. */
async function resolveInput(
  db: SupabaseClient,
  workspaceId: string,
  input: DealInput,
  current: Deal | null,
  viewer: string | null,
): Promise<Resolved> {
  const row: Record<string, unknown> = {}

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) return { ok: false, error: 'A deal needs a name.' }
    row.name = name.slice(0, 200)
  }
  if (input.value !== undefined) {
    if (input.value !== null && (!Number.isFinite(input.value) || input.value < 0)) return { ok: false, error: 'The value must be a positive number.' }
    row.value = input.value === null ? null : Math.round(input.value * 100) / 100
  }
  if (input.currency !== undefined) {
    const c = input.currency.trim().toUpperCase()
    if (!CURRENCY_RE.test(c)) return { ok: false, error: 'Currency is a three-letter code, like USD or EUR.' }
    row.currency = c
  }
  if (input.expected_close_date !== undefined) {
    if (input.expected_close_date !== null && !isIsoDate(input.expected_close_date)) return { ok: false, error: 'The close date is YYYY-MM-DD.' }
    row.expected_close_date = input.expected_close_date
  }
  if (input.notes !== undefined) row.notes = input.notes === null ? null : input.notes.slice(0, 10000)

  // Pipeline and stage.
  if (input.pipeline !== undefined || input.stage !== undefined || !current) {
    const pipelines = await listPipelines(db, workspaceId)
    let pipeline: DealPipeline | undefined
    if (input.pipeline) {
      const p = input.pipeline.trim().toLowerCase()
      pipeline = pipelines.find((x) => x.id === input.pipeline) ?? pipelines.find((x) => x.name.toLowerCase() === p)
      if (!pipeline) return { ok: false, error: `No pipeline called "${input.pipeline}". Pipelines: ${pipelines.map((x) => x.name).join(', ')}.` }
    } else {
      pipeline = (current && pipelines.find((x) => x.id === current.pipeline_id)) || pipelines.find((x) => x.is_default) || pipelines[0]
    }
    if (!pipeline || !pipeline.stages.length) return { ok: false, error: 'That pipeline has no stages.' }
    let stage: DealStage | null = null
    if (input.stage) {
      stage = matchStage(pipeline.stages, input.stage)
      if (!stage) return { ok: false, error: `No stage "${input.stage}" in ${pipeline.name}. Stages: ${stageList(pipeline)}.` }
    } else if (current && current.pipeline_id === pipeline.id) {
      stage = pipeline.stages.find((s) => s.id === current.stage_id) ?? pipeline.stages[0]
    } else {
      stage = pipeline.stages[0]
    }
    row.pipeline_id = pipeline.id
    row.stage_id = stage.id
  }

  // References: owner, company, contacts.
  if (input.owner_id !== undefined) {
    if (input.owner_id !== null) {
      if (!isUuid(input.owner_id)) return { ok: false, error: 'owner_id is a workspace member id.' }
      const { data } = await db.from('member').select('id').eq('id', input.owner_id).eq('workspace_id', workspaceId).maybeSingle()
      if (!data) return { ok: false, error: 'That owner is not a member of this workspace.' }
    }
    row.owner_id = input.owner_id
  }
  if (input.company_id !== undefined) {
    if (input.company_id !== null) {
      if (!isUuid(input.company_id)) return { ok: false, error: 'company_id is a company id from list_companies.' }
      const { data } = await db.from('company').select('id').eq('id', input.company_id).eq('workspace_id', workspaceId).maybeSingle()
      if (!data) return { ok: false, error: 'Company not found.' }
      // On a service-role client (the agent's tools), a company the person
      // can't see is not found, as their own page would say.
      if (viewer && input.company_id !== current?.company_id && !(await isCompanyVisibleTo(db, input.company_id, viewer))) {
        return { ok: false, error: 'Company not found.' }
      }
    }
    row.company_id = input.company_id
  }
  if (input.contact_ids !== undefined || input.add_contact_ids?.length) {
    const base = input.contact_ids ?? current?.contact_ids ?? []
    const wanted = [...new Set([...base, ...(input.add_contact_ids ?? [])])]
    if (wanted.some((id) => !isUuid(id))) return { ok: false, error: 'contact_ids are contact ids from list_contacts.' }
    if (wanted.length > 50) return { ok: false, error: 'A deal holds at most 50 contacts.' }
    if (wanted.length) {
      const { data, error } = await db.from('contact').select('id').eq('workspace_id', workspaceId).in('id', wanted)
      if (error) return { ok: false, error: error.message }
      let rows = (data ?? []) as { id: string }[]
      // Contacts already on the deal stay; a new one must be one the person can see.
      if (viewer) {
        const already = new Set(current?.contact_ids ?? [])
        const fresh = await filterVisibleContacts(db, viewer, rows.filter((r) => !already.has(r.id)))
        rows = [...rows.filter((r) => already.has(r.id)), ...fresh]
      }
      const found = new Set(rows.map((c) => c.id))
      const missing = wanted.filter((id) => !found.has(id))
      if (missing.length) return { ok: false, error: `Contact not found: ${missing.join(', ')}` }
    }
    row.contact_ids = wanted
  }

  if (input.custom_fields && Object.keys(input.custom_fields).length) {
    const defs = await listCustomFieldDefinitions(db, workspaceId, 'deal')
    const resolved = resolveCustomValues(defs, input.custom_fields)
    if (!resolved.ok) return resolved
    row.custom_fields = mergeCustomFields(current?.custom_fields ?? {}, resolved.patch)
  }

  return { ok: true, row }
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

/** The before/after of every field a write changes; custom fields one key at a time. */
export function diffDeal(current: Partial<Deal>, next: Record<string, unknown>): DealChanges {
  const changes: DealChanges = {}
  for (const field of DEAL_FIELDS) {
    if (!(field in next)) continue
    const from = current[field] ?? null
    const to = next[field] ?? null
    if (field === 'contact_ids') {
      const a = [...((from as string[]) ?? [])].sort()
      const b = [...((to as string[]) ?? [])].sort()
      if (!sameValue(a, b)) changes[field] = { from, to }
      continue
    }
    if (field === 'value' && from !== null && to !== null && Number(from) === Number(to)) continue
    if (!sameValue(from, to)) changes[field] = { from, to }
  }
  if ('custom_fields' in next) {
    const before = (current.custom_fields ?? {}) as Record<string, unknown>
    const after = (next.custom_fields ?? {}) as Record<string, unknown>
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (!sameValue(before[key], after[key])) changes[`custom_fields.${key}`] = { from: before[key] ?? null, to: after[key] ?? null }
    }
  }
  return changes
}

async function logEvent(
  db: SupabaseClient,
  workspaceId: string,
  dealId: string,
  kind: 'created' | 'updated' | 'moved' | 'undo',
  changes: DealChanges,
  actor: DealActor,
): Promise<string | null> {
  const { data, error } = await db
    .from('deal_event')
    .insert({
      workspace_id: workspaceId,
      deal_id: dealId,
      kind,
      changes,
      source: actor.source,
      source_ref: actor.sourceRef?.slice(0, 200) ?? null,
      reason: actor.reason?.slice(0, 500) ?? null,
      actor_user_id: actor.userId,
    })
    .select('id')
    .single()
  if (error) {
    console.error('[deals] event log failed', { dealId, kind, error: error.message })
    return null
  }
  return (data as { id: string }).id
}

/**
 * `viewer`: the person a service-role caller (the agent's tools) acts for. A
 * new contact or company on a deal must then be one they can see; the routes
 * run on the person's own RLS client and need no viewer.
 */
export interface WriteOptions {
  viewer?: string | null
}

export type DealWriteResult =
  | { ok: true; deal: Deal; changes: DealChanges; eventId: string | null }
  | { ok: false; error: string }

const SOURCE_FOR_DEAL: Record<DealChangeSource, string> = {
  person: 'manual',
  agent: 'agent',
  email: 'email',
  capture: 'capture',
  sms: 'sms',
}

/** Creates a deal (in the default pipeline's first stage unless told otherwise) and logs it. */
export async function createDeal(
  db: SupabaseClient,
  workspaceId: string,
  input: DealInput & { name: string },
  actor: DealActor,
  opts: WriteOptions = {},
): Promise<DealWriteResult> {
  const resolved = await resolveInput(db, workspaceId, input, null, opts.viewer ?? null)
  if (!resolved.ok) return resolved
  const row = resolved.row
  if (row.owner_id === undefined && actor.userId) {
    const { data } = await db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', actor.userId).maybeSingle()
    if (data) row.owner_id = (data as { id: string }).id
  }
  const { data, error } = await db
    .from('deal')
    .insert({ ...row, workspace_id: workspaceId, source: SOURCE_FOR_DEAL[actor.source], created_by_user_id: actor.userId })
    .select(DEAL_SELECT)
    .single()
  if (error) return { ok: false, error: error.message }
  const deal = normalizeDeal(data as Record<string, unknown>)
  const changes = diffDeal({}, row)
  const eventId = await logEvent(db, workspaceId, deal.id, 'created', changes, actor)
  return { ok: true, deal, changes, eventId }
}

/**
 * Updates a deal: only the fields given are touched. Logs one event with
 * every changed field (kind `moved` when the stage is all that changed), so
 * one undo reverses the whole write. A write that changes nothing logs
 * nothing.
 */
export async function updateDeal(
  db: SupabaseClient,
  workspaceId: string,
  dealId: string,
  input: DealInput,
  actor: DealActor,
  opts: WriteOptions = {},
): Promise<DealWriteResult> {
  const current = await getDeal(db, workspaceId, dealId)
  if (!current) return { ok: false, error: 'Deal not found' }
  const resolved = await resolveInput(db, workspaceId, input, current, opts.viewer ?? null)
  if (!resolved.ok) return resolved
  const changes = diffDeal(current, resolved.row)
  if (!Object.keys(changes).length) return { ok: true, deal: current, changes, eventId: null }

  const patch: Record<string, unknown> = {}
  for (const key of Object.keys(changes)) {
    const field = key.startsWith('custom_fields.') ? 'custom_fields' : key
    patch[field] = resolved.row[field]
  }
  // A pipeline change carries its stage with it (the trigger checks the pair).
  if ('pipeline_id' in patch || 'stage_id' in patch) {
    patch.pipeline_id = resolved.row.pipeline_id
    patch.stage_id = resolved.row.stage_id
  }
  const { data, error } = await db.from('deal').update(patch).eq('id', dealId).eq('workspace_id', workspaceId).select(DEAL_SELECT).single()
  if (error) return { ok: false, error: error.message }
  const kind = Object.keys(changes).every((k) => k === 'stage_id' || k === 'pipeline_id') ? 'moved' : 'updated'
  const eventId = await logEvent(db, workspaceId, dealId, kind, changes, actor)
  return { ok: true, deal: normalizeDeal(data as Record<string, unknown>), changes, eventId }
}

export interface DealEvent {
  id: string
  deal_id: string
  kind: 'created' | 'updated' | 'moved' | 'undo'
  changes: DealChanges
  source: DealChangeSource
  source_ref: string | null
  reason: string | null
  actor_user_id: string | null
  undone_at: string | null
  created_at: string
}

export async function listDealEvents(db: SupabaseClient, workspaceId: string, dealId: string, limit = 20): Promise<DealEvent[]> {
  const { data, error } = await db
    .from('deal_event')
    .select('id, deal_id, kind, changes, source, source_ref, reason, actor_user_id, undone_at, created_at')
    .eq('workspace_id', workspaceId)
    .eq('deal_id', dealId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(error.message)
  return (data ?? []) as DealEvent[]
}

export type UndoResult =
  | { ok: true; deal: Deal; restored: string[]; kept: string[] }
  | { ok: false; error: string }

/**
 * Takes one change back: each field it touched gets its `from` value again,
 * unless the field has changed since (then the newer value stays, and the
 * result says so in `kept`). With no event id, the deal's latest change that
 * is not itself an undo and not undone yet. A deal's creation is not undone
 * here: that is a delete, which stays the person's click.
 */
export async function undoDealEvent(
  db: SupabaseClient,
  workspaceId: string,
  args: { dealId: string; eventId?: string },
  actor: DealActor,
): Promise<UndoResult> {
  const deal = await getDeal(db, workspaceId, args.dealId)
  if (!deal) return { ok: false, error: 'Deal not found' }

  let event: DealEvent | undefined
  if (args.eventId) {
    if (!isUuid(args.eventId)) return { ok: false, error: 'Change not found' }
    const { data } = await db
      .from('deal_event')
      .select('id, deal_id, kind, changes, source, source_ref, reason, actor_user_id, undone_at, created_at')
      .eq('id', args.eventId)
      .eq('deal_id', deal.id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    event = (data as DealEvent | null) ?? undefined
    if (!event) return { ok: false, error: 'Change not found' }
  } else {
    const events = await listDealEvents(db, workspaceId, deal.id, 50)
    event = events.find((e) => e.kind !== 'undo' && !e.undone_at)
    if (!event) return { ok: false, error: 'Nothing to undo on this deal.' }
  }
  if (event.kind === 'created') return { ok: false, error: 'That change created the deal. Delete the deal instead if it should not exist.' }
  if (event.kind === 'undo') return { ok: false, error: 'That change was itself an undo.' }
  if (event.undone_at) return { ok: false, error: 'That change was already undone.' }

  const patch: Record<string, unknown> = {}
  const restored: string[] = []
  const kept: string[] = []
  let customFields: Record<string, unknown> | null = null
  for (const [key, change] of Object.entries(event.changes ?? {})) {
    // Only a deal's own fields go back: the log is written by the app, but a
    // member can add a row by hand, so a key that is no field is ignored.
    if (!change || typeof change !== 'object') continue
    const { from, to } = change as { from: unknown; to: unknown }
    const isCustom = key.startsWith('custom_fields.') && CUSTOM_KEY_RE.test(key.slice('custom_fields.'.length))
    if (!isCustom && !(DEAL_FIELDS as readonly string[]).includes(key)) continue
    if (isCustom) {
      const k = key.slice('custom_fields.'.length)
      const now = deal.custom_fields?.[k] ?? null
      if (!sameValue(now, to)) {
        kept.push(key)
        continue
      }
      customFields = customFields ?? { ...deal.custom_fields }
      if (from === null || from === undefined) delete customFields[k]
      else customFields[k] = from
      restored.push(key)
      continue
    }
    const now = (deal as unknown as Record<string, unknown>)[key] ?? null
    const matches = key === 'value' ? (now === null ? to === null : to !== null && Number(now) === Number(to)) : key === 'contact_ids' ? sameValue([...((now as string[]) ?? [])].sort(), [...((to as string[]) ?? [])].sort()) : sameValue(now, to)
    if (!matches) {
      kept.push(key)
      continue
    }
    patch[key] = from
    restored.push(key)
  }
  // What the old value points at may be gone since: a contact deleted, a
  // member who left, a company removed. Contacts still there go back; a
  // missing owner or company keeps the current value.
  if (Array.isArray(patch.contact_ids) && patch.contact_ids.length) {
    const wanted = (patch.contact_ids as unknown[]).filter(isUuid)
    const { data } = wanted.length ? await db.from('contact').select('id').eq('workspace_id', workspaceId).in('id', wanted) : { data: [] }
    const alive = new Set(((data ?? []) as { id: string }[]).map((c) => c.id))
    patch.contact_ids = wanted.filter((id) => alive.has(id))
  }
  for (const [key, table] of [['owner_id', 'member'], ['company_id', 'company']] as const) {
    const v = patch[key]
    if (v === null || v === undefined) continue
    const { data } = isUuid(v) ? await db.from(table).select('id').eq('id', v).eq('workspace_id', workspaceId).maybeSingle() : { data: null }
    if (!data) {
      delete patch[key]
      restored.splice(restored.indexOf(key), 1)
      kept.push(key)
    }
  }
  if (customFields) patch.custom_fields = customFields
  // The stage and its pipeline go back as a pair, or not at all.
  if (('stage_id' in patch) !== ('pipeline_id' in patch) && event.changes.pipeline_id) {
    delete patch.stage_id
    delete patch.pipeline_id
    for (const k of ['stage_id', 'pipeline_id']) {
      const i = restored.indexOf(k)
      if (i >= 0) {
        restored.splice(i, 1)
        kept.push(k)
      }
    }
  }

  if (!restored.length) {
    return { ok: false, error: 'Nothing to restore: every field it changed has changed again since.' }
  }

  let updated = deal
  if (Object.keys(patch).length) {
    const { data, error } = await db.from('deal').update(patch).eq('id', deal.id).eq('workspace_id', workspaceId).select(DEAL_SELECT).single()
    if (error) return { ok: false, error: error.message }
    updated = normalizeDeal(data as Record<string, unknown>)
  }
  await db.from('deal_event').update({ undone_at: new Date().toISOString() }).eq('id', event.id).eq('workspace_id', workspaceId)
  const undoChanges: DealChanges = {}
  for (const key of restored) undoChanges[key] = { from: event.changes[key].to, to: key.startsWith('custom_fields.') ? event.changes[key].from : patch[key] }
  await logEvent(db, workspaceId, deal.id, 'undo', undoChanges, { ...actor, sourceRef: event.id })
  return { ok: true, deal: updated, restored, kept }
}

// ── For the model ───────────────────────────────────────────────────────────

/** A deal as the agent reads it: names instead of ids where it helps. */
export function describeDeal(
  deal: Deal,
  ctx: { pipelines: DealPipeline[]; companies?: Map<string, string>; contacts?: Map<string, string>; owners?: Map<string, string> },
) {
  const pipeline = ctx.pipelines.find((p) => p.id === deal.pipeline_id)
  const stage = pipeline?.stages.find((s) => s.id === deal.stage_id)
  return {
    id: deal.id,
    name: deal.name,
    value: deal.value,
    currency: deal.currency,
    pipeline: pipeline?.name ?? null,
    stage: stage?.name ?? null,
    status: stage?.kind ?? 'open',
    expected_close_date: deal.expected_close_date,
    owner_id: deal.owner_id,
    owner: deal.owner_id ? ctx.owners?.get(deal.owner_id) ?? null : null,
    // A company the reader can't see is neither named nor pointed at.
    company_id: deal.company_id && (!ctx.companies || ctx.companies.has(deal.company_id)) ? deal.company_id : null,
    company: deal.company_id ? ctx.companies?.get(deal.company_id) ?? null : null,
    // A contact the reader can't see is left out (its count says so).
    contacts: deal.contact_ids.filter((id) => !ctx.contacts || ctx.contacts.has(id)).map((id) => ({ id, name: ctx.contacts?.get(id) ?? null })),
    ...(ctx.contacts && deal.contact_ids.some((id) => !ctx.contacts!.has(id)) ? { other_contacts: deal.contact_ids.filter((id) => !ctx.contacts!.has(id)).length } : {}),
    custom_fields: deal.custom_fields,
    closed_at: deal.closed_at,
    updated_at: deal.updated_at,
  }
}

/** Names for the ids a set of deals points at, in three small reads. */
export async function lookupDealNames(db: SupabaseClient, workspaceId: string, deals: readonly Deal[], viewer: string | null = null) {
  const companyIds = [...new Set(deals.map((d) => d.company_id).filter((x): x is string => !!x))]
  const contactIds = [...new Set(deals.flatMap((d) => d.contact_ids))].slice(0, 200)
  const ownerIds = [...new Set(deals.map((d) => d.owner_id).filter((x): x is string => !!x))]
  const [companies, contacts, owners] = await Promise.all([
    companyIds.length ? db.from('company').select('id, name').eq('workspace_id', workspaceId).in('id', companyIds) : Promise.resolve({ data: [] }),
    contactIds.length ? db.from('contact').select('id, full_name, email').eq('workspace_id', workspaceId).in('id', contactIds) : Promise.resolve({ data: [] }),
    ownerIds.length ? db.from('member').select('id, display_name').eq('workspace_id', workspaceId).in('id', ownerIds) : Promise.resolve({ data: [] }),
  ])
  // On a service-role client, only what the person can see is named.
  let companyRows = (companies.data ?? []) as { id: string; name: string }[]
  let contactRows = (contacts.data ?? []) as { id: string; full_name: string | null; email: string | null }[]
  if (viewer) {
    ;[companyRows, contactRows] = await Promise.all([filterVisibleCompanies(db, viewer, companyRows), filterVisibleContacts(db, viewer, contactRows)])
  }
  return {
    companies: new Map(companyRows.map((c) => [c.id, c.name])),
    contacts: new Map(contactRows.map((c) => [c.id, c.full_name || c.email || 'Unnamed'])),
    owners: new Map(((owners.data ?? []) as { id: string; display_name: string }[]).map((m) => [m.id, m.display_name])),
  }
}

/** "Lead → Won", "$10,000 → $12,500": a change in words, for the agent's reply and the history. */
export function describeChanges(changes: DealChanges, ctx: { pipelines: DealPipeline[]; currency?: string | null }): string[] {
  const stageName = (id: unknown) => ctx.pipelines.flatMap((p) => p.stages).find((s) => s.id === id)?.name ?? 'none'
  const out: string[] = []
  for (const [key, { from, to }] of Object.entries(changes)) {
    if (key === 'pipeline_id') continue
    if (key === 'stage_id') out.push(`stage: ${stageName(from)} → ${stageName(to)}`)
    else if (key === 'contact_ids') out.push(`contacts: ${(from as string[] | null)?.length ?? 0} → ${(to as string[] | null)?.length ?? 0}`)
    else if (key === 'value') {
      const money = (v: unknown) => (v === null || v === undefined ? 'none' : formatDealValue(v as number, ctx.currency ?? 'USD') || String(v))
      out.push(`value: ${money(from)} → ${money(to)}`)
    }
    else out.push(`${key.replace(/^custom_fields\./, '')}: ${from ?? 'none'} → ${to ?? 'none'}`)
  }
  return out
}
