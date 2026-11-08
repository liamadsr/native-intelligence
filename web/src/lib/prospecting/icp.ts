/**
 * Seeding and normalizing the ICP object (spec §4).
 *
 * `prospect_list.icp` is prose-shaped, not filter-shaped, because Exa's deep
 * search consumes a query string and a systemPrompt — every structured filter
 * would be flattened back to prose before the call, so a filter UI is a lossy
 * intermediate the user tunes and cannot debug.
 *
 * Two exports:
 *
 *   * `buildIcpDraft(sourceCompany, purpose)` — the §4 seeding table plus the
 *     four purpose templates, with PROVENANCE on every field so the panel can
 *     render "From your company profile · dial8.ai" in the same register the
 *     Details tab uses for an enriched field. The seed is a proposal, never a
 *     commitment: every field renders pre-filled and editable.
 *
 *   * `normalizeIcp(input)` — the PATCH gate. Anything the client sends is
 *     coerced into the exact `Icp` shape (missing keys defaulted, arrays
 *     cleaned of blanks and duplicates, unknown keys dropped), so a malformed
 *     edit can never store a blob the angle builder then has to defend against.
 *
 * Pure: no network, no database. The caller loads the row.
 */
import { normalizeDomain } from '@/lib/crm/domains'
import type { Icp, ProspectListPurpose } from './types'
import { ICP_CARD_FIELDS } from './schemas'
import type { SourceCompanyRow } from './source-company'

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/** Where a seeded value came from. `null` means "we had nothing" — the field
 *  renders empty and the panel prompts for it. */
export type IcpProvenanceSource = 'company_profile' | 'template' | null

/** One seeded value plus how we got it. The UI renders `from` as the muted
 *  provenance line and `source_url` as its link. */
export interface IcpProvenance {
  /** The seeded value, as a display string. Array fields are joined with ', '
   *  so the panel has one thing to render regardless of field shape. */
  value: string
  from: IcpProvenanceSource
  source_url?: string | null
}

/** Provenance for every seeded field, keyed by a dotted path into `Icp`
 *  ('source.what_we_sell', 'target.description', …). Only fields we actually
 *  seeded appear; an absent key means "nothing was proposed for this". */
export type IcpProvenanceMap = Record<string, IcpProvenance>

export interface IcpDraft {
  icp: Icp
  provenance: IcpProvenanceMap
}

// ---------------------------------------------------------------------------
// Blob reading
// ---------------------------------------------------------------------------

/** One entry as it sits in `metadata.enrichment.fields`. */
interface BlobField {
  value: string
  source_url: string | null
}

/**
 * Read `company.metadata.enrichment.fields` tolerantly. Every shape the blob
 * has ever had is accepted; anything that does not parse is simply absent,
 * which is the same discipline `readPreviousBlob` applies in enrichment.ts.
 */
function readBlobFields(metadata: unknown): Record<string, BlobField> {
  const out: Record<string, BlobField> = {}
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out
  const enrichment = (metadata as Record<string, unknown>).enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return out
  const fields = (enrichment as Record<string, unknown>).fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return out

  for (const [key, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const rec = entry as Record<string, unknown>
    const value = typeof rec.value === 'string' ? rec.value.trim() : ''
    if (!value) continue
    out[key] = {
      value,
      source_url: typeof rec.source_url === 'string' && rec.source_url ? rec.source_url : null,
    }
  }
  return out
}

/**
 * Split a comma-separated blob value ("Acme, Globex, Initech") into names.
 * Semicolons and newlines count too — Exa's prose answers use all three — and
 * blanks/duplicates are dropped, case-insensitively on the trimmed form.
 */
export function splitBlobList(raw: string | null | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of raw.split(/[,;\n]/)) {
    const value = part.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/**
 * True when a blob field's citation is on the company's OWN domain (or a
 * subdomain of it).
 *
 * WHY IT GATES SEEDING. `metadata.enrichment.fields` is a UNION of cards, and
 * only the CORE and CONTACT cards are `includeDomains`-anchored — the DETAILS
 * card runs on the open web, so an off-domain answer about a NAMESAKE can and
 * does land in the same blob at high confidence. Production: dial8.ai's blob
 * carried `products_and_services: "Cocktail bar and event space"` cited to
 * hotelvarenne.com, beside a `description` from the company's own site
 * reading "Native Intelligence is an agentic workspace and sales intelligence platform".
 * Seeding `what_we_sell` from the first of those pointed every ICP, every
 * angle and every search in the workspace at the wrong business.
 *
 * So the fields that describe WHO WE ARE and WHO BUYS FROM US are only taken
 * from the blob when their citation is the company's own site. Domains are
 * compared through `normalizeDomain` — the same normalizer the enrichment
 * write-back uses — so scheme, `www.` and a path never decide the match.
 * A missing `source_url` is NOT own-domain: unattributable is not trusted.
 */
function isOwnDomainField(
  field: BlobField | undefined,
  companyDomain: string | null | undefined,
): boolean {
  const own = normalizeDomain(companyDomain)
  if (!own || !field?.source_url) return false
  const host = normalizeDomain(field.source_url)
  if (!host) return false
  return host === own || host.endsWith(`.${own}`)
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

/**
 * The four starter templates the New-list sheet leads with. `purpose` ONLY
 * seeds the draft and selects angle templates — it never branches the
 * pipeline, so a user can invent a purpose we never anticipated ("podcast
 * hosts in our space") and it just works.
 *
 * `description` is interpolated with what the company sells; `{{what_we_sell}}`
 * is the single placeholder.
 */
interface PurposeTemplate {
  /** Template description, used when the ICP card gave us no targetCustomer.
   *  An empty string means "leave it blank and ask" — the investors case. */
  description: string
  buyerTitles: string[]
  /** Investors deliberately CLEAR any card-derived target description: the
   *  card answers "who does our website say we sell to", which is exactly
   *  right for a sales list and exactly wrong for a fund search. */
  clearsCardDescription: boolean
}

export const ICP_PURPOSE_TEMPLATES: Record<ProspectListPurpose, PurposeTemplate> = {
  buyers: {
    description: 'Companies that would buy {{what_we_sell}}.',
    buyerTitles: ['Head of Sales', 'VP Sales', 'Founder'],
    clearsCardDescription: false,
  },
  investors: {
    // Blank on purpose: the sheet asks for the fund profile. `source` and
    // `comparables` stay intact so the investor angles have portfolio
    // evidence to cite (§7).
    description: '',
    buyerTitles: ['Partner', 'Principal'],
    clearsCardDescription: true,
  },
  partners: {
    description: 'Companies whose product complements {{what_we_sell}}, for a partnership or integration.',
    buyerTitles: ['BD', 'Partnerships'],
    clearsCardDescription: false,
  },
  talent: {
    description: 'Companies whose people we would want to hire, working on problems close to {{what_we_sell}}.',
    buyerTitles: ['Recruiter', 'Head of Talent'],
    clearsCardDescription: false,
  },
  custom: {
    // Blank target, seeded source.
    description: '',
    buyerTitles: [],
    clearsCardDescription: true,
  },
}

function interpolate(template: string, whatWeSell: string): string {
  if (!template) return ''
  const subject = whatWeSell.trim() || 'what we sell'
  return template.replace(/\{\{what_we_sell\}\}/g, subject)
}

// ---------------------------------------------------------------------------
// The empty ICP
// ---------------------------------------------------------------------------

/** A structurally-complete, entirely empty ICP. Every builder starts here, so
 *  no consumer ever has to guard for a missing key. */
export function emptyIcp(): Icp {
  return {
    source: { company_id: '', name: '', domain: '', what_we_sell: '', our_customers: [] },
    target: {
      description: '',
      industries: [],
      employee_bands: [],
      geographies: [],
      buyer_titles: [],
      use_cases: [],
      competitors: [],
      comparables: [],
    },
    anti: { exclude_industries: [], exclude_keywords: [], notes: '' },
    search_hint: '',
  }
}

// ---------------------------------------------------------------------------
// buildIcpDraft
// ---------------------------------------------------------------------------

/**
 * Seed an ICP from the workspace's own enriched company row, per §4's table:
 *
 *   source.name / source.domain   ← company.name / company.domain columns
 *   source.what_we_sell           ← blob products_and_services, else
 *                                   company.description, else industry
 *   source.our_customers          ← knownCustomers from COMPANY_CARD_ICP
 *   target.description            ← targetCustomer from the card, else the
 *                                   purpose template interpolated
 *   target.industries             ← company.industry + market_segment
 *   target.buyer_titles           ← the card's buyerTitles, else purpose defaults
 *   target.comparables            ← the card's competitors + our_customers
 *
 * `sourceCompany` may be null (§4 step 4): the draft comes back structurally
 * complete with only the purpose template applied, which is exactly what the
 * sheet needs to render before the user has supplied a domain.
 */
export function buildIcpDraft(
  sourceCompany: SourceCompanyRow | null,
  purpose: ProspectListPurpose,
): IcpDraft {
  const icp = emptyIcp()
  const provenance: IcpProvenanceMap = {}
  const template = ICP_PURPOSE_TEMPLATES[purpose] ?? ICP_PURPOSE_TEMPLATES.custom
  const blob = readBlobFields(sourceCompany?.metadata)

  /** Record a seeded scalar and its provenance in one move. */
  const seed = (path: string, value: string, from: IcpProvenanceSource, sourceUrl?: string | null) => {
    if (!value) return
    provenance[path] = { value, from, ...(sourceUrl ? { source_url: sourceUrl } : {}) }
  }
  const seedList = (
    path: string,
    values: string[],
    from: IcpProvenanceSource,
    sourceUrl?: string | null,
  ) => {
    if (values.length === 0) return
    provenance[path] = {
      value: values.join(', '),
      from,
      ...(sourceUrl ? { source_url: sourceUrl } : {}),
    }
  }

  // ── source ───────────────────────────────────────────────────────────
  if (sourceCompany) {
    icp.source.company_id = sourceCompany.id
    icp.source.name = (sourceCompany.name ?? '').trim()
    icp.source.domain = (sourceCompany.domain ?? '').trim()
    seed('source.name', icp.source.name, 'company_profile')
    seed('source.domain', icp.source.domain, 'company_profile')

    /*
     * what_we_sell, in ANCHORED-FIRST order:
     *
     *   1. the ICP card's `valueProposition` — own-domain by construction
     *      (`fireIcpCard` runs `includeDomains: [domain]`), and the one field
     *      whose whole job is "the core value promise, in one sentence";
     *   2. `company.description` — the COLUMN, which the fill-empty write-back
     *      only ever filled from the own-domain CORE card;
     *   3. the blob's `description` field, for a row whose column was already
     *      populated by hand and whose blob still carries the CORE answer;
     *   4. `products_and_services` — but ONLY when its citation is the
     *      company's own site. This field comes off the OPEN-WEB DETAILS card,
     *      and on production dial8.ai's read "Cocktail bar and event space"
     *      cited to a namesake's site while the description above was correct;
     *   5. `company.industry`, the last resort.
     *
     * Falls through on EMPTY, not just on absent: an enriched row can carry a
     * blank description column, and `||` is what makes the chain reach the
     * industry fallback rather than seeding "".
     */
    const valueProp = blob[ICP_CARD_FIELDS.valueProposition]
    const blobDescription = blob.description
    const products = blob.products_and_services
    const ownDomainProducts = isOwnDomainField(products, sourceCompany.domain) ? products : undefined
    const whatWeSell: Array<BlobField | undefined> = [
      valueProp,
      { value: (sourceCompany.description ?? '').trim(), source_url: null },
      blobDescription,
      ownDomainProducts,
      { value: (sourceCompany.industry ?? '').trim(), source_url: null },
    ]
    const chosen = whatWeSell.find((f) => (f?.value ?? '').trim() !== '')
    icp.source.what_we_sell = (chosen?.value ?? '').trim()
    seed('source.what_we_sell', icp.source.what_we_sell, 'company_profile', chosen?.source_url ?? null)

    // Same own-domain rule: "who our customers are" off a namesake's site is
    // a list of somebody else's logos, and it seeds `comparables` too.
    const knownCustomers = blob[ICP_CARD_FIELDS.knownCustomers]
    const ownDomainCustomers = isOwnDomainField(knownCustomers, sourceCompany.domain)
      ? knownCustomers
      : undefined
    icp.source.our_customers = splitBlobList(ownDomainCustomers?.value)
    seedList(
      'source.our_customers',
      icp.source.our_customers,
      'company_profile',
      ownDomainCustomers?.source_url ?? null,
    )
  }

  // ── target.description ───────────────────────────────────────────────
  // The card's answer wins for a sales-shaped list; the investors and custom
  // templates clear it and ask, keeping `source` and `comparables` intact.
  const targetCustomer = blob[ICP_CARD_FIELDS.targetCustomer]
  if (!template.clearsCardDescription && targetCustomer?.value) {
    icp.target.description = targetCustomer.value
    seed('target.description', icp.target.description, 'company_profile', targetCustomer.source_url)
  } else {
    icp.target.description = interpolate(template.description, icp.source.what_we_sell)
    seed('target.description', icp.target.description, 'template')
  }

  // ── target.industries ← company.industry + the card's market_segment ──
  const marketSegment = blob[ICP_CARD_FIELDS.marketSegment]
  icp.target.industries = dedupeList([
    ...(sourceCompany?.industry ? [sourceCompany.industry.trim()] : []),
    ...splitBlobList(marketSegment?.value),
  ])
  seedList(
    'target.industries',
    icp.target.industries,
    'company_profile',
    marketSegment?.source_url ?? null,
  )

  // ── target.buyer_titles ← the card, else the purpose defaults ─────────
  const cardTitles = blob[ICP_CARD_FIELDS.buyerTitles]
  const fromCard = template.clearsCardDescription ? [] : splitBlobList(cardTitles?.value)
  if (fromCard.length > 0) {
    icp.target.buyer_titles = fromCard
    seedList('target.buyer_titles', fromCard, 'company_profile', cardTitles?.source_url ?? null)
  } else {
    icp.target.buyer_titles = [...template.buyerTitles]
    seedList('target.buyer_titles', icp.target.buyer_titles, 'template')
  }

  // ── target.use_cases ← the card ──────────────────────────────────────
  const useCases = blob[ICP_CARD_FIELDS.useCases]
  icp.target.use_cases = splitBlobList(useCases?.value)
  seedList('target.use_cases', icp.target.use_cases, 'company_profile', useCases?.source_url ?? null)

  // ── target.competitors + comparables ─────────────────────────────────
  // `competitors` is the DETAILS card's field, present on any enriched
  // company. `comparables` is competitors + our_customers, and exists because
  // the investor angles need portfolio evidence to cite (§7) — which is why
  // the investors template keeps it rather than clearing it with description.
  const competitors = blob.competitors
  icp.target.competitors = splitBlobList(competitors?.value)
  seedList(
    'target.competitors',
    icp.target.competitors,
    'company_profile',
    competitors?.source_url ?? null,
  )
  icp.target.comparables = dedupeList([...icp.target.competitors, ...icp.source.our_customers])
  seedList('target.comparables', icp.target.comparables, 'company_profile')

  // ── anti ─────────────────────────────────────────────────────────────
  // Nothing is seeded: an exclusion the user did not ask for is the one kind
  // of seeded value that silently costs them results.

  return { icp, provenance }
}

// ---------------------------------------------------------------------------
// normalizeIcp
// ---------------------------------------------------------------------------

function dedupeList(values: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (!value) continue
    const key = value.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(value)
  }
  return out
}

/** Coerce an arbitrary jsonb value into a clean string list. Accepts an array
 *  (the client's shape) or a comma-separated string (a paste). */
function toList(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return dedupeList(raw.filter((v): v is string => typeof v === 'string'))
  }
  if (typeof raw === 'string') return splitBlobList(raw)
  return []
}

function toText(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : ''
}

function asRecord(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

/**
 * The PATCH gate: coerce anything into the exact `Icp` shape.
 *
 * Unknown keys are DROPPED rather than carried, so an old client's stray field
 * cannot accrete in the blob forever; missing keys are defaulted, so every
 * consumer can read `icp.target.industries` without a guard. Long free-text is
 * capped — the ICP ends up inside an Exa systemPrompt, and an unbounded paste
 * there is a cost and a truncation bug, not a feature.
 */
const MAX_TEXT = 2_000
const MAX_LIST_ITEMS = 50

function cap(value: string): string {
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) : value
}

function capList(values: string[]): string[] {
  return values.slice(0, MAX_LIST_ITEMS).map(cap)
}

export function normalizeIcp(raw: unknown): Icp {
  const input = asRecord(raw)
  const source = asRecord(input.source)
  const target = asRecord(input.target)
  const anti = asRecord(input.anti)

  return {
    source: {
      company_id: toText(source.company_id),
      name: cap(toText(source.name)),
      domain: cap(toText(source.domain)),
      what_we_sell: cap(toText(source.what_we_sell)),
      our_customers: capList(toList(source.our_customers)),
    },
    target: {
      description: cap(toText(target.description)),
      industries: capList(toList(target.industries)),
      employee_bands: capList(toList(target.employee_bands)),
      geographies: capList(toList(target.geographies)),
      buyer_titles: capList(toList(target.buyer_titles)),
      use_cases: capList(toList(target.use_cases)),
      competitors: capList(toList(target.competitors)),
      comparables: capList(toList(target.comparables)),
    },
    anti: {
      exclude_industries: capList(toList(anti.exclude_industries)),
      exclude_keywords: capList(toList(anti.exclude_keywords)),
      notes: cap(toText(anti.notes)),
    },
    search_hint: cap(toText(input.search_hint)),
  }
}

/**
 * True when two ICPs differ in any field a search would see. The list PATCH
 * uses it to decide whether to bump `icp_version`: a no-op save (the user
 * opened the panel and closed it) must not drift every entry's badge.
 */
export function icpEquals(a: Icp, b: Icp): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}
