/**
 * Deals (roadmap #8) are the rows of pipeline tables (Tables, phase 7,
 * migration 540): a pipeline is a table marked `kind = 'pipeline'`, and a
 * deal is one of its rows. The row's title is the deal's name; its system
 * columns hold the rest (PIPELINE_KEYS): the stage (a select whose options
 * carry open, won or lost), the value (currency), the company and contacts
 * (relations), the expected close date and the owner (a member). People add
 * their own columns; a pipeline starts with Notes too.
 *
 * This is a thin layer over the table store (src/lib/tables/store.ts): it
 * reads a row as a Deal and turns a deal change into one batch of row ops,
 * so every change is in the pipeline's change log with its before and
 * after, who or what made it and why, and Undo takes it back (apply with
 * undo, never an accept/dismiss queue). The database keeps `closed_at` and
 * `stage_changed_at` (540's trigger) and the stage rules (required_when).
 *
 * The default pipeline ("Sales": Lead, Qualified, Proposal, Won, Lost) is
 * made on first use by ensure_default_pipeline (540), from any read here.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  isIsoDate,
  resolveCustomValues,
  type CustomFieldDefinition,
  type CustomFieldValue,
} from './custom-fields'
import { optionOutcome, relationIds, type CurrencyValue, type StageOutcome } from './custom-field-types'
import { toIlikeSearchTerm } from './ilike-search-term'
import { formatDealValue } from './deal-format'
import { filterVisibleCompanies, filterVisibleContacts, isCompanyVisibleTo } from './contact-visibility'
import { fieldReferenceCheck } from './custom-field-references'
import { applyOps, CHANGE_SELECT, listTables, ROW_SELECT, summarizeChange, undoChange, type TableActor } from '@/lib/tables/store'
import { touchedBy } from '@/lib/tables/ops'
import { isComputedType, type DataChange, type DataColumn, type DataRow, type DataTable } from '@/lib/tables/types'

export type DealStageKind = StageOutcome
export type DealChangeSource = 'person' | 'agent' | 'email' | 'capture' | 'sms'

/** A pipeline's own columns' keys (540), and its Notes. */
export const PIPELINE_KEYS = {
  stage: 'stage',
  value: 'value',
  company: 'company',
  contacts: 'contacts',
  expectedClose: 'expected_close',
  owner: 'owner',
  notes: 'notes',
} as const

/** The keys that are not a deal's own custom fields. */
const BUILT_IN_KEYS = new Set<string>(Object.values(PIPELINE_KEYS))

export interface DealStage {
  name: string
  kind: DealStageKind
  position: number
}

export interface DealPipeline {
  id: string
  name: string
  is_default: boolean
  position: number
  version: number
  visibility: DataTable['visibility']
  owner_member_id: string | null
  archived_at: string | null
  stages: DealStage[]
  /** Its live columns, in order. */
  columns: DataColumn[]
}

export interface Deal {
  id: string
  workspace_id: string
  pipeline_id: string
  name: string
  value: number | null
  currency: string
  /** Its stage's name (an option of the Stage column), or null. */
  stage: string | null
  status: DealStageKind
  expected_close_date: string | null
  owner_id: string | null
  company_id: string | null
  contact_ids: string[]
  notes: string | null
  /** Its other columns' values, by column key. */
  custom_fields: Record<string, CustomFieldValue>
  stage_changed_at: string | null
  closed_at: string | null
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** Who or what is making a change, for the log and the undo. */
export interface DealActor {
  userId: string | null
  source: DealChangeSource
  /** The email thread, capture or text it came from (kept on the change: data_change.source_ref). */
  sourceRef?: string | null
  /** Why, in a sentence: "Signed contract in Dana's email of Nov 3". */
  reason?: string | null
}

/**
 * `viewer`: the person a service-role caller (the agent's tools) acts for: a
 * new contact or company on a deal must be one they can see, the batch names
 * them (asUserId), and the pipelines they read are fenced. The routes run on
 * the person's own client.
 */
export interface WriteOptions {
  viewer?: string | null
  /** false on a guest's or a linked agent's turn (omitGrants): the viewer's grants open nothing. */
  grants?: boolean
}

/** The fields a change can touch, as a deal's change names them: the title, or a column key. */
export type DealChanges = Record<string, { from: unknown; to: unknown }>

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)

// ── Pipelines ───────────────────────────────────────────────────────────────

/** The workspace's default pipeline id, made (with its five stages) the first time; null for a guest before it exists. */
export async function ensureDefaultPipeline(db: SupabaseClient, workspaceId: string, asUserId: string | null = null): Promise<string | null> {
  const { data, error } = await db.rpc('ensure_default_pipeline', { p_workspace_id: workspaceId, p_as_user: asUserId })
  if (error) throw new Error(error.message)
  return (data as string | null) ?? null
}

/** A pipeline's stages: its Stage column's options, each with its outcome. */
export function stagesOf(columns: readonly DataColumn[]): DealStage[] {
  const stage = columns.find((c) => c.key === PIPELINE_KEYS.stage && c.field_type === 'select')
  return (stage?.options ?? []).map((name, position) => ({ name, kind: optionOutcome(stage?.config, name), position }))
}

export interface PipelineReadOptions {
  /** The person a service-role client acts for (made the default pipeline for, and fenced to). */
  viewer?: string | null
  /** The pipeline ids among these the person may read (a service-role caller's fence). */
  readable?: (ids: string[]) => Promise<Set<string>>
  /** Archived ones too. */
  archived?: boolean
}

/** Every live pipeline the caller can read, the default first, each with its columns and stages. Makes the default on first use. */
export async function listPipelines(db: SupabaseClient, workspaceId: string, opts: PipelineReadOptions = {}): Promise<DealPipeline[]> {
  await ensureDefaultPipeline(db, workspaceId, opts.viewer ?? null)
  let tables = await listTables(db, workspaceId, { kind: 'pipeline' })
  if (opts.archived) tables = [...tables, ...(await listTables(db, workspaceId, { kind: 'pipeline', archived: true }))]
  if (opts.readable && tables.length) {
    const ok = await opts.readable(tables.map((t) => t.id))
    tables = tables.filter((t) => ok.has(t.id))
  }
  if (!tables.length) return []
  const { data, error } = await db
    .from('custom_field_definition')
    .select('id, table_id, key, label, field_type, options, config, position, deleted_at, system')
    .eq('workspace_id', workspaceId)
    .eq('entity_type', 'data_row')
    .in('table_id', tables.map((t) => t.id))
    .is('deleted_at', null)
    .order('position', { ascending: true })
  if (error) throw new Error(error.message)
  const byTable = new Map<string, DataColumn[]>()
  for (const c of (data ?? []) as DataColumn[]) {
    const list = byTable.get(c.table_id) ?? []
    list.push({ ...c, options: c.options ?? [], config: c.config ?? {} })
    byTable.set(c.table_id, list)
  }
  return tables
    .map((t) => {
      const columns = byTable.get(t.id) ?? []
      return {
        id: t.id,
        name: t.name,
        is_default: !!t.is_default,
        position: t.position,
        version: t.version,
        visibility: t.visibility,
        owner_member_id: t.owner_member_id,
        archived_at: t.archived_at,
        stages: stagesOf(columns),
        columns,
      }
    })
    .sort((a, b) => Number(b.is_default) - Number(a.is_default) || a.position - b.position)
}

/** The pipeline a person or the agent names: its id, or its name (any case). */
export function matchPipeline(pipelines: readonly DealPipeline[], ref: string): DealPipeline | null {
  const p = ref.trim().toLowerCase()
  return pipelines.find((x) => x.id === ref.trim()) ?? pipelines.find((x) => x.name.toLowerCase() === p) ?? null
}

/**
 * A stage named the way a person or the agent would ("won", "Proposal"),
 * within one pipeline. Exact name first, then a prefix; `won`/`lost` also
 * match the stage of that outcome ("closed won" → the Won stage).
 */
export function matchStage(stages: readonly DealStage[], name: string): DealStage | null {
  const raw = name.trim()
  if (!raw) return null
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

const stageList = (pipeline: DealPipeline): string => pipeline.stages.map((s) => s.name).join(', ')

// ── A row as a deal ─────────────────────────────────────────────────────────

/** The currency a pipeline's bare amounts take (its Value column's). */
export function pipelineCurrency(pipeline: Pick<DealPipeline, 'columns'>): string {
  const code = pipeline.columns.find((c) => c.key === PIPELINE_KEYS.value)?.config?.currency
  return typeof code === 'string' && /^[A-Z]{3}$/.test(code) ? code : 'USD'
}

/** A pipeline's row, read as a deal. */
export function rowToDeal(row: DataRow & { workspace_id?: string }, pipeline: Pick<DealPipeline, 'columns'>, workspaceId: string): Deal {
  const cf = (row.custom_fields ?? {}) as Record<string, CustomFieldValue>
  const money = cf[PIPELINE_KEYS.value] as Partial<CurrencyValue> | undefined
  const amount = money && typeof money === 'object' && typeof money.amount === 'number' ? money.amount : null
  const stageCol = pipeline.columns.find((c) => c.key === PIPELINE_KEYS.stage)
  const stage = typeof cf[PIPELINE_KEYS.stage] === 'string' ? (cf[PIPELINE_KEYS.stage] as string) : null
  const custom: Record<string, CustomFieldValue> = {}
  for (const [k, v] of Object.entries(cf)) if (!BUILT_IN_KEYS.has(k)) custom[k] = v
  return {
    id: row.id,
    workspace_id: row.workspace_id ?? workspaceId,
    pipeline_id: row.table_id,
    name: row.title,
    value: amount,
    currency: amount !== null && typeof money?.currency === 'string' ? money.currency : pipelineCurrency(pipeline),
    stage,
    status: optionOutcome(stageCol?.config, stage),
    expected_close_date: typeof cf[PIPELINE_KEYS.expectedClose] === 'string' ? (cf[PIPELINE_KEYS.expectedClose] as string) : null,
    owner_id: typeof cf[PIPELINE_KEYS.owner] === 'string' ? (cf[PIPELINE_KEYS.owner] as string) : null,
    company_id: relationIds(cf[PIPELINE_KEYS.company])[0] ?? null,
    contact_ids: relationIds(cf[PIPELINE_KEYS.contacts]),
    notes: typeof cf[PIPELINE_KEYS.notes] === 'string' ? (cf[PIPELINE_KEYS.notes] as string) : null,
    custom_fields: custom,
    stage_changed_at: row.stage_changed_at ?? null,
    closed_at: row.closed_at ?? null,
    archived_at: row.archived_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}

// ── Reads ───────────────────────────────────────────────────────────────────

/** One deal (a live row of one of these pipelines), or null. */
export async function getDeal(db: SupabaseClient, workspaceId: string, dealId: string, pipelines?: readonly DealPipeline[]): Promise<Deal | null> {
  if (!isUuid(dealId)) return null
  const { data, error } = await db.from('data_row').select(ROW_SELECT).eq('id', dealId).eq('workspace_id', workspaceId).is('archived_at', null).maybeSingle()
  if (error) throw new Error(error.message)
  if (!data) return null
  const row = data as DataRow
  const list = pipelines ?? (await listPipelines(db, workspaceId))
  const pipeline = list.find((p) => p.id === row.table_id)
  return pipeline ? rowToDeal(row, pipeline, workspaceId) : null
}

export interface FindDealsInput {
  search?: string
  stage?: string
  status?: 'open' | 'won' | 'lost' | 'all'
  company_id?: string
  contact_id?: string
  owner_id?: string
  /** A pipeline id or name: only its deals. */
  pipeline?: string
  limit?: number
}

/** A list of option names for a PostgREST in() filter, each quoted. */
const inList = (names: readonly string[]) => `(${names.map((n) => `"${n.replace(/["\\]/g, (m) => `\\${m}`)}"`).join(',')})`

/** Deals matching a search, newest activity first, across the pipelines the caller reads. `status` defaults to every deal. */
export async function findDeals(
  db: SupabaseClient,
  workspaceId: string,
  input: FindDealsInput = {},
  opts: PipelineReadOptions = {},
): Promise<{ deals: Deal[]; pipelines: DealPipeline[] }> {
  const pipelines = await listPipelines(db, workspaceId, opts)
  const limit = Math.min(Math.max(input.limit ?? 25, 1), 100)
  let scoped = pipelines
  if (input.pipeline) {
    const one = matchPipeline(pipelines, input.pipeline)
    if (!one) return { deals: [], pipelines }
    scoped = [one]
  }
  const reads = scoped.map(async (pipeline) => {
    let q = db.from('data_row').select(ROW_SELECT).eq('workspace_id', workspaceId).eq('table_id', pipeline.id).is('archived_at', null)
    if (input.search) {
      const term = toIlikeSearchTerm(input.search)
      if (term) q = q.ilike('title', `%${term}%`)
    }
    if (input.stage) {
      const stage = matchStage(pipeline.stages, input.stage)
      if (!stage) return []
      q = q.eq(`custom_fields->>${PIPELINE_KEYS.stage}`, stage.name)
    }
    if (input.status && input.status !== 'all') {
      const names = pipeline.stages.filter((s) => s.kind === input.status).map((s) => s.name)
      if (input.status === 'open') {
        // An open deal is one in an open stage, or in none.
        q = names.length ? q.or(`custom_fields->>${PIPELINE_KEYS.stage}.is.null,custom_fields->>${PIPELINE_KEYS.stage}.in.${inList(names)}`) : q.is(`custom_fields->>${PIPELINE_KEYS.stage}`, null)
      } else {
        if (!names.length) return []
        q = q.in(`custom_fields->>${PIPELINE_KEYS.stage}`, names)
      }
    }
    if (input.company_id && isUuid(input.company_id)) q = q.contains('custom_fields', { [PIPELINE_KEYS.company]: [input.company_id] })
    if (input.contact_id && isUuid(input.contact_id)) q = q.contains('custom_fields', { [PIPELINE_KEYS.contacts]: [input.contact_id] })
    if (input.owner_id && isUuid(input.owner_id)) q = q.eq(`custom_fields->>${PIPELINE_KEYS.owner}`, input.owner_id)
    const { data, error } = await q.order('updated_at', { ascending: false }).limit(limit)
    if (error) throw new Error(error.message)
    return ((data ?? []) as DataRow[]).map((r) => rowToDeal(r, pipeline, workspaceId))
  })
  const deals = (await Promise.all(reads)).flat().sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0))
  return { deals: deals.slice(0, limit), pipelines }
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface DealInput {
  name?: string
  value?: number | null
  currency?: string
  /** A pipeline id or name. Default: the default pipeline. A deal stays in its pipeline. */
  pipeline?: string
  /** A stage name in that pipeline. Default on create: the first stage. */
  stage?: string
  expected_close_date?: string | null
  owner_id?: string | null
  company_id?: string | null
  contact_ids?: string[]
  /** Contacts to add to the ones already on the deal. */
  add_contact_ids?: string[]
  notes?: string | null
  /** The pipeline's other columns' values, by key or name; null clears one. */
  custom_fields?: Record<string, unknown>
}

/** The most a Notes value holds: a table's text column's limit. */
export const DEAL_NOTES_MAX = 2000

type Resolved = { ok: true; title?: string; values: Record<string, CustomFieldValue> } | { ok: false; error: string }

/** A pipeline's columns a value is written to, as custom field definitions (a formula or rollup is worked out, never set). */
function columnDefs(pipeline: DealPipeline): CustomFieldDefinition[] {
  return pipeline.columns.flatMap((c) => (isComputedType(c.field_type) ? [] : [{ ...c, field_type: c.field_type }])).map((c) => ({
    id: c.id,
    workspace_id: '',
    entity_type: 'contact',
    key: c.key,
    label: c.label,
    field_type: c.field_type,
    options: c.options,
    config: c.config ?? {},
    position: c.position,
  }))
}

/** A DealInput as row values, each reference checked against the workspace (and the viewer). */
async function resolveInput(
  db: SupabaseClient,
  workspaceId: string,
  pipeline: DealPipeline,
  input: DealInput,
  current: Deal | null,
  viewer: string | null,
  grants: boolean,
  writer: string | null,
): Promise<Resolved> {
  const values: Record<string, CustomFieldValue> = {}
  let title: string | undefined
  const has = (key: string) => pipeline.columns.some((c) => c.key === key)

  if (input.name !== undefined) {
    const name = input.name.trim()
    if (!name) return { ok: false, error: 'A deal needs a name.' }
    title = name.slice(0, 200)
  }
  if (input.value !== undefined || input.currency !== undefined) {
    let currency = current?.value !== null && current ? current.currency : pipelineCurrency(pipeline)
    if (input.currency !== undefined) {
      const c = input.currency.trim().toUpperCase()
      if (!/^[A-Z]{3}$/.test(c)) return { ok: false, error: 'Currency is a three-letter code, like USD or EUR.' }
      currency = c
    }
    const amount = input.value !== undefined ? input.value : current?.value ?? null
    if (amount !== null && (!Number.isFinite(amount) || amount < 0)) return { ok: false, error: 'The value must be a positive number.' }
    if (input.value !== undefined || amount !== null) values[PIPELINE_KEYS.value] = amount === null ? null : { amount: Math.round(amount * 100) / 100, currency }
  }
  if (input.expected_close_date !== undefined) {
    if (input.expected_close_date !== null && !isIsoDate(input.expected_close_date)) return { ok: false, error: 'The close date is YYYY-MM-DD.' }
    values[PIPELINE_KEYS.expectedClose] = input.expected_close_date
  }
  if (input.notes !== undefined) {
    if (!has(PIPELINE_KEYS.notes)) return { ok: false, error: `${pipeline.name} has no Notes column.` }
    const notes = input.notes === null ? '' : input.notes.trim()
    values[PIPELINE_KEYS.notes] = notes ? notes.slice(0, DEAL_NOTES_MAX) : null
  }

  if (input.stage !== undefined || !current) {
    if (!pipeline.stages.length) return { ok: false, error: `${pipeline.name} has no stages.` }
    let stage: DealStage | null = pipeline.stages[0]
    if (input.stage) {
      stage = matchStage(pipeline.stages, input.stage)
      if (!stage) return { ok: false, error: `No stage "${input.stage}" in ${pipeline.name}. Stages: ${stageList(pipeline)}.` }
    }
    if (stage) values[PIPELINE_KEYS.stage] = stage.name
  }

  if (input.owner_id !== undefined) {
    if (input.owner_id !== null) {
      if (!isUuid(input.owner_id)) return { ok: false, error: 'owner_id is a workspace member id.' }
      const { data } = await db.from('member').select('id').eq('id', input.owner_id).eq('workspace_id', workspaceId).maybeSingle()
      if (!data) return { ok: false, error: 'That owner is not a member of this workspace.' }
    }
    values[PIPELINE_KEYS.owner] = input.owner_id
  }
  if (input.company_id !== undefined) {
    if (input.company_id !== null) {
      if (!isUuid(input.company_id)) return { ok: false, error: 'company_id is a company id from list_companies.' }
      const { data } = await db.from('company').select('id').eq('id', input.company_id).eq('workspace_id', workspaceId).maybeSingle()
      if (!data) return { ok: false, error: 'Company not found.' }
      // On a service-role client (the agent's tools), a company the person
      // can't see is not found, as their own page would say.
      if (viewer && input.company_id !== current?.company_id && !(await isCompanyVisibleTo(db, input.company_id, viewer, grants ? {} : { grants: false }))) {
        return { ok: false, error: 'Company not found.' }
      }
    }
    values[PIPELINE_KEYS.company] = input.company_id === null ? null : [input.company_id]
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
        const fresh = await filterVisibleContacts(db, viewer, rows.filter((r) => !already.has(r.id)), grants ? {} : { grants: false })
        rows = [...rows.filter((r) => already.has(r.id)), ...fresh]
      }
      const found = new Set(rows.map((c) => c.id))
      const missing = wanted.filter((id) => !found.has(id))
      if (missing.length) return { ok: false, error: `Contact not found: ${missing.join(', ')}` }
    }
    values[PIPELINE_KEYS.contacts] = wanted.length ? wanted : null
  }

  if (input.custom_fields && Object.keys(input.custom_fields).length) {
    const defs = columnDefs(pipeline).filter((d) => !BUILT_IN_KEYS.has(d.key))
    const resolved = resolveCustomValues(defs, input.custom_fields)
    if (!resolved.ok) return resolved
    const problem = await fieldReferenceCheck(db, { workspaceId, userId: writer, grants })(defs, resolved.patch, current?.custom_fields ?? {})
    if (problem) return { ok: false, error: problem }
    Object.assign(values, resolved.patch)
  }

  return { ok: true, ...(title !== undefined ? { title } : {}), values }
}

/** The stored values a deal holds now, by row field ('title' and column keys). */
function storedOf(deal: Deal | null): Record<string, unknown> {
  if (!deal) return {}
  return {
    title: deal.name,
    [PIPELINE_KEYS.stage]: deal.stage,
    [PIPELINE_KEYS.value]: deal.value === null ? null : { amount: deal.value, currency: deal.currency },
    [PIPELINE_KEYS.expectedClose]: deal.expected_close_date,
    [PIPELINE_KEYS.owner]: deal.owner_id,
    [PIPELINE_KEYS.company]: deal.company_id ? [deal.company_id] : null,
    [PIPELINE_KEYS.contacts]: deal.contact_ids.length ? deal.contact_ids : null,
    [PIPELINE_KEYS.notes]: deal.notes,
    ...deal.custom_fields,
  }
}

/** The before and after of every field a write changes (contacts compared as sets). */
export function diffDeal(current: Deal | null, next: { title?: string; values: Record<string, unknown> }): DealChanges {
  const now = storedOf(current)
  const changes: DealChanges = {}
  const fields: Array<[string, unknown]> = [...(next.title !== undefined ? [['title', next.title] as [string, unknown]] : []), ...Object.entries(next.values)]
  for (const [key, to] of fields) {
    const from = now[key] ?? null
    if (key === PIPELINE_KEYS.contacts) {
      const a = [...((from as string[] | null) ?? [])].sort()
      const b = [...((to as string[] | null) ?? [])].sort()
      if (!sameValue(a, b)) changes[key] = { from, to: to ?? null }
      continue
    }
    if (!sameValue(from, to)) changes[key] = { from, to: to ?? null }
  }
  return changes
}

export type DealWriteResult =
  | { ok: true; deal: Deal; changes: DealChanges; eventId: string | null }
  | { ok: false; error: string }

/** The table store's actor for a deal change. */
function tableActor(actor: DealActor, opts: WriteOptions): TableActor {
  return {
    userId: actor.userId,
    source: actor.source,
    reason: actor.reason ?? null,
    sourceRef: actor.sourceRef ?? null,
    asUserId: opts.viewer ?? actor.userId,
    ...(opts.grants === false ? { grants: false } : {}),
  }
}

const readOpts = (opts: WriteOptions): PipelineReadOptions => ({ viewer: opts.viewer ?? null })

/** Creates a deal (in the default pipeline's first stage unless told otherwise) in one logged batch. */
export async function createDeal(
  db: SupabaseClient,
  workspaceId: string,
  input: DealInput & { name: string },
  actor: DealActor,
  opts: WriteOptions & { pipelines?: DealPipeline[] } = {},
): Promise<DealWriteResult> {
  const pipelines = opts.pipelines ?? (await listPipelines(db, workspaceId, readOpts(opts)))
  const pipeline = input.pipeline ? matchPipeline(pipelines, input.pipeline) : pipelines.find((p) => p.is_default) ?? pipelines[0]
  if (!pipeline) {
    return { ok: false, error: input.pipeline ? `No pipeline called "${input.pipeline}". Pipelines: ${pipelines.map((x) => x.name).join(', ')}.` : 'There is no pipeline to put it in.' }
  }
  const writer = opts.viewer ?? actor.userId
  const resolved = await resolveInput(db, workspaceId, pipeline, input, null, opts.viewer ?? null, opts.grants !== false, writer)
  if (!resolved.ok) return resolved
  const values = { ...resolved.values }
  if (values[PIPELINE_KEYS.owner] === undefined && actor.userId) {
    const { data } = await db.from('member').select('id').eq('workspace_id', workspaceId).eq('user_id', actor.userId).maybeSingle()
    if (data) values[PIPELINE_KEYS.owner] = (data as { id: string }).id
  }
  // A new row has nothing to clear.
  for (const [k, v] of Object.entries(values)) if (v === null) delete values[k]
  const id = crypto.randomUUID()
  const written = await applyOps(db, workspaceId, pipeline.id, { baseVersion: null, ops: [{ op: 'insert_rows', rows: [{ id, title: resolved.title ?? input.name, values }] }] }, tableActor(actor, opts))
  if (!written.ok) return { ok: false, error: written.error }
  const deal = await getDeal(db, workspaceId, id, pipelines)
  if (!deal) return { ok: false, error: 'The deal was made but could not be read back.' }
  return { ok: true, deal, changes: diffDeal(null, { title: deal.name, values }), eventId: written.value.change_id }
}

/**
 * Updates a deal: only the fields given are touched, in one batch, so one
 * undo reverses the whole write. A write that changes nothing logs nothing.
 */
export async function updateDeal(
  db: SupabaseClient,
  workspaceId: string,
  dealId: string,
  input: DealInput,
  actor: DealActor,
  opts: WriteOptions & { pipelines?: DealPipeline[] } = {},
): Promise<DealWriteResult> {
  const pipelines = opts.pipelines ?? (await listPipelines(db, workspaceId, readOpts(opts)))
  const current = await getDeal(db, workspaceId, dealId, pipelines)
  if (!current) return { ok: false, error: 'Deal not found' }
  const pipeline = pipelines.find((p) => p.id === current.pipeline_id)!
  if (input.pipeline && matchPipeline(pipelines, input.pipeline)?.id !== pipeline.id) {
    return { ok: false, error: `A deal stays in its pipeline (${pipeline.name}). Make a new deal in the other one instead.` }
  }
  const writer = opts.viewer ?? actor.userId
  const resolved = await resolveInput(db, workspaceId, pipeline, input, current, opts.viewer ?? null, opts.grants !== false, writer)
  if (!resolved.ok) return resolved
  const changes = diffDeal(current, resolved)
  if (!Object.keys(changes).length) return { ok: true, deal: current, changes, eventId: null }
  const values: Record<string, CustomFieldValue> = {}
  for (const key of Object.keys(changes)) if (key !== 'title') values[key] = resolved.values[key] ?? null
  const op = { op: 'update_row' as const, row_id: dealId, ...('title' in changes ? { title: resolved.title } : {}), ...(Object.keys(values).length ? { values } : {}) }
  const written = await applyOps(db, workspaceId, pipeline.id, { baseVersion: null, ops: [op] }, tableActor(actor, opts))
  if (!written.ok) return { ok: false, error: written.error }
  const deal = (await getDeal(db, workspaceId, dealId, pipelines)) ?? current
  return { ok: true, deal, changes, eventId: written.value.change_id }
}

export interface DealEvent {
  id: string
  deal_id: string
  kind: 'created' | 'updated' | 'moved' | 'undo'
  changes: DealChanges
  source: DealChangeSource | 'import'
  reason: string | null
  /** The email thread, capture or text it came from. */
  source_ref: string | null
  actor_user_id: string | null
  undone_at: string | null
  created_at: string
}

/** Does a pipeline change touch this deal? */
const touches = (change: DataChange, dealId: string) => touchedBy(change).rowIds.includes(dealId)

/** One change as a deal's event: what it did to this deal. */
function asEvent(change: DataChange, dealId: string): DealEvent {
  const changes: DealChanges = {}
  let created = false
  for (const e of change.changes ?? []) {
    if (e?.op === 'insert_rows' && e.row_ids.includes(dealId)) created = true
    if (e?.op !== 'update_row' || e.row_id !== dealId) continue
    for (const [field, ch] of Object.entries(e.fields ?? {})) {
      const key = field.startsWith('values.') ? field.slice('values.'.length) : field
      changes[key] = { from: ch.from, to: ch.to }
    }
  }
  const kind = created ? 'created' : change.undo_of ? 'undo' : Object.keys(changes).every((k) => k === PIPELINE_KEYS.stage) && changes[PIPELINE_KEYS.stage] ? 'moved' : 'updated'
  return {
    id: change.id,
    deal_id: dealId,
    kind,
    changes,
    source: change.source as DealEvent['source'],
    reason: change.reason,
    source_ref: change.source_ref ?? null,
    actor_user_id: change.actor_user_id,
    undone_at: change.undone_at,
    created_at: change.created_at,
  }
}

/**
 * A deal's changes, newest first: its pipeline's changes that name its row,
 * read by the row (an entry's row_id, or its row_ids), not from the table's
 * latest.
 */
export async function changesForDeal(db: SupabaseClient, workspaceId: string, deal: Pick<Deal, 'id' | 'pipeline_id'>, limit = 50): Promise<DataChange[]> {
  const n = Math.min(Math.max(1, limit), 200)
  const read = (shape: Record<string, unknown>) =>
    db
      .from('data_change')
      .select(CHANGE_SELECT)
      .eq('workspace_id', workspaceId)
      .eq('table_id', deal.pipeline_id)
      .contains('changes', [shape])
      .order('created_at', { ascending: false })
      .limit(n)
  const [one, many] = await Promise.all([read({ row_id: deal.id }), read({ row_ids: [deal.id] })])
  if (one.error) throw new Error(one.error.message)
  if (many.error) throw new Error(many.error.message)
  const byId = new Map<string, DataChange>()
  for (const c of [...((one.data ?? []) as DataChange[]), ...((many.data ?? []) as DataChange[])]) byId.set(c.id, c)
  return [...byId.values()]
    .filter((c) => touches(c, deal.id))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.version - a.version))
    .slice(0, n)
}

/** A deal's recent changes, newest first. */
export async function listDealEvents(db: SupabaseClient, workspaceId: string, deal: Pick<Deal, 'id' | 'pipeline_id'>, limit = 20): Promise<DealEvent[]> {
  const changes = await changesForDeal(db, workspaceId, deal, limit)
  return changes.map((c) => asEvent(summarizeChange(c), deal.id))
}

export type UndoResult =
  | { ok: true; deal: Deal; restored: string[]; kept: string[] }
  | { ok: false; error: string }

/**
 * Takes one change back: what it changed goes back, unless it has changed
 * since (then the newer value stays, and the result says so in `kept`).
 * With no change id, the deal's latest change that is not itself an undo
 * and not undone yet. A deal's creation is not undone here: removing a deal
 * stays the person's click. A change that touched other rows too (a batch
 * from the grid) is taken back whole.
 */
export async function undoDealChange(
  db: SupabaseClient,
  workspaceId: string,
  args: { dealId: string; changeId?: string },
  actor: DealActor,
  opts: WriteOptions & { pipelines?: DealPipeline[] } = {},
): Promise<UndoResult> {
  const pipelines = opts.pipelines ?? (await listPipelines(db, workspaceId, readOpts(opts)))
  const deal = await getDeal(db, workspaceId, args.dealId, pipelines)
  if (!deal) return { ok: false, error: 'Deal not found' }
  const changes = await changesForDeal(db, workspaceId, deal, 200)
  let change: DataChange | undefined
  if (args.changeId) {
    if (!isUuid(args.changeId)) return { ok: false, error: 'Change not found' }
    change = changes.find((c) => c.id === args.changeId)
    if (!change) return { ok: false, error: 'Change not found' }
  } else {
    change = changes.find((c) => !c.undo_of && !c.undone_at)
    if (!change) return { ok: false, error: 'Nothing to undo on this deal.' }
  }
  if (asEvent(change, deal.id).kind === 'created') return { ok: false, error: 'That change created the deal. Archive the deal instead if it should not exist.' }
  if (change.undo_of) return { ok: false, error: 'That change was itself an undo.' }
  if (change.undone_at) return { ok: false, error: 'That change was already undone.' }
  const undone = await undoChange(db, workspaceId, deal.pipeline_id, change.id, tableActor(actor, opts))
  if (!undone.ok) return { ok: false, error: undone.error }
  const updated = (await getDeal(db, workspaceId, deal.id, pipelines)) ?? deal
  return { ok: true, deal: updated, restored: undone.value.restored, kept: undone.value.kept }
}

// ── For the model ───────────────────────────────────────────────────────────

/** A deal as the agent reads it: names instead of ids where it helps. */
export function describeDeal(
  deal: Deal,
  ctx: { pipelines: DealPipeline[]; companies?: Map<string, string>; contacts?: Map<string, string>; owners?: Map<string, string> },
) {
  const pipeline = ctx.pipelines.find((p) => p.id === deal.pipeline_id)
  return {
    id: deal.id,
    name: deal.name,
    value: deal.value,
    currency: deal.currency,
    pipeline: pipeline?.name ?? null,
    stage: deal.stage,
    status: deal.status,
    expected_close_date: deal.expected_close_date,
    owner_id: deal.owner_id,
    owner: deal.owner_id ? ctx.owners?.get(deal.owner_id) ?? null : null,
    // A company the reader can't see is neither named nor pointed at.
    company_id: deal.company_id && (!ctx.companies || ctx.companies.has(deal.company_id)) ? deal.company_id : null,
    company: deal.company_id ? ctx.companies?.get(deal.company_id) ?? null : null,
    // A contact the reader can't see is left out (its count says so).
    contacts: deal.contact_ids.filter((id) => !ctx.contacts || ctx.contacts.has(id)).map((id) => ({ id, name: ctx.contacts?.get(id) ?? null })),
    ...(ctx.contacts && deal.contact_ids.some((id) => !ctx.contacts!.has(id)) ? { other_contacts: deal.contact_ids.filter((id) => !ctx.contacts!.has(id)).length } : {}),
    notes: deal.notes,
    custom_fields: deal.custom_fields,
    closed_at: deal.closed_at,
    updated_at: deal.updated_at,
  }
}

/** Names for the ids a set of deals points at, in three small reads. */
export async function lookupDealNames(
  db: SupabaseClient,
  workspaceId: string,
  deals: readonly Deal[],
  viewer: string | null = null,
  // `grants: false` on a guest's or linked agent's turn: a grant opens no name (contact-visibility.ts).
  opts: { grants?: boolean } = {},
) {
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
    ;[companyRows, contactRows] = await Promise.all([filterVisibleCompanies(db, viewer, companyRows, opts), filterVisibleContacts(db, viewer, contactRows, opts)])
  }
  return {
    companies: new Map(companyRows.map((c) => [c.id, c.name])),
    contacts: new Map(contactRows.map((c) => [c.id, c.full_name || c.email || 'Unnamed'])),
    owners: new Map(((owners.data ?? []) as { id: string; display_name: string }[]).map((m) => [m.id, m.display_name])),
  }
}

/** "stage: Lead → Won", "value: $10,000 → $12,500": a change in words, for the agent's reply and a deal's history. */
export function describeChanges(changes: DealChanges, ctx: { columns?: readonly DataColumn[] } = {}): string[] {
  const label = (key: string) => (key === 'title' ? 'name' : ctx.columns?.find((c) => c.key === key)?.label.toLowerCase() ?? key)
  const money = (v: unknown) => {
    const m = v as Partial<CurrencyValue> | null
    return m && typeof m === 'object' && typeof m.amount === 'number' ? formatDealValue(m.amount, m.currency ?? 'USD') || String(m.amount) : 'none'
  }
  const out: string[] = []
  for (const [key, { from, to }] of Object.entries(changes)) {
    if (key === PIPELINE_KEYS.value) out.push(`${label(key)}: ${money(from)} → ${money(to)}`)
    else if (key === PIPELINE_KEYS.contacts) out.push(`${label(key)}: ${relationIds(from).length} → ${relationIds(to).length}`)
    else if (key === PIPELINE_KEYS.company) out.push(`${label(key)}: ${relationIds(from).length ? 'set' : 'none'} → ${relationIds(to).length ? 'set' : 'none'}`)
    else {
      const word = (v: unknown) => (v === null || v === undefined || v === '' ? 'none' : Array.isArray(v) ? v.join(', ') : String(v))
      out.push(`${label(key)}: ${word(from)} → ${word(to)}`)
    }
  }
  return out
}

/** The columns a deal's custom fields may be set on: a pipeline's own, past its system ones and Notes. */
export function dealFieldColumns(pipeline: DealPipeline): DataColumn[] {
  return pipeline.columns.filter((c) => !BUILT_IN_KEYS.has(c.key))
}

// ── Making pipelines; a record's deals ──────────────────────────────────────

export interface NewPipelineInput {
  name: string
  /** Its stages in order, each open, won or lost. None: Lead, Qualified, Proposal, Won, Lost. */
  stages?: Array<{ name: string; outcome?: DealStageKind }>
  currency?: string
}

/** A new pipeline (540's create_pipeline): its system columns, Notes and stages, owned by the caller. */
export async function createPipeline(
  db: SupabaseClient,
  workspaceId: string,
  input: NewPipelineInput,
  actor: DealActor & { asUserId?: string | null },
): Promise<{ ok: true; id: string } | { ok: false; error: string }> {
  const name = input.name.trim()
  if (!name) return { ok: false, error: 'A pipeline needs a name.' }
  if (name.length > 200) return { ok: false, error: "A pipeline's name is at most 200 characters." }
  const seen = new Set<string>()
  const stages = (input.stages ?? [])
    .map((s) => ({ name: s.name.trim().slice(0, 60), outcome: s.outcome === 'won' || s.outcome === 'lost' ? s.outcome : 'open' }))
    .filter((s) => {
      if (!s.name || seen.has(s.name.toLowerCase())) return false
      seen.add(s.name.toLowerCase())
      return true
    })
    .slice(0, 50)
  const currency = input.currency?.trim().toUpperCase() || 'USD'
  if (!/^[A-Z]{3}$/.test(currency)) return { ok: false, error: 'Currency is a three-letter code, like USD or EUR.' }
  const { data, error } = await db.rpc('create_pipeline', {
    p_workspace_id: workspaceId,
    p_name: name,
    p_stages: stages.length ? stages : null,
    p_source: actor.source,
    p_as_user: actor.asUserId ?? null,
    p_reason: actor.reason ?? null,
    p_default: false,
    p_currency: currency,
  })
  if (error) return { ok: false, error: error.message.charAt(0).toUpperCase() + error.message.slice(1) }
  return { ok: true, id: String((data as { table_id?: string } | null)?.table_id ?? '') }
}

/**
 * Make a pipeline the workspace's default (540's set_default_pipeline): a
 * live, workspace-wide pipeline the caller may change. The default is never
 * archived or private, so this is how another one takes its place first.
 */
export async function setDefaultPipeline(
  db: SupabaseClient,
  tableId: string,
  asUserId: string | null = null,
): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' | 'invalid'; error: string }> {
  const { error } = await db.rpc('set_default_pipeline', { p_table_id: tableId, p_as_user: asUserId })
  if (!error) return { ok: true }
  const message = error.message.charAt(0).toUpperCase() + error.message.slice(1)
  if (error.code === 'P0002') return { ok: false, reason: 'not_found', error: 'Pipeline not found' }
  if (error.code === '42501') return { ok: false, reason: 'forbidden', error: message }
  return { ok: false, reason: 'invalid', error: message }
}

/**
 * The deals a company or a contact is on: the pipeline rows whose Company or
 * Contacts value links it, found through their relation edges (524's
 * field_link), newest first. The caller's client decides what it reads.
 */
export async function dealsLinkedTo(
  db: SupabaseClient,
  workspaceId: string,
  target: { kind: 'company' | 'contact'; id: string },
  opts: PipelineReadOptions = {},
): Promise<{ deals: Deal[]; pipelines: DealPipeline[] }> {
  if (!isUuid(target.id)) return { deals: [], pipelines: [] }
  const { data: edges, error } = await db
    .from('entity_link')
    .select('source_id')
    .eq('workspace_id', workspaceId)
    .eq('relation', 'field_link')
    .eq('source_type', 'data_row')
    .eq('target_type', target.kind)
    .eq('target_id', target.id)
    .limit(500)
  if (error) throw new Error(error.message)
  const ids = [...new Set(((edges ?? []) as Array<{ source_id: string }>).map((e) => e.source_id))]
  const pipelines = await listPipelines(db, workspaceId, opts)
  if (!ids.length || !pipelines.length) return { deals: [], pipelines }
  const key = target.kind === 'company' ? PIPELINE_KEYS.company : PIPELINE_KEYS.contacts
  const { data, error: rowError } = await db
    .from('data_row')
    .select(ROW_SELECT)
    .eq('workspace_id', workspaceId)
    .in('table_id', pipelines.map((p) => p.id))
    .in('id', ids)
    .is('archived_at', null)
    .order('updated_at', { ascending: false })
  if (rowError) throw new Error(rowError.message)
  const deals = ((data ?? []) as DataRow[])
    // The link is the deal's own Company or Contacts, not another column's.
    .filter((r) => relationIds((r.custom_fields ?? {})[key]).includes(target.id))
    .map((r) => rowToDeal(r, pipelines.find((p) => p.id === r.table_id)!, workspaceId))
  return { deals, pipelines }
}
