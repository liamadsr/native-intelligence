/**
 * Checking what the agent asked `show` for, before anything is queried.
 *
 * Every field, operator and value is checked against the views system's own
 * tables (FILTERABLE_FIELDS, OPERATORS_BY_TYPE, DISPLAY_PROPERTIES), the same
 * ones the page's filter picker offers. The lesson of #669: weak models
 * misplace ids and fields, so a refusal names exactly what to change and lists
 * what is valid, and the obvious slips (a single value where a list goes,
 * `me` for `@me`, a case slip in an option, `board` as a kind) are fixed
 * rather than refused.
 *
 * Pure: names of people, projects and the like are turned into ids later, on
 * the server (./server.ts resolveNamedValues), where the workspace is known.
 */
import {
  DISPLAY_PROPERTIES,
  FILTERABLE_FIELDS,
  OPERATORS_BY_TYPE,
  type FilterFieldDefinition,
  type FilterOperator,
  type FilterValue,
  type GroupConfig,
  type RelativeDateValue,
  type SortConfig,
  type ViewEntityType,
} from '@/lib/views/types'
import {
  CARD_LIST_ENTITIES,
  CARD_RECORD_TYPES,
  MAIL_FOLDERS,
  type CalendarCardSpec,
  type CardFilter,
  type CardListEntity,
  type CardRecordType,
  type ListCardSpec,
  type MailCardSpec,
  type MailFolder,
  type RecordCardSpec,
} from './kinds'
import { fitCalendarRange } from './calendar'

export type Checked<T> = { ok: true; value: T } | { ok: false; error: string }

/** The raw input `show` hands over (its zod schema keeps the shapes loose so these messages, not zod's, reach the model). */
export interface ShowInput {
  kind?: string
  title?: string
  entity_type?: string
  filters?: Array<{ field?: unknown; operator?: unknown; value?: unknown }>
  ordering?: Array<{ field?: unknown; direction?: unknown }>
  grouping?: { field?: unknown; direction?: unknown } | null
  layout?: string
  columns?: unknown[]
  record?: { type?: unknown; id?: unknown }
  calendar?: { from?: unknown; to?: unknown; view?: unknown; accounts?: unknown }
  mail?: { folder?: unknown; search?: unknown; unread?: unknown; thread_id?: unknown; accounts?: unknown }
}

/** Field types whose values are ids; a name there is resolved on the server. */
export const ID_FIELD_TYPES: ReadonlySet<string> = new Set([
  'member', 'project', 'team', 'cycle', 'milestone', 'initiative', 'capture', 'action', 'contact', 'company', 'label',
])

/** True for a field whose values are ids (workflow states included). */
export function isIdField(def: FilterFieldDefinition): boolean {
  return ID_FIELD_TYPES.has(def.type) || def.options === 'workflow_states'
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function isUuid(value: unknown): boolean {
  return typeof value === 'string' && UUID_RE.test(value)
}

const LIST_OPS: ReadonlySet<FilterOperator> = new Set(['is_any_of', 'is_none_of', 'includes', 'excludes', 'equals'])
const NO_VALUE_OPS: ReadonlySet<FilterOperator> = new Set(['is_empty', 'is_not_empty'])
const GROUPABLE_TYPES = new Set(['enum', 'member', 'project', 'team', 'cycle', 'milestone', 'company', 'boolean', 'date'])
const MAX_FILTERS = 12
/** The most values one list filter (is_any_of and the like) takes: it rides every turn's header. */
export const MAX_LIST_VALUES = 50

/** The fields an entity can be sorted on: what the page's sort picker offers. */
export function sortableFields(entity: CardListEntity): string[] {
  return FILTERABLE_FIELDS[entity]
    .filter((f) => f.type !== 'relation' && f.type !== 'label' && f.type !== 'tag' && !f.virtual && f.field !== 'status_type')
    .map((f) => f.field)
}

/** The fields an entity can be grouped on: what the page's group picker offers. */
export function groupableFields(entity: CardListEntity): string[] {
  return FILTERABLE_FIELDS[entity].filter((f) => GROUPABLE_TYPES.has(f.type)).map((f) => f.field)
}

function listOf(values: readonly string[]): string {
  return values.join(', ')
}

/**
 * A relative date the model may spell as text: "this week", "past 7 days",
 * "next 2 weeks", "last month", "today". Null when it is none of those.
 */
export function parseRelativeDate(value: unknown): RelativeDateValue | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const v = value as Record<string, unknown>
    const units = ['day', 'week', 'month', 'quarter', 'year']
    const directions = ['past', 'future', 'this']
    if (!units.includes(v.unit as string) || !directions.includes(v.direction as string)) return null
    const count = typeof v.count === 'number' && Number.isFinite(v.count) && v.count > 0 ? Math.floor(v.count) : undefined
    return { unit: v.unit as RelativeDateValue['unit'], direction: v.direction as RelativeDateValue['direction'], ...(count ? { count } : {}) }
  }
  if (typeof value !== 'string') return null
  const text = value.trim().toLowerCase().replace(/_/g, ' ')
  if (text === 'today') return { unit: 'day', direction: 'this' }
  const m = /^(this|past|last|next)\s*(\d+)?\s*(day|week|month|quarter|year)s?$/.exec(text)
  if (!m) return null
  const direction = m[1] === 'this' ? 'this' : m[1] === 'next' ? 'future' : 'past'
  const count = m[2] ? Number(m[2]) : undefined
  return { unit: m[3] as RelativeDateValue['unit'], direction, ...(count && direction !== 'this' ? { count } : {}) }
}

/** One filter, checked and tidied. `where` names it in a refusal ("filters[2]"). */
export function checkFilter(entity: ViewEntityType, raw: { field?: unknown; operator?: unknown; value?: unknown }, where: string): Checked<CardFilter> {
  const fields = FILTERABLE_FIELDS[entity]
  const fieldNames = fields.map((f) => f.field)
  if (typeof raw.field !== 'string' || !raw.field) {
    return { ok: false, error: `${where}: give a field. Valid fields for ${entity}: ${listOf(fieldNames)}` }
  }
  const def = fields.find((f) => f.field === raw.field)
  if (!def) {
    return {
      ok: false,
      error: `${where}: '${raw.field}' is not a field of ${entity}. Use one of these exactly: ${listOf(fieldNames)}`,
    }
  }
  const operators = OPERATORS_BY_TYPE[def.type]
  const operator = raw.operator as FilterOperator
  if (typeof raw.operator !== 'string' || !operators.includes(operator)) {
    return {
      ok: false,
      error: `${where}: '${String(raw.operator ?? '')}' is not an operator for ${def.field} (a ${def.type} field). Use one of: ${listOf(operators)}`,
    }
  }

  if (NO_VALUE_OPS.has(operator)) return { ok: true, value: { field: def.field, operator, value: '' } }

  let value: unknown = raw.value
  if (value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0)) {
    return { ok: false, error: `${where}: ${def.field} ${operator} needs a value` }
  }

  if (operator === 'is_relative') {
    const rel = parseRelativeDate(value)
    if (!rel) {
      return {
        ok: false,
        error: `${where}: ${def.field} is_relative takes {"unit":"day|week|month|quarter|year","direction":"past|future|this","count":N}, or text such as "this week" or "next 7 days"`,
      }
    }
    return { ok: true, value: { field: def.field, operator, value: rel } }
  }

  if (operator === 'between') {
    const v = value as Record<string, unknown>
    if (!v || typeof v !== 'object' || Array.isArray(v) || v.from === undefined || v.to === undefined) {
      return { ok: false, error: `${where}: ${def.field} between takes {"from": …, "to": …}` }
    }
    if (def.type === 'date' && (!isDate(v.from) || !isDate(v.to))) {
      return { ok: false, error: `${where}: ${def.field} between takes ISO dates, e.g. {"from":"2026-10-01","to":"2026-10-31"}` }
    }
    return { ok: true, value: { field: def.field, operator, value: { from: v.from as string | number, to: v.to as string | number } } }
  }

  // Lists: a single value where a list goes is a list of one.
  if (LIST_OPS.has(operator)) {
    const raw = Array.isArray(value) ? value : [value]
    if (raw.length > MAX_LIST_VALUES) {
      return { ok: false, error: `${where}: ${def.field} ${operator} takes at most ${MAX_LIST_VALUES} values; narrow it with another filter` }
    }
    const items = raw.map((x) => normalizeScalar(def, x))
    for (const item of items) {
      const bad = badScalar(def, item, where)
      if (bad) return { ok: false, error: bad }
    }
    return { ok: true, value: { field: def.field, operator, value: items.map(String) } }
  }

  if (Array.isArray(value)) {
    if (value.length !== 1) {
      return {
        ok: false,
        error: `${where}: ${def.field} ${operator} takes one value. For several, use is_any_of${operators.includes('is_any_of') ? '' : ' (not offered on this field: use one filter per value)'}`,
      }
    }
    value = value[0]
  }
  const scalar = normalizeScalar(def, value)
  const bad = badScalar(def, scalar, where)
  if (bad) return { ok: false, error: bad }
  return { ok: true, value: { field: def.field, operator, value: scalar as FilterValue } }
}

function isDate(value: unknown): boolean {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) && !Number.isNaN(Date.parse(value))
}

/** A value tidied for its field: `me` → `@me`, a case slip in an option, numbers and booleans from text. */
function normalizeScalar(def: FilterFieldDefinition, value: unknown): string | number | boolean {
  if (def.type === 'member' && typeof value === 'string' && /^(@?me|myself)$/i.test(value.trim())) return '@me'
  if (def.type === 'number' && typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  if (def.type === 'boolean') {
    if (value === 'true') return true
    if (value === 'false') return false
  }
  if (Array.isArray(def.options) && typeof value === 'string') {
    const hit = def.options.find((o) => o.toLowerCase() === value.trim().toLowerCase())
    if (hit) return hit
  }
  return typeof value === 'string' ? value.trim().slice(0, MAX_VALUE_CHARS) : (value as number | boolean)
}

/** The longest text a filter value keeps. */
const MAX_VALUE_CHARS = 200

/** Why a scalar does not fit its field, or null when it does. */
function badScalar(def: FilterFieldDefinition, value: unknown, where: string): string | null {
  if (typeof value === 'object' && value !== null) return `${where}: ${def.field} takes a plain value here, not an object`
  if (def.type === 'boolean' && typeof value !== 'boolean') return `${where}: ${def.field} takes true or false`
  if (def.type === 'number' && typeof value !== 'number') return `${where}: ${def.field} takes a number`
  if (def.type === 'date' && !isDate(value)) {
    return `${where}: ${def.field} takes an ISO date such as "2026-10-08" here; for "this week" or "next 7 days" use operator is_relative`
  }
  if (Array.isArray(def.options) && !def.options.includes(String(value))) {
    return `${where}: '${String(value)}' is not a ${def.field} value. Use one of: ${listOf(def.options)}`
  }
  return null
}

function checkSort(entity: CardListEntity, raw: ShowInput['ordering']): Checked<SortConfig[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  if (!Array.isArray(raw)) return { ok: false, error: 'ordering takes a list, e.g. [{"field":"due_at","direction":"asc"}]' }
  const valid = sortableFields(entity)
  const out: SortConfig[] = []
  for (const [i, s] of raw.slice(0, 3).entries()) {
    if (typeof s?.field !== 'string' || !valid.includes(s.field)) {
      return { ok: false, error: `ordering[${i}]: ${entity} can be sorted on: ${listOf(valid)}` }
    }
    out.push({ field: s.field, direction: s.direction === 'asc' ? 'asc' : 'desc' })
  }
  return { ok: true, value: out.length ? out : undefined }
}

function checkGrouping(entity: CardListEntity, raw: ShowInput['grouping']): Checked<GroupConfig | null | undefined> {
  if (raw === undefined) return { ok: true, value: undefined }
  if (raw === null) return { ok: true, value: null }
  const valid = groupableFields(entity)
  if (typeof raw.field !== 'string' || !valid.includes(raw.field)) {
    return { ok: false, error: `grouping: ${entity} can be grouped on: ${listOf(valid)}` }
  }
  return { ok: true, value: { field: raw.field, direction: raw.direction === 'desc' ? 'desc' : 'asc' } }
}

function checkColumns(entity: CardListEntity, raw: unknown[] | undefined): Checked<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  const valid = DISPLAY_PROPERTIES[entity].filter((p) => !p.scopeOnly).map((p) => p.field)
  const out: string[] = []
  for (const c of raw) {
    if (typeof c !== 'string' || !valid.includes(c)) {
      return { ok: false, error: `columns: '${String(c)}' is not a column of ${entity}. Use any of: ${listOf(valid)}` }
    }
    if (!out.includes(c)) out.push(c)
  }
  return { ok: true, value: out.length ? out : undefined }
}

/** The most accounts a calendar or mail card filters to. */
const MAX_ACCOUNTS = 10

/**
 * A card's account filter: connected account ids or their email addresses,
 * turned into ids on the server against the person's own accounts. Absent or
 * empty is every account the page would show.
 */
function checkAccounts(where: string, raw: unknown): Checked<string[] | undefined> {
  if (raw === undefined || raw === null) return { ok: true, value: undefined }
  const list = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const a of list) {
    if (typeof a !== 'string' || !a.trim()) {
      return { ok: false, error: `${where}: a list of the connected accounts' email addresses, e.g. ["me@acme.com"], or leave it out for all` }
    }
    const v = a.trim().toLowerCase()
    if (!out.includes(v)) out.push(v)
  }
  if (out.length > MAX_ACCOUNTS) return { ok: false, error: `${where}: at most ${MAX_ACCOUNTS} accounts` }
  return { ok: true, value: out.length ? out : undefined }
}

/** A calendar card's spec: its range fitted to one view (./calendar.ts fitCalendarRange). */
export function checkCalendarSpec(title: string, raw: ShowInput['calendar']): Checked<CalendarCardSpec> {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: `calendar: give the range, e.g. "calendar": {"from":"2026-10-05","view":"week"} (view: day, week or month)` }
  }
  const range = fitCalendarRange(raw.from, raw.to, raw.view)
  if (!range.ok) return range
  const accounts = checkAccounts('calendar.accounts', raw.accounts)
  if (!accounts.ok) return accounts
  return { ok: true, value: { kind: 'calendar', title, calendar: { ...range.value, ...(accounts.value ? { accounts: accounts.value } : {}) } } }
}

/** A mail card's spec: a folder (default the inbox), a search, or one thread. */
export function checkMailSpec(title: string, raw: ShowInput['mail']): Checked<MailCardSpec> {
  const m = raw && typeof raw === 'object' ? raw : {}
  let folder: MailFolder = 'inbox'
  if (m.folder !== undefined && m.folder !== null && m.folder !== '') {
    const f = typeof m.folder === 'string' ? m.folder.trim().toLowerCase() : ''
    // The obvious slips: "Archived", "draft", "junk".
    const alias: Record<string, MailFolder> = { archived: 'archive', draft: 'drafts', junk: 'spam', deleted: 'trash', bin: 'trash' }
    const hit = (MAIL_FOLDERS as readonly string[]).includes(f) ? (f as MailFolder) : alias[f]
    if (!hit) return { ok: false, error: `mail.folder: '${String(m.folder)}' is not a folder. Use one of: ${listOf(MAIL_FOLDERS)}` }
    folder = hit
  }
  if (m.search !== undefined && m.search !== null && typeof m.search !== 'string') {
    return { ok: false, error: 'mail.search: plain text to look for in the subject, preview and sender, e.g. "invoice"' }
  }
  const search = typeof m.search === 'string' ? m.search.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  if (m.thread_id !== undefined && m.thread_id !== null && (typeof m.thread_id !== 'string' || !m.thread_id.trim())) {
    return { ok: false, error: 'mail.thread_id: the thread_id from list_emails, read_email or search, or leave it out for a folder' }
  }
  const threadId = typeof m.thread_id === 'string' ? m.thread_id.trim() : ''
  const unread = m.unread === true || m.unread === 'true'
  if (m.unread !== undefined && m.unread !== null && !unread && m.unread !== false && m.unread !== 'false') {
    return { ok: false, error: 'mail.unread: true for only unread threads, or leave it out' }
  }
  const accounts = checkAccounts('mail.accounts', m.accounts)
  if (!accounts.ok) return accounts
  return {
    ok: true,
    value: {
      kind: 'mail',
      title,
      mail: {
        folder,
        ...(search ? { search } : {}),
        ...(unread ? { unread: true } : {}),
        ...(threadId ? { thread_id: threadId } : {}),
        ...(accounts.value ? { accounts: accounts.value } : {}),
      },
    },
  }
}

/**
 * The agent's `show` input as a card spec, or the one thing to fix. Names in
 * id fields are left for resolveNamedValues on the server.
 */
export function normalizeShowInput(input: ShowInput): Checked<ListCardSpec | RecordCardSpec | CalendarCardSpec | MailCardSpec> {
  const rawKind = typeof input.kind === 'string' ? input.kind.trim().toLowerCase() : ''
  const title = typeof input.title === 'string' ? input.title.replace(/\s+/g, ' ').trim().slice(0, 120) : ''
  if (!title) return { ok: false, error: 'title: give the card a short title that says what it shows, e.g. "Due this week · Atlas"' }

  if (rawKind === 'record') {
    const type = input.record?.type
    const id = input.record?.id
    if (typeof type !== 'string' || !(CARD_RECORD_TYPES as readonly string[]).includes(type)) {
      return { ok: false, error: `record.type: use one of ${listOf(CARD_RECORD_TYPES)}` }
    }
    if (typeof id !== 'string' || !id.trim()) {
      return { ok: false, error: `record.id: give the ${type}'s id${type === 'action' ? ' or its identifier, e.g. GEN-42' : ''}` }
    }
    return { ok: true, value: { kind: 'record', title, record: { type: type as CardRecordType, id: id.trim() } } }
  }

  if (rawKind === 'calendar' || rawKind === 'events') return checkCalendarSpec(title, input.calendar)
  if (rawKind === 'mail' || rawKind === 'email' || rawKind === 'inbox') return checkMailSpec(title, input.mail)

  if (rawKind !== 'list' && rawKind !== 'board') {
    return {
      ok: false,
      error: `kind: use 'list' (a filtered page of records), 'board' (the same as a board), 'record' (one record), 'calendar' (a day, week or month of events) or 'mail' (a mail folder or one thread)`,
    }
  }
  const entity = input.entity_type
  if (typeof entity !== 'string' || !(CARD_LIST_ENTITIES as readonly string[]).includes(entity)) {
    return { ok: false, error: `entity_type: a list shows one of ${listOf(CARD_LIST_ENTITIES)}` }
  }
  const entityType = entity as CardListEntity

  const rawFilters = input.filters ?? []
  if (!Array.isArray(rawFilters)) return { ok: false, error: 'filters takes a list of {field, operator, value}' }
  if (rawFilters.length > MAX_FILTERS) return { ok: false, error: `filters: at most ${MAX_FILTERS}` }
  const filters: CardFilter[] = []
  for (const [i, f] of rawFilters.entries()) {
    const checked = checkFilter(entityType, f ?? {}, `filters[${i}]`)
    if (!checked.ok) return checked
    filters.push(checked.value)
  }

  const ordering = checkSort(entityType, input.ordering)
  if (!ordering.ok) return ordering
  const grouping = checkGrouping(entityType, input.grouping)
  if (!grouping.ok) return grouping
  const columns = checkColumns(entityType, input.columns)
  if (!columns.ok) return columns

  let layout: 'list' | 'board' | undefined
  if (rawKind === 'board' || input.layout === 'board') layout = 'board'
  else if (input.layout === undefined || input.layout === null || input.layout === 'list') layout = undefined
  else return { ok: false, error: `layout: use 'list' or 'board'` }

  // A board with no grouping takes the page's own default columns
  // (DEFAULT_BOARD_GROUP_BY), as switching a list to a board does.
  const groupingValue = grouping.value

  const spec: ListCardSpec = {
    kind: 'list',
    title,
    entity_type: entityType,
    filters,
    ...(ordering.value ? { ordering: ordering.value } : {}),
    ...(groupingValue !== undefined ? { grouping: groupingValue } : {}),
    ...(layout ? { layout } : {}),
    ...(columns.value ? { columns: columns.value } : {}),
  }
  return { ok: true, value: spec }
}
