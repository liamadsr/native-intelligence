/**
 * What a form takes, and one submission read against it (forms phase 1).
 *
 *   validateFormFields   the fields a form is saved with: each the row's name,
 *                        a live column of a type a stranger may fill
 *                        (./types.ts FORM_FIELD_TYPES) or the form's files
 *                        (FORM_FILES_KEY, at most one, never alone: ./files.ts
 *                        checks what is sent), with its label and whether it
 *                        is required. No field may answer to a name the
 *                        intake keeps for itself (FORM_RESERVED_NAMES: the
 *                        submission id, the redirect, the bot check's, the
 *                        personal link's, the website check's and the
 *                        honeypots), compared as posted names are matched.
 *   parseSubmission      one posted submission: only the form's own fields
 *                        are read (anything else posted is dropped), each
 *                        value cleaned and coerced to its column's stored
 *                        form by the tables' one rule (coerceCustomValue), a
 *                        required one that is missing refused.
 *
 * A posted field is matched to a form field by name, loosely: the column's
 * key, or the label's slug, so a plain website form's "Full Name" or
 * "full_name" both find a field labelled Full Name.
 *
 * A files field is no column and no posted name: a submission's files are
 * every file part it carries (./body.ts), read by ./files.ts, never here.
 *
 * Every string is the submitter's own words: cleaned of control characters
 * and clipped, and read by the agents only inside the untrusted fence
 * (data_row.from_form). Pure.
 */
import { cleanText } from '@/lib/customers/intake'
import { coerceCustomValue, customFieldKey, type CustomFieldValue } from '@/lib/crm/custom-fields'
import { MAX_TEXT, type CustomFieldType } from '@/lib/crm/custom-field-types'
import type { DataColumn } from '@/lib/tables/types'
import { normalizeE164 } from '@/lib/twilio/phone'
import { INTAKE_TEST_FIELD } from '@/lib/website/types'
import { FORM_FILES_KEY, FORM_LIMITS, FORM_TITLE_KEY, isFormColumn, isFormFieldType, type FormField } from './types'

type Checked<T> = { ok: true; value: T } | { ok: false; error: string }
const fail = (error: string): { ok: false; error: string } => ({ ok: false, error })

type FormColumn = Pick<DataColumn, 'key' | 'label' | 'field_type' | 'options' | 'config' | 'deleted_at' | 'system'>

/**
 * Fields a bot fills and a person never sees. `_gotcha`, `hp` and
 * `company_website` are reserved (FORM_RESERVED_NAMES: no field may be
 * called them); `website` is not, since a business may well ask for one, so
 * it is a honeypot only while no field of the form is called that.
 */
const HONEYPOTS = ['_gotcha', 'hp', 'company_website', 'website']
/** A form's own id for a submission: the same one from the same sender is stored once. */
const EXTERNAL_ID_NAMES = ['submission_id', 'external_id']

/**
 * The names a post carries for the intake itself, never for a field: the
 * submission's own id, the redirect, the bot check's challenge and answer,
 * a personal link's secret, the website check's nonce, and the honeypots but
 * `website` (see HONEYPOTS). The intake takes the form's own ones out of a
 * post before reading its fields (./submit.ts); all of them are refused as a
 * field's name, by the slug posted names are matched by, so none can ever
 * fill a field or be filled by one.
 */
export const FORM_RESERVED_NAMES = ['submission_id', 'external_id', '_redirect', '_gotcha', '_challenge', '_answer', '_invite', INTAKE_TEST_FIELD, 'hp', 'company_website'] as const
/** A value that isn't text (a number, a date, an option) is short. */
const SHORT_VALUE_MAX = 500
/** The posted names a field answers to that mean a person's name (the contact's). */
const NAME_SLUGS = new Set(['name', 'full_name', 'your_name', 'customer_name', 'contact_name'])

const slug = (name: string) => customFieldKey(name)

/** The live column a field fills, or null (the row's name, or a column that is gone). */
function columnOf(field: FormField, columns: ReadonlyMap<string, FormColumn>): FormColumn | null {
  if (field.key === FORM_TITLE_KEY) return null
  const col = columns.get(field.key)
  // Checked again at every submission: a column retyped since the form was saved (to a person, a relation) is no longer a stranger's to fill.
  return col && isFormColumn(col) ? col : null
}

/** The posted names a field answers to: its own first, then the looser ones. */
function namesOf(field: FormField, column: FormColumn | null): { own: string[]; loose: string[] } {
  const own = [slug(field.label)]
  if (field.key === FORM_TITLE_KEY) return { own, loose: ['title', 'name'] }
  own.push(field.key)
  return { own, loose: column ? [slug(column.label)] : [] }
}

/** Which form field each posted name fills. A field's own names win over another's looser ones. */
function nameMap(fields: readonly FormField[], columns: ReadonlyMap<string, FormColumn>): Map<string, FormField> {
  const map = new Map<string, FormField>()
  const named = fields.map((f) => ({ f, names: namesOf(f, columnOf(f, columns)) }))
  for (const { f, names } of named) for (const n of names.own) if (n && !map.has(n)) map.set(n, f)
  for (const { f, names } of named) for (const n of names.loose) if (n && !map.has(n)) map.set(n, f)
  return map
}

/**
 * The fields a form is saved with, from `[{ key, label?, required? }]`: see
 * the header. `columns` are the table's (deleted ones may be among them).
 */
export function validateFormFields(columns: readonly FormColumn[], input: unknown): Checked<FormField[]> {
  if (!Array.isArray(input) || input.length === 0) return fail('A form needs at least one field.')
  if (input.length > FORM_LIMITS.fields) return fail(`A form takes at most ${FORM_LIMITS.fields} fields.`)
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const out: FormField[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('Each field is { key, label, required }.')
    const r = raw as Record<string, unknown>
    const key = typeof r.key === 'string' ? r.key : ''
    if (seen.has(key)) return fail(key === FORM_FILES_KEY ? 'A form takes files through one field.' : `The field "${key}" is listed twice.`)
    seen.add(key)
    let fallbackLabel = key === FORM_FILES_KEY ? 'Files' : 'Name'
    if (key !== FORM_TITLE_KEY && key !== FORM_FILES_KEY) {
      const col = byKey.get(key)
      if (!col || col.deleted_at) return fail(`No column "${key}" in this table.`)
      if (!isFormFieldType(col.field_type)) {
        return fail(`${col.label} can't be on a form: a form fills text, number, date, select, multi-select, checkbox, URL, email, phone and currency columns.`)
      }
      if (!isFormColumn(col)) return fail(`${col.label} can't be on a form: it is the pipeline's own, and a deal from a form starts in its first open stage.`)
      fallbackLabel = col.label
    }
    const label = cleanText(r.label, FORM_LIMITS.label) ?? fallbackLabel
    if (!slug(label)) return fail(`"${label}" has no letters or digits to name the field by.`)
    out.push({ key, label, required: r.required === true })
  }
  // A name the intake keeps for itself, matched as a posted name is (by its slug), can't be a field's.
  const reserved = new Map<string, string>()
  for (const r of FORM_RESERVED_NAMES) for (const n of [r, slug(r)]) if (n) reserved.set(n, r)
  for (const f of out) {
    if (f.key === FORM_FILES_KEY) continue
    const clash = [...namesOf(f, null).own, postedNameOf(f)].map((n) => reserved.get(n)).find(Boolean)
    if (clash) return fail(`"${f.label}" can't name a field: a post uses ${clash} for the form itself. Give the field another label.`)
  }
  // A form's row needs something to be named by: files alone fill nothing of it.
  if (!out.some((f) => f.key !== FORM_FILES_KEY)) return fail('A form needs at least one field besides its files.')
  // Two fields a post can't tell apart would silently lose one of them (files are posted as files, never by a name).
  const claimed = new Map<string, string>()
  for (const f of out) {
    if (f.key === FORM_FILES_KEY) continue
    for (const n of namesOf(f, null).own) {
      const other = claimed.get(n)
      if (other && other !== f.key) return fail(`Two fields would both be called "${n}". Give one another label.`)
      claimed.set(n, f.key)
    }
  }
  return { ok: true, value: out }
}

/** A stored `fields` value read back: well-formed entries only. */
export function readFormFields(raw: unknown): FormField[] {
  if (!Array.isArray(raw)) return []
  const out: FormField[] = []
  for (const item of raw.slice(0, FORM_LIMITS.fields)) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    if (typeof r.key !== 'string' || typeof r.label !== 'string' || !r.key || !r.label) continue
    out.push({ key: r.key, label: r.label, required: r.required === true })
  }
  return out
}

/** The name a website form's input carries for a field: what to put in `name="…"`. */
export function postedNameOf(field: FormField): string {
  if (field.key === FORM_FILES_KEY) return 'files'
  return field.key === FORM_TITLE_KEY ? slug(field.label) || 'name' : field.key
}

export interface ParsedSubmission {
  /** The row's name: one line, short. Empty when the form gave nothing to name it by. */
  title: string
  values: Record<string, CustomFieldValue>
  externalId: string | null
  /** Who to find or make in the CRM: null when there is no email and no phone. */
  contact: { name: string | null; email: string | null; phone: string | null } | null
}

export type ParseSubmissionResult = { ok: true; submission: ParsedSubmission } | { ok: false; reason: 'bot' | 'invalid'; error: string }

/** A posted value, cleaned for its type before the coercion: null when empty, undefined when it can't be one value. */
function cleanPosted(type: CustomFieldType | 'title', raw: unknown): unknown {
  if (raw === null || raw === undefined) return null
  if (typeof raw === 'boolean') return type === 'checkbox' ? raw : undefined
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : undefined
  if (typeof raw === 'string') {
    if (type === 'text') return cleanText(raw, MAX_TEXT, { multiline: true })
    return cleanText(raw, type === 'title' ? FORM_LIMITS.title : SHORT_VALUE_MAX)
  }
  if (Array.isArray(raw)) {
    if (type !== 'multi_select' || raw.length > 50) return undefined
    const parts = raw.map((x) => (typeof x === 'string' || typeof x === 'number' ? cleanText(x, SHORT_VALUE_MAX) : undefined))
    return parts.some((p) => p === undefined) ? undefined : parts.filter((p): p is string => !!p)
  }
  if (type === 'currency') {
    const o = raw as { amount?: unknown; currency?: unknown }
    const amount = typeof o.amount === 'number' ? o.amount : cleanText(o.amount, 40)
    return amount === null ? null : { amount, currency: cleanText(o.currency, 3) ?? undefined }
  }
  return undefined
}

/**
 * Read one posted submission against the form (see the header). `columns`
 * are the table's now: a field whose column was deleted since, or retyped
 * to something a form may not fill, is skipped (never refused: the visitor
 * can't fix it), unless nothing is left.
 */
export function parseSubmission(fields: readonly FormField[], columns: readonly FormColumn[], posted: unknown): ParseSubmissionResult {
  if (!posted || typeof posted !== 'object' || Array.isArray(posted)) return { ok: false, reason: 'invalid', error: 'Send the form as JSON or form fields.' }
  const byKey = new Map(columns.map((c) => [c.key, c]))
  const live = fields.filter((f) => f.key === FORM_TITLE_KEY || columnOf(f, byKey))
  if (!live.length) return { ok: false, reason: 'invalid', error: 'This form has no fields to fill any more.' }
  const names = nameMap(live, byKey)

  const entries = Object.entries(posted as Record<string, unknown>)
  for (const [name, value] of entries) {
    if (HONEYPOTS.includes(name) && !names.has(slug(name)) && typeof value === 'string' && value.trim() !== '') return { ok: false, reason: 'bot', error: 'ok' }
  }

  // The first posted value for each form field; everything else posted is dropped.
  const given = new Map<string, unknown>()
  for (const [name, value] of entries) {
    const field = names.get(slug(name))
    if (field && !given.has(field.key) && value !== '' && value !== null && value !== undefined) given.set(field.key, value)
  }

  const values: Record<string, CustomFieldValue> = {}
  let title = ''
  let contactName: string | null = null
  let email: string | null = null
  let phone: string | null = null
  for (const field of live) {
    const column = columnOf(field, byKey)
    const type = column ? (column.field_type as CustomFieldType) : 'title'
    const cleaned = cleanPosted(type, given.get(field.key))
    if (cleaned === undefined) return { ok: false, reason: 'invalid', error: `${field.label} takes one value.` }
    let stored: CustomFieldValue = null
    if (!column) {
      title = typeof cleaned === 'number' ? String(cleaned) : typeof cleaned === 'string' ? cleaned : ''
    } else {
      const coerced = coerceCustomValue({ label: field.label, field_type: type as CustomFieldType, options: column.options ?? [], config: column.config }, cleaned)
      if (!coerced.ok) return { ok: false, reason: 'invalid', error: `${coerced.error}.` }
      stored = coerced.value
      if (stored !== null) values[field.key] = stored
    }
    // A required checkbox is one that must be ticked ("I agree"): unticked is empty.
    const empty = column ? stored === null || (field.required && stored === false) : title === ''
    if (field.required && empty) return { ok: false, reason: 'invalid', error: `${field.label} is required.` }
    if (empty) continue
    if (column?.field_type === 'email' && !email && typeof stored === 'string') email = stored
    if (column?.field_type === 'phone' && !phone && typeof stored === 'string') phone = normalizeE164(stored)
    const called = [slug(field.label), ...(column ? [field.key] : [])]
    if (!contactName && called.some((n) => NAME_SLUGS.has(n))) {
      const text = column ? (column.field_type === 'text' && typeof stored === 'string' ? stored : null) : title
      contactName = text ? cleanText(text, 120) : null
    }
  }
  if (!title && Object.keys(values).length === 0) return { ok: false, reason: 'invalid', error: 'Fill in at least one field.' }

  // No name field on the form: the row is named by the first thing it was given.
  if (!title) {
    const first = live.map((f) => values[f.key]).find((v) => typeof v === 'string' || typeof v === 'number')
    title = first === undefined ? '' : (cleanText(String(first), FORM_LIMITS.title) ?? '')
  }

  const raw = posted as Record<string, unknown>
  const externalName = EXTERNAL_ID_NAMES.find((n) => !names.has(n) && raw[n] !== undefined)
  return {
    ok: true,
    submission: {
      title,
      values,
      externalId: externalName ? cleanText(raw[externalName], FORM_LIMITS.externalId) : null,
      contact: email || phone ? { name: contactName, email, phone } : null,
    },
  }
}
