/**
 * Records kept up to date from email, meetings and texts (tables phase 8,
 * migration 539; roadmap #8: "kept up to date from your email, meetings and
 * messages instead of by hand"). It generalizes ../email/action-done-from-mail.ts
 * from to-dos to any table row.
 *
 * A source (./sources.ts: an arriving email thread, a finished meeting, a
 * customer's text) comes with the person it is for and the people it
 * involves. Then, for that one source:
 *
 *   1. Candidates, in the source's own workspace only, never another's:
 *      - the person's open to-dos, as ../email/action-done-from-mail.ts reads
 *        them, when the source may close one (./sources.ts says): a meeting,
 *        any of them; an email or a text, only those linked (entity_link,
 *        either way, the to-do's own or its project's) to the contacts or
 *        companies the source involves, so a stranger can't close what isn't
 *        theirs;
 *      - the table rows a relation field links to a contact or a company the
 *        source involves (field_link edges, migration 524), in live tables
 *        the person may change (data_table_editable_by: a private table of
 *        another member, or one they only view, is left out).
 *      Never a record made after the source (a record made from this very
 *      source is not changed by it), and never one a pending proposal names
 *      (a meeting's card decides that one).
 *   2. The changes each could take (planChanges): a to-do done; a select set
 *      to another of its options; a date, an amount or a number the source's
 *      own sentences name (./values.ts); a checkbox flipped. Never a change
 *      this engine made to that record before (applied or undone: a record
 *      the person took back stays as they left it), never a select or a
 *      checkbox set back to a value the person moved it away from, and never
 *      a to-do mail or this engine closed before. A pipeline's stage (a select
 *      with outcomes, migration 540) reads by its outcomes: a closed deal
 *      (won or lost) is the person's to reopen, so its stage is left alone; a
 *      deal the person reopened, or one this engine closed before, is never
 *      closed again (no won or lost stage); moving between open stages is
 *      normal, so an open stage left behind can be set again.
 *   3. One decision (record.kept_up_to_date, on Jev, the utility path): the
 *      ONE change the source states in plain words, and the sentence that
 *      says it, or none.
 *   4. Apply, recorded once: a kept_change row first (unique per source and
 *      record: a retried pass changes nothing twice), then the change, only
 *      while the record still holds what was read (another change in between
 *      wins, and the row goes):
 *      - a row: one applyOps batch as the person's agent, source 'email',
 *        'capture' or 'sms', its reason only what and where from ("Kept up to
 *        date from an email"): never the source's words, sender or domain,
 *        since the table's history is every reader's and mail is never shown
 *        to another person (341). The sentence lives only in the person's
 *        own message and kept_change. A refusal (a required-when rule, a
 *        column changed) means no change, and the row goes;
 *      - a to-do: its team's done state, as an agent's change for flows.
 *   5. ONE message in the person's home thread with what changed, the
 *      sentence and Undo (./part.ts), and a line in the agent's log.
 *
 * At most MAX_KEPT_PER_PASS changes a pass. No setting: Undo is the control
 * (Liam, 2026-10-20: apply with undo, not an approval queue).
 *
 * Undo (undoKeptChange): a row's batch goes back through undoChange (each
 * value back unless changed since); a to-do goes back where it was, while it
 * is still in the done state. The kept_change row stays, so that source
 * never changes that record again, and no source sets it that way again.
 *
 * Until migration 539 is applied the reads fail and nothing changes. Never
 * throws into a source's pass.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { runDecision } from '@/lib/ai/decisions/run-decision'
import type { DecisionResult } from '@/lib/ai/decisions/contracts'
import {
  KEPT_MAX_CHANGES,
  KEPT_MAX_RECORDS,
  type KeptChange,
  type KeptChangeType,
  type KeptRecord,
  type RecordKeptUpToDateInput,
  type RecordKeptUpToDateValue,
} from '@/lib/ai/decisions/tasks/record-kept-up-to-date'
import { readOpenTodos, type OpenTodo } from '@/lib/email/action-done-from-mail'
import { homeConversationId } from '@/lib/email/auto-archive'
import { emitStatusChange } from '@/lib/flows/emit-status-change'
import { appendLogLine, logDedupeKey, logLineFor } from '@/lib/log/agent-log'
import { isMissingColumnError } from '@/lib/mcp-client/public-row'
import { fieldCurrency, formatFieldValue, isCustomFieldType, optionOutcome } from '@/lib/crm/custom-field-types'
import type { CustomFieldValue } from '@/lib/crm/custom-fields'
import { applyOps, listColumns, undoChange } from '@/lib/tables/store'
import { TABLE_LIMITS, type DataColumn } from '@/lib/tables/types'
import { KEPT_EVIDENCE_MAX, KEPT_MESSAGE_KIND, KEPT_PART_TYPE, KEPT_TITLE_MAX, KEPT_VALUE_MAX, keptMessageId, type KeptPartData, type KeptSourceKind } from './part'
import { amountsIn, datesIn, numbersIn, sentencesOf, type FoundAmount, type FoundDate } from './values'

/** At most this many records changed by one pass (a flood waits for Undo, not a sweep). */
export const MAX_KEPT_PER_PASS = 3
/** Rows read per source, the most recently touched first, before the per-decision cap. */
const ROW_READS = 40
/** Tables a source's rows may sit in. */
const MAX_TABLES = 10
/** Rows and to-dos beside one source. */
const MAX_ROWS = 10
const MAX_TASKS = 15
/** Options of one select offered as changes. */
const MAX_SELECT_OPTIONS = 10
/** Values shown per row. */
const MAX_VALUES_SHOWN = 8
/** The decision's input, as JSON, within the task's state budget (its option keys and notes ride on top). */
const INPUT_BUDGET = 20_000
/** How far back the person's own moves count (a select or a checkbox they moved away from a value). */
const PERSON_MOVES_DAYS = 180

const TABLE = 'kept_change'

function isPre539Error(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumnError(error, TABLE) || error?.code === '42P01'
}

export interface KeptScope {
  workspaceId: string
  userId: string
}

/** Who a source involves: CRM contacts and companies in its workspace, with their names. */
export interface KeptPeople {
  contactIds: string[]
  companyIds: string[]
  names: Map<string, string>
}

/** One source, as a pass reads it (./sources.ts makes these). */
export interface KeptSourceItem {
  source: KeptSourceKind
  /** The source's own id: unique per source item (a message, a capture). */
  ref: string
  /** A sender's domain, or null. */
  label: string | null
  /** When it happened: a record made after it is not changed by it. */
  atIso: string | null
  header: RecordKeptUpToDateInput['source']
  /** What came before, for context only (never quoted). */
  context?: string
  /** The words judged: one or more lines. */
  text: string
  people: KeptPeople
  /** Which of the person's open to-dos are candidates: none, those linked to its people, or all (a meeting). */
  tasks: false | 'linked' | 'all'
}

// ── Who a source involves ──────────────────────────────────────────────────

const EMAIL_RE = /^[^\s@,()"<>]+@[^\s@,()"<>]+\.[^\s@,()"<>]+$/

/**
 * The live CRM contacts with these emails or ids in the workspace, their
 * companies, and the companies at these domains. Never throws: a failed read
 * is nobody.
 */
export async function peopleFor(
  supabase: SupabaseClient,
  workspaceId: string,
  who: { emails?: readonly string[]; contactIds?: readonly string[]; domains?: readonly string[] },
): Promise<KeptPeople> {
  const people: KeptPeople = { contactIds: [], companyIds: [], names: new Map() }
  try {
    const emails = [...new Set((who.emails ?? []).map((e) => e.trim().toLowerCase()).filter((e) => EMAIL_RE.test(e)))].slice(0, 20)
    const ids = [...new Set((who.contactIds ?? []).filter((id) => typeof id === 'string' && id))].slice(0, 20)
    const rows: Array<{ id: string; full_name: string | null; company_id: string | null }> = []
    if (emails.length) {
      const { data } = await supabase.from('contact').select('id, full_name, company_id').eq('workspace_id', workspaceId).is('merged_into_contact_id', null).in('email', emails).limit(20)
      rows.push(...((data ?? []) as typeof rows))
    }
    if (ids.length) {
      const { data } = await supabase.from('contact').select('id, full_name, company_id').eq('workspace_id', workspaceId).is('merged_into_contact_id', null).in('id', ids).limit(20)
      rows.push(...((data ?? []) as typeof rows))
    }
    for (const r of rows) {
      if (!people.contactIds.includes(r.id)) people.contactIds.push(r.id)
      if (r.full_name) people.names.set(r.id, r.full_name)
    }
    const companyIds = new Set(rows.map((r) => r.company_id).filter((id): id is string => !!id))
    const domains = [...new Set((who.domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))].slice(0, 10)
    const companies: Array<{ id: string; name: string | null }> = []
    if (companyIds.size) {
      const { data } = await supabase.from('company').select('id, name').eq('workspace_id', workspaceId).in('id', [...companyIds])
      companies.push(...((data ?? []) as typeof companies))
    }
    if (domains.length) {
      const { data } = await supabase.from('company').select('id, name').eq('workspace_id', workspaceId).in('domain', domains).limit(10)
      companies.push(...((data ?? []) as typeof companies))
    }
    for (const c of companies) {
      if (!people.companyIds.includes(c.id)) people.companyIds.push(c.id)
      if (c.name) people.names.set(c.id, c.name)
    }
  } catch (err) {
    console.warn('[kept-up-to-date] people not read:', err instanceof Error ? err.message : String(err))
  }
  return people
}

// ── Candidates ─────────────────────────────────────────────────────────────

/** A table row a source may change. */
export interface RowCandidate {
  id: string
  tableId: string
  tableName: string
  title: string
  values: Record<string, CustomFieldValue>
  columns: DataColumn[]
  /** The names of who it links to that the source involves. */
  linked: string[]
  createdAt: string | null
}

const before = (createdAt: string | null, atIso: string | null) => {
  const at = atIso ? Date.parse(atIso) : NaN
  return !Number.isFinite(at) || !createdAt || Date.parse(createdAt) < at
}

/**
 * The rows linked to the source's people that the person may change, in the
 * workspace, the ones linked to a contact first (see the header). Null when
 * they can't be read: the pass changes nothing.
 */
export async function readRowCandidates(supabase: SupabaseClient, scope: KeptScope, people: KeptPeople, atIso: string | null): Promise<RowCandidate[] | null> {
  const targets = [...people.contactIds, ...people.companyIds]
  if (!targets.length) return []
  try {
    const { data: links, error: linkError } = await supabase
      .from('entity_link')
      .select('source_id, target_type, target_id')
      .eq('workspace_id', scope.workspaceId)
      .eq('source_type', 'data_row')
      .eq('relation', 'field_link')
      .in('target_type', ['contact', 'company'])
      .in('target_id', targets)
      .limit(200)
    if (linkError) return null
    const byRow = new Map<string, { contact: boolean; names: Set<string> }>()
    for (const l of (links ?? []) as Array<{ source_id: string; target_type: string; target_id: string }>) {
      const entry = byRow.get(l.source_id) ?? byRow.set(l.source_id, { contact: false, names: new Set() }).get(l.source_id)!
      if (l.target_type === 'contact') entry.contact = true
      const name = people.names.get(l.target_id)
      if (name) entry.names.add(name)
    }
    if (!byRow.size) return []
    const { data: rowData, error: rowError } = await supabase
      .from('data_row')
      .select('id, table_id, title, custom_fields, created_at, updated_at')
      .eq('workspace_id', scope.workspaceId)
      .in('id', [...byRow.keys()].slice(0, 200))
      .is('archived_at', null)
      .order('updated_at', { ascending: false })
      .limit(ROW_READS)
    if (rowError) return null
    const rows = ((rowData ?? []) as Array<{ id: string; table_id: string; title: string | null; custom_fields: Record<string, CustomFieldValue> | null; created_at: string | null }>).filter((r) => before(r.created_at, atIso))
    if (!rows.length) return []
    const tableIds = [...new Set(rows.map((r) => r.table_id))].slice(0, MAX_TABLES)
    const { data: tableData, error: tableError } = await supabase
      .from('data_table')
      .select('id, name')
      .eq('workspace_id', scope.workspaceId)
      .in('id', tableIds)
      .is('archived_at', null)
    if (tableError) return null
    const tables = new Map<string, { name: string; columns: DataColumn[] }>()
    // Only a table the person may change (a private one of another member, or one shared to view, is not), all at once.
    const checked = await Promise.all(
      ((tableData ?? []) as Array<{ id: string; name: string }>).map(async (t) => {
        const { data: editable, error } = await supabase.rpc('data_table_editable_by', { p_table_id: t.id, p_user_id: scope.userId })
        return error || editable !== true ? null : { ...t, columns: await listColumns(supabase, scope.workspaceId, t.id) }
      }),
    )
    for (const t of checked) if (t) tables.set(t.id, { name: t.name, columns: t.columns })
    return rows
      .filter((r) => tables.has(r.table_id))
      .map((r) => {
        const table = tables.get(r.table_id)!
        return {
          id: r.id,
          tableId: r.table_id,
          tableName: table.name,
          title: (r.title ?? '').trim() || 'Untitled',
          values: r.custom_fields ?? {},
          columns: table.columns,
          linked: [...byRow.get(r.id)!.names].slice(0, 6),
          createdAt: r.created_at,
          contact: byRow.get(r.id)!.contact,
        }
      })
      .sort((a, b) => Number(b.contact) - Number(a.contact))
      .slice(0, MAX_ROWS)
      .map(({ contact: _contact, ...row }) => row)
  } catch (err) {
    console.warn('[kept-up-to-date] rows not read:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** What earlier changes rule out (see the header). */
export interface PriorChanges {
  /** Tasks mail or this engine closed before. */
  tasks: Set<string>
  /** `${recordId}|${key}|${JSON value}`: a value this engine set before. */
  values: Set<string>
  /** The same keys: a value the person moved a field away from. */
  moved: Set<string>
}

export const valueKey = (recordId: string, key: string, value: unknown) => `${recordId}|${key}|${JSON.stringify(value ?? null)}`

/** Earlier changes on these records. Null when they can't be read (539 not applied): nothing changes. */
export async function readPriorChanges(
  supabase: SupabaseClient,
  scope: KeptScope,
  rows: ReadonlyArray<{ id: string; tableId: string }>,
  taskIds: readonly string[],
  nowMs = Date.now(),
): Promise<PriorChanges | null> {
  const prior: PriorChanges = { tasks: new Set(), values: new Set(), moved: new Set() }
  const rowIds = rows.map((r) => r.id)
  const ids = [...rowIds, ...taskIds]
  if (!ids.length) return prior
  try {
    const { data, error } = await supabase.from(TABLE).select('record_type, record_id, field_key, to_value').eq('workspace_id', scope.workspaceId).in('record_id', ids)
    if (error) {
      if (!isPre539Error(error)) console.warn('[kept-up-to-date] earlier changes not read:', error.message)
      return null
    }
    for (const r of (data ?? []) as Array<{ record_type: string; record_id: string; field_key: string | null; to_value: unknown }>) {
      if (r.record_type === 'action') prior.tasks.add(r.record_id)
      else if (r.field_key) prior.values.add(valueKey(r.record_id, r.field_key, r.to_value))
    }
    if (rows.length) {
      const since = new Date(nowMs - PERSON_MOVES_DAYS * 86_400_000).toISOString()
      // Each row's own history (the batches that touched it), not the newest across its tables.
      const reads = await Promise.all(
        rows.map((r) =>
          supabase
            .from('data_change')
            .select('changes')
            .eq('workspace_id', scope.workspaceId)
            .eq('table_id', r.tableId)
            .eq('source', 'person')
            .gte('created_at', since)
            .contains('changes', [{ row_id: r.id }])
            .order('created_at', { ascending: false })
            .limit(50),
        ),
      )
      if (reads.some((r) => r.error)) return null
      const wanted = new Set(rowIds)
      for (const c of reads.flatMap((r) => (r.data ?? []) as Array<{ changes: unknown }>)) {
        for (const e of Array.isArray(c.changes) ? (c.changes as Array<Record<string, unknown>>) : []) {
          if (e?.op !== 'update_row' || typeof e.row_id !== 'string' || !wanted.has(e.row_id)) continue
          for (const [field, ch] of Object.entries((e.fields ?? {}) as Record<string, { from?: unknown; to?: unknown }>)) {
            if (!field.startsWith('values.') || !ch || ch.from === null || ch.from === undefined) continue
            prior.moved.add(valueKey(e.row_id, field.slice('values.'.length), ch.from))
          }
        }
      }
    }
    return prior
  } catch (err) {
    console.warn('[kept-up-to-date] earlier changes not read:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── Changes ────────────────────────────────────────────────────────────────

/** One change a source could make, as the engine keeps it. */
export type PlannedChange =
  | { id: string; kind: 'task_done'; record: number; task: OpenTodo }
  | { id: string; kind: 'row_set'; record: number; row: RowCandidate; key: string; label: string; type: Exclude<KeptChangeType, 'done'>; from: CustomFieldValue | null; to: CustomFieldValue }

export type KeptCandidate = { kind: 'task'; task: OpenTodo } | { kind: 'row'; row: RowCandidate }

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
const amountOf = (v: unknown): number | null => (typeof v === 'number' ? v : v && typeof v === 'object' && typeof (v as { amount?: unknown }).amount === 'number' ? (v as { amount: number }).amount : null)

/**
 * The changes each candidate could take from these found values (see the
 * header), rows first, at most KEPT_MAX_CHANGES, and the candidates that
 * have one, in the decision's order. Pure.
 */
export function planChanges(
  candidates: readonly KeptCandidate[],
  found: { dates: readonly FoundDate[]; amounts: readonly FoundAmount[]; numbers: readonly FoundAmount[] },
  prior: PriorChanges,
): { records: KeptCandidate[]; changes: PlannedChange[] } {
  const records: KeptCandidate[] = []
  const changes: PlannedChange[] = []
  const ordered = [...candidates.filter((c) => c.kind === 'row'), ...candidates.filter((c) => c.kind === 'task')]
  for (const c of ordered) {
    if (records.length >= KEPT_MAX_RECORDS || changes.length >= KEPT_MAX_CHANGES) break
    const index = records.length
    const mine: PlannedChange[] = []
    if (c.kind === 'task') {
      if (!prior.tasks.has(c.task.id)) mine.push({ id: `c${changes.length + 1}`, kind: 'task_done', record: index, task: c.task })
    } else {
      const row = c.row
      const set = (col: DataColumn, type: Exclude<KeptChangeType, 'done'>, to: CustomFieldValue, opts: { movedBlocks?: boolean } = {}) => {
        const from = row.values[col.key] ?? null
        const key = valueKey(row.id, col.key, to)
        if (sameValue(from, to) || prior.values.has(key) || (opts.movedBlocks && prior.moved.has(key))) return
        mine.push({ id: `c${changes.length + mine.length + 1}`, kind: 'row_set', record: index, row, key: col.key, label: col.label, type, from, to })
      }
      for (const col of row.columns) {
        if (col.deleted_at) continue
        switch (col.field_type) {
          case 'select': {
            const options = col.options.slice(0, MAX_SELECT_OPTIONS)
            if (!col.config?.outcomes || !Object.keys(col.config.outcomes).length) {
              for (const option of options) set(col, 'select', option, { movedBlocks: true })
              break
            }
            // A pipeline's stage, read by its outcomes.
            const closed = (o: unknown) => optionOutcome(col.config, o) !== 'open'
            if (closed(row.values[col.key])) break
            const touched = (o: string) => prior.values.has(valueKey(row.id, col.key, o)) || prior.moved.has(valueKey(row.id, col.key, o))
            const neverClose = options.some((o) => closed(o) && touched(o))
            for (const option of options) {
              if (closed(option) && neverClose) continue
              set(col, 'select', option)
            }
            break
          }
          case 'checkbox':
            set(col, 'checkbox', row.values[col.key] !== true, { movedBlocks: true })
            break
          case 'date':
            for (const d of found.dates) set(col, 'date', d.value)
            break
          case 'currency': {
            const currency = fieldCurrency(col.config)
            for (const a of found.amounts) {
              if (a.currency && a.currency !== currency) continue
              if (amountOf(row.values[col.key]) === a.amount) continue
              set(col, 'currency', { amount: a.amount, currency })
            }
            break
          }
          case 'number':
            for (const n of [...found.amounts, ...found.numbers]) set(col, 'number', n.amount)
            break
          default:
            break
        }
      }
    }
    const room = KEPT_MAX_CHANGES - changes.length
    if (!mine.length) continue
    records.push(c)
    changes.push(...mine.slice(0, room))
  }
  // Ids in order, once the cap has cut.
  changes.forEach((ch, i) => (ch.id = `c${i + 1}`))
  return { records, changes }
}

/** A value as the decision and the message say it. */
export function valueWords(type: KeptChangeType | DataColumn['field_type'], value: unknown): string | null {
  if (value === null || value === undefined) return null
  const shape = type === 'done' || !isCustomFieldType(type) ? 'text' : type
  const text = formatFieldValue(shape, value, { now: new Date(0) })
  return text ? text.slice(0, KEPT_VALUE_MAX) : null
}

const oneLine = (text: string | null | undefined, max: number) => {
  const s = (text ?? '').replace(/\s+/g, ' ').trim()
  return s ? s.slice(0, max) : undefined
}

/** A record as the decision reads it. Pure. */
function recordOf(c: KeptCandidate): KeptRecord {
  if (c.kind === 'task') {
    const details = oneLine(c.task.description, 240)
    return {
      kind: 'task',
      title: c.task.title.trim().slice(0, 300),
      ...(details ? { details } : {}),
      ...(c.task.dueAt && /^\d{4}-\d{2}-\d{2}/.test(c.task.dueAt) ? { due: c.task.dueAt.slice(0, 10) } : {}),
    }
  }
  const values: Record<string, string> = {}
  for (const col of c.row.columns) {
    if (Object.keys(values).length >= MAX_VALUES_SHOWN) break
    if (col.deleted_at || ['relation', 'person', 'multi_select', 'url', 'email', 'phone'].includes(col.field_type)) continue
    const words = valueWords(col.field_type, c.row.values[col.key])
    if (words) values[col.label.slice(0, 60)] = words.slice(0, 200)
  }
  return {
    kind: 'row',
    title: c.row.title.slice(0, 300),
    table: c.row.tableName.slice(0, 200),
    ...(Object.keys(values).length ? { values } : {}),
    ...(c.row.linked.length ? { linked: c.row.linked } : {}),
  }
}

/** A change as the decision reads it. Pure. */
function changeOf(ch: PlannedChange): KeptChange {
  if (ch.kind === 'task_done') return { id: ch.id, record: ch.record, type: 'done', field: 'Status', from: 'Open', to: 'Done' }
  return { id: ch.id, record: ch.record, type: ch.type, field: ch.label.slice(0, 60), from: valueWords(ch.type, ch.from), to: valueWords(ch.type, ch.to) ?? String(ch.to) }
}

/**
 * record.kept_up_to_date's input for a source, its sentences and the planned
 * changes; the last records' changes dropped until it fits the budget. Null
 * when nothing is left. Pure.
 */
export function keptInput(args: { now: string; item: KeptSourceItem; sentences: readonly string[]; records: readonly KeptCandidate[]; changes: readonly PlannedChange[] }): { input: RecordKeptUpToDateInput; changes: PlannedChange[] } | null {
  if (!args.sentences.length || !args.changes.length) return null
  let changes = [...args.changes]
  const build = (): RecordKeptUpToDateInput => {
    const used = [...new Set(changes.map((c) => c.record))]
    const index = new Map(used.map((r, i) => [r, i]))
    return {
      now: args.now.slice(0, 100),
      source: args.item.header,
      ...(args.item.context ? { context: args.item.context.slice(0, 4000) } : {}),
      sentences: [...args.sentences],
      records: used.map((r) => recordOf(args.records[r])),
      changes: changes.map((c) => ({ ...changeOf(c), record: index.get(c.record)! })),
    }
  }
  let input = build()
  while (changes.length > 1 && JSON.stringify(input).length > INPUT_BUDGET) {
    const last = changes.at(-1)!.record
    changes = changes.filter((c) => c.record !== last)
    if (!changes.length) return null
    input = build()
  }
  return JSON.stringify(input).length > INPUT_BUDGET ? null : { input, changes }
}

// ── Messages ───────────────────────────────────────────────────────────────

/**
 * Write (or rewrite, on Undo) a change's message in the home thread: one data
 * part, the server's own words. Never throws: a lost message leaves the log
 * line, and the record still changes back from its own page.
 */
export async function writeKeptMessage(supabase: SupabaseClient, scope: KeptScope & { conversationId: string }, data: KeptPartData): Promise<boolean> {
  try {
    const messageId = keptMessageId(data.record_id)
    const { error } = await supabase.from('chat_messages').upsert(
      {
        conversation_id: scope.conversationId,
        user_id: scope.userId,
        workspace_id: scope.workspaceId,
        role: 'assistant',
        ui_message: {
          id: messageId,
          role: 'assistant',
          parts: [{ type: KEPT_PART_TYPE, id: messageId, data }],
          metadata: { kind: KEPT_MESSAGE_KIND, record_id: data.record_id, target_id: data.target_id },
        },
      },
      { onConflict: 'conversation_id,ui_message_id' },
    )
    if (error) {
      console.warn('[kept-up-to-date] message not written:', error.message)
      return false
    }
    return true
  } catch (err) {
    console.warn('[kept-up-to-date] message not written:', err instanceof Error ? err.message : String(err))
    return false
  }
}

/** "an email from acme.example", "a meeting", "a text": a change's source in the log's words. */
function sourcePhrase(source: KeptSourceKind, label: string | null): string {
  if (source === 'email') return label ? `an email from ${label}` : 'an email'
  return source === 'capture' ? 'a meeting' : 'a text'
}

/**
 * The batch's reason in the table's history, which every reader of the table
 * sees: what and where from only, never the source's words, sender or domain.
 */
export function keptReason(source: KeptSourceKind): string {
  return `Kept up to date from ${source === 'email' ? 'an email' : source === 'capture' ? 'a meeting' : 'a text'}`.slice(0, TABLE_LIMITS.reason)
}

// ── Apply ──────────────────────────────────────────────────────────────────

export interface KeptDeps {
  writeMessage?: typeof writeKeptMessage
  appendLog?: typeof appendLogLine
  emit?: typeof emitStatusChange
  apply?: typeof applyOps
  undo?: typeof undoChange
  homeThread?: (supabase: SupabaseClient, scope: KeptScope) => Promise<string | null>
}

export type ApplyKeptResult =
  | { status: 'changed'; recordId: string }
  /** Changed by this source before; changed since it was read; refused by the table (a required-when rule); no done state; 539 missing; a failed write. */
  | { status: 'already' | 'moved' | 'refused' | 'no_done_state' | 'unavailable' | 'failed' }

async function insertKept(supabase: SupabaseClient, row: Record<string, unknown>): Promise<{ id: string } | Exclude<ApplyKeptResult, { status: 'changed' }>> {
  const { data, error } = await supabase.from(TABLE).insert(row).select('id').single()
  if (error) {
    if (error.code === '23505') return { status: 'already' }
    if (isPre539Error(error)) return { status: 'unavailable' }
    console.warn('[kept-up-to-date] row not written:', error.message)
    return { status: 'failed' }
  }
  return { id: (data as { id: string }).id }
}

/** The team's done state (its first `completed` one), or null. */
async function doneStateOf(supabase: SupabaseClient, teamId: string): Promise<string | null> {
  const { data } = await supabase.from('workflow_state').select('id').eq('team_id', teamId).eq('category', 'completed').order('sort_order', { ascending: true }).limit(1).maybeSingle()
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}

/**
 * Apply one picked change for its source (see the header): the record, the
 * change, the message and the log line. Never throws.
 */
export async function applyKeptChange(
  supabase: SupabaseClient,
  args: KeptScope & { conversationId: string; item: KeptSourceItem; change: PlannedChange; evidence: string; nowMs?: number },
  deps: KeptDeps = {},
): Promise<ApplyKeptResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString()
  const evidence = args.evidence.slice(0, KEPT_EVIDENCE_MAX)
  const base = {
    workspace_id: scope.workspaceId,
    user_id: scope.userId,
    source: args.item.source,
    source_ref: args.item.ref.slice(0, 1000),
    source_label: args.item.label,
    evidence,
  }
  try {
    let part: KeptPartData
    let recordId: string
    const ch = args.change
    if (ch.kind === 'task_done') {
      const task = ch.task
      const doneStatusId = await doneStateOf(supabase, task.teamId)
      if (!doneStatusId) return { status: 'no_done_state' }
      const kept = await insertKept(supabase, { ...base, record_type: 'action', record_id: task.id, prior_status_id: task.statusId, done_status_id: doneStatusId })
      if ('status' in kept) return kept
      recordId = kept.id
      // Only while it sits where it was read: a change in between wins.
      const { data: moved, error: moveError } = await supabase
        .from('actions')
        .update({ status_id: doneStatusId })
        .eq('id', task.id)
        .eq('workspace_id', scope.workspaceId)
        .eq('status_id', task.statusId)
        .select('id')
      if (moveError || !(moved as unknown[] | null)?.length) {
        await supabase.from(TABLE).delete().eq('id', recordId)
        if (moveError) console.warn('[kept-up-to-date] to-do not moved:', moveError.message)
        return { status: moveError ? 'failed' : 'moved' }
      }
      ;(deps.emit ?? emitStatusChange)({
        entityType: 'action',
        entityId: task.id,
        workspaceId: scope.workspaceId,
        teamId: task.teamId,
        fromStatusId: task.statusId,
        toStatusId: doneStatusId,
        actorUserId: scope.userId,
        origin: { actor: 'agent', depth: 1 },
      })
      part = {
        record_id: recordId,
        record_type: 'action',
        target_id: task.id,
        table_id: null,
        title: task.title.trim().slice(0, KEPT_TITLE_MAX),
        identifier: task.identifier,
        table: null,
        field: null,
        from: null,
        to: 'Done',
        evidence,
        source: args.item.source,
        source_label: args.item.label,
      }
    } else {
      const row = ch.row
      const kept = await insertKept(supabase, {
        ...base,
        record_type: 'data_row',
        record_id: row.id,
        table_id: row.tableId,
        field_key: ch.key,
        from_value: ch.from,
        to_value: ch.to,
      })
      if ('status' in kept) return kept
      recordId = kept.id
      const drop = async (status: 'moved' | 'refused' | 'failed') => {
        await supabase.from(TABLE).delete().eq('id', recordId)
        return { status } as const
      }
      // Twice at most: a teammate's write elsewhere in the table bumps its version.
      let changeId: string | null = null
      for (let attempt = 0; attempt < 2 && !changeId; attempt++) {
        const [{ data: now }, { data: table }] = await Promise.all([
          supabase.from('data_row').select('custom_fields, archived_at').eq('id', row.id).eq('workspace_id', scope.workspaceId).maybeSingle(),
          supabase.from('data_table').select('version, archived_at').eq('id', row.tableId).eq('workspace_id', scope.workspaceId).maybeSingle(),
        ])
        const current = now as { custom_fields: Record<string, unknown> | null; archived_at: string | null } | null
        const t = table as { version: number; archived_at: string | null } | null
        // Only while it holds what was read: a change in between wins.
        if (!current || current.archived_at || !t || t.archived_at || !sameValue(current.custom_fields?.[ch.key], ch.from)) return drop('moved')
        const applied = await (deps.apply ?? applyOps)(
          supabase,
          scope.workspaceId,
          row.tableId,
          { baseVersion: Number(t.version), ops: [{ op: 'update_row', row_id: row.id, values: { [ch.key]: ch.to } }] },
          { userId: scope.userId, asUserId: scope.userId, source: args.item.source, reason: keptReason(args.item.source), sourceRef: args.item.ref },
        )
        if (applied.ok) {
          changeId = applied.value.change_id
          if (!changeId) return drop('moved')
          break
        }
        if (applied.reason === 'conflict' && attempt === 0) continue
        // A required-when rule (or a column changed under it): no change.
        if (applied.reason === 'invalid') return drop('refused')
        console.warn('[kept-up-to-date] row not changed:', applied.reason)
        return drop(applied.reason === 'conflict' ? 'moved' : 'failed')
      }
      if (!changeId) return drop('moved')
      // Undo takes back this batch: the id must land (else Undo falls back to the values).
      for (let attempt = 0; attempt < 2; attempt++) {
        const { error: linkError } = await supabase.from(TABLE).update({ data_change_id: changeId }).eq('id', recordId)
        if (!linkError) break
        console.warn('[kept-up-to-date] batch id not recorded:', linkError.message)
      }
      part = {
        record_id: recordId,
        record_type: 'data_row',
        target_id: row.id,
        table_id: row.tableId,
        title: row.title.slice(0, KEPT_TITLE_MAX),
        identifier: null,
        table: row.tableName.slice(0, KEPT_TITLE_MAX),
        field: ch.label,
        from: valueWords(ch.type, ch.from),
        to: valueWords(ch.type, ch.to) ?? String(ch.to),
        evidence,
        source: args.item.source,
        source_label: args.item.label,
      }
    }

    await (deps.writeMessage ?? writeKeptMessage)(supabase, { ...scope, conversationId: args.conversationId }, part)
    const line = logLineFor({ type: 'kept_up_to_date', title: part.title, change: changeWords(part), from: sourcePhrase(args.item.source, args.item.label) })
    if (line) {
      await (deps.appendLog ?? appendLogLine)(
        { ...scope, kind: line.kind, line: line.line, refType: part.record_type === 'action' ? 'action' : 'data_row', refId: part.target_id, dedupeKey: logDedupeKey.keptUpToDate(recordId), at: nowIso },
        supabase,
      )
    }
    return { status: 'changed', recordId }
  } catch (err) {
    console.warn('[kept-up-to-date] change skipped:', err instanceof Error ? err.message : String(err))
    return { status: 'failed' }
  }
}

/** "Stage → Won", "done": a change in a line's words. */
function changeWords(part: Pick<KeptPartData, 'record_type' | 'field' | 'to'>): string {
  return part.record_type === 'action' ? 'done' : `${part.field ?? 'value'} → ${part.to}`
}

// ── The pass ───────────────────────────────────────────────────────────────

/**
 * Whether this source changed a record before (one change a source: a
 * reprocessed meeting changes nothing new). Null when unreadable (539 not
 * applied): nothing changes.
 */
export async function sourceChangedBefore(supabase: SupabaseClient, scope: KeptScope, item: Pick<KeptSourceItem, 'source' | 'ref'>): Promise<boolean | null> {
  const { data, error } = await supabase.from(TABLE).select('id').eq('workspace_id', scope.workspaceId).eq('source', item.source).eq('source_ref', item.ref.slice(0, 1000)).limit(1)
  if (error) {
    if (!isPre539Error(error)) console.warn('[kept-up-to-date] source not read:', error.message)
    return null
  }
  return ((data as unknown[] | null) ?? []).length > 0
}

/**
 * The to-dos among `taskIds` linked to the source's contacts or companies:
 * an entity_link either way between them, or between the to-do's project and
 * them. Null when unreadable: no to-do is offered.
 */
export async function linkedTaskIds(supabase: SupabaseClient, scope: KeptScope, people: KeptPeople, taskIds: readonly string[]): Promise<Set<string> | null> {
  const targets = [...people.contactIds, ...people.companyIds]
  if (!targets.length || !taskIds.length) return new Set()
  try {
    const { data: actions, error } = await supabase.from('actions').select('id, project_id').eq('workspace_id', scope.workspaceId).in('id', [...taskIds])
    if (error) return null
    const projectOf = new Map(((actions ?? []) as Array<{ id: string; project_id: string | null }>).map((a) => [a.id, a.project_id]))
    const projects = [...new Set([...projectOf.values()].filter((p): p is string => !!p))]
    const edges = async (kind: string, ids: readonly string[]) => {
      if (!ids.length) return new Set<string>()
      const [out, back] = await Promise.all([
        supabase.from('entity_link').select('source_id').eq('workspace_id', scope.workspaceId).eq('source_type', kind).in('source_id', [...ids]).in('target_type', ['contact', 'company']).in('target_id', targets),
        supabase.from('entity_link').select('target_id').eq('workspace_id', scope.workspaceId).eq('target_type', kind).in('target_id', [...ids]).in('source_type', ['contact', 'company']).in('source_id', targets),
      ])
      if (out.error || back.error) throw new Error((out.error ?? back.error)!.message)
      return new Set([...((out.data ?? []) as Array<{ source_id: string }>).map((r) => r.source_id), ...((back.data ?? []) as Array<{ target_id: string }>).map((r) => r.target_id)])
    }
    const [direct, viaProject] = await Promise.all([edges('action', taskIds), edges('project', projects)])
    return new Set(taskIds.filter((id) => direct.has(id) || (!!projectOf.get(id) && viaProject.has(projectOf.get(id)!))))
  } catch (err) {
    console.warn('[kept-up-to-date] linked to-dos not read:', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** The records among `ids` a pending proposal names (a meeting's card). Null when unreadable: nothing changes. */
export async function pendingProposalIds(supabase: SupabaseClient, scope: KeptScope, ids: readonly string[]): Promise<Set<string> | null> {
  if (!ids.length) return new Set()
  const { data, error } = await supabase.from('proposed_change').select('entity_id').eq('workspace_id', scope.workspaceId).eq('status', 'pending').in('entity_id', [...ids])
  if (error) {
    console.warn('[kept-up-to-date] pending proposals not read:', error.message)
    return null
  }
  return new Set(((data ?? []) as Array<{ entity_id: string | null }>).map((r) => r.entity_id).filter((id): id is string => !!id))
}

export interface KeptPassDeps extends KeptDeps {
  sourceDone?: typeof sourceChangedBefore
  linkedTasks?: typeof linkedTaskIds
  pendingProposals?: typeof pendingProposalIds
  readTodos?: typeof readOpenTodos
  readRows?: typeof readRowCandidates
  readPrior?: typeof readPriorChanges
  decide?: (input: RecordKeptUpToDateInput, ctx: { userId: string; workspaceId: string; runId: string }) => Promise<DecisionResult<RecordKeptUpToDateValue>>
  applyChange?: typeof applyKeptChange
  nowMs?: number
}

export interface KeptPass {
  /**
   * Put one source beside the person's records and apply the one change it
   * states. 'skipped': no candidate, no sentence, no home thread, the cap
   * reached, or the records can't be read. Never throws.
   */
  consider(item: KeptSourceItem, runId?: string): Promise<'changed' | 'none' | 'skipped'>
  changed(): number
}

/**
 * One pass's keeper: the home thread and the to-dos are read once, on the
 * first source that needs them, and a changed record leaves the list.
 */
export function keptPass(supabase: SupabaseClient, scope: KeptScope & { now: string; timeZone?: string }, deps: KeptPassDeps = {}): KeptPass {
  let home: string | null | undefined
  let todos: OpenTodo[] | null | undefined
  const done = new Set<string>()
  let count = 0
  const decide = deps.decide ?? ((input, ctx) => runDecision('record.kept_up_to_date', input, ctx))
  return {
    changed: () => count,
    async consider(item, runId) {
      try {
        if (count >= MAX_KEPT_PER_PASS) return 'skipped'
        if (home === undefined) home = await (deps.homeThread ?? homeConversationId)(supabase, scope).catch(() => null)
        // Undo lives in the home thread: none yet (or unreadable), nothing changes.
        if (!home) return 'skipped'
        const sentences = sentencesOf(item.text)
        if (!sentences.length) return 'skipped'
        if ((await (deps.sourceDone ?? sourceChangedBefore)(supabase, scope, item)) !== false) return 'skipped'

        let tasks: OpenTodo[] = []
        if (item.tasks) {
          if (todos === undefined) todos = await (deps.readTodos ?? readOpenTodos)(supabase, scope)
          tasks = (todos ?? []).filter((t) => !done.has(t.id) && before(t.createdAt, item.atIso))
          if (item.tasks === 'linked' && tasks.length) {
            const linked = await (deps.linkedTasks ?? linkedTaskIds)(supabase, scope, item.people, tasks.map((t) => t.id))
            tasks = linked ? tasks.filter((t) => linked.has(t.id)) : []
          }
          tasks = tasks.slice(0, MAX_TASKS)
        }
        let rows = ((await (deps.readRows ?? readRowCandidates)(supabase, scope, item.people, item.atIso)) ?? []).filter((r) => !done.has(r.id))
        if (!rows.length && !tasks.length) return 'skipped'
        // A record a pending proposal names is the card's to decide.
        const pending = await (deps.pendingProposals ?? pendingProposalIds)(supabase, scope, [...rows.map((r) => r.id), ...tasks.map((t) => t.id)])
        if (!pending) return 'skipped'
        rows = rows.filter((r) => !pending.has(r.id))
        tasks = tasks.filter((t) => !pending.has(t.id))
        if (!rows.length && !tasks.length) return 'skipped'

        const prior = await (deps.readPrior ?? readPriorChanges)(supabase, scope, rows.map((r) => ({ id: r.id, tableId: r.tableId })), tasks.map((t) => t.id), deps.nowMs)
        if (!prior) return 'skipped'
        const dates = datesIn(sentences, item.atIso, { timeZone: scope.timeZone })
        const amounts = amountsIn(sentences)
        const numbers = rows.some((r) => r.columns.some((c) => c.field_type === 'number')) ? numbersIn(sentences, dates, amounts) : []
        const candidates: KeptCandidate[] = [...rows.map((row) => ({ kind: 'row' as const, row })), ...tasks.map((task) => ({ kind: 'task' as const, task }))]
        const planned = planChanges(candidates, { dates, amounts, numbers }, prior)
        const built = keptInput({ now: scope.now, item, sentences, records: planned.records, changes: planned.changes })
        if (!built) return 'skipped'

        const decided = await decide(built.input, { userId: scope.userId, workspaceId: scope.workspaceId, runId: runId ?? item.ref.slice(0, 200) })
        if (decided.status !== 'accepted' || !decided.value.changeId || decided.value.evidence === null) return 'none'
        const change = built.changes.find((c) => c.id === decided.value.changeId)
        const evidence = sentences[decided.value.evidence]
        if (!change || !evidence) return 'none'
        const result = await (deps.applyChange ?? applyKeptChange)(supabase, { ...scope, conversationId: home, item, change, evidence, nowMs: deps.nowMs }, deps)
        // Changed, or no longer changeable by this source: either way it leaves the list.
        if (result.status === 'changed' || result.status === 'already' || result.status === 'moved') done.add(change.kind === 'task_done' ? change.task.id : change.row.id)
        if (result.status !== 'changed') return 'none'
        count += 1
        return 'changed'
      } catch (err) {
        console.warn('[kept-up-to-date] source skipped:', err instanceof Error ? err.message : String(err))
        return 'skipped'
      }
    },
  }
}

// ── Undo ───────────────────────────────────────────────────────────────────

export type UndoKeptResult =
  /**
   * `reverted`: back as it was. `changed`: changed since, so left as it is.
   * `gone`: deleted since. `already`: undone before.
   */
  | { ok: true; status: 'reverted' | 'changed' | 'gone' | 'already' }
  | { ok: false; reason: 'not_found' | 'unavailable' | 'read_failed' | 'forbidden' }

interface KeptRow {
  id: string
  source: KeptSourceKind
  source_label: string | null
  record_type: 'action' | 'data_row'
  record_id: string
  table_id: string | null
  field_key: string | null
  from_value: unknown
  to_value: unknown
  prior_status_id: string | null
  done_status_id: string | null
  data_change_id: string | null
  evidence: string | null
  undone_at: string | null
}

/**
 * Undo one change (see the header): put the record back, mark the row
 * undone, rewrite its message and log it. Safe to repeat. The row is read for
 * this person and workspace only.
 */
export async function undoKeptChange(supabase: SupabaseClient, args: KeptScope & { recordId: string; nowMs?: number }, deps: KeptDeps = {}): Promise<UndoKeptResult> {
  const scope = { workspaceId: args.workspaceId, userId: args.userId }
  const nowIso = new Date(args.nowMs ?? Date.now()).toISOString()
  const { data, error } = await supabase
    .from(TABLE)
    .select('id, source, source_label, record_type, record_id, table_id, field_key, from_value, to_value, prior_status_id, done_status_id, data_change_id, evidence, undone_at')
    .eq('id', args.recordId)
    .eq('workspace_id', scope.workspaceId)
    .eq('user_id', scope.userId)
    .maybeSingle()
  if (error) return { ok: false, reason: isPre539Error(error) ? 'unavailable' : 'read_failed' }
  const row = data as KeptRow | null
  if (!row) return { ok: false, reason: 'not_found' }
  if (row.undone_at) return { ok: true, status: 'already' }

  let status: 'reverted' | 'changed' | 'gone' = 'changed'
  let part: Omit<KeptPartData, 'undone' | 'changed'> | null = null
  if (row.record_type === 'action') {
    const { data: actionData, error: actionError } = await supabase.from('actions').select('id, identifier, title, team_id, status_id').eq('id', row.record_id).eq('workspace_id', scope.workspaceId).maybeSingle()
    if (actionError) return { ok: false, reason: 'read_failed' }
    const action = actionData as { id: string; identifier: string | null; title: string | null; team_id: string; status_id: string } | null
    if (!action) status = 'gone'
    else if (row.done_status_id && action.status_id === row.done_status_id) {
      const back = await reopenStateOf(supabase, action.team_id, row.prior_status_id)
      if (back) {
        const { data: moved, error: moveError } = await supabase.from('actions').update({ status_id: back }).eq('id', action.id).eq('workspace_id', scope.workspaceId).eq('status_id', row.done_status_id).select('id')
        if (moveError) return { ok: false, reason: 'read_failed' }
        if ((moved as unknown[] | null)?.length) {
          status = 'reverted'
          // The person's own click.
          ;(deps.emit ?? emitStatusChange)({ entityType: 'action', entityId: action.id, workspaceId: scope.workspaceId, teamId: action.team_id, fromStatusId: row.done_status_id, toStatusId: back, actorUserId: scope.userId })
        }
      }
    }
    if (action) {
      part = {
        record_id: row.id, record_type: 'action', target_id: action.id, table_id: null,
        title: (action.title ?? '').trim().slice(0, KEPT_TITLE_MAX) || 'To-do', identifier: action.identifier,
        table: null, field: null, from: null, to: 'Done', evidence: row.evidence, source: row.source, source_label: row.source_label,
      }
    }
  } else {
    const tableId = row.table_id
    const [{ data: rowData }, { data: tableData }] = await Promise.all([
      supabase.from('data_row').select('id, title').eq('id', row.record_id).eq('workspace_id', scope.workspaceId).maybeSingle(),
      tableId ? supabase.from('data_table').select('id, name').eq('id', tableId).eq('workspace_id', scope.workspaceId).maybeSingle() : Promise.resolve({ data: null }),
    ])
    const target = rowData as { id: string; title: string | null } | null
    const table = tableData as { id: string; name: string } | null
    if (!target || !table || !tableId) status = 'gone'
    else if (!row.data_change_id) {
      // The batch's id never landed: put the value back by hand, while it is still the one set.
      const back = await undoByValues(supabase, scope, row, tableId, deps)
      if (back === 'forbidden') return { ok: false, reason: 'forbidden' }
      if (back === 'failed') return { ok: false, reason: 'read_failed' }
      status = back
    } else {
      const undone = await (deps.undo ?? undoChange)(supabase, scope.workspaceId, tableId, row.data_change_id, { userId: scope.userId, asUserId: scope.userId, source: 'person' })
      if (undone.ok) status = undone.value.restored.length ? 'reverted' : 'changed'
      else if (undone.reason === 'forbidden') return { ok: false, reason: 'forbidden' }
      else if (undone.reason === 'not_found') status = 'gone'
      else if (undone.reason === 'conflict') return { ok: false, reason: 'read_failed' }
      // 'invalid': everything it changed has changed again since, or it was undone from the table's history.
    }
    if (target && table) {
      const columns = await listColumns(supabase, scope.workspaceId, table.id, { deleted: true }).catch(() => [] as DataColumn[])
      const col = columns.find((c) => c.key === row.field_key)
      const type = col?.field_type ?? 'text'
      part = {
        record_id: row.id, record_type: 'data_row', target_id: target.id, table_id: table.id,
        title: ((target.title ?? '').trim() || 'Untitled').slice(0, KEPT_TITLE_MAX), identifier: null,
        table: table.name.slice(0, KEPT_TITLE_MAX), field: col?.label ?? row.field_key, from: valueWords(type, row.from_value),
        to: valueWords(type, row.to_value) ?? 'changed', evidence: row.evidence, source: row.source, source_label: row.source_label,
      }
    }
  }

  const { error: markError } = await supabase.from(TABLE).update({ undone_at: nowIso }).eq('id', row.id).is('undone_at', null)
  if (markError) console.warn('[kept-up-to-date] undo mark failed:', markError.message)
  if (part) {
    if (status === 'reverted') {
      const line = logLineFor({ type: 'kept_up_to_date', title: part.title, change: changeWords(part), undone: true })
      if (line) {
        await (deps.appendLog ?? appendLogLine)(
          { ...scope, kind: line.kind, line: line.line, refType: part.record_type === 'action' ? 'action' : 'data_row', refId: part.target_id, dedupeKey: logDedupeKey.keptUpToDate(row.id, true), at: nowIso },
          supabase,
        )
      }
    }
    const conversationId = await (deps.homeThread ?? homeConversationId)(supabase, scope).catch(() => null)
    if (conversationId) {
      await (deps.writeMessage ?? writeKeptMessage)(supabase, { ...scope, conversationId }, { ...part, undone: true, ...(status === 'changed' ? { changed: true } : {}) })
    }
  }
  return { ok: true, status }
}

/** A row's value put back as the person, only while it still holds what the change set. */
async function undoByValues(supabase: SupabaseClient, scope: KeptScope, row: KeptRow, tableId: string, deps: KeptDeps): Promise<'reverted' | 'changed' | 'forbidden' | 'failed'> {
  if (!row.field_key) return 'changed'
  for (let attempt = 0; attempt < 2; attempt++) {
    const [{ data: now }, { data: table }] = await Promise.all([
      supabase.from('data_row').select('custom_fields').eq('id', row.record_id).eq('workspace_id', scope.workspaceId).maybeSingle(),
      supabase.from('data_table').select('version').eq('id', tableId).eq('workspace_id', scope.workspaceId).maybeSingle(),
    ])
    const current = (now as { custom_fields: Record<string, unknown> | null } | null)?.custom_fields?.[row.field_key]
    if (!now || !table || !sameValue(current, row.to_value)) return 'changed'
    const applied = await (deps.apply ?? applyOps)(
      supabase,
      scope.workspaceId,
      tableId,
      { baseVersion: Number((table as { version: number }).version), ops: [{ op: 'update_row', row_id: row.record_id, values: { [row.field_key]: (row.from_value ?? null) as CustomFieldValue } }] },
      { userId: scope.userId, asUserId: scope.userId, source: 'person' },
    )
    if (applied.ok) return 'reverted'
    if (applied.reason === 'conflict') continue
    return applied.reason === 'forbidden' ? 'forbidden' : applied.reason === 'invalid' ? 'changed' : 'failed'
  }
  return 'failed'
}

/** Where Undo puts a to-do: its state before, while it is still its team's; else the team's default. */
async function reopenStateOf(supabase: SupabaseClient, teamId: string, priorStatusId: string | null): Promise<string | null> {
  if (priorStatusId) {
    const { data } = await supabase.from('workflow_state').select('id').eq('id', priorStatusId).eq('team_id', teamId).maybeSingle()
    if (typeof (data as { id?: unknown } | null)?.id === 'string') return priorStatusId
  }
  const { data } = await supabase.from('workflow_state').select('id').eq('team_id', teamId).eq('is_default', true).limit(1).maybeSingle()
  const id = (data as { id?: unknown } | null)?.id
  return typeof id === 'string' ? id : null
}
