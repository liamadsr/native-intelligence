/**
 * Spreadsheets as import records (roadmap track G1): a CSV (any delimiter a
 * spreadsheet app writes), an Excel workbook (.xlsx, its first sheet), or the
 * export of any tool that writes either. Pure, apart from unzipping.
 *
 *   read     {@link parseCsv} / {@link readXlsx} → a header row and rows.
 *   map      {@link autoMapColumns}: each header to a field it plainly is
 *            ("Phone", "Cell", "Mobile #" → phone), or unmapped. The agent asks
 *            the owner only about the unmapped ones, then passes their answers
 *            as overrides ("Rug type" → note, "Sq ft" → skip). The export of a
 *            tool it knows (QuickBooks, Stripe, Square…: ./export-layouts.ts)
 *            maps every column itself, so nothing is asked.
 *   records  {@link rowsToRecords}: one contact per row. A row's job, date and
 *            amount become a past job on the timeline; an invoice export with
 *            a row per invoice folds into one contact per customer (the
 *            importer sees the repeats).
 */
import JSZip from 'jszip'
import {
  cleanText,
  formatAddress,
  normalizeDate,
  parseMoneyCents,
  splitTags,
  UNSUBSCRIBED_EMAIL_TAG,
  type ImportContactRecord,
  type ImportPastJob,
  type ImportRelationship,
} from '../record'

/** The fields a column can feed. `note` keeps the column as "Header: value" in notes; `skip` drops it. */
export const COLUMN_TARGETS = [
  'full_name',
  'first_name',
  'last_name',
  'email',
  'phone',
  'address',
  'street',
  'street2',
  'city',
  'state',
  'postal_code',
  'country',
  'company',
  'job_title',
  'tags',
  'notes',
  'last_contact',
  'job',
  'job_date',
  'amount',
  'relationship',
  /** The name a tool shows them by: their name when no other column has one, else their company when it names someone else. */
  'display_name',
  /** What they have spent or bought in all (a total, a count): kept in notes; above zero, they are a customer. */
  'spend',
  /** Says they unsubscribed from email (a yes, a date, "Unsubscribed"): never emailed by outreach. */
  'email_opt_out',
  'note',
  'skip',
] as const
export type ColumnTarget = (typeof COLUMN_TARGETS)[number]

/**
 * What a column can map to: a field, or (only from a recognised export's
 * layout, never an answer) the app's own id for the row, which links the
 * contact so a second import of the same app finds it (a plain spreadsheet's
 * "ID" column names nothing outside that one file), a yes/no column that
 * says the row is a lead, or one line of an address written over several
 * columns (QuickBooks Desktop's "Bill to 1" to "Bill to 5", where a line may
 * be the customer's own name).
 */
export type MappedTarget = ColumnTarget | 'external_id' | 'lead_flag' | 'address_line'

export function isColumnTarget(value: unknown): value is ColumnTarget {
  return typeof value === 'string' && (COLUMN_TARGETS as readonly string[]).includes(value)
}

/** The most rows one file imports. */
export const MAX_SHEET_ROWS = 20_000
/** The most columns read. */
const MAX_COLUMNS = 60

export interface Sheet {
  headers: string[]
  rows: string[][]
  /** More rows than MAX_SHEET_ROWS: the rest were left out. */
  truncated?: boolean
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** The delimiter a CSV uses: the one that splits its first line most (comma, semicolon, tab, pipe). */
export function detectDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? ''
  let best = ','
  let bestCount = 0
  for (const d of [',', ';', '\t', '|']) {
    // Count outside quotes.
    let count = 0
    let quoted = false
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted
      else if (ch === d && !quoted) count++
    }
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

/** RFC 4180 CSV: quoted fields, doubled quotes, line breaks inside quotes. Blank lines are dropped. */
export function parseCsv(input: string, delimiter = detectDelimiter(input)): Sheet {
  const text = input.replace(/^﻿/, '')
  const records: string[][] = []
  let field = ''
  let row: string[] = []
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') quoted = true
    else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(field)
      field = ''
      if (row.some((c) => c.trim() !== '')) records.push(row)
      row = []
      if (records.length > MAX_SHEET_ROWS + 1) break
    } else field += ch
  }
  row.push(field)
  if (row.some((c) => c.trim() !== '')) records.push(row)
  return toSheet(records)
}

/** The rows above a header a report export may have (its title, the business, the dates). */
const MAX_TITLE_ROWS = 10

/** How many of a row's cells name a field. */
function headerScore(row: string[]): number {
  return row.filter((cell) => cell.trim() && targetForHeader(cell) !== null).length
}

/**
 * The header row: the first row, unless a report's title rows sit above it
 * (QuickBooks: "Customer Contact List", the business, "All Dates"). Then it is
 * the row that names the most fields, when every row above it has at most two
 * cells: a row with more is data or the header itself, never a title.
 */
export function headerRowIndex(records: string[][]): number {
  let best = 0
  let bestScore = records.length ? headerScore(records[0]) : 0
  for (let i = 0; i < Math.min(records.length, MAX_TITLE_ROWS); i++) {
    if (records[i].filter((c) => c.trim()).length > 2) {
      const score = headerScore(records[i])
      if (score > bestScore && score >= 2) best = i
      break
    }
  }
  return best
}

function toSheet(all: string[][]): Sheet {
  const records = all.slice(headerRowIndex(all))
  const [head = [], ...rest] = records
  const width = Math.min(Math.max(head.length, ...rest.slice(0, 50).map((r) => r.length)), MAX_COLUMNS)
  const headers = Array.from({ length: width }, (_, i) => cleanText(head[i], 120) ?? `Column ${i + 1}`)
  const rows = rest.slice(0, MAX_SHEET_ROWS).map((r) => Array.from({ length: width }, (_, i) => (r[i] ?? '').trim()))
  return rest.length > MAX_SHEET_ROWS ? { headers, rows, truncated: true } : { headers, rows }
}

// ---------------------------------------------------------------------------
// XLSX (the first sheet)
// ---------------------------------------------------------------------------

function xmlText(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&')
}

/** "AB12" → column index 27. */
function columnIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64)
  return n - 1
}

/** The zip's parts are capped: a crafted workbook can deflate a thousand to one. */
const MAX_PART_CHARS = 40_000_000

async function part(zip: JSZip, path: string): Promise<string | null> {
  const file = zip.file(path)
  if (!file) return null
  const declared = (file as unknown as { _data?: { uncompressedSize?: number } })._data?.uncompressedSize
  if (typeof declared === 'number' && declared > MAX_PART_CHARS) throw new Error('This workbook is too large to read.')
  const text = await file.async('string')
  if (text.length > MAX_PART_CHARS) throw new Error('This workbook is too large to read.')
  return text
}

/**
 * The first worksheet of an .xlsx as a sheet. Dates come back as Excel's day
 * numbers (a date column reads them through normalizeDate). The old binary
 * .xls is not read: the agent asks for a CSV or .xlsx instead.
 */
export async function readXlsx(bytes: Uint8Array): Promise<Sheet> {
  const zip = await JSZip.loadAsync(bytes)
  const shared: string[] = []
  const sst = await part(zip, 'xl/sharedStrings.xml')
  if (sst) for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText([...m[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')))

  // The first sheet in the workbook's own order.
  let sheetPath = 'xl/worksheets/sheet1.xml'
  const workbook = await part(zip, 'xl/workbook.xml')
  const rels = await part(zip, 'xl/_rels/workbook.xml.rels')
  const firstRid = workbook ? /<sheet\b[^>]*\br:id="([^"]+)"/.exec(workbook)?.[1] : null
  if (firstRid && rels) {
    const target = new RegExp(`<Relationship\\b[^>]*\\bId="${firstRid}"[^>]*\\bTarget="([^"]+)"`).exec(rels)?.[1] ??
      new RegExp(`<Relationship\\b[^>]*\\bTarget="([^"]+)"[^>]*\\bId="${firstRid}"`).exec(rels)?.[1]
    if (target) sheetPath = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`
  }
  const sheet = await part(zip, sheetPath)
  if (!sheet) throw new Error('This workbook has no sheet to read.')

  const records: string[][] = []
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row: string[] = []
    for (const c of rowMatch[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]
      const body = c[2] ?? ''
      const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1]
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const index = ref ? columnIndex(ref) : row.length
      if (index >= MAX_COLUMNS) continue
      let value = ''
      if (type === 'inlineStr') value = xmlText(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '')
      else {
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1]
        if (v !== undefined) value = type === 's' ? (shared[Number(v)] ?? '') : type === 'b' ? (v === '1' ? 'TRUE' : 'FALSE') : xmlText(v)
      }
      while (row.length < index) row.push('')
      row[index] = value
    }
    if (row.some((cell) => cell.trim() !== '')) records.push(row)
    if (records.length > MAX_SHEET_ROWS + 1) break
  }
  return toSheet(records)
}

// ---------------------------------------------------------------------------
// Column mapping
// ---------------------------------------------------------------------------

const SYNONYMS: Array<[ColumnTarget, string[]]> = [
  ['email', ['email', 'emailaddress', 'mail', 'primaryemail', 'email1', 'email2', 'email3', 'secondaryemail', 'otheremail', 'workemail', 'homeemail', 'personalemail', 'emails', 'emailaddresses', 'customeremail', 'clientemail', 'contactemail']],
  ['phone', ['phone', 'phonenumber', 'phone1', 'phone2', 'mobile', 'mobilephone', 'mobilenumber', 'cell', 'cellphone', 'cellnumber', 'tel', 'telephone', 'homephone', 'workphone', 'primaryphone', 'otherphone', 'sms', 'contactnumber', 'customerphone', 'clientphone', 'whatsapp', 'phones']],
  ['first_name', ['first', 'firstname', 'givenname', 'fname', 'forename']],
  ['last_name', ['last', 'lastname', 'surname', 'familyname', 'lname']],
  ['full_name', ['name', 'fullname', 'customer', 'customername', 'client', 'clientname', 'contact', 'contactname', 'displayname', 'person', 'yourname', 'nameofcustomer']],
  ['address', ['address', 'fulladdress', 'streetaddress', 'mailingaddress', 'homeaddress', 'billingaddress', 'serviceaddress', 'shippingaddress', 'pickupaddress', 'location']],
  ['street', ['street', 'address1', 'addressline1', 'street1', 'streetline1', 'billingstreet', 'billingaddress1', 'shippingaddress1']],
  ['street2', ['address2', 'addressline2', 'street2', 'apt', 'apartment', 'suite', 'unit', 'aptsuite']],
  ['city', ['city', 'town', 'billingcity', 'shippingcity', 'locality']],
  ['state', ['state', 'province', 'region', 'st', 'stateprovince', 'billingstate', 'shippingstate', 'county']],
  ['postal_code', ['zip', 'zipcode', 'postalcode', 'postcode', 'postal', 'billingzip', 'shippingzip', 'billingpostalcode']],
  ['country', ['country', 'countryregion', 'billingcountry', 'shippingcountry']],
  ['company', ['company', 'companyname', 'organization', 'organisation', 'org', 'business', 'businessname', 'employer', 'account', 'accountname']],
  ['job_title', ['title', 'jobtitle', 'position', 'role', 'occupation']],
  ['tags', ['tags', 'tag', 'labels', 'label', 'groups', 'group', 'category', 'categories', 'segment', 'segments', 'lists', 'list']],
  ['notes', ['notes', 'note', 'comments', 'comment', 'description', 'remarks', 'memo', 'details', 'customernotes', 'internalnotes']],
  ['last_contact', ['lastcontact', 'lastcontacted', 'lastcontactdate', 'lastvisit', 'lastvisitdate', 'lastservice', 'lastservicedate', 'lastjobdate', 'lastorder', 'lastorderdate', 'lastpurchase', 'lastpurchasedate', 'lastappointment', 'lastactivity', 'lastactivitydate', 'lastseen', 'lastcleaning', 'lastcleaningdate', 'lastinvoicedate', 'lastbooking', 'lastinteraction', 'lastinteractiondate']],
  ['job', ['service', 'services', 'job', 'jobdescription', 'servicetype', 'servicedescription', 'work', 'workdone', 'item', 'items', 'product', 'products', 'order', 'orderdescription', 'lastjob', 'lastjobdescription', 'description of work', 'invoicedescription', 'lineitem', 'lineitems']],
  ['job_date', ['date', 'jobdate', 'servicedate', 'invoicedate', 'orderdate', 'appointmentdate', 'visitdate', 'bookingdate', 'completeddate', 'datecompleted', 'pickupdate', 'deliverydate']],
  ['amount', ['amount', 'total', 'price', 'invoicetotal', 'invoiceamount', 'jobtotal', 'ordertotal', 'revenue', 'totalspent', 'spent', 'paid', 'amountpaid', 'value', 'cost', 'charge', 'subtotal', 'grandtotal', 'lifetimevalue', 'totalsales']],
  ['relationship', ['status', 'type', 'lifecyclestage', 'stage', 'customertype', 'relationship', 'contacttype', 'leadstatus']],
]

const SYNONYM_INDEX = new Map<string, ColumnTarget>()
for (const [target, words] of SYNONYMS) for (const w of words) if (!SYNONYM_INDEX.has(w.replace(/\s+/g, ''))) SYNONYM_INDEX.set(w.replace(/\s+/g, ''), target)

/** Header endings that name one field whatever comes before them, longest first. */
const SUFFIXES: Array<[string, ColumnTarget]> = [
  ['phonenumber', 'phone'],
  ['mobilenumber', 'phone'],
  ['emailaddress', 'email'],
  ['postalcode', 'postal_code'],
  ['firstname', 'first_name'],
  ['lastname', 'last_name'],
  ['fullname', 'full_name'],
  ['address', 'address'],
  ['zipcode', 'postal_code'],
  ['company', 'company'],
  ['country', 'country'],
  ['mobile', 'phone'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['notes', 'notes'],
  ['city', 'city'],
  ['tags', 'tags'],
  ['zip', 'postal_code'],
]

/** A header as the synonyms compare it: lowercase letters and digits only ("E-mail Address" → "emailaddress"). */
export function headerKey(header: string): string {
  return header
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/#/g, 'number')
    .replace(/[^a-z0-9]/g, '')
}

/** The field a header plainly is, or null. */
export function targetForHeader(header: string): ColumnTarget | null {
  const key = headerKey(header)
  if (!key) return null
  const exact = SYNONYM_INDEX.get(key)
  if (exact) return exact
  // "Customer Email", "Mobile Phone Number", "Home Address": a header that ends in a word only one field uses.
  // Generic words ("type", "date", "total", "name") don't count this way: "Rug Type" is asked about.
  for (const [suffix, target] of SUFFIXES) if (key.endsWith(suffix)) return target
  if (/email/.test(key)) return 'email'
  if (/phone|mobile/.test(key)) return 'phone'
  return null
}

export interface ColumnMapping {
  header: string
  /** How a note line names the column, when not by its header (a recognised export's prefix off). */
  label?: string
  target: MappedTarget | null
  /** A few non-empty values from the column, to show the owner when asking. */
  samples: string[]
}

/** What a recognised export knows about its own columns (./export-layouts.ts). */
export interface LayoutColumns {
  /** The field of a column the export is known to have, or null when it isn't one of them. */
  target(header: string): MappedTarget | null
  /** A column it doesn't know that no field's name fits (a custom field): kept in notes, never asked about. */
  rest: 'note' | 'skip'
  /** How a note line names a column, when not by its header. */
  label?: (header: string) => string
  /** A field's value as the app writes it, read plain (Jobber's "client_property" id → the client's). */
  cell?: Partial<Record<MappedTarget, (value: string) => string>>
}

/**
 * Each column's field, as far as its header says. Overrides win: keyed by the
 * column's number ("#3", counting from 1) or its header (case-insensitive).
 * Then a recognised export's own columns, then the field a header plainly
 * names; a recognised export leaves nothing unmapped.
 */
export function autoMapColumns(sheet: Sheet, overrides: Record<string, string> = {}, layout: LayoutColumns | null = null): ColumnMapping[] {
  const byKey = new Map(Object.entries(overrides).filter(([h]) => !/^#\d+$/.test(h)).map(([h, t]) => [headerKey(h), t]))
  const mappings = sheet.headers.map((header, i) => {
    const override = overrides[`#${i + 1}`] ?? byKey.get(headerKey(header))
    const target: MappedTarget | null =
      override !== undefined && isColumnTarget(override) ? override : (layout?.target(header) ?? targetForHeader(header) ?? layout?.rest ?? null)
    const samples: string[] = []
    for (const row of sheet.rows) {
      const v = cleanText(row[i], 60)
      if (v && !samples.includes(v)) samples.push(v)
      if (samples.length >= 3) break
    }
    const label = layout?.label?.(header)
    return label && label !== header ? { header, label, target, samples } : { header, target, samples }
  })
  // An empty column needs no question.
  for (const m of mappings) if (m.target === null && m.samples.length === 0) m.target = 'skip'
  return mappings
}

/** The columns the agent must ask the owner about. */
export function unmappedColumns(mappings: ColumnMapping[]): ColumnMapping[] {
  return mappings.filter((m) => m.target === null)
}

// ---------------------------------------------------------------------------
// Rows → records
// ---------------------------------------------------------------------------

/** "Customer", "Client", "Won" → customer; "Lead", "Prospect" → lead. */
export function relationshipFromCell(value: string | null): ImportRelationship | null {
  if (!value) return null
  const v = value.toLowerCase()
  if (/\b(customer|client|won|closed won|active|repeat|regular|member)\b/.test(v)) return 'customer'
  if (/\b(lead|prospect|opportunity|new|inquiry|enquiry|quote)\b/.test(v)) return 'lead'
  return null
}

/**
 * The numbers in a phone cell: one, several ("626-555-0101; 626-555-0102"),
 * or labelled ("Phone: (626) 555-0101 Mobile: (626) 555-0102", as QuickBooks
 * writes them). A fax number is not a phone.
 */
export function splitPhones(value: string): string[] {
  const parts = value.split(/([A-Za-z][A-Za-z. ]{0,20}):\s*/)
  const numbers = parts[0].trim() ? [parts[0]] : []
  for (let i = 1; i < parts.length; i += 2) if (!/fax/i.test(parts[i])) numbers.push(parts[i + 1] ?? '')
  return numbers.flatMap((v) => v.split(/[;,/]|\s{2,}/)).map((v) => v.trim()).filter(Boolean)
}

/** An address cell on one line: its lines or double-spaced parts (Mailchimp's "12 Elm St  Pasadena  CA  91101  US") become commas. */
export function addressFromCell(value: string): string | null {
  const parts = value.split(/\s*\n\s*| {2,}|\t/)
  return parts.length > 1 ? formatAddress(parts) : cleanText(value, 300)
}

/**
 * A cell that says they unsubscribed from email: yes or true (an
 * "Unsubscribed" column), "Unsubscribed" or "Opted out" (a status), "No
 * consent", or a date (when they left: Mailchimp's UNSUB_TIME). "Subscribed",
 * "No", "Not subscribed" and blanks are not.
 */
export function isEmailOptOut(value: string | null | undefined): boolean {
  const v = (value ?? '').trim().toLowerCase()
  if (!v || /^(false|no|n|0|subscribed|opted ?in|active|pending|unknown|none|n\/a|-)$/.test(v) || /^not\b/.test(v)) return false
  if (/unsub|opt(?:ed)?[ -]?out|no consent|do not|cleaned|bounced|^(true|yes|y|1)$/.test(v)) return true
  return normalizeDate(v) !== null
}

/** Words two names share ("Ruiz, Ana" and "Ana Ruiz" do; "Fernhill Cleaning" and "Ana Ruiz" don't). */
function sharesWord(a: string, b: string): boolean {
  const words = (s: string) => new Set(s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1))
  const left = words(a)
  return [...words(b)].some((w) => left.has(w))
}

/** "0", "0.00", "$0.00": a total that says nothing. */
const ZERO = /^[$€£]?\s*0+(?:[.,]0+)?\s*[$€£]?$/

/**
 * One contact per row. Unmapped columns (target null) are left out: the agent
 * asks about them first. `relationship` is the file's default (most files an
 * owner sends at signup are their customers); a row with a past job, or one
 * that spent something, is a customer either way, and one whose spend is all
 * zero is a lead. `skipRow` drops a row before it is read (a report's totals
 * line).
 */
export function rowsToRecords(
  sheet: Sheet,
  mappings: ColumnMapping[],
  opts: { relationship?: ImportRelationship; nowMs?: number; skipRow?: (row: string[]) => boolean; cell?: LayoutColumns['cell'] } = {},
): ImportContactRecord[] {
  const nowMs = opts.nowMs ?? Date.now()
  const rows = opts.skipRow ? sheet.rows.filter((row) => !opts.skipRow!(row)) : sheet.rows
  return rows.map((row) => {
    const values = (target: MappedTarget) =>
      mappings
        .flatMap((m, i) => (m.target === target ? [row[i] ?? ''] : []))
        .map((v) => (opts.cell?.[target] ? opts.cell[target]!(v.trim()) : v).trim())
        .filter(Boolean)
    const first = (target: MappedTarget) => values(target)[0] ?? null
    const lines = (target: MappedTarget) =>
      mappings.flatMap((m, i) => {
        const v = cleanText(row[i], 500)
        return m.target === target && v && !ZERO.test(v) ? [`${m.label ?? m.header}: ${v}`] : []
      })

    const emails = values('email').flatMap((v) => v.split(/[;,\s]+/))
    const phones = values('phone').flatMap(splitPhones)
    // An address line that only repeats who they are ("Bill to 1": "Ana Ruiz") is not an address.
    const names = new Set([...values('full_name'), ...values('display_name'), ...values('company'), [first('first_name'), first('last_name')].filter(Boolean).join(' ')].map((n) => n.toLowerCase()))
    const addressLines = values('address_line').filter((line) => !names.has(line.toLowerCase()))
    const fullAddress = first('address')
    const address = fullAddress
      ? addressFromCell(fullAddress)
      : addressLines.length
        ? formatAddress(addressLines)
        : formatAddress([values('street').join(' '), first('street2'), first('city'), first('state'), first('postal_code'), first('country')])
    const spends = values('spend')
    const spent = spends.some((v) => (parseMoneyCents(v) ?? 0) > 0)
    // Every spend column there and zero: they never bought (a quote, an abandoned checkout), so not a customer.
    const neverBought = spends.length > 0 && spends.length === mappings.filter((m) => m.target === 'spend').length && spends.every((v) => ZERO.test(v))
    const noteLines = [...values('notes'), ...lines('note'), ...lines('spend')]
    const job = first('job')
    const jobDate = first('job_date')
    const amountCents = parseMoneyCents(first('amount'))
    const history: ImportPastJob[] = []
    if (job || amountCents !== null) {
      history.push({
        kind: job ? 'job' : 'invoice',
        title: job ?? 'Invoice',
        occurredAt: normalizeDate(jobDate, nowMs) ?? normalizeDate(first('last_contact'), nowMs),
        amountCents,
        currency: null,
      })
    }
    const lastContacts = values('last_contact').map((v) => normalizeDate(v, nowMs)).filter((d): d is string => !!d)
    const lastContact = lastContacts.length ? lastContacts.reduce((a, b) => (a > b ? a : b)) : history.length ? null : normalizeDate(jobDate, nowMs)
    const lead = values('lead_flag').some((v) => /^(true|yes|y|1|lead)$/i.test(v))
    const relationship =
      relationshipFromCell(first('relationship')) ?? (history.length || spent ? 'customer' : lead || neverBought ? 'lead' : (opts.relationship ?? null))

    // A tool's display name is the person when nothing else names them, else
    // their business when it names someone else ("Fernhill Cleaning" for Ana Ruiz).
    let fullName = first('full_name')
    let companyName = first('company')
    const display = first('display_name')
    const personName = fullName ?? ([first('first_name'), first('last_name')].filter(Boolean).join(' ') || null)
    if (display && !personName) fullName = display
    else if (display && personName && !companyName && !sharesWord(display, personName)) companyName = display

    const tags = values('tags').flatMap(splitTags)
    if (values('email_opt_out').some(isEmailOptOut)) tags.push(UNSUBSCRIBED_EMAIL_TAG)
    return {
      kind: 'contact' as const,
      externalId: first('external_id'),
      fullName,
      firstName: first('first_name'),
      lastName: first('last_name'),
      emails,
      phones,
      address,
      company: companyName ? { name: companyName } : null,
      jobTitle: first('job_title'),
      tags,
      notes: noteLines.length ? noteLines.join('\n') : null,
      history,
      lastContactAt: lastContact,
      relationship,
    }
  })
}
