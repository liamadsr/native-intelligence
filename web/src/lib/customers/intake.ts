/**
 * A website's quote form, as the intake endpoint reads it
 * (src/app/api/intake/quotes/[key]/route.ts; roadmap B1). Forms differ, so
 * this reads the field names they commonly use, in JSON or form encoding:
 *
 *   who      name | full_name | fullName | first_name + last_name,
 *            email, phone | phone_number | phoneNumber | tel,
 *            address (or street, city, zip joined)
 *   what     items: a JSON array of { description, service, width, length,
 *            unit, size, quantity, price }; or one item from the flat
 *            fields width / length (a price calculator) or size; service
 *            ("cleaning", "repair"); message | notes | details | description
 *   price    total | price | estimated_price | estimate (dollars, "$600"
 *            reads), or total_cents
 *   when     requested_date(s) | preferred_date | pickup_date | date
 *   id       submission_id | external_id: a form's own id, so a
 *            re-posted submission is stored once (the same id from someone
 *            else is a new quote: a guessed id never swallows a real one)
 *
 * Bright Loom's form (the first client) sends Full Name, Email, Phone, a
 * free-text "about your rugs" box and its calculator's length × width.
 *
 * A post with neither a phone nor an email is refused (nobody to answer);
 * a honeypot field (`website`, `_gotcha`, `company_website`) that a person
 * never fills is dropped as a bot's, answered as if stored.
 *
 * Every string is the customer's own words: cleaned of control characters,
 * clipped to the table's caps, and read by the agents only inside the
 * untrusted fence. Pure.
 */
import { normalizeE164 } from '@/lib/twilio/phone'
import {
  QUOTE_ADDRESS_MAX,
  QUOTE_EMAIL_MAX,
  QUOTE_EXTERNAL_ID_MAX,
  QUOTE_MAX_ITEMS,
  QUOTE_NAME_MAX,
  QUOTE_NOTES_MAX,
  QUOTE_REQUESTED_DATES_MAX,
  QUOTE_SERVICE_MAX,
  QUOTE_TOTAL_MAX_CENTS,
  type QuoteItem,
} from './types'

/** The largest body the endpoint reads. */
export const QUOTE_BODY_MAX_BYTES = 32_000
/** The raw fields kept with the quote (as posted, clipped). */
const RAW_MAX_FIELDS = 40
const RAW_VALUE_MAX = 500

export interface ParsedQuote {
  externalId: string | null
  customerName: string | null
  customerEmail: string | null
  customerPhone: string | null
  address: string | null
  service: string | null
  items: QuoteItem[]
  totalCents: number | null
  requestedDates: string[]
  notes: string | null
  /** The fields as posted, clipped (for the owner's own record). */
  raw: Record<string, string>
}

export type ParseQuoteResult = { ok: true; quote: ParsedQuote } | { ok: false; reason: 'no_contact' | 'bot' | 'bad_body' }

const HONEYPOTS = ['website', '_gotcha', 'company_website', 'hp']

/** Control, zero-width, bidi and other format characters: never kept from a form. */
const INVISIBLE_CHARS = new RegExp('[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F\\u200B-\\u200F\\u2028-\\u202E\\u2060-\\u206F\\uFEFF]', 'g')

/** Control and format characters out, whitespace collapsed, clipped. Null when empty. */
export function cleanText(value: unknown, max: number, opts: { multiline?: boolean } = {}): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(value)
  if (typeof value !== 'string') return null
  let text = value.replace(INVISIBLE_CHARS, '')
  text = opts.multiline ? text.replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim() : text.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text
}

/** Dollars as cents: 600, "600", "$612.50", "1,200". Null when it isn't money. */
export function dollarsToCents(value: unknown): number | null {
  let n: number
  if (typeof value === 'number') n = value
  else if (typeof value === 'string') {
    const cleaned = value.replace(/[$,\s]|usd/gi, '')
    if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
    n = Number(cleaned)
  } else return null
  if (!Number.isFinite(n) || n < 0) return null
  const cents = Math.round(n * 100)
  return cents <= QUOTE_TOTAL_MAX_CENTS ? cents : null
}

function positiveNumber(value: unknown, max = 10_000): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value.trim()) : NaN
  return Number.isFinite(n) && n > 0 && n <= max ? n : undefined
}

function first(fields: Record<string, unknown>, names: readonly string[]): unknown {
  for (const name of names) {
    const v = fields[name]
    if (v !== undefined && v !== null && v !== '') return v
  }
  return undefined
}

const UNITS = new Set(['ft', 'in', 'm', 'cm'])

function cleanItem(raw: unknown): QuoteItem | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  const unitRaw = typeof r.unit === 'string' ? r.unit.trim().toLowerCase().replace(/\.$/, '') : ''
  const unit = UNITS.has(unitRaw) ? unitRaw : unitRaw === 'feet' || unitRaw === 'foot' ? 'ft' : undefined
  const width = positiveNumber(r.width)
  const length = positiveNumber(r.length)
  const size = cleanText(r.size, 40) ?? undefined
  const service = cleanText(r.service, QUOTE_SERVICE_MAX) ?? undefined
  const quantity = positiveNumber(r.quantity ?? r.qty, 100)
  const price = dollarsToCents(r.price) ?? (typeof r.price_cents === 'number' && Number.isInteger(r.price_cents) && r.price_cents >= 0 ? r.price_cents : null)
  const description =
    cleanText(r.description ?? r.name ?? r.type, 200) ??
    (width && length ? 'Rug' : size ? 'Rug' : service ? service : null)
  if (!description) return null
  return {
    description,
    ...(service ? { service } : {}),
    ...(width ? { width } : {}),
    ...(length ? { length } : {}),
    ...(unit && (width || length) ? { unit } : width || length ? { unit: 'ft' } : {}),
    ...(size && !(width && length) ? { size } : {}),
    ...(quantity ? { quantity: Math.round(quantity) } : {}),
    ...(price !== null ? { price_cents: price } : {}),
  }
}

/** The items a form sent: its JSON array, else one from the flat size fields. */
function readItems(fields: Record<string, unknown>, service: string | null): QuoteItem[] {
  let list = first(fields, ['items', 'rugs', 'line_items'])
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      list = undefined
    }
  }
  if (Array.isArray(list)) {
    return list
      .slice(0, QUOTE_MAX_ITEMS)
      .map((item) => cleanItem(item && typeof item === 'object' && service && !(item as Record<string, unknown>).service ? { ...item, service } : item))
      .filter((i): i is QuoteItem => !!i)
  }
  const width = first(fields, ['width', 'width_ft', 'rug_width'])
  const length = first(fields, ['length', 'length_ft', 'rug_length'])
  const size = first(fields, ['size', 'rug_size', 'dimensions'])
  if (width === undefined && length === undefined && size === undefined) return []
  const item = cleanItem({ description: first(fields, ['item', 'rug_type']) ?? undefined, width, length, size, unit: first(fields, ['unit', 'units']), service: service ?? undefined, quantity: first(fields, ['quantity', 'count', 'rug_count']) })
  return item ? [item] : []
}

function readDates(fields: Record<string, unknown>): string[] {
  const raw = first(fields, ['requested_dates', 'requested_date', 'preferred_dates', 'preferred_date', 'pickup_date', 'date'])
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/\s*[;|]\s*/) : raw === undefined ? [] : [raw]
  return values
    .map((v) => cleanText(v, 60))
    .filter((v): v is string => !!v)
    .slice(0, QUOTE_REQUESTED_DATES_MAX)
}

function readEmail(value: unknown): string | null {
  const email = cleanText(value, QUOTE_EMAIL_MAX)?.toLowerCase() ?? null
  return email && /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i.test(email) ? email : null
}

function readName(fields: Record<string, unknown>): string | null {
  const full = cleanText(first(fields, ['name', 'full_name', 'fullName', 'Full Name', 'customer_name']), QUOTE_NAME_MAX)
  if (full) return full
  const joined = [cleanText(first(fields, ['first_name', 'firstName']), 60), cleanText(first(fields, ['last_name', 'lastName']), 60)].filter(Boolean).join(' ')
  return joined || null
}

function readAddress(fields: Record<string, unknown>): string | null {
  const whole = cleanText(first(fields, ['address', 'pickup_address', 'street_address']), QUOTE_ADDRESS_MAX)
  if (whole) return whole
  const parts = ['street', 'city', 'state', 'zip', 'zipcode', 'postal_code'].map((k) => cleanText(fields[k], 80)).filter(Boolean)
  return parts.length ? cleanText(parts.join(', '), QUOTE_ADDRESS_MAX) : null
}

/** The fields as posted, for the owner's record: strings only, clipped, honeypots left out. */
function rawFields(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(fields).slice(0, RAW_MAX_FIELDS)) {
    if (HONEYPOTS.includes(key)) continue
    const k = cleanText(key, 60)
    const v = typeof value === 'string' || typeof value === 'number' ? cleanText(value, RAW_VALUE_MAX, { multiline: true }) : Array.isArray(value) || (value && typeof value === 'object') ? cleanText(JSON.stringify(value), RAW_VALUE_MAX) : null
    if (k && v) out[k] = v
  }
  return out
}

/** Read one posted form (see the header). Pure. */
export function parseQuoteForm(input: unknown): ParseQuoteResult {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, reason: 'bad_body' }
  const fields = input as Record<string, unknown>
  if (HONEYPOTS.some((h) => typeof fields[h] === 'string' && (fields[h] as string).trim() !== '')) return { ok: false, reason: 'bot' }

  const customerEmail = readEmail(first(fields, ['email', 'Email', 'email_address']))
  const customerPhone = normalizeE164(first(fields, ['phone', 'phone_number', 'phoneNumber', 'Phone Number', 'tel', 'mobile']))
  if (!customerEmail && !customerPhone) return { ok: false, reason: 'no_contact' }

  const service = cleanText(first(fields, ['service', 'service_type', 'services']), QUOTE_SERVICE_MAX)
  const items = readItems(fields, service)
  const totalFromCents = typeof fields.total_cents === 'number' && Number.isInteger(fields.total_cents) && fields.total_cents >= 0 && fields.total_cents <= QUOTE_TOTAL_MAX_CENTS ? fields.total_cents : null
  const totalCents = totalFromCents ?? dollarsToCents(first(fields, ['total', 'price', 'estimated_price', 'estimate', 'quote']))
  const itemsTotal = items.every((i) => typeof i.price_cents === 'number') && items.length ? items.reduce((n, i) => n + (i.price_cents ?? 0) * (i.quantity ?? 1), 0) : null

  return {
    ok: true,
    quote: {
      // Only a form's own explicit submission id (a generic `id` could be anything, and guessable).
      externalId: cleanText(first(fields, ['submission_id', 'external_id']), QUOTE_EXTERNAL_ID_MAX),
      customerName: readName(fields),
      customerEmail,
      customerPhone,
      address: readAddress(fields),
      service,
      items,
      totalCents: totalCents ?? (itemsTotal !== null && itemsTotal <= QUOTE_TOTAL_MAX_CENTS ? itemsTotal : null),
      requestedDates: readDates(fields),
      notes: cleanText(first(fields, ['message', 'notes', 'details', 'description', 'comments', 'about']), QUOTE_NOTES_MAX, { multiline: true }),
      raw: rawFields(fields),
    },
  }
}

/** A form post's fields from its body: JSON, or form / multipart encoding (files ignored). */
export async function readFormBody(request: Request): Promise<Record<string, unknown> | null> {
  const type = (request.headers.get('content-type') ?? '').toLowerCase()
  const length = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(length) && length > QUOTE_BODY_MAX_BYTES) return null
  try {
    if (type.includes('application/json')) {
      const text = await request.text()
      if (text.length > QUOTE_BODY_MAX_BYTES) return null
      const json = JSON.parse(text) as unknown
      return json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : null
    }
    if (type.includes('application/x-www-form-urlencoded')) {
      const text = await request.text()
      if (text.length > QUOTE_BODY_MAX_BYTES) return null
      return Object.fromEntries(new URLSearchParams(text))
    }
    if (type.includes('multipart/form-data')) {
      const form = await request.formData()
      const out: Record<string, unknown> = {}
      for (const [key, value] of form.entries()) if (typeof value === 'string') out[key] = value.slice(0, RAW_VALUE_MAX * 4)
      return out
    }
  } catch {
    return null
  }
  return null
}
