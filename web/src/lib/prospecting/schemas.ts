/**
 * Exa output schemas owned by Prospecting (spec §4).
 *
 * `COMPANY_CARD_CORE` and `COMPANY_CARD_DETAILS` (src/lib/exa/deep-search.ts)
 * are entirely firmographic and EACH SIT AT THE 10-PROPERTY CAP, so ICP fields
 * cannot be appended to them without adding a fourth sequential company search
 * to every CRM enrichment forever — for fields only Prospecting reads.
 *
 * So this is a separate card, fired ONCE at first list creation (decision 4),
 * own-domain anchored, and deliberately NOT appended to
 * `COMPANY_CARD_SCHEMAS`.
 */
import {
  MAX_OUTPUT_SCHEMA_PROPERTIES,
  assertSchemaWithinCapDeep,
  countSchemaProperties,
} from '@/lib/exa/deep-search'

/**
 * The ICP card: what the company's own website says about who it sells to.
 *
 * `required: []` is deliberate — a thin answer is normal for an early-stage
 * company and must not fail the card. Six flat properties, comfortably under
 * the cap, leaving headroom if a seventh ever earns its place.
 *
 * Run with `includeDomains: [sourceDomain]`, which makes it ANCHORED BY
 * CONSTRUCTION: a card built only from the company's own site cannot describe
 * someone else, so its fields must NOT be passed through
 * `demoteUnrelatedSources` (see `research.ts`).
 */
export const COMPANY_CARD_ICP = {
  type: 'object',
  properties: {
    targetCustomer: {
      type: 'string',
      description: 'The kind of company or person this company sells to.',
    },
    knownCustomers: {
      type: 'string',
      description: 'Named customers, logos or case studies, comma separated.',
    },
    useCases: {
      type: 'string',
      description: 'Problems the product solves for its buyers.',
    },
    buyerTitles: {
      type: 'string',
      description: 'Job titles of the people who buy or champion it.',
    },
    marketSegment: {
      type: 'string',
      description: 'SMB, mid-market, enterprise, prosumer, developer.',
    },
    valueProposition: {
      type: 'string',
      description: 'The core value promise, in one sentence.',
    },
  },
  required: [],
} as const

/**
 * MODULE-LOAD ASSERTION. `deepSearch()` throws on an over-cap schema at call
 * time, which would surface as a paid-lane failure minutes into a run. Failing
 * here instead means an over-cap edit cannot even be imported — the same
 * discipline `assertSchemaFitsCap` applies inside the Exa client, moved
 * forward to the earliest possible moment.
 *
 * A plain `throw` on purpose: this is a programming mistake in our own schema
 * definition, never an upstream condition, and must never be mistaken for a
 * transient Exa failure that a retry lane would re-bill forever.
 */
{
  const count = countSchemaProperties(COMPANY_CARD_ICP)
  if (count > MAX_OUTPUT_SCHEMA_PROPERTIES) {
    throw new Error(
      `COMPANY_CARD_ICP has ${count} properties, exceeding Exa's maximum of ` +
        `${MAX_OUTPUT_SCHEMA_PROPERTIES}.`,
    )
  }
}

/**
 * The blob field key the ICP card's `targetCustomer` lands under once
 * `groundedFields` has snake-cased it — the card's single most load-bearing
 * field, named here so a rename of it cannot pass silently.
 *
 * NOT an idempotence key. `COMPANY_CARD_ICP` declares `required: []` and
 * `groundedFields` drops absent/non-answer/low-grounding values, so a paid,
 * successful run may never produce this field. `fireIcpCard` keys its spend
 * guard on the unconditional `enrichment.icp_card_at` stamp instead.
 */
export const ICP_CARD_MARKER_FIELD = 'target_customer'

/** Every field key the ICP card contributes to the blob, snake-cased the way
 *  `groundedFields` writes them. `icp.ts` reads exactly these. */
export const ICP_CARD_FIELDS = {
  targetCustomer: 'target_customer',
  knownCustomers: 'known_customers',
  useCases: 'use_cases',
  buyerTitles: 'buyer_titles',
  marketSegment: 'market_segment',
  valueProposition: 'value_proposition',
} as const

// ---------------------------------------------------------------------------
// The pipeline cards (§7)
// ---------------------------------------------------------------------------

/**
 * Stage 2 — DISCOVERY. The one card that returns a LIST (spec §7).
 *
 * Seven properties AS EXA COUNTS THEM: 1 for the `companies` array itself plus
 * the 6 leaves of its item shape. Our own `countSchemaProperties` reports 1
 * for this — it never descends into `items` — which is precisely why
 * `assertSchemaWithinCapDeep` exists and is what the assertion below uses. A
 * 12-leaf item shape was measured returning `HTTP 400 "Output_schema exceeds
 * maximum of 10 properties"` (§12), so every array card stays at 9 leaves or
 * fewer.
 *
 * `required: []` deliberately: a round that finds three companies instead of
 * twenty is a normal, billable outcome and must not fail the card. The
 * per-item `description`s are load-bearing — Exa's synthesizer reads them, and
 * without one `domain` comes back as a full URL and `signal` duplicates
 * `whyMatch`.
 *
 * Both `whyMatch` and `signal` are what Stage 3a scores against for free
 * (`fit.ts`), which is the design's single largest cost saving: the demo
 * spends a deep search per company to derive a number this card already paid
 * for.
 */
export const PROSPECT_DISCOVERY_CARD = {
  type: 'object',
  properties: {
    companies: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Company name.' },
          domain: { type: 'string', description: 'Primary website domain, no scheme.' },
          oneLiner: { type: 'string', description: 'What the company does, one sentence.' },
          whyMatch: {
            type: 'string',
            description: 'Why this company fits the described buyer.',
          },
          signal: {
            type: 'string',
            description: 'A recent hiring, funding or product signal, if any, with dates.',
          },
          employeeRange: { type: 'string', description: 'Approximate headcount band.' },
        },
      },
    },
  },
  required: [],
} as const

/**
 * Stage 3b — the PROSPECT ACCOUNT CARD: one own-domain-anchored search per
 * entry, fired only when the user asks for it, before Save.
 *
 * FLAT on purpose, so the count is straightforward: 9 properties by both
 * counters, one under the cap. It is written to `entry.research` in the same
 * blob-field shape `company.metadata.enrichment.fields` uses, so `readBlob` /
 * `DetailField` / `isUnverified` render it with zero new display code.
 *
 * This is NOT the CRM's `enrichCompany`. That runs its three cards at
 * ≈$0.04-0.05 and up to 180s, needs a real row to write back to, and only ever
 * runs AFTER Save. This card is ≈$0.013 and 5-15s for a company the user has
 * not committed to yet.
 *
 * `whyFit` is the one field that is not firmographic: it is why this company
 * would buy the SOURCE company's product, which is why the caller passes the
 * source blurb in the systemPrompt.
 *
 * `required: []`, again because a thin answer is normal and must not fail.
 */
export const PROSPECT_ACCOUNT_CARD = {
  type: 'object',
  properties: {
    employeeCount: { type: 'string', description: 'Headcount or range.' },
    headquarters: { type: 'string', description: 'City, state, country.' },
    fundingStage: {
      type: 'string',
      description: 'Bootstrapped, Seed, Series A/B/C, Growth, Public.',
    },
    totalRaised: { type: 'string', description: 'Total funding raised.' },
    growthSignals: {
      type: 'string',
      description: 'Recent hiring, funding or product signals with dates.',
    },
    techStack: { type: 'string', description: 'Notable technologies in use.' },
    products: { type: 'string', description: 'Products and services.' },
    keyPeople: { type: 'string', description: 'Founders and executives, name — title.' },
    whyFit: {
      type: 'string',
      description:
        "Why this company would (or would not) buy the source company's product, judged against the ideal customer in the system prompt. State the reasons behind fitScore.",
    },
    // THE SCORE. Exa's own demo asks the synthesis model for a 0–100 rating
    // with the whole profile in hand; this is that field. It is the tenth
    // property, which puts the card exactly at Exa's cap, and it is stripped
    // out of the research blob by `applyCard` — it is a column, not a fact
    // about the company.
    fitScore: {
      type: 'integer',
      description:
        'How likely this company is to buy from the source company, 0–100, judged against the ideal customer in the system prompt. Use the whole range and be strict: 85–100 only for a company that matches the profile AND shows an active need or signal; 60–84 a solid match; 35–59 a partial match; below 35 a poor match or an excluded case.',
    },
  },
  required: ['fitScore', 'whyFit'],
} as const

/**
 * Stage 4 — PEOPLE. The second array card: 6 as Exa counts (1 array + 5
 * leaves), 1 as `countSchemaProperties` counts.
 *
 * Always run with `includeDomains: [companyDomain]` and `category: 'people'`.
 * `linkedinUrl` is the most load-bearing property in the whole feature: it is
 * the PRIMARY `personCandidateKey` tier (keys.ts), and the measured run
 * returned a `linkedin.com/in` URL for every person it found, grounded high
 * (§12). Without it a person falls back to `name@domain`, which two people
 * with the same name at one company would collide on.
 */
export const PROSPECT_PEOPLE_CARD = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          fullName: { type: 'string', description: 'Full name.' },
          jobTitle: { type: 'string', description: 'Current title.' },
          linkedinUrl: { type: 'string', description: 'LinkedIn profile URL.' },
          seniority: { type: 'string', description: 'C-level, VP, Director, Manager, IC.' },
          whyRelevant: {
            type: 'string',
            description: 'Why this person matters for a sales-tooling purchase.',
          },
        },
      },
    },
  },
  required: [],
} as const

/**
 * MODULE-LOAD ASSERTIONS for the three pipeline cards, by BOTH counters.
 *
 * The shallow counter is the one every pre-existing call site was sized
 * against; the deep one is the number Exa's server actually enforces, and for
 * the two array cards it is the only one that can catch an over-cap edit at
 * all (the shallow counter reports 1 for both). Asserting here means an
 * over-cap edit cannot be imported, rather than hard-failing every round of a
 * run that preflight has already billed.
 */
assertSchemaWithinCapDeep(PROSPECT_DISCOVERY_CARD, 'PROSPECT_DISCOVERY_CARD')
assertSchemaWithinCapDeep(PROSPECT_ACCOUNT_CARD, 'PROSPECT_ACCOUNT_CARD')
assertSchemaWithinCapDeep(PROSPECT_PEOPLE_CARD, 'PROSPECT_PEOPLE_CARD')

/** The `output.content` key each list card returns, named once so
 *  `groundedArray(res, …)` and the parsers cannot drift from the schema. */
export const DISCOVERY_ARRAY_KEY = 'companies'
export const PEOPLE_ARRAY_KEY = 'people'
