/**
 * Turning Exa responses into candidates (spec §7).
 *
 * Three pure functions, one per paid call in the pipeline: discovery
 * (`PROSPECT_DISCOVERY_CARD`), people (`PROSPECT_PEOPLE_CARD`) and the
 * prospect account card (`PROSPECT_ACCOUNT_CARD`). No network, no Supabase, no
 * LLM — everything here is a total function of a `DeepSearchResult`.
 *
 * WHAT THIS FILE DOES NOT DO — deliberately, and this is the load-bearing
 * boundary in the run engine:
 *
 *   * It does NOT dedupe against the CRM, other lists, dismissals, opt-outs or
 *     enrollments. That is the exclusion set (`exclusions.ts`), recomputed at
 *     the start of every round, and it must see EVERY candidate this file
 *     produced so it can record each one's `outcome` and `suppressed_by`
 *     (§6). A candidate silently dropped here would be a suppression the UI
 *     cannot explain.
 *   * It does NOT score fit. That is `fit.ts`, which reads the `fields` this
 *     file produces.
 *   * It does NOT write anything.
 *
 * The one collapse it DOES perform is within a SINGLE response: Exa returned
 * forgehand.co twice in one measured 20-entry answer (§12), and two rows for one
 * identity would violate `UNIQUE (list_id, candidate_key)` on insert rather
 * than being reported as a suppression. Within-response duplicates are a
 * malformed answer, not a repeat discovery.
 */
import {
  type DeepSearchResult,
  type GroundedField,
  demoteUnrelatedPersonSources,
  groundedArray,
  groundedFields,
  resultEntities,
  sourcesOf,
} from '@/lib/exa/deep-search'
import type {
  ProspectCandidate,
  ProspectFoundVia,
  ProspectIdentityState,
} from './types'
import { companyCandidateKey, personCandidateKey } from './keys'
import { DISCOVERY_ARRAY_KEY, PEOPLE_ARRAY_KEY } from './schemas'

/** Blob-field shape: the same `{ snake_case_key: GroundedField }` map
 *  `company.metadata.enrichment.fields` carries, so a candidate promoted at
 *  Save merges with the existing `mergeBlobFields` discipline and `readBlob`
 *  renders it with no new display code. */
export type BlobFields = Record<string, GroundedField>

/** Confidence ordering, lowest first — used to take the WEAKEST of a set. */
const CONFIDENCE_RANK: Record<GroundedField['confidence'], number> = {
  low: 0,
  medium: 1,
  high: 2,
}

/** The weakest confidence among the named fields, defaulting to 'low' when a
 *  field is absent entirely. Absence is weaker than a low-grounded value, not
 *  stronger, so a missing identity field can never lift the overall number. */
function weakestConfidence(
  fields: BlobFields,
  keys: string[],
): GroundedField['confidence'] {
  let worst: GroundedField['confidence'] = 'high'
  for (const key of keys) {
    const found = fields[key]?.confidence ?? 'low'
    if (CONFIDENCE_RANK[found] < CONFIDENCE_RANK[worst]) worst = found
  }
  return worst
}

// ---------------------------------------------------------------------------
// Discovery (Stage 2)
// ---------------------------------------------------------------------------

export interface DiscoveryCandidate {
  /** `companyCandidateKey` of the domain — null when the domain is missing,
   *  unparseable or a personal/webmail host. The caller records a null key as
   *  `outcome='invalid'` (or `suppressed_by='personal_domain'`) rather than
   *  inventing an identity. */
  identity_key: string | null
  display_name: string | null
  /** The normalized domain when there is one, else the raw string we tried —
   *  kept so an `invalid` row can still say what it was. */
  domain: string | null
  found_via: ProspectFoundVia
  /** The item verbatim, for `prospect_run_candidate.raw`: the synthesized item
   *  object, or the flattened result entity. */
  raw: Record<string, unknown>
  /** Blob-field shape, ready for `entry.research` / fit scoring. */
  fields: BlobFields
  /** How much to trust this candidate's IDENTITY, not its prose: the weakest
   *  of the `name` and `domain` groundings for a synthesized item. Result
   *  entities are 'high' — they are Exa's own indexed firmographics attached
   *  to a URL we retrieved, not a synthesis that could have hallucinated a
   *  domain. */
  confidence: GroundedField['confidence']
  /** Which discovery angle produced it — cheap telemetry that is unavailable
   *  retroactively (§7). */
  angle: string | null
  /** Present only on `found_via: 'result_entity'`. */
  exa_entity_id?: string | null
  /** The result URL an entity rode in on — the per-item citation `fit.ts`
   *  stores as the entry's citation. */
  evidence_url?: string | null
  /**
   * The Exa entity's properties verbatim, on a `result_entity` candidate.
   *
   * Pass this straight to `antiRuleHit` as `FitInput.entity`: it is where
   * `workforce.total` and `headquarters` live, and they are the free fallbacks
   * §7's table routes `employee_bands` and `geographies` at. A synthesized
   * candidate that collapsed with an entity keeps the entity's properties too,
   * via `mergeDiscoveryCandidates`.
   */
  entity?: Record<string, unknown> | null
}

export interface ParseDiscoveryOptions {
  /** The angle string stamped onto every candidate from this response. */
  angle?: string | null
}

/**
 * Harvest BOTH candidate sources from one discovery response (§7).
 *
 * 1. `output.content.companies[]` — the synthesized list, with per-item
 *    grounding via `groundedArray` (NOT `groundedFields`, which collapses
 *    `companies[0].whyMatch` and `companies[7].whyMatch` into one key).
 * 2. `results[].entities[]` of type 'company' — free firmographics riding on
 *    results we already paid for, carrying a stable `exa_entity_id`. This is
 *    what makes a round cheap: a measured 25-result response gave 5
 *    synthesized companies against 20 entity-bearing hosts.
 *
 * Synthesized wins on collision, because it carries `whyMatch` / `signal` —
 * the fit-relevant prose the entity harvest has no equivalent of — and a
 * result entity for the same domain adds only `exa_entity_id` and a
 * description, which are merged onto the winner rather than discarded.
 *
 * Every candidate is returned, INCLUDING ones whose key is null. The caller
 * needs the invalid rows to write `prospect_run_candidate` honestly.
 */
export function parseDiscoveryResponse(
  res: DeepSearchResult,
  options: ParseDiscoveryOptions = {},
): DiscoveryCandidate[] {
  const angle = options.angle ?? null
  const out: DiscoveryCandidate[] = []
  // Collapse within THIS response only. Keyed by identity_key; a null key
  // cannot collide with anything (two unusable candidates are two rows, each
  // recorded as invalid) so those bypass the map entirely.
  const byKey = new Map<string, number>()

  const push = (candidate: DiscoveryCandidate) => {
    const key = candidate.identity_key
    if (!key) {
      out.push(candidate)
      return
    }
    const seen = byKey.get(key)
    if (seen === undefined) {
      byKey.set(key, out.length)
      out.push(candidate)
      return
    }
    out[seen] = mergeDiscoveryCandidates(out[seen], candidate)
  }

  // --- 1. Synthesized -------------------------------------------------------
  const rawItems = readArray(res.content, DISCOVERY_ARRAY_KEY)
  const grounded = groundedArray(res, DISCOVERY_ARRAY_KEY)
  grounded.forEach((item, index) => {
    const fields = item.fields
    const domainRaw = fields.domain?.value ?? null
    const name = fields.name?.value ?? null
    push({
      identity_key: companyCandidateKey(domainRaw),
      display_name: name,
      domain: companyCandidateKey(domainRaw) ?? domainRaw,
      found_via: 'synthesized',
      raw: rawItems[index] ?? {},
      fields,
      // The identity is only as good as the two fields that ESTABLISH it. A
      // high-grounded `whyMatch` on a low-grounded domain is a confident
      // rationale about a company we are not sure exists.
      confidence: weakestConfidence(fields, ['name', 'domain']),
      angle,
      evidence_url: fields.domain?.source_url ?? fields.name?.source_url ?? null,
    })
  })

  // --- 2. Result entities ---------------------------------------------------
  for (const entity of resultEntities(res)) {
    const fields: BlobFields = {}
    // Entity properties are Exa's own index, attached to a URL we retrieved,
    // so the result URL is their citation and 'high' is honest. They are NOT
    // grounded per field the way the synthesized card is — there is no
    // `grounding[]` row for an entity property — so inventing a lower number
    // per field would be equally arbitrary and would suppress good data.
    const cite = (value: string | null): GroundedField | null =>
      value ? { value, source_url: entity.url, source_title: entity.title, confidence: 'high' } : null
    const nameField = cite(entity.name)
    if (nameField) fields.name = nameField
    const descField = cite(entity.description)
    if (descField) fields.one_liner = descField
    if (entity.foundedYear != null) {
      const yearField = cite(String(entity.foundedYear))
      if (yearField) fields.founded_year = yearField
    }
    const domainField = cite(entity.domain)
    if (domainField) fields.domain = domainField

    push({
      identity_key: companyCandidateKey(entity.domain),
      display_name: entity.name ?? entity.title,
      domain: companyCandidateKey(entity.domain) ?? entity.domain,
      found_via: 'result_entity',
      raw: {
        id: entity.id,
        name: entity.name,
        domain: entity.domain,
        description: entity.description,
        foundedYear: entity.foundedYear,
        url: entity.url,
        title: entity.title,
      },
      fields,
      confidence: 'high',
      angle,
      exa_entity_id: entity.id,
      evidence_url: entity.url,
      entity: entity.properties,
    })
  }

  return out
}

/**
 * Fold a duplicate of an already-harvested candidate into the one we keep.
 *
 * SYNTHESIZED WINS: it carries `whyMatch` and `signal`, the prose Stage 3a
 * scores against, and a result entity has no equivalent. But the loser is not
 * thrown away — its `exa_entity_id` (which only the entity harvest has) and
 * any field the winner is missing are merged on, so harvesting the same
 * company twice strictly improves it.
 */
function mergeDiscoveryCandidates(
  kept: DiscoveryCandidate,
  incoming: DiscoveryCandidate,
): DiscoveryCandidate {
  const winner = kept.found_via === 'synthesized' ? kept : incoming
  const loser = winner === kept ? incoming : kept
  const fields: BlobFields = { ...loser.fields }
  // Winner's fields overwrite the loser's on collision.
  for (const [key, field] of Object.entries(winner.fields)) fields[key] = field
  return {
    ...winner,
    fields,
    display_name: winner.display_name ?? loser.display_name,
    exa_entity_id: winner.exa_entity_id ?? loser.exa_entity_id ?? null,
    evidence_url: winner.evidence_url ?? loser.evidence_url ?? null,
    // The entity half is the only source of `workforce`/`headquarters`, so a
    // synthesized winner inherits them rather than losing the free
    // firmographics `fit.ts` falls back to.
    entity: winner.entity ?? loser.entity ?? null,
  }
}

// ---------------------------------------------------------------------------
// People (Stage 4)
// ---------------------------------------------------------------------------

export interface PersonCandidate {
  /** `personCandidateKey`: linkedin → email → name@domain. Null when none of
   *  the three can be produced, which the caller records as `invalid`. */
  identity_key: string | null
  display_name: string | null
  /** Normalized `linkedin.com/in/<slug>` when there is one. */
  linkedin_url: string | null
  job_title: string | null
  seniority: string | null
  /** 'anchored' when at least one field survived
   *  `demoteUnrelatedPersonSources` at high or medium; 'needs_review'
   *  otherwise, which excludes the row from bulk save (§7). */
  identity_state: Extract<ProspectIdentityState, 'anchored' | 'needs_review'>
  raw: Record<string, unknown>
  /** Blob-field shape, AFTER the identity gate — a demoted field is kept with
   *  `confidence: 'low'`, never dropped, so the UI can show it as Unverified. */
  fields: BlobFields
  /** The candidate object stored on the entry. */
  candidate: ProspectCandidate
}

export interface ParsePeopleOptions {
  companyName?: string | null
  companyDomain?: string | null
}

/**
 * Parse one anchored people response into candidates, each gated for identity.
 *
 * THE GATE. Every person's fields go through `demoteUnrelatedPersonSources`
 * with the ACCOUNT's identity — the Devin Marsh namesake incident is exactly
 * this shape: a real profile, a confident card, and a different human. The
 * person's OWN `linkedinUrl` from the card is passed as `identity.linkedinUrl`
 * because that IS the identity the candidate asserts: the measured response
 * cites every field to the profile the card itself named, and a page's title
 * carrying only the person's name (which is how LinkedIn titles read) would
 * otherwise fail the name-AND-company test and demote a perfectly anchored
 * person.
 *
 * A person whose citations point somewhere else entirely still comes back —
 * as `identity_state: 'needs_review'`, excluded from bulk save and requiring a
 * per-row confirm. Nothing is dropped for failing the gate.
 */
export function parsePeopleResponse(
  res: DeepSearchResult,
  options: ParsePeopleOptions = {},
): PersonCandidate[] {
  const rawItems = readArray(res.content, PEOPLE_ARRAY_KEY)
  const grounded = groundedArray(res, PEOPLE_ARRAY_KEY)
  const out: PersonCandidate[] = []
  const seen = new Set<string>()

  grounded.forEach((item, index) => {
    const raw = rawItems[index] ?? {}
    const fullName = item.fields.full_name?.value ?? null
    const linkedinRaw = item.fields.linkedin_url?.value ?? null
    const jobTitle = item.fields.job_title?.value ?? null
    const seniority = item.fields.seniority?.value ?? null

    const identityKey = personCandidateKey({
      linkedinUrl: linkedinRaw,
      name: fullName,
      domain: options.companyDomain ?? null,
    })

    const fields = demoteUnrelatedPersonSources(item.fields, {
      name: fullName,
      companyName: options.companyName ?? null,
      companyDomain: options.companyDomain ?? null,
      linkedinUrl: linkedinRaw,
    })

    const anchored = Object.values(fields).some((f) => f.confidence !== 'low')

    const candidate: PersonCandidate = {
      identity_key: identityKey,
      display_name: fullName,
      // Store the NORMALIZED profile so two spellings of one profile compare
      // equal everywhere downstream, falling back to the raw string when it is
      // not a personal profile URL at all.
      linkedin_url: identityKey?.startsWith('linkedin.com/in/') ? identityKey : linkedinRaw,
      job_title: jobTitle,
      seniority,
      identity_state: anchored ? 'anchored' : 'needs_review',
      raw,
      fields,
      candidate: {
        name: fullName,
        domain: options.companyDomain ?? null,
        linkedin_url: identityKey?.startsWith('linkedin.com/in/') ? identityKey : linkedinRaw,
        title: jobTitle,
        seniority,
        one_liner: fields.why_relevant?.value ?? null,
        found_via: 'synthesized',
      },
    }

    // Within-response collapse, first occurrence wins: a second entry for one
    // profile is a malformed answer, and two rows for one key would violate
    // `UNIQUE (list_id, candidate_key)` on insert.
    if (identityKey) {
      if (seen.has(identityKey)) return
      seen.add(identityKey)
    }
    out.push(candidate)
  })

  return out
}

// ---------------------------------------------------------------------------
// The account card (Stage 3b)
// ---------------------------------------------------------------------------

export interface ParsedAccountCard {
  /** Blob-field shape for `entry.research`. Non-answers are already dropped by
   *  `groundedFields`, so "Not publicly disclosed" never reaches the UI. */
  fields: BlobFields
  sources: Array<{ url: string; title: string | null; published_date: string | null }>
  /** What Exa charged, 0 when it reported nothing — the run's spend
   *  accounting adds these up and must never add `null`. */
  cost: number
}

/**
 * Parse the own-domain-anchored account card.
 *
 * NO IDENTITY GATE, on purpose and for the same reason `fireIcpCard` skips
 * one: this card is fetched with `includeDomains: [domain]`, so it is ANCHORED
 * BY CONSTRUCTION — a card built only from the company's own site cannot
 * describe someone else, and running `demoteUnrelatedSources` over it would
 * only demote the company's own untitled pages.
 */
export function parseAccountCard(res: DeepSearchResult): ParsedAccountCard {
  return {
    fields: groundedFields(res),
    sources: sourcesOf(res),
    cost: res.costDollars ?? 0,
  }
}

// ---------------------------------------------------------------------------

/** `content[key]` as an array of plain objects, positionally aligned with
 *  `groundedArray`'s output (which walks the same array). */
function readArray(
  content: Record<string, unknown> | null,
  key: string,
): Array<Record<string, unknown>> {
  const raw = content?.[key]
  if (!Array.isArray(raw)) return []
  return raw.map((item) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {},
  )
}
