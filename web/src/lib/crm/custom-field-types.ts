/**
 * What each custom field type holds (Tables, phase 2; migrations 523 to 526):
 * one field system, so a table's columns (src/lib/tables) and every kind's
 * custom fields (./custom-fields.ts) take the same types, store them the
 * same way and read them the same way.
 *
 * The stored form, in a record's `custom_fields` jsonb under the field's key:
 *
 *   text, date, select, url, email, phone   a string
 *   number                                  a number
 *   checkbox                                true or false
 *   multi_select                            a list of the field's options
 *   person                                  a workspace member's id
 *   currency                                { amount, currency }: an ISO code
 *   relation                                a list of record ids (one at most
 *                                           unless the field takes several)
 *
 * A definition's `config` carries what a type needs past its options: a
 * currency's default code, a relation's target ({kind, table_id?}) and
 * whether it takes several, and (a table's column only) `required_when`.
 *
 * `coerceCustomValue` turns what a person or the agent sent into the stored
 * form, or says why not. Converting stored values to another type is the
 * database's one cast rule (523's _field_cast), so a table's column and a
 * kind's field convert alike and nothing a caller can't see leaves it. The
 * checks that need the database (a person is a member, a linked record is
 * one the writer can read) are ./custom-field-references.ts and 524.
 *
 * Client-safe and pure.
 */
import { normalizeEmail, normalizePhone } from '@/lib/crm/import/record'
import type { MentionableType } from '@/lib/entity-links/mentionable'

export const CUSTOM_FIELD_TYPES = [
  'text',
  'number',
  'date',
  'select',
  'multi_select',
  'checkbox',
  'url',
  'email',
  'phone',
  'person',
  'currency',
  'relation',
] as const
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number]

export function isCustomFieldType(v: unknown): v is CustomFieldType {
  return typeof v === 'string' && (CUSTOM_FIELD_TYPES as readonly string[]).includes(v)
}

/** What each type is called in a menu. */
export const CUSTOM_FIELD_TYPE_LABELS: Readonly<Record<CustomFieldType, string>> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  select: 'Select',
  multi_select: 'Multi-select',
  checkbox: 'Checkbox',
  url: 'URL',
  email: 'Email',
  phone: 'Phone',
  person: 'Person',
  currency: 'Currency',
  relation: 'Relation',
}

/** The types whose values are one of the definition's options. */
export const hasOptions = (t: CustomFieldType): boolean => t === 'select' || t === 'multi_select'

/**
 * What a relation can link to: the records a person works on and can find in
 * the search menu, and a table's rows (with the table named). 524 keeps the
 * same list for its edges and its clean-up when a record is deleted.
 */
export const RELATION_TARGET_KINDS = [
  'contact',
  'company',
  'action',
  'project',
  'initiative',
  'document',
  'capture',
  'flow',
  'data_row',
] as const satisfies readonly MentionableType[]
export type RelationTargetKind = (typeof RELATION_TARGET_KINDS)[number]

export function isRelationTargetKind(v: unknown): v is RelationTargetKind {
  return typeof v === 'string' && (RELATION_TARGET_KINDS as readonly string[]).includes(v)
}

/** A relation's target: a kind, or (kind data_row) one table's rows. */
export interface RelationTarget {
  kind: RelationTargetKind
  table_id?: string
}

/** A column required while one of the table's select columns holds one option. */
export interface RequiredWhen {
  key: string
  option: string
}

export interface CustomFieldConfig {
  /** currency: the ISO code an amount takes when it names none. */
  currency?: string
  /** relation: what it links to. */
  target?: RelationTarget
  /** relation: it takes several records (default one). */
  multiple?: boolean
  /** A table's column only (src/lib/tables): needed while `key` is `option`. */
  required_when?: RequiredWhen
  /** A table's formula column (src/lib/tables/formula.ts): its expression, references as `{#key}`. */
  expression?: string
  /** A table's rollup column (src/lib/tables/computed.ts): the relation column it reads through. */
  relation?: string
  /** A rollup: the linked records' field it aggregates (`_title`: their name; none: the records themselves). */
  field?: string | null
  /** A rollup: how it aggregates (count, sum, avg, min, max, earliest, latest, list). */
  fn?: string
  /**
   * A select column of a table only: each option's outcome, a pipeline's
   * stages (migration 540). An option not named is open.
   */
  outcomes?: Record<string, StageOutcome>
}

/** Where a pipeline's stage leaves a deal: still open, won or lost. */
export type StageOutcome = 'open' | 'won' | 'lost'
export const STAGE_OUTCOMES: readonly StageOutcome[] = ['open', 'won', 'lost']

/** An option's outcome in a select's config: 'won', 'lost', or 'open' for any other. */
export function optionOutcome(config: CustomFieldConfig | null | undefined, option: unknown): StageOutcome {
  if (typeof option !== 'string') return 'open'
  const o = config?.outcomes?.[option]
  return o === 'won' || o === 'lost' ? o : 'open'
}

export interface CurrencyValue {
  amount: number
  currency: string
}

export type CustomFieldValue = string | number | boolean | string[] | CurrencyValue | null

/** The definition fields a value check reads. */
export type FieldShape = { label: string; field_type: CustomFieldType; options: readonly string[]; config?: CustomFieldConfig | null }

export const DEFAULT_CURRENCY = 'USD'
export const MAX_TEXT = 2000
export const MAX_URL = 2000
export const MAX_RELATED = 100
const MAX_AMOUNT = 1e15

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const CODE_RE = /^[A-Z]{3}$/

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'x', 'on', 'checked', 'done'])
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off', 'unchecked'])

/** A valid calendar date in YYYY-MM-DD form. */
export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false
  const d = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value
}

/** A three-letter ISO currency code the runtime knows (any three capitals where it can't say). */
export function isCurrencyCode(code: unknown): code is string {
  if (typeof code !== 'string' || !CODE_RE.test(code)) return false
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf
  if (!supported) return true
  try {
    return supported('currency').includes(code)
  } catch {
    return true
  }
}

/** The currency a field's bare amounts take. */
export function fieldCurrency(config: CustomFieldConfig | null | undefined): string {
  return config?.currency && isCurrencyCode(config.currency) ? config.currency : DEFAULT_CURRENCY
}

const SYMBOLS: Record<string, string> = { '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR' }

/** "$1,200.50", "1200 EUR", "EUR 1,200", "€12": an amount and its code, or null. */
export function parseCurrency(raw: string, fallback: string): CurrencyValue | null {
  const s = raw.trim()
  if (!s || s.length > 60) return null
  const named = /\b([A-Za-z]{3})\b/.exec(s)?.[1]?.toUpperCase()
  const symbol = [...s].find((ch) => ch in SYMBOLS || ch === '$')
  const code = named ?? (symbol === '$' ? (fallback.endsWith('D') ? fallback : 'USD') : symbol ? SYMBOLS[symbol] : fallback)
  const digits = s.replace(/[A-Za-z]{3}/, '').replace(/[^\d.+-]/g, '')
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)$/.test(digits)) return null
  const amount = Number(digits)
  if (!Number.isFinite(amount) || Math.abs(amount) >= MAX_AMOUNT || !isCurrencyCode(code)) return null
  return { amount, currency: code }
}

/** "acme.com/pricing" → "https://acme.com/pricing"; null when it isn't a web address. */
export function normalizeUrl(raw: string): string | null {
  const s = raw.trim()
  if (!s || s.length > MAX_URL || /\s/.test(s)) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    if (!url.hostname.includes('.') || url.hostname.startsWith('.') || url.hostname.endsWith('.')) return null
    return withScheme.length > MAX_URL ? null : withScheme
  } catch {
    return null
  }
}

type Coerced = { ok: true; value: CustomFieldValue } | { ok: false; error: string }
const no = (error: string): Coerced => ({ ok: false, error })

/** Record ids from a list, one id, a comma-separated string, or {id} objects. */
function idList(raw: unknown): string[] | null {
  const items = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [raw]
  const out: string[] = []
  for (const item of items) {
    const id = typeof item === 'string' ? item.trim() : item && typeof item === 'object' && typeof (item as { id?: unknown }).id === 'string' ? (item as { id: string }).id.trim() : null
    if (id === null) return null
    if (!id) continue
    if (!UUID_RE.test(id)) return null
    const lower = id.toLowerCase()
    if (!out.includes(lower)) out.push(lower)
  }
  return out
}

/**
 * A raw value checked against its definition: the stored form, or why not.
 * `null`, '' and an empty list clear the field. A select (and each choice of
 * a multi-select) takes its option case-insensitively and stores the
 * option's own spelling.
 */
export function coerceCustomValue(def: FieldShape, raw: unknown): Coerced {
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: null }
  if (Array.isArray(raw) && raw.length === 0) return { ok: true, value: null }
  const { label } = def
  // A list or an object is one value only where the type holds one (String()
  // would store "[object Object]", or a one-item list's item). A person takes
  // {id} or a one-item list too (a picker's answer).
  const objectOk = ['multi_select', 'relation', 'person'].includes(def.field_type) || (def.field_type === 'currency' && !Array.isArray(raw))
  if (typeof raw === 'object' && !objectOk) return no(`${label} takes one value`)
  switch (def.field_type) {
    case 'text': {
      const text = String(raw).trim()
      if (text.length > MAX_TEXT) return no(`${label} is longer than ${MAX_TEXT} characters`)
      return { ok: true, value: text || null }
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''))
      if (typeof raw === 'boolean' || !Number.isFinite(n)) return no(`${label} needs a number`)
      return { ok: true, value: n }
    }
    case 'date': {
      const text = String(raw).trim()
      if (!isIsoDate(text)) return no(`${label} needs a date as YYYY-MM-DD`)
      return { ok: true, value: text }
    }
    case 'select': {
      const text = String(raw).trim().toLowerCase()
      const match = def.options.find((o) => o.toLowerCase() === text)
      if (!match) return no(`${label} is one of: ${def.options.join(', ')}`)
      return { ok: true, value: match }
    }
    case 'multi_select': {
      const parts = Array.isArray(raw) ? raw.map((x) => (typeof x === 'string' || typeof x === 'number' ? String(x) : null)) : String(raw).split(',')
      const out: string[] = []
      for (const part of parts) {
        if (part === null) return no(`${label} takes a list of options`)
        const text = part.trim().toLowerCase()
        if (!text) continue
        const match = def.options.find((o) => o.toLowerCase() === text)
        if (!match) return no(`${label} takes options from: ${def.options.join(', ')}`)
        if (!out.includes(match)) out.push(match)
      }
      return { ok: true, value: out.length ? out : null }
    }
    case 'checkbox': {
      if (typeof raw === 'boolean') return { ok: true, value: raw }
      const text = String(raw).trim().toLowerCase()
      if (TRUE_WORDS.has(text)) return { ok: true, value: true }
      if (FALSE_WORDS.has(text)) return { ok: true, value: false }
      return no(`${label} is yes or no`)
    }
    case 'url': {
      const url = normalizeUrl(String(raw))
      return url ? { ok: true, value: url } : no(`${label} needs a web address`)
    }
    case 'email': {
      const email = normalizeEmail(String(raw))
      return email ? { ok: true, value: email } : no(`${label} needs an email address`)
    }
    case 'phone': {
      const phone = normalizePhone(String(raw))
      return phone ? { ok: true, value: phone } : no(`${label} needs a phone number`)
    }
    case 'person': {
      const ids = idList(raw)
      if (!ids || ids.length > 1) return no(`${label} takes one workspace member`)
      return { ok: true, value: ids[0] ?? null }
    }
    case 'currency': {
      const fallback = fieldCurrency(def.config)
      if (typeof raw === 'number') {
        if (!Number.isFinite(raw) || Math.abs(raw) >= MAX_AMOUNT) return no(`${label} needs an amount`)
        return { ok: true, value: { amount: raw, currency: fallback } }
      }
      if (typeof raw === 'object') {
        const o = raw as { amount?: unknown; currency?: unknown }
        const amount = typeof o.amount === 'number' ? o.amount : typeof o.amount === 'string' ? Number(o.amount.replace(/[,\s]/g, '')) : NaN
        const code = o.currency === undefined || o.currency === null || o.currency === '' ? fallback : String(o.currency).trim().toUpperCase()
        if (!Number.isFinite(amount) || Math.abs(amount) >= MAX_AMOUNT) return no(`${label} needs an amount`)
        if (!isCurrencyCode(code)) return no(`${label}'s currency is a three-letter code, like USD or EUR`)
        return { ok: true, value: { amount, currency: code } }
      }
      const parsed = parseCurrency(String(raw), fallback)
      return parsed ? { ok: true, value: parsed } : no(`${label} needs an amount, like 1200 or 1200 EUR`)
    }
    case 'relation': {
      const ids = idList(raw)
      if (!ids) return no(`${label} takes record ids`)
      const max = def.config?.multiple ? MAX_RELATED : 1
      if (ids.length > max) return no(max === 1 ? `${label} links one record` : `${label} links at most ${max} records`)
      return { ok: true, value: ids.length ? ids : null }
    }
  }
}

/**
 * A definition's config, checked for its type: the parts that type takes,
 * cleaned, or why not. `required_when` is a table column's (its own check is
 * src/lib/tables/ops.ts), so a kind's field refuses it.
 */
export function cleanFieldConfig(
  fieldType: CustomFieldType,
  raw: unknown,
  opts: { tableColumn?: boolean } = {},
): { ok: true; config: CustomFieldConfig } | { ok: false; error: string } {
  const c = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
  const config: CustomFieldConfig = {}
  if (fieldType === 'currency') {
    const code = c.currency === undefined || c.currency === null || c.currency === '' ? DEFAULT_CURRENCY : String(c.currency).trim().toUpperCase()
    if (!isCurrencyCode(code)) return { ok: false, error: 'A currency is a three-letter code, like USD or EUR.' }
    config.currency = code
  }
  if (fieldType === 'relation') {
    const t = (c.target && typeof c.target === 'object' ? c.target : {}) as Record<string, unknown>
    if (!isRelationTargetKind(t.kind)) return { ok: false, error: `A relation links to one of: ${RELATION_TARGET_KINDS.join(', ')}.` }
    if (t.kind === 'data_row') {
      if (typeof t.table_id !== 'string' || !UUID_RE.test(t.table_id)) return { ok: false, error: "A relation to a table's rows names the table." }
      config.target = { kind: 'data_row', table_id: t.table_id.toLowerCase() }
    } else {
      config.target = { kind: t.kind }
    }
    if (c.multiple !== undefined && typeof c.multiple !== 'boolean') return { ok: false, error: 'multiple is true or false.' }
    config.multiple = c.multiple === true
  }
  if (c.required_when !== undefined && c.required_when !== null) {
    if (!opts.tableColumn) return { ok: false, error: "Only a table's column can be required when another is set." }
    const r = c.required_when as Record<string, unknown>
    if (typeof r?.key !== 'string' || typeof r?.option !== 'string' || !r.key || !r.option) {
      return { ok: false, error: 'required_when names a select column and one of its options.' }
    }
    config.required_when = { key: r.key, option: r.option }
  }
  if (c.outcomes !== undefined && c.outcomes !== null) {
    if (fieldType !== 'select' || !opts.tableColumn) return { ok: false, error: "Only a table's select column has outcomes." }
    if (typeof c.outcomes !== 'object' || Array.isArray(c.outcomes)) return { ok: false, error: 'outcomes names options and won or lost.' }
    const outcomes: Record<string, StageOutcome> = {}
    for (const [option, outcome] of Object.entries(c.outcomes as Record<string, unknown>)) {
      if (outcome !== 'open' && outcome !== 'won' && outcome !== 'lost') return { ok: false, error: 'An outcome is open, won or lost.' }
      // Open is every option's default: only won and lost are kept.
      if (outcome !== 'open') outcomes[option] = outcome
    }
    config.outcomes = outcomes
  }
  return { ok: true, config }
}

/** The same relation target (a kind, and for rows the same table). */
export function sameRelationTarget(a: RelationTarget | undefined, b: RelationTarget | undefined): boolean {
  return !!a && !!b && a.kind === b.kind && (a.table_id ?? null) === (b.table_id ?? null)
}

/** Every record id a relation value links to. */
export function relationIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && UUID_RE.test(v)) : []
}

/** Is a stored value empty (nothing to show, nothing a required column has)? */
export function isEmptyValue(value: unknown): boolean {
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
}

/** A number as a currency reads: "$1,200.00", "€12.50". */
export function formatCurrency(value: CurrencyValue): string {
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: value.currency }).format(value.amount)
  } catch {
    return `${value.amount.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${value.currency}`
  }
}

/**
 * A stored value as text: a number with its digit grouping, a date as
 * "Mar 4" (with the year when it is not this one), a currency in its own
 * symbol, a checkbox Yes or No, a list joined, a person or a linked record by
 * name when `labels` knows it (else nothing: an id means nothing to read).
 * Empty for a value that isn't there.
 */
export function formatFieldValue(
  fieldType: CustomFieldType | undefined,
  value: unknown,
  opts: { now?: Date; labels?: ReadonlyMap<string, string> | Record<string, string> } = {},
): string {
  if (isEmptyValue(value)) return ''
  const label = (id: string) => (opts.labels instanceof Map ? opts.labels.get(id) : (opts.labels as Record<string, string> | undefined)?.[id])
  switch (fieldType) {
    case 'number':
      return typeof value === 'number' ? value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : ''
    case 'date': {
      if (typeof value !== 'string' || !DATE_RE.test(value)) return ''
      const now = opts.now ?? new Date()
      const [y, m, d] = value.split('-').map(Number)
      const day = new Date(y, m - 1, d)
      return day.toLocaleDateString('en-US', y === now.getFullYear() ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
    }
    case 'checkbox':
      return value === true ? 'Yes' : value === false ? 'No' : ''
    case 'multi_select':
      return Array.isArray(value) ? value.filter((v) => typeof v === 'string').join(', ') : ''
    case 'currency': {
      const v = value as Partial<CurrencyValue>
      return typeof v === 'object' && typeof v.amount === 'number' && typeof v.currency === 'string' ? formatCurrency(v as CurrencyValue) : ''
    }
    case 'person':
      return typeof value === 'string' ? (label(value) ?? '') : ''
    case 'relation':
      return relationIds(value)
        .map((id) => label(id))
        .filter((x): x is string => !!x)
        .join(', ')
    default:
      return typeof value === 'object' ? '' : String(value)
  }
}

/** The ids a value names that need a name to show: a person's, a relation's. */
export function referencedIds(fieldType: CustomFieldType, value: unknown): string[] {
  if (fieldType === 'person') return typeof value === 'string' && UUID_RE.test(value) ? [value] : []
  if (fieldType === 'relation') return relationIds(value)
  return []
}
