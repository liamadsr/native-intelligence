import { z } from 'zod'
import type { BrowserObservation } from './task-contract'

export const MAX_BROWSER_EVIDENCE_BYTES = 8000
export const MAX_BROWSER_EVIDENCE_PAGES = 3
// A single reading page can use most of the ledger; the total remains 8 KB.
const MAX_PAGE_BYTES = 6500
const MAX_SNIPPETS = 16
const MAX_LINKS = 20
const MAX_TOTAL_LINKS = 30
const EARLY_LINKS = 10
const encoder = new TextEncoder()
const byteSize = (value: unknown) => encoder.encode(JSON.stringify(value)).length

/** Preserve the supplied URL exactly. Seeing a destination never visits it. */
function safeUrl(value: string): boolean {
  if (!value || /[\u0000-\u0020\u007f]/.test(value)) return false
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password
  } catch { return false }
}

// Position is within the first-seen native text/link inventory, never global result rank.
const positionSchema = { firstSeenStep: z.number().int().nonnegative(), position: z.number().int().nonnegative() }
const pageSchema = z.object({
  documentId: z.string().max(100), url: z.string().max(4000).refine(safeUrl), title: z.string().max(500),
  firstSeenStep: z.number().int().nonnegative(), lastSeenStep: z.number().int().nonnegative(),
  latestObservationId: z.number().int().nonnegative(), latestObservedAt: z.number().finite(),
  snippets: z.array(z.object({ text: z.string().min(1).max(480), ...positionSchema }).strict()).max(MAX_SNIPPETS),
  links: z.array(z.object({ name: z.string().min(1).max(300), url: z.string().max(4000).refine(safeUrl), ...positionSchema,
    readScope: z.literal('rendered_heading_links').optional(), documentOrder: z.number().int().min(0).max(499).optional(),
    section: z.string().max(300).optional(), context: z.string().max(700).optional(), contextTruncated: z.boolean().optional() }).strict()).max(MAX_LINKS),
  truncated: z.boolean(),
}).strict().refine(page => byteSize(page) <= MAX_PAGE_BYTES && page.firstSeenStep <= page.lastSeenStep &&
  [...page.snippets, ...page.links].every(item => item.firstSeenStep >= page.firstSeenStep && item.firstSeenStep <= page.lastSeenStep),
'Invalid or oversized page evidence.')

/** This is server-owned task state. Never accept a prior ledger from a browser
 * decision request. Only append observations authorized by the queue lease. */
export const browserEvidenceLedgerSchema = z.object({
  version: z.literal(1), source: z.literal('accepted_native_observations'), scope: z.literal('historical_read_evidence'),
  destinationsVisited: z.literal(false), pages: z.array(pageSchema).max(MAX_BROWSER_EVIDENCE_PAGES), truncated: z.boolean(),
}).strict().refine(value => byteSize(value) <= MAX_BROWSER_EVIDENCE_BYTES &&
  new Set(value.pages.map(page => JSON.stringify([page.documentId, page.url]))).size === value.pages.length &&
  value.pages.reduce((count, page) => count + page.links.length, 0) <= MAX_TOTAL_LINKS &&
  value.pages.every((page, index) => index === 0 || page.firstSeenStep >= value.pages[index - 1].firstSeenStep),
'Invalid or oversized browser evidence ledger.')

export type BrowserEvidenceLedger = z.infer<typeof browserEvidenceLedgerSchema>
type Page = BrowserEvidenceLedger['pages'][number]

function empty(truncated = false): BrowserEvidenceLedger {
  return { version: 1, source: 'accepted_native_observations', scope: 'historical_read_evidence',
    destinationsVisited: false, pages: [], truncated }
}

/** Remove supporting text before exact links, retaining early and recent text
 * when possible. Every removal stays visible to the decision and parent. */
function shrinkPage(page: Page): boolean {
  page.truncated = true
  if (page.snippets.length) { page.snippets.splice(page.snippets.length > 4 ? 4 : page.snippets.length - 1, 1); return true }
  if (page.links.length) { page.links.splice(page.links.length > EARLY_LINKS ? EARLY_LINKS : page.links.length - 1, 1); return true }
  return false
}

/** Bounded, lossily retained source evidence, not a summary or action memory.
 * Pages merge across viewport reads by exact document identity and URL. Their
 * first-seen ordering survives revisits; observations never copy control refs,
 * input values, checked state, dialogs or completion predicates into history. */
export function appendBrowserEvidence(previous: unknown, observation: BrowserObservation, step: number): BrowserEvidenceLedger {
  const parsed = browserEvidenceLedgerSchema.safeParse(previous)
  const ledger = parsed.success ? parsed.data : empty(previous !== undefined && previous !== null)
  const latestStep = Math.max(-1, ...ledger.pages.map(page => page.lastSeenStep))
  if (!Number.isSafeInteger(step) || step < latestStep || step < 0 || !safeUrl(observation.url) ||
      !Number.isFinite(observation.observedAt)) return { ...ledger, truncated: true }

  let page = ledger.pages.find(value => value.documentId === observation.documentId && value.url === observation.url)
  if (page && observation.observationId <= page.latestObservationId) return ledger
  if (!page) {
    page = { documentId: observation.documentId, url: observation.url, title: observation.title,
      firstSeenStep: step, lastSeenStep: step, latestObservationId: observation.observationId, latestObservedAt: observation.observedAt,
      snippets: [], links: [], truncated: false }
    if (byteSize(page) > MAX_PAGE_BYTES) return { ...ledger, truncated: true }
    ledger.pages.push(page)
    // Keep the first page and the most recent two distinct pages. Setup and
    // picker snapshots within one document never consume more page slots.
    if (ledger.pages.length > MAX_BROWSER_EVIDENCE_PAGES) { ledger.pages.splice(1, 1); ledger.truncated = true }
  }
  page.lastSeenStep = step
  page.latestObservationId = observation.observationId
  page.latestObservedAt = observation.observedAt
  page.title = observation.title
  page.truncated ||= observation.textTruncated === true || observation.elements.length >= 100
  const seenText = new Set(page.snippets.map(snippet => snippet.text))
  // Bound each line without inventing an ending or changing the source order.
  // Unicode code points avoid splitting a surrogate pair at the excerpt edge.
  observation.text.split(/\n+/).forEach((line, position) => {
    const clean = line.replace(/\s+/g, ' ').trim()
    if (!clean) return
    const characters = Array.from(clean)
    const text = characters.slice(0, 240).join('')
    page!.truncated ||= characters.length > 240
    if (seenText.has(text)) return
    seenText.add(text)
    page!.snippets.push({ text, firstSeenStep: step, position })
    if (page!.snippets.length > MAX_SNIPPETS) { page!.snippets.splice(4, 1); page!.truncated = true }
  })
  // Current rendered semantic records retain each whole association. Append
  // after viewport prose so recent records survive the bounded snippet policy.
  if (observation.evidence?.documentRecordsScope === 'rendered_semantic_records') {
    page.truncated ||= observation.evidence.documentRecordsTruncated === true
    for (const record of observation.evidence.documentRecords ?? []) {
      page.truncated ||= record.textTruncated
      if (seenText.has(record.text)) continue
      seenText.add(record.text)
      page.snippets.push({ text: record.text, firstSeenStep: step, position: record.order })
      if (page.snippets.length > MAX_SNIPPETS) { page.snippets.splice(4, 1); page.truncated = true }
    }
  }
  const seenLinks = new Set(page.links.map(link => link.url))
  // Heading-link records retain their exact title and document order before
  // navigation links can crowd out the page's reading findings.
  page.truncated ||= observation.evidence?.documentLinksTruncated === true
  if (observation.evidence?.documentLinksScope === 'rendered_heading_links') {
    for (const record of observation.evidence.documentLinks ?? []) {
      if (!safeUrl(record.destination) || record.destination.length >= 4000 || seenLinks.has(record.destination)) continue
      const item = { name: record.title, url: record.destination, firstSeenStep: step, position: record.order,
        readScope: 'rendered_heading_links' as const, documentOrder: record.order, section: record.section,
        ...(record.context !== undefined ? { context: record.context, contextTruncated: record.contextTruncated === true } : {}) }
      if (byteSize(item) > 1500) { page.truncated = true; continue }
      seenLinks.add(record.destination)
      page.links.push(item)
      if (page.links.length > MAX_LINKS) { page.links.splice(EARLY_LINKS, 1); page.truncated = true }
    }
  }
  observation.elements.forEach((control, position) => {
    if (control.role !== 'link' || control.disabled || control.forbidden || !control.name.trim() ||
        !safeUrl(control.destination) || seenLinks.has(control.destination)) return
    // The native producer caps these strings; a parseable cut URL is not exact.
    if (control.destination.length >= 4000) { page!.truncated = true; return }
    page!.truncated ||= control.name.length >= 300
    seenLinks.add(control.destination)
    const link = { name: control.name, url: control.destination, firstSeenStep: step, position }
    // An individual giant destination must not evict all the smaller findings.
    if (byteSize(link) > 1500) { page!.truncated = true; return }
    page!.links.push(link)
    if (page!.links.length > MAX_LINKS) { page!.links.splice(EARLY_LINKS, 1); page!.truncated = true }
  })
  while (byteSize(page) > MAX_PAGE_BYTES && shrinkPage(page)) { /* bounded by items */ }
  if (byteSize(page) > MAX_PAGE_BYTES) {
    ledger.pages = ledger.pages.filter(value => value !== page)
    ledger.truncated = true
  }
  // Preserve the newest page before spending space on older supporting prose.
  while (ledger.pages.reduce((count, value) => count + value.links.length, 0) > MAX_TOTAL_LINKS) {
    const older = ledger.pages.find(value => value !== page && value.links.length) ?? page
    older.links.splice(older.links.length > EARLY_LINKS ? EARLY_LINKS : older.links.length - 1, 1)
    older.truncated = true
    ledger.truncated = true
  }
  while (byteSize(ledger) > MAX_BROWSER_EVIDENCE_BYTES) {
    const older = ledger.pages.find(value => value !== page && (value.snippets.length || value.links.length))
    if (older) shrinkPage(older)
    else if (page && shrinkPage(page)) { /* current content is the final fallback */ }
    else if (ledger.pages.length) ledger.pages.shift()
    else break
    ledger.truncated = true
  }
  ledger.truncated ||= ledger.pages.some(value => value.truncated)
  return ledger
}
