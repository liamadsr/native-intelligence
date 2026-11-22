/**
 * Companies and contacts as CSV (migration 679's fields included), and a
 * companies CSV brought back in.
 *
 * Export writes what the caller's own client reads, so it is exactly what the
 * person can see: the contact and company row policies (058, 059, 493) decide,
 * as they do for the list. Every column a person or the import can set, the
 * company's stage, owner and revenue, then the workspace's custom fields by
 * label. Values are written to be read back: dates ISO, numbers raw, a
 * revenue as its amount and its code; a text a spreadsheet would run as a
 * formula is defused (tables/csv.ts safeText). Pipelines keep their own
 * export (/api/account/tables/[id]/export).
 *
 * Import maps a companies CSV's headers to the company's columns, its stage
 * (by name), owner (by name or email), revenue (an amount, with a currency
 * column or a symbol) and its custom fields (by label or key). Pure: the
 * route reads and writes.
 */
import { csvField, safeText } from '@/lib/tables/csv'
import {
  coerceCustomValue,
  formatFieldValue,
  type CurrencyValue,
  type CustomFieldType,
  type FieldShape,
} from '@/lib/crm/custom-field-types'
import { coerceRevenue, resolveStage, type CompanyStage } from '@/lib/crm/company-stages'

/** The most rows one export writes, and one import reads. */
export const CRM_EXPORT_MAX_ROWS = 10_000
export const CRM_IMPORT_MAX_ROWS = 2_000

export interface CsvCustomDef extends FieldShape {
  key: string
}

/** A custom value as the export writes it (read back by the import). */
export function exportCustomValue(def: Pick<CsvCustomDef, 'field_type'>, raw: unknown, labels: Readonly<Record<string, string>>): string {
  if (raw === null || raw === undefined || raw === '') return ''
  const t: CustomFieldType = def.field_type
  switch (t) {
    case 'number':
      return typeof raw === 'number' ? String(raw) : ''
    case 'date':
      return typeof raw === 'string' ? raw : ''
    case 'checkbox':
      return raw === true ? 'Yes' : raw === false ? 'No' : ''
    case 'currency': {
      const v = raw as Partial<CurrencyValue>
      return typeof v?.amount === 'number' && typeof v.currency === 'string' ? `${v.amount} ${v.currency}` : ''
    }
    default:
      return safeText(formatFieldValue(t, raw, { labels }))
  }
}

const text = (v: unknown): string => (v === null || v === undefined ? '' : safeText(String(v)))
const one = <T>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

export interface ExportCompanyRow {
  name: string
  domain?: string | null
  website?: string | null
  industry?: string | null
  employee_count_range?: string | null
  phone?: string | null
  contact_email?: string | null
  address?: string | null
  city?: string | null
  state?: string | null
  country?: string | null
  tags?: string[] | null
  created_at?: string | null
  revenue?: CurrencyValue | null
  stage?: { name?: string } | { name?: string }[] | null
  owner?: { display_name?: string } | { display_name?: string }[] | null
  last_interaction_at?: string | null
  custom_fields?: Record<string, unknown> | null
}

export const COMPANY_EXPORT_COLUMNS = [
  'Name', 'Domain', 'Website', 'Industry', 'Stage', 'Owner', 'Revenue', 'Revenue currency', 'Employee count',
  'Phone', 'Email', 'Address', 'City', 'State', 'Country', 'Tags', 'Last interaction', 'Created',
] as const

export function companiesCsv(rows: readonly ExportCompanyRow[], defs: readonly CsvCustomDef[], labels: Readonly<Record<string, string>>): string {
  const header = [...COMPANY_EXPORT_COLUMNS, ...defs.map((d) => d.label)]
  const lines = [header.map((h) => csvField(safeText(h))).join(',')]
  for (const r of rows) {
    const cells = [
      text(r.name), text(r.domain), text(r.website), text(r.industry),
      text(one(r.stage)?.name), text(one(r.owner)?.display_name),
      r.revenue && typeof r.revenue.amount === 'number' ? String(r.revenue.amount) : '', r.revenue?.currency ?? '',
      text(r.employee_count_range), text(r.phone), text(r.contact_email), text(r.address), text(r.city), text(r.state), text(r.country),
      text((r.tags ?? []).join('; ')), r.last_interaction_at ?? '', r.created_at ?? '',
      ...defs.map((d) => exportCustomValue(d, r.custom_fields?.[d.key], labels)),
    ]
    lines.push(cells.map(csvField).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export interface ExportContactRow {
  full_name: string
  email?: string | null
  phone?: string | null
  job_title?: string | null
  relationship_type?: string | null
  relationship_strength?: string | null
  last_interaction_at?: string | null
  tags?: string[] | null
  created_at?: string | null
  company?: { name?: string; domain?: string | null } | { name?: string; domain?: string | null }[] | null
  custom_fields?: Record<string, unknown> | null
}

export const CONTACT_EXPORT_COLUMNS = [
  'Name', 'Email', 'Phone', 'Job title', 'Company', 'Company domain', 'Relationship', 'Strength', 'Tags', 'Last interaction', 'Created',
] as const

export function contactsCsv(rows: readonly ExportContactRow[], defs: readonly CsvCustomDef[], labels: Readonly<Record<string, string>>): string {
  const header = [...CONTACT_EXPORT_COLUMNS, ...defs.map((d) => d.label)]
  const lines = [header.map((h) => csvField(safeText(h))).join(',')]
  for (const r of rows) {
    const co = one(r.company)
    const cells = [
      text(r.full_name), text(r.email), text(r.phone), text(r.job_title), text(co?.name), text(co?.domain),
      text(r.relationship_type), text(r.relationship_strength), text((r.tags ?? []).join('; ')),
      r.last_interaction_at ?? '', r.created_at ?? '',
      ...defs.map((d) => exportCustomValue(d, r.custom_fields?.[d.key], labels)),
    ]
    lines.push(cells.map(csvField).join(','))
  }
  return `${lines.join('\r\n')}\r\n`
}

export function crmExportFileName(kind: 'company' | 'contact', now = new Date()): string {
  return `${kind === 'company' ? 'Companies' : 'Contacts'} ${now.toISOString().slice(0, 10)}.csv`
}

// ── Import: a companies CSV ────────────────────────────────────────────────

export type CompanyImportTarget =
  | 'name' | 'domain' | 'website' | 'industry' | 'description' | 'employee_count_range' | 'phone' | 'contact_email'
  | 'address' | 'city' | 'state' | 'country' | 'tags' | 'stage' | 'owner' | 'revenue' | 'revenue_currency'

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

/** Header words → the company field they fill (an export's own headers come back to the same place). */
const HEADER_TARGETS: Record<string, CompanyImportTarget> = {
  name: 'name', company: 'name', 'company name': 'name', account: 'name', 'account name': 'name', organization: 'name', organisation: 'name',
  domain: 'domain', 'company domain': 'domain', website: 'website', url: 'website', 'web site': 'website',
  industry: 'industry', description: 'description', about: 'description',
  'employee count': 'employee_count_range', employees: 'employee_count_range', size: 'employee_count_range', 'company size': 'employee_count_range',
  phone: 'phone', 'phone number': 'phone', email: 'contact_email', 'contact email': 'contact_email',
  address: 'address', street: 'address', city: 'city', state: 'state', region: 'state', country: 'country', tags: 'tags', labels: 'tags',
  stage: 'stage', 'lifecycle stage': 'stage', lifecycle: 'stage', 'company stage': 'stage', status: 'stage',
  owner: 'owner', 'account owner': 'owner', 'company owner': 'owner',
  revenue: 'revenue', 'annual revenue': 'revenue', arr: 'revenue', 'revenue amount': 'revenue',
  'revenue currency': 'revenue_currency', currency: 'revenue_currency',
}

export type CompanyColumnMap = Array<{ index: number; header: string } & ({ kind: 'field'; target: CompanyImportTarget } | { kind: 'custom'; key: string } | { kind: 'skip' })>

/** Each header's place: a company field, a custom field (by label or key), or nothing. */
export function mapCompanyHeaders(headers: readonly string[], defs: readonly CsvCustomDef[]): CompanyColumnMap {
  const used = new Set<string>()
  return headers.map((header, index) => {
    const n = norm(header)
    const target = HEADER_TARGETS[n]
    if (target && !used.has(target)) {
      used.add(target)
      return { index, header, kind: 'field' as const, target }
    }
    const def = defs.find((d) => norm(d.label) === n || d.key === n.replace(/ /g, '_'))
    if (def && !used.has(`custom:${def.key}`)) {
      used.add(`custom:${def.key}`)
      return { index, header, kind: 'custom' as const, key: def.key }
    }
    return { index, header, kind: 'skip' as const }
  })
}

export interface ImportMember {
  id: string
  display_name: string | null
  email?: string | null
}

export interface PlannedCompany {
  line: number
  /** The base columns as the CSV gives them (empty cells left out). */
  fields: Record<string, string | string[]>
  stage_id?: string | null
  owner_member_id?: string | null
  revenue?: CurrencyValue | null
  custom_fields: Record<string, unknown>
}

export interface CompanyImportPlan {
  companies: PlannedCompany[]
  /** Rows left out, each with why (a line number as a spreadsheet counts it, the header being 1). */
  skipped: Array<{ line: number; reason: string }>
  /** Cells that couldn't be read (the rest of the row came in). */
  warnings: Array<{ line: number; column: string; reason: string }>
  columns: CompanyColumnMap
}

const EMPLOYEE_RANGES = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+']

/** One cell's employee range: a range as written, or a headcount placed in its range. */
function employeeRange(raw: string): string | null {
  const s = raw.replace(/\s/g, '')
  if (EMPLOYEE_RANGES.includes(s)) return s
  const n = Number(s.replace(/[,+]/g, ''))
  if (!Number.isFinite(n) || n <= 0) return null
  return n <= 10 ? '1-10' : n <= 50 ? '11-50' : n <= 200 ? '51-200' : n <= 500 ? '201-500' : n <= 1000 ? '501-1000' : '1000+'
}

/** A CSV's rows as companies to bring in: every cell checked, nothing written. */
export function planCompanyImport(
  sheet: { headers: string[]; rows: string[][] },
  ctx: { stages: readonly CompanyStage[]; members: readonly ImportMember[]; defs: readonly CsvCustomDef[] },
): CompanyImportPlan {
  const columns = mapCompanyHeaders(sheet.headers, ctx.defs)
  const plan: CompanyImportPlan = { companies: [], skipped: [], warnings: [], columns }
  if (!columns.some((c) => c.kind === 'field' && c.target === 'name')) {
    plan.skipped.push({ line: 1, reason: 'No Name (or Company) column.' })
    return plan
  }
  const currencyCol = columns.find((c) => c.kind === 'field' && c.target === 'revenue_currency')
  sheet.rows.slice(0, CRM_IMPORT_MAX_ROWS).forEach((row, i) => {
    const line = i + 2
    if (row.every((c) => !c || !c.trim())) return
    const out: PlannedCompany = { line, fields: {}, custom_fields: {} }
    for (const col of columns) {
      const raw = (row[col.index] ?? '').trim()
      if (col.kind === 'skip' || !raw) continue
      if (col.kind === 'custom') {
        const def = ctx.defs.find((d) => d.key === col.key)!
        // An export's currency reads "1200 USD"; checkboxes Yes/No.
        const r = coerceCustomValue(def, raw)
        if (r.ok) out.custom_fields[col.key] = r.value
        else plan.warnings.push({ line, column: col.header, reason: r.error })
        continue
      }
      switch (col.target) {
        case 'revenue_currency':
          break
        case 'stage': {
          const s = resolveStage(ctx.stages, raw)
          if (s === undefined) plan.warnings.push({ line, column: col.header, reason: `No company stage named “${raw}”.` })
          else out.stage_id = s?.id ?? null
          break
        }
        case 'owner': {
          const lower = raw.toLowerCase()
          const m = ctx.members.find((x) => x.id === raw || (x.email ?? '').toLowerCase() === lower || (x.display_name ?? '').toLowerCase() === lower)
          if (m) out.owner_member_id = m.id
          else plan.warnings.push({ line, column: col.header, reason: `No workspace member named “${raw}”.` })
          break
        }
        case 'revenue': {
          const code = currencyCol ? (row[currencyCol.index] ?? '').trim().toUpperCase() : ''
          const r = coerceRevenue(/^[A-Z]{3}$/.test(code) && !/[A-Za-z]{3}/.test(raw) ? `${raw} ${code}` : raw)
          if (r.ok) out.revenue = r.value
          else plan.warnings.push({ line, column: col.header, reason: r.error })
          break
        }
        case 'employee_count_range': {
          const r = employeeRange(raw)
          if (r) out.fields.employee_count_range = r
          else plan.warnings.push({ line, column: col.header, reason: `Employee count is one of ${EMPLOYEE_RANGES.join(', ')} or a number.` })
          break
        }
        case 'tags':
          out.fields.tags = raw.split(/[;,]/).map((t) => t.trim()).filter(Boolean).slice(0, 50)
          break
        case 'domain': {
          const d = raw.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]
          if (d) out.fields.domain = d
          break
        }
        case 'contact_email':
          out.fields.contact_email = raw.toLowerCase()
          break
        default:
          out.fields[col.target] = raw.slice(0, 2000)
      }
    }
    if (!out.fields.name) {
      plan.skipped.push({ line, reason: 'No name.' })
      return
    }
    plan.companies.push(out)
  })
  if (sheet.rows.length > CRM_IMPORT_MAX_ROWS) plan.skipped.push({ line: CRM_IMPORT_MAX_ROWS + 2, reason: `Only the first ${CRM_IMPORT_MAX_ROWS} rows are read.` })
  return plan
}
