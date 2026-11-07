/**
 * `COMPANY_CARD_ICP` — under the cap, shaped as §4 specifies, and NOT wired
 * into the CRM's own card list.
 *
 * The cap assertion is the load-bearing one. `deepSearch` throws on an
 * over-cap schema at CALL time, which surfaces as a paid-lane failure minutes
 * into a run; the module-load assertion in schemas.ts moves that to import
 * time, and this test proves the schema is currently under it by the same
 * function Exa's own counting matches.
 */
import { describe, it, expect } from 'vitest'
import {
  COMPANY_CARD_SCHEMAS,
  MAX_OUTPUT_SCHEMA_PROPERTIES,
  buildDeepSearchBody,
  camelToSnake,
  countSchemaProperties,
  countSchemaPropertiesDeep,
} from '@/lib/exa/deep-search'
import {
  COMPANY_CARD_ICP,
  DISCOVERY_ARRAY_KEY,
  ICP_CARD_FIELDS,
  ICP_CARD_MARKER_FIELD,
  PEOPLE_ARRAY_KEY,
  PROSPECT_ACCOUNT_CARD,
  PROSPECT_DISCOVERY_CARD,
  PROSPECT_PEOPLE_CARD,
} from '../schemas'

describe('COMPANY_CARD_ICP', () => {
  it("sits under Exa's property cap", () => {
    expect(countSchemaProperties(COMPANY_CARD_ICP)).toBeLessThanOrEqual(MAX_OUTPUT_SCHEMA_PROPERTIES)
  })

  it('is the six flat properties §4 specifies, with no nesting', () => {
    const keys = Object.keys(COMPANY_CARD_ICP.properties)
    expect(keys).toEqual([
      'targetCustomer',
      'knownCustomers',
      'useCases',
      'buyerTitles',
      'marketSegment',
      'valueProposition',
    ])
    // Flat: the deep count equals the shallow one, so no nested object is
    // quietly consuming cap headroom.
    expect(countSchemaProperties(COMPANY_CARD_ICP)).toBe(keys.length)
    for (const prop of Object.values(COMPANY_CARD_ICP.properties)) {
      expect(prop.type).toBe('string')
      expect(prop.description.length).toBeGreaterThan(0)
    }
  })

  it('requires nothing — a thin answer is normal for an early-stage company', () => {
    expect(COMPANY_CARD_ICP.required).toEqual([])
  })

  it('is NOT appended to COMPANY_CARD_SCHEMAS — it must not join every CRM enrichment', () => {
    expect(COMPANY_CARD_SCHEMAS).not.toContain(COMPANY_CARD_ICP as never)
    expect(COMPANY_CARD_SCHEMAS).toHaveLength(3)
  })
})

describe('ICP_CARD_FIELDS', () => {
  it('maps every schema property to the key groundedFields will actually write', () => {
    const schemaKeys = Object.keys(COMPANY_CARD_ICP.properties)
    expect(Object.keys(ICP_CARD_FIELDS).sort()).toEqual(schemaKeys.sort())
    for (const [camel, snake] of Object.entries(ICP_CARD_FIELDS)) {
      expect(snake).toBe(camelToSnake(camel))
    }
  })

  it('the idempotence marker is a field the card actually produces', () => {
    expect(Object.values(ICP_CARD_FIELDS)).toContain(ICP_CARD_MARKER_FIELD)
    expect(ICP_CARD_MARKER_FIELD).toBe(ICP_CARD_FIELDS.targetCustomer)
  })
})

// ---------------------------------------------------------------------------
// The three pipeline cards (§7)
// ---------------------------------------------------------------------------

/**
 * EVERY card is checked by BOTH counters, which is the whole point: the
 * shallow one reports 1 for an array card, so it would have waved through the
 * 12-leaf shape Exa answered with a 400 (§12). `buildDeepSearchBody` runs the
 * same both-counter assertion at call time, so a card that passes here cannot
 * fail there.
 */
const ALL_CARDS = {
  COMPANY_CARD_ICP,
  PROSPECT_DISCOVERY_CARD,
  PROSPECT_ACCOUNT_CARD,
  PROSPECT_PEOPLE_CARD,
} as const

describe('every prospecting card is under the cap by BOTH counters', () => {
  for (const [name, schema] of Object.entries(ALL_CARDS)) {
    it(`${name} fits`, () => {
      expect(countSchemaProperties(schema)).toBeLessThanOrEqual(MAX_OUTPUT_SCHEMA_PROPERTIES)
      expect(countSchemaPropertiesDeep(schema)).toBeLessThanOrEqual(MAX_OUTPUT_SCHEMA_PROPERTIES)
      // ...and the client agrees, so no card can 400 on the property cap.
      expect(() => buildDeepSearchBody({ query: 'q', outputSchema: schema })).not.toThrow()
    })
  }
})

describe('PROSPECT_DISCOVERY_CARD', () => {
  it('counts 7 deep — 1 array plus 6 leaves — where the shallow counter says 1', () => {
    expect(countSchemaPropertiesDeep(PROSPECT_DISCOVERY_CARD)).toBe(7)
    expect(countSchemaProperties(PROSPECT_DISCOVERY_CARD)).toBe(1)
  })

  it('leaves headroom: an array card may carry at most 9 leaves', () => {
    const leaves = Object.keys(PROSPECT_DISCOVERY_CARD.properties.companies.items.properties)
    expect(leaves.length).toBeLessThanOrEqual(MAX_OUTPUT_SCHEMA_PROPERTIES - 1)
  })

  it('declares the six item properties §7 specifies, each described', () => {
    const items = PROSPECT_DISCOVERY_CARD.properties.companies.items
    expect(Object.keys(items.properties)).toEqual([
      'name',
      'domain',
      'oneLiner',
      'whyMatch',
      'signal',
      'employeeRange',
    ])
    for (const prop of Object.values(items.properties)) {
      expect(prop.type).toBe('string')
      // Exa's synthesizer READS these; without one, `domain` comes back as a
      // full URL and `signal` duplicates `whyMatch`.
      expect(prop.description.length).toBeGreaterThan(0)
    }
  })

  it('requires nothing — a round that finds three companies is a normal outcome', () => {
    expect(PROSPECT_DISCOVERY_CARD.required).toEqual([])
  })

  it('names its array key the way groundedArray will be asked for it', () => {
    expect(DISCOVERY_ARRAY_KEY).toBe('companies')
    expect(Object.keys(PROSPECT_DISCOVERY_CARD.properties)).toEqual([DISCOVERY_ARRAY_KEY])
  })
})

describe('PROSPECT_ACCOUNT_CARD', () => {
  it('is FLAT, so both counters agree at 10 — exactly Exa\'s cap', () => {
    expect(countSchemaProperties(PROSPECT_ACCOUNT_CARD)).toBe(10)
    expect(countSchemaPropertiesDeep(PROSPECT_ACCOUNT_CARD)).toBe(10)
  })

  it('requires the score and its reasoning — the two things the card is now FOR', () => {
    expect(PROSPECT_ACCOUNT_CARD.required).toEqual(['fitScore', 'whyFit'])
    expect(PROSPECT_ACCOUNT_CARD.properties.fitScore.type).toBe('integer')
    expect(PROSPECT_ACCOUNT_CARD.properties.fitScore.description).toMatch(/0–100/)
  })

  it('declares the nine §7 properties plus fitScore', () => {
    expect(Object.keys(PROSPECT_ACCOUNT_CARD.properties)).toEqual([
      'employeeCount',
      'headquarters',
      'fundingStage',
      'totalRaised',
      'growthSignals',
      'techStack',
      'products',
      'keyPeople',
      'whyFit',
      'fitScore',
    ])
    expect(PROSPECT_ACCOUNT_CARD.required).toEqual(['fitScore', 'whyFit'])
  })

  it('snake-cases into the blob keys the CRM Details tab already renders', () => {
    for (const key of Object.keys(PROSPECT_ACCOUNT_CARD.properties)) {
      expect(camelToSnake(key)).toMatch(/^[a-z][a-z_]*$/)
    }
    expect(camelToSnake('employeeCount')).toBe('employee_count')
  })
})

describe('PROSPECT_PEOPLE_CARD', () => {
  it('counts 6 deep — 1 array plus 5 leaves', () => {
    expect(countSchemaPropertiesDeep(PROSPECT_PEOPLE_CARD)).toBe(6)
    expect(countSchemaProperties(PROSPECT_PEOPLE_CARD)).toBe(1)
  })

  it('declares the five item properties §7 specifies', () => {
    const items = PROSPECT_PEOPLE_CARD.properties.people.items
    expect(Object.keys(items.properties)).toEqual([
      'fullName',
      'jobTitle',
      'linkedinUrl',
      'seniority',
      'whyRelevant',
    ])
    expect(PROSPECT_PEOPLE_CARD.required).toEqual([])
  })

  it('keeps linkedinUrl, the PRIMARY person key tier', () => {
    // Without it a person falls back to `name@domain`, which two people with
    // the same name at one company collide on (keys.ts).
    expect(PROSPECT_PEOPLE_CARD.properties.people.items.properties.linkedinUrl).toBeDefined()
  })

  it('names its array key the way groundedArray will be asked for it', () => {
    expect(PEOPLE_ARRAY_KEY).toBe('people')
    expect(Object.keys(PROSPECT_PEOPLE_CARD.properties)).toEqual([PEOPLE_ARRAY_KEY])
  })
})
