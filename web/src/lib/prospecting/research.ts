/**
 * The ICP card, fired once (spec §4, decision 4).
 *
 * `fireIcpCard` runs `COMPANY_CARD_ICP` against the source company's OWN
 * domain and merges the answer into that company's `metadata.enrichment` blob
 * — the same blob the CRM's Details tab already renders, so this adds fields
 * without adding display code.
 *
 * Three properties this function is built around:
 *
 *   1. IDEMPOTENT. Every run that actually reached Exa stamps
 *      `enrichment.icp_card_at`, and a later run skips on seeing it — so
 *      first-list-creation firing it, a retry firing it, and a second list
 *      firing it all cost $0.012 exactly once.
 *
 *      The marker is that unconditional timestamp and NOT a data field:
 *      `COMPANY_CARD_ICP` declares `required: []`, and `groundedFields` drops
 *      absent, non-answer and low-grounding values, so a perfectly successful
 *      run can return `useCases` but no `targetCustomer`. Keying the guard on
 *      a field the card is not obliged to return would leave it unarmed and
 *      re-bill on every press — and this guard is the only spend control on
 *      POST /api/account/prospecting/source. A thin answer therefore stamps
 *      too (`status:'empty'`), because Exa was paid either way.
 *   2. ANCHORED BY CONSTRUCTION. `includeDomains: [domain]` means the card is
 *      built only from the company's own site, so it CANNOT describe someone
 *      else — and therefore must NOT be passed through
 *      `demoteUnrelatedSources`, which exists to gate open-web cards and would
 *      here only throw away correct fields.
 *   3. ADDITIVE. `mergeBlobFields` keeps every field an earlier run found and
 *      refuses to let a lower-confidence answer displace a higher-confidence
 *      one, so firing this can only ever add to the row.
 *
 * It writes ONLY `metadata` — never a column, never `enrichment_status`. The
 * ICP fields have no columns and this is not a CRM enrichment run: overwriting
 * the row's enrichment status here would make a $0.012 side-search look like
 * the full three-card pipeline had just completed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  DEEP_SEARCH_TIMEOUT_MS,
  companyProfileQuery,
  groundedFields,
  sourcesOf,
} from '@/lib/exa/deep-search'
import { mergeBlobFields, normalizeDomain } from '@/lib/crm/enrichment'
import { COMPANY_CARD_ICP } from './schemas'
import { deepSearchForUser } from '@/lib/web-research/plan-deep-search'

export interface FireIcpCardArgs {
  workspaceId: string
  userId: string
  companyId: string
  /** Force the search even when `enrichment.icp_card_at` is already stamped.
   *  Only the explicit "refresh" affordance passes this; never a list
   *  creation. */
  force?: boolean
}

/**
 * Every outcome carries `fired` and `fields_count` so a caller can answer the
 * one question the UI actually asks — "did anything land?" — without
 * re-deriving it from the four-way status union.
 *
 *   * `fired` is true only when this call reached Exa AND merged at least one
 *     field into the blob. A skip, an empty card, a failure and a card whose
 *     every field lost the confidence merge are all `false`: nothing new is on
 *     the row, so the sheet must keep showing "Researching…" or fall back to
 *     seeding from the columns rather than claiming a refresh happened.
 *   * `fields_count` is how many field keys the card contributed, so the
 *     caller can say "6 fields" without unpacking `fields`.
 *
 * `status` / `reason` / `fields` / `cost` / `error` are unchanged — every
 * existing consumer keeps reading exactly what it read before.
 */
export type FireIcpCardOutcome =
  | {
      status: 'skipped'
      reason: 'already_present' | 'not_found' | 'no_domain'
      cost: 0
      fired: false
      fields_count: 0
    }
  | { status: 'fired'; fields: string[]; cost: number; fired: true; fields_count: number }
  | { status: 'empty'; cost: number; fired: false; fields_count: 0 }
  | { status: 'failed'; error: string; cost: 0; fired: false; fields_count: 0 }

/** Pull `metadata.enrichment` off a row as a plain object, tolerantly. */
function blobEnrichment(metadata: unknown): Record<string, unknown> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const enrichment = (metadata as Record<string, unknown>).enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return {}
  return enrichment as Record<string, unknown>
}

/**
 * Has this company already been ICP-carded? True means {@link fireIcpCard} will
 * skip and spend NOTHING; false means the next call fires a paid search.
 *
 * Exported because a caller that needs consent BEFORE spending has to be able
 * to ask that question without spending to find out — `research_my_company`
 * gates its quote requirement on it. It reads the same unconditional
 * `icp_card_at` stamp `fireIcpCard`'s own guard reads, deliberately: two
 * predicates that agree today would drift, and the one that drifts would let
 * money out without a quote.
 */
export function hasIcpCard(metadata: unknown): boolean {
  return typeof blobEnrichment(metadata).icp_card_at === 'string'
}

/** Pull `metadata.enrichment.fields` off a row, tolerantly. */
function blobFields(metadata: unknown): Record<string, Record<string, unknown>> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {}
  const enrichment = (metadata as Record<string, unknown>).enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return {}
  const fields = (enrichment as Record<string, unknown>).fields
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) return {}
  const out: Record<string, Record<string, unknown>> = {}
  for (const [key, entry] of Object.entries(fields as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    out[key] = entry as Record<string, unknown>
  }
  return out
}

/** Existing citations, so the merge appends rather than replaces. */
function blobSources(
  metadata: unknown,
): Array<{ url: string; title?: string | null; published_date?: string | null }> {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
  const enrichment = (metadata as Record<string, unknown>).enrichment
  if (!enrichment || typeof enrichment !== 'object' || Array.isArray(enrichment)) return []
  const sources = (enrichment as Record<string, unknown>).sources
  if (!Array.isArray(sources)) return []
  return sources.filter(
    (s): s is { url: string } => !!s && typeof s === 'object' && typeof (s as { url?: unknown }).url === 'string',
  )
}

const MAX_BLOB_SOURCES = 40

/**
 * Fire the ICP card for one company, once.
 *
 * Never throws: every failure comes back as an outcome, because a list
 * creation must succeed even when Exa is down. The ICP simply seeds from the
 * columns instead, and the sheet's "refresh" affordance can retry later.
 */
export async function fireIcpCard(
  supabase: SupabaseClient,
  args: FireIcpCardArgs,
): Promise<FireIcpCardOutcome> {
  const { data: row, error: loadError } = await supabase
    .from('company')
    .select('id, name, domain, metadata')
    .eq('id', args.companyId)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()

  if (loadError) {
    console.error('[prospecting] icp card company load failed:', loadError.message)
    return { status: 'failed', error: loadError.message, cost: 0, fired: false, fields_count: 0 }
  }
  const company = row as { id: string; name: string | null; domain: string | null; metadata: unknown } | null
  if (!company) return { status: 'skipped', reason: 'not_found', cost: 0, fired: false, fields_count: 0 }

  // Own-domain anchoring is the whole design. Without a domain there is
  // nothing to anchor to, and an open-web "who does Acme sell to" is exactly
  // the namesake answer the CRM enrichment path already refuses to store.
  const domain = normalizeDomain(company.domain)
  if (!domain) return { status: 'skipped', reason: 'no_domain', cost: 0, fired: false, fields_count: 0 }

  // The spend guard: an unconditional stamp, not a data field. See the module
  // header — the card may legitimately return nothing, and a field-keyed guard
  // would re-bill forever on such a company.
  if (!args.force && hasIcpCard(company.metadata)) {
    return { status: 'skipped', reason: 'already_present', cost: 0, fired: false, fields_count: 0 }
  }

  let result
  try {
    // Exa's, or the person's own ChatGPT plan's (the free tier): the same card,
    // still anchored to the company's own site. A plan that can't be read
    // fails the card, never runs it on Exa.
    const search = await deepSearchForUser(args.userId, args.workspaceId)
    result = await search({
      // The same query shape the CORE card uses for an own-domain run — the
      // schema, not the query, is what makes this the ICP card.
      query: companyProfileQuery(domain),
      category: 'company',
      outputSchema: COMPANY_CARD_ICP,
      includeDomains: [domain],
      signal: AbortSignal.timeout(DEEP_SEARCH_TIMEOUT_MS),
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[prospecting] icp card search failed:', message)
    return { status: 'failed', error: message.slice(0, 500), cost: 0, fired: false, fields_count: 0 }
  }

  const cost = result.costDollars ?? 0
  // NO demote gate: includeDomains already anchored this by construction, and
  // running the open-web relevance gate over an own-domain card only ever
  // discards correct fields.
  const fields = groundedFields(result)
  const found = Object.keys(fields)

  /*
   * RE-READ before merging. The search above took seconds to a minute, and the
   * one caller (POST /api/account/prospecting/source) kicks the full three-card
   * CRM enrichment immediately before this — which writes the SAME blob when it
   * lands. Merging onto the row as loaded BEFORE the search would silently drop
   * everything that arrived meanwhile; merging onto the row as it stands NOW is
   * what makes "this only ever adds" true in the presence of a concurrent
   * writer. A failed re-read falls back to the row we already hold: losing a
   * concurrent merge beats losing this card's own answer.
   */
  const { data: fresh } = await supabase
    .from('company')
    .select('metadata')
    .eq('id', company.id)
    .eq('workspace_id', args.workspaceId)
    .maybeSingle()
  const currentMetadata = (fresh as { metadata?: unknown } | null)?.metadata ?? company.metadata

  const existingFields = blobFields(currentMetadata)

  // A thin answer is normal for an early-stage company (`required: []` says
  // so). Nothing to merge — but Exa was still paid, so the run STILL stamps
  // `icp_card_at` and falls through to the write below. Returning early here
  // would leave the spend guard unarmed and re-bill on the next press.
  const now = new Date().toISOString()
  const mergedFields =
    found.length === 0
      ? existingFields
      : mergeBlobFields(existingFields, fields as Record<string, unknown>, now)

  const seen = new Set<string>()
  const mergedSources: Array<{ url: string; title?: string | null; published_date?: string | null }> = []
  for (const s of [...sourcesOf(result), ...blobSources(currentMetadata)]) {
    if (seen.has(s.url)) continue
    seen.add(s.url)
    mergedSources.push(s)
    if (mergedSources.length >= MAX_BLOB_SOURCES) break
  }

  // Merge into the SIBLING-SAFE shape: only `enrichment.fields`,
  // `enrichment.sources` and a stamp change. `company_autolinked` (mig 232),
  // `hubspot_push_error` and — crucially — `enrichment.status`,
  // `enrichment.applied_fields` and the attempt streak all survive untouched.
  const baseMetadata =
    currentMetadata && typeof currentMetadata === 'object' && !Array.isArray(currentMetadata)
      ? { ...(currentMetadata as Record<string, unknown>) }
      : {}
  const baseEnrichment = { ...blobEnrichment(currentMetadata) }

  const priorTotal =
    typeof baseEnrichment.total_cost_dollars === 'number' && Number.isFinite(baseEnrichment.total_cost_dollars)
      ? (baseEnrichment.total_cost_dollars as number)
      : 0

  baseMetadata.enrichment = {
    ...baseEnrichment,
    fields: mergedFields,
    sources: mergedSources,
    icp_card_at: now,
    total_cost_dollars: Math.round((priorTotal + cost) * 1e6) / 1e6,
  }

  const { error: writeError } = await supabase
    .from('company')
    .update({ metadata: baseMetadata, updated_at: now })
    .eq('id', company.id)
    .eq('workspace_id', args.workspaceId)

  if (writeError) {
    console.error('[prospecting] icp card write failed:', writeError.message)
    return { status: 'failed', error: writeError.message, cost: 0, fired: false, fields_count: 0 }
  }

  if (found.length === 0) return { status: 'empty', cost, fired: false, fields_count: 0 }
  return { status: 'fired', fields: found, cost, fired: true, fields_count: found.length }
}
