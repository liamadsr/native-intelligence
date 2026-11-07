/**
 * An import's counts and the one text the agent sends when it ends
 * (roadmap track G): "412 customers imported from HubSpot: 37 matched ones
 * you had, 3 to check." Pure.
 */
import { IMPORT_SOURCE_LABEL, type ImportSource } from './record'

/** What an import did, by outcome (contact_import_item.outcome). */
export interface ImportCounts {
  /** New contacts. */
  created: number
  /** Matched a contact the workspace already had (filled in what was missing). */
  matched: number
  /** The same person twice in the source: folded into the first. */
  repeat: number
  /** New contacts that may be someone already there: to check. */
  review: number
  /** Matched, with nothing new to add. */
  unchanged: number
  /** Rows that named nobody (no name, email or phone). */
  skipped: number
  failed: number
  companiesCreated: number
  companiesMatched: number
  /** Past jobs and invoices added to timelines. */
  history: number
  /** How many of the contacts are customers. */
  customers: number
}

export function emptyCounts(): ImportCounts {
  return { created: 0, matched: 0, repeat: 0, review: 0, unchanged: 0, skipped: 0, failed: 0, companiesCreated: 0, companiesMatched: 0, history: 0, customers: 0 }
}

/** Counts read back from a stored jsonb (missing keys are 0). */
export function readCounts(value: unknown): ImportCounts {
  const out = emptyCounts()
  if (!value || typeof value !== 'object') return out
  for (const key of Object.keys(out) as Array<keyof ImportCounts>) {
    const n = (value as Record<string, unknown>)[key]
    if (typeof n === 'number' && Number.isFinite(n)) out[key] = n
  }
  return out
}

export function addCounts(a: ImportCounts, b: Partial<ImportCounts>): ImportCounts {
  const out = { ...a }
  for (const key of Object.keys(out) as Array<keyof ImportCounts>) out[key] += b[key] ?? 0
  return out
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`
}

/** The people an import brought in: new, matched and to-check ones (a repeat is one of them). */
export function importedPeople(counts: ImportCounts): number {
  return counts.created + counts.matched + counts.unchanged + counts.review
}

/**
 * The summary the owner reads: how many came in, how many were already
 * there, how many to check, and how to undo it. "customers" when most of
 * them are customers, else "contacts".
 */
export function importSummaryText(args: { source: ImportSource; counts: ImportCounts; label?: string | null }): string {
  const { counts } = args
  const people = importedPeople(counts)
  const from = args.source === 'spreadsheet' && args.label ? args.label : IMPORT_SOURCE_LABEL[args.source]
  if (people === 0 && counts.companiesCreated + counts.companiesMatched === 0) {
    const why = counts.skipped > 0 ? ` ${plural(counts.skipped, 'row')} had no name, email or phone.` : ''
    return `Nothing to import from ${from}.${why}`
  }
  const noun = counts.customers * 2 >= people && people > 0 ? 'customer' : 'contact'
  const head = people > 0 ? `${plural(people, noun)} imported from ${from}` : `${plural(counts.companiesCreated + counts.companiesMatched, 'company', 'companies')} imported from ${from}`
  const parts: string[] = []
  const had = counts.matched + counts.unchanged
  if (had > 0) parts.push(`${had.toLocaleString('en-US')} matched ones you had`)
  if (counts.review > 0) parts.push(`${counts.review.toLocaleString('en-US')} to check`)
  let text = parts.length ? `${head}: ${parts.join(', ')}.` : `${head}.`
  if (counts.history > 0) text += ` ${plural(counts.history, 'past job')} on their timelines.`
  if (counts.skipped > 0) text += ` ${plural(counts.skipped, 'row')} had no name, email or phone and ${counts.skipped === 1 ? 'was' : 'were'} skipped.`
  if (counts.failed > 0) text += ` ${plural(counts.failed, 'row')} couldn't be saved.`
  text += ' Nothing was sent to anyone. Text "undo import" to take it all back.'
  return text
}

/** What the owner is told after an undo. */
export function undoSummaryText(args: { source: ImportSource; removed: number; restored: number; kept: number; label?: string | null }): string {
  const from = args.source === 'spreadsheet' && args.label ? args.label : IMPORT_SOURCE_LABEL[args.source]
  const parts = [`Undid the import from ${from}: removed ${plural(args.removed, 'contact')} it added`]
  if (args.restored > 0) parts.push(`put back what it changed on ${plural(args.restored, 'contact')} you had`)
  let text = `${parts.join(' and ')}.`
  if (args.kept > 0) text += ` Kept ${plural(args.kept, 'contact')} you've worked with since (tag removed).`
  return text
}
