import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  bucketEmployeeCount,
  bucketAnnualRevenue,
  isEmptyValue,
  computeFillEmptyPatch,
  mapCompany,
  mapContact,
  shouldRecomputeFullName,
  firstAssociatedCompanyId,
  decideCompanyMatch,
  decideContactMatch,
  shouldSkip,
  normalizeDomain,
  buildContactPatch,
  upsertHubspotCompany,
  upsertHubspotContact,
  HUBSPOT_CONTACT_SOURCE,
  HUBSPOT_SOURCE_PROVIDER,
  type MappedContact,
} from '@/lib/crm/hubspot-sync'
import type { HubspotObject } from '@/lib/integrations/hubspot-api'

/**
 * Tests for src/lib/crm/hubspot-sync.ts.
 *
 * The pure decision functions carry the enrich-don't-clobber contract, so they
 * get the most coverage: bucketing edges, fill-empty (never clobbers a
 * populated local value; name/domain company exception), match priority
 * (hubspot-id > email/domain > insert), the no-email contact path, and the
 * archived skip. A thin DB-layer harness confirms the upsert wiring routes to
 * the right branch.
 */

// ---------------------------------------------------------------------------
// Pure: bucketing
// ---------------------------------------------------------------------------

describe('bucketEmployeeCount', () => {
  it('buckets across the boundaries', () => {
    expect(bucketEmployeeCount(1)).toBe('1-10')
    expect(bucketEmployeeCount(10)).toBe('1-10')
    expect(bucketEmployeeCount(11)).toBe('11-50')
    expect(bucketEmployeeCount(50)).toBe('11-50')
    expect(bucketEmployeeCount(51)).toBe('51-200')
    expect(bucketEmployeeCount(200)).toBe('51-200')
    expect(bucketEmployeeCount(201)).toBe('201-1000')
    expect(bucketEmployeeCount(1000)).toBe('201-1000')
    expect(bucketEmployeeCount(1001)).toBe('1000+')
    expect(bucketEmployeeCount(250000)).toBe('1000+')
  })
  it('accepts numeric strings from the HubSpot property', () => {
    expect(bucketEmployeeCount('42')).toBe('11-50')
  })
  it('returns null for absent/zero/invalid', () => {
    expect(bucketEmployeeCount(null)).toBeNull()
    expect(bucketEmployeeCount(undefined)).toBeNull()
    expect(bucketEmployeeCount('')).toBeNull()
    expect(bucketEmployeeCount(0)).toBeNull()
    expect(bucketEmployeeCount(-5)).toBeNull()
    expect(bucketEmployeeCount('not-a-number')).toBeNull()
  })
})

describe('bucketAnnualRevenue', () => {
  it('buckets across the boundaries', () => {
    expect(bucketAnnualRevenue(0)).toBe('<$1M')
    expect(bucketAnnualRevenue(999_999)).toBe('<$1M')
    expect(bucketAnnualRevenue(1_000_000)).toBe('$1M-$10M')
    expect(bucketAnnualRevenue(9_999_999)).toBe('$1M-$10M')
    expect(bucketAnnualRevenue(10_000_000)).toBe('$10M-$100M')
    expect(bucketAnnualRevenue(99_999_999)).toBe('$10M-$100M')
    expect(bucketAnnualRevenue(100_000_000)).toBe('$100M+')
  })
  it('accepts numeric strings', () => {
    expect(bucketAnnualRevenue('2500000')).toBe('$1M-$10M')
  })
  it('returns null for absent/invalid/negative', () => {
    expect(bucketAnnualRevenue(null)).toBeNull()
    expect(bucketAnnualRevenue('')).toBeNull()
    expect(bucketAnnualRevenue(-1)).toBeNull()
    expect(bucketAnnualRevenue('xyz')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: fill-empty
// ---------------------------------------------------------------------------

describe('isEmptyValue', () => {
  it('treats null/undefined/blank string as empty', () => {
    expect(isEmptyValue(null)).toBe(true)
    expect(isEmptyValue(undefined)).toBe(true)
    expect(isEmptyValue('')).toBe(true)
    expect(isEmptyValue('   ')).toBe(true)
  })
  it('treats a populated value as non-empty', () => {
    expect(isEmptyValue('x')).toBe(false)
    expect(isEmptyValue(0)).toBe(false)
    expect(isEmptyValue(false)).toBe(false)
  })
})

describe('computeFillEmptyPatch', () => {
  it('fills only empty local fields, never clobbers populated ones', () => {
    const local = { industry: 'Software', city: null, state: '' }
    const incoming = { industry: 'Fintech', city: 'NYC', state: 'NY' }
    const patch = computeFillEmptyPatch(local, incoming)
    expect(patch).toEqual({ city: 'NYC', state: 'NY' }) // industry preserved
  })

  it('ignores incoming empty values (does not blank a populated local field)', () => {
    const local = { phone: '555-1234' }
    const incoming = { phone: null }
    expect(computeFillEmptyPatch(local, incoming)).toEqual({})
  })

  it('name/domain sync from HubSpot when changed (alwaysSync exception)', () => {
    const local = { name: 'Old Co', domain: 'old.com', industry: 'X' }
    const incoming = { name: 'New Co', domain: 'new.com', industry: 'Y' }
    const patch = computeFillEmptyPatch(local, incoming, ['name', 'domain'])
    // name/domain overwrite; industry is preserved (populated).
    expect(patch).toEqual({ name: 'New Co', domain: 'new.com' })
  })

  it('does not emit an alwaysSync field when it is unchanged', () => {
    const local = { name: 'Same Co' }
    const incoming = { name: 'Same Co' }
    expect(computeFillEmptyPatch(local, incoming, ['name'])).toEqual({})
  })

  it('does not emit an alwaysSync field when incoming is empty', () => {
    const local = { name: 'Keep Me' }
    const incoming = { name: '' }
    expect(computeFillEmptyPatch(local, incoming, ['name'])).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// Pure: mapping
// ---------------------------------------------------------------------------

describe('mapCompany', () => {
  it('maps + buckets, deriving domain from website when domain absent', () => {
    const obj: HubspotObject = {
      id: 'c1',
      properties: {
        name: 'Acme',
        domain: null,
        website: 'https://www.acme.io/pricing',
        industry: 'SaaS',
        numberofemployees: '75',
        annualrevenue: '5000000',
        city: 'SF',
        state: 'CA',
        country: 'US',
        description: 'Makers of things',
      },
    }
    const m = mapCompany(obj)
    expect(m.name).toBe('Acme')
    expect(m.domain).toBe('acme.io')
    expect(m.employee_count_range).toBe('51-200')
    expect(m.annual_revenue_range).toBe('$1M-$10M')
    expect(m.city).toBe('SF')
  })
})

describe('mapContact', () => {
  it('composes full_name from first + last', () => {
    const m = mapContact({
      id: 'p1',
      properties: { email: 'Jane@Acme.io', firstname: 'Jane', lastname: 'Doe', jobtitle: 'CTO' },
    })
    expect(m.email).toBe('jane@acme.io')
    expect(m.full_name).toBe('Jane Doe')
    expect(m.job_title).toBe('CTO')
  })
  it('falls back to email for full_name when no name present', () => {
    const m = mapContact({ id: 'p2', properties: { email: 'x@y.com' } })
    expect(m.full_name).toBe('x@y.com')
  })
  it('drops a display label that carries an address (its commas would rewrite the .or() email match)', () => {
    expect(mapContact({ id: 'p5', properties: { email: 'Smith, John <john@x.com>' } }).email).toBeNull()
    expect(mapContact({ id: 'p6', properties: { email: 'a@b.co,id.neq.0' } }).email).toBeNull()
  })
  it('yields null email + null full_name when neither name nor email present', () => {
    const m = mapContact({ id: 'p3', properties: { phone: '555' } })
    expect(m.email).toBeNull()
    expect(m.full_name).toBeNull()
    expect(m.phone).toBe('555')
  })
  it('prefers phone over mobilephone', () => {
    const m = mapContact({ id: 'p4', properties: { phone: '111', mobilephone: '222' } })
    expect(m.phone).toBe('111')
    const m2 = mapContact({ id: 'p5', properties: { mobilephone: '222' } })
    expect(m2.phone).toBe('222')
  })
})

describe('shouldRecomputeFullName', () => {
  it('recomputes when local full_name is empty', () => {
    expect(shouldRecomputeFullName(null, 'a@b.com')).toBe(true)
    expect(shouldRecomputeFullName('  ', 'a@b.com')).toBe(true)
  })
  it('recomputes when local full_name equals the local email (placeholder)', () => {
    expect(shouldRecomputeFullName('a@b.com', 'a@b.com')).toBe(true)
    expect(shouldRecomputeFullName('A@B.com', 'a@b.com')).toBe(true)
  })
  it('preserves a human-entered name', () => {
    expect(shouldRecomputeFullName('Jane Doe', 'a@b.com')).toBe(false)
  })
})

describe('firstAssociatedCompanyId', () => {
  it('returns the first associated company id', () => {
    const obj: HubspotObject = {
      id: 'p1',
      properties: {},
      associations: { companies: { results: [{ id: 'co-1' }, { id: 'co-2' }] } },
    }
    expect(firstAssociatedCompanyId(obj)).toBe('co-1')
  })
  it('returns null when no associations present (search-path result)', () => {
    expect(firstAssociatedCompanyId({ id: 'p2', properties: {} })).toBeNull()
  })
})

describe('normalizeDomain', () => {
  it('strips scheme/www/path and lowercases', () => {
    expect(normalizeDomain('https://www.Acme.IO/pricing?x=1')).toBe('acme.io')
  })
  it('returns null for non-domains', () => {
    expect(normalizeDomain('acme')).toBeNull()
    expect(normalizeDomain('')).toBeNull()
    expect(normalizeDomain(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Pure: match priority + skip
// ---------------------------------------------------------------------------

describe('decideCompanyMatch', () => {
  it('hubspot-id beats domain beats insert', () => {
    expect(decideCompanyMatch({ hubspotIdMatch: true, domainMatch: true })).toBe('hubspot_id')
    expect(decideCompanyMatch({ hubspotIdMatch: false, domainMatch: true })).toBe('domain')
    expect(decideCompanyMatch({ hubspotIdMatch: false, domainMatch: false })).toBe('insert')
  })
})

describe('decideContactMatch', () => {
  it('hubspot-id beats email beats insert', () => {
    expect(decideContactMatch({ hubspotIdMatch: true, emailMatch: true })).toBe('hubspot_id')
    expect(decideContactMatch({ hubspotIdMatch: false, emailMatch: true })).toBe('email')
    expect(decideContactMatch({ hubspotIdMatch: false, emailMatch: false })).toBe('insert')
  })
})

describe('shouldSkip', () => {
  it('skips archived records', () => {
    expect(shouldSkip({ id: '1', properties: {}, archived: true })).toBe(true)
    expect(shouldSkip({ id: '1', properties: {}, archived: false })).toBe(false)
    expect(shouldSkip({ id: '1', properties: {} })).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure: buildContactPatch (full_name recompute + company link rules)
// ---------------------------------------------------------------------------

describe('buildContactPatch', () => {
  const mapped: MappedContact = {
    email: 'jane@acme.io',
    first_name: 'Jane',
    last_name: 'Doe',
    full_name: 'Jane Doe',
    phone: '555',
    job_title: 'CTO',
  }

  it('fills empty fields and recomputes full_name when local is a placeholder', () => {
    const local = {
      full_name: 'jane@acme.io', // equals email → placeholder
      email: 'jane@acme.io',
      first_name: null,
      last_name: null,
      phone: null,
      job_title: null,
      company_id: null,
    }
    const patch = buildContactPatch(local, mapped, null)
    expect(patch.full_name).toBe('Jane Doe')
    expect(patch.first_name).toBe('Jane')
    expect(patch.phone).toBe('555')
  })

  it('preserves a human-entered full_name and populated fields', () => {
    const local = {
      full_name: 'Jane The Great',
      email: 'jane@acme.io',
      first_name: 'Jane',
      last_name: 'X',
      phone: '999',
      job_title: 'VP',
      company_id: 'existing-co',
    }
    const patch = buildContactPatch(local, mapped, 'new-co')
    expect(patch.full_name).toBeUndefined() // preserved
    expect(patch.phone).toBeUndefined() // preserved
    expect(patch.company_id).toBeUndefined() // already set → not overwritten
  })

  it('sets company_id from association ONLY when currently null', () => {
    const local = { full_name: 'X', email: 'e', company_id: null }
    expect(buildContactPatch(local, mapped, 'co-1').company_id).toBe('co-1')
    const local2 = { full_name: 'X', email: 'e', company_id: 'already' }
    expect(buildContactPatch(local2, mapped, 'co-1').company_id).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// DB-layer harness: confirm upsert routing to the right branch.
// ---------------------------------------------------------------------------

/**
 * Records inserts/updates and serves per-lookup rows. Each `.from(table)`
 * returns a builder whose terminal `.maybeSingle()` resolves the row the test
 * queued for that (table, kind) pair, where kind is inferred from the columns
 * filtered on: hubspot-id match filters on provider_*_id; domain/email match
 * doesn't.
 */
function makeSupabase(opts: {
  companyByHsId?: Record<string, unknown> | null
  companyByDomain?: Record<string, unknown> | null
  contactByHsId?: Record<string, unknown> | null
  contactByEmail?: Record<string, unknown> | null
  insertedId?: string
  /**
   * Per-INSERT error queue (FIFO). Each entry replaces the success result for
   * one insert; a `{ code: '23505' }` entry simulates a lost unique-constraint
   * race so the upsert's retry path can be exercised. Once exhausted, inserts
   * succeed as normal.
   */
  insertErrors?: Array<{ code?: string; message?: string }>
  /**
   * Per-UPDATE error queue (FIFO). Each entry replaces the success result for
   * one applyUpdate call; a `{ code: '23505' }` entry simulates a concurrent
   * writer claiming the provider id (e.g. contact_hubspot_id_key) between our
   * match SELECT and this UPDATE, so the update-conflict re-match path can be
   * exercised. Once exhausted, updates succeed as normal.
   */
  updateErrors?: Array<{ code?: string; message?: string }>
  /**
   * Lookup overrides applied AFTER the first insert/update conflict resolves —
   * models "the conflicting row is now visible on the retry". Only the provided
   * keys override; the rest fall back to the base opts above.
   */
  afterConflict?: {
    companyByHsId?: Record<string, unknown> | null
    companyByDomain?: Record<string, unknown> | null
    contactByHsId?: Record<string, unknown> | null
    contactByEmail?: Record<string, unknown> | null
  }
}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = []
  const updates: Array<{ table: string; id: string; patch: Record<string, unknown> }> = []
  const insertErrors = [...(opts.insertErrors ?? [])]
  const updateErrors = [...(opts.updateErrors ?? [])]
  // Flips true once a unique-violation insert OR update has been observed, so
  // subsequent SELECTs return the `afterConflict` overrides.
  let conflicted = false

  function lookup(table: string, isHsIdLookup: boolean) {
    const pick = <T>(after: T | undefined, base: T | undefined): T | null =>
      (conflicted && after !== undefined ? after : base) ?? null
    if (table === 'company') {
      return isHsIdLookup
        ? pick(opts.afterConflict?.companyByHsId, opts.companyByHsId)
        : pick(opts.afterConflict?.companyByDomain, opts.companyByDomain)
    }
    return isHsIdLookup
      ? pick(opts.afterConflict?.contactByHsId, opts.contactByHsId)
      : pick(opts.afterConflict?.contactByEmail, opts.contactByEmail)
  }

  function builder(table: string) {
    const filters: Record<string, unknown> = {}
    let mode: 'select' | 'insert' | 'update' = 'select'
    let insertRow: Record<string, unknown> | null = null
    let updatePatch: Record<string, unknown> | null = null

    const api: Record<string, unknown> = {
      select: () => api,
      insert: (row: Record<string, unknown>) => {
        mode = 'insert'
        insertRow = row
        return api
      },
      update: (patch: Record<string, unknown>) => {
        mode = 'update'
        updatePatch = patch
        return api
      },
      eq: (k: string, v: unknown) => {
        filters[k] = v
        return api
      },
      is: (k: string, _v: unknown) => {
        filters[k] = null
        return api
      },
      or: () => api,
      limit: () => api,
      maybeSingle: async () => {
        if (mode === 'insert') {
          inserts.push({ table, row: insertRow! })
          const err = insertErrors.shift()
          if (err) {
            if (err.code === '23505') conflicted = true
            return { data: null, error: err }
          }
          return { data: { id: opts.insertedId ?? 'new-id' }, error: null }
        }
        if (mode === 'update') {
          updates.push({ table, id: String(filters.id), patch: updatePatch! })
          return { data: null, error: null }
        }
        // select — decide which lookup this is by the filters present.
        const isHsIdLookup = 'provider_company_id' in filters || 'provider_contact_id' in filters
        return { data: lookup(table, isHsIdLookup), error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        // update path is awaited directly in applyUpdate (no maybeSingle).
        if (mode === 'update') {
          updates.push({ table, id: String(filters.id), patch: updatePatch! })
          const err = updateErrors.shift()
          if (err) {
            if (err.code === '23505') conflicted = true
            return Promise.resolve({ data: null, error: err }).then(resolve)
          }
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: null, error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    client: { from: (t: string) => builder(t) } as never,
    inserts,
    updates,
  }
}

describe('upsertHubspotCompany — branch routing', () => {
  const obj: HubspotObject = {
    id: 'hs-co-1',
    properties: { name: 'Acme', domain: 'acme.io', industry: 'SaaS' },
  }

  it('skips archived companies as a no-op', async () => {
    const s = makeSupabase({})
    const res = await upsertHubspotCompany(s.client, 'ws-1', { ...obj, archived: true })
    expect(res.action).toBe('skipped')
    expect(s.inserts).toHaveLength(0)
    expect(s.updates).toHaveLength(0)
  })

  it('updates via hubspot-id match (fill-empty)', async () => {
    const s = makeSupabase({
      companyByHsId: { id: 'local-co', name: 'Acme', domain: 'acme.io', industry: null, source_provider: 'hubspot' },
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.companyId).toBe('local-co')
    expect(s.updates[0].patch.industry).toBe('SaaS') // filled empty
    expect(s.inserts).toHaveLength(0)
  })

  it('claims via domain match and fills provenance when unclaimed', async () => {
    const s = makeSupabase({
      companyByHsId: null,
      companyByDomain: { id: 'dom-co', name: 'Acme', domain: 'acme.io', source_provider: null },
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(s.updates[0].patch.source_provider).toBe(HUBSPOT_SOURCE_PROVIDER)
    expect(s.updates[0].patch.provider_company_id).toBe('hs-co-1')
  })

  it('inserts when neither match hits', async () => {
    const s = makeSupabase({ companyByHsId: null, companyByDomain: null, insertedId: 'ins-co' })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('inserted')
    expect(res.companyId).toBe('ins-co')
    expect(s.inserts[0].row.source_provider).toBe(HUBSPOT_SOURCE_PROVIDER)
    expect(s.inserts[0].row.provider_company_id).toBe('hs-co-1')
  })

  // FINDING 1: SELECT-then-INSERT race. A concurrent writer inserts the same
  // company between our lookups and our INSERT, tripping a unique constraint.
  it('retries once on a 23505 insert conflict and updates the now-visible row', async () => {
    const s = makeSupabase({
      // First pass: no match anywhere → INSERT, which loses the race (23505).
      companyByHsId: null,
      companyByDomain: null,
      insertErrors: [{ code: '23505', message: 'duplicate key' }],
      // Retry: the conflicting row (the concurrent writer's) is now visible by
      // hubspot id, so the retry updates instead of dropping the record.
      afterConflict: {
        companyByHsId: { id: 'raced-co', name: 'Acme', domain: 'acme.io', industry: null, source_provider: 'hubspot' },
      },
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.companyId).toBe('raced-co')
    // Exactly one failed insert, then the fill-empty update on the retry.
    expect(s.inserts).toHaveLength(1)
    expect(s.updates[0].id).toBe('raced-co')
    expect(s.updates[0].patch.industry).toBe('SaaS') // filled empty on retry
  })

  it('does NOT retry on a non-23505 insert error (skips)', async () => {
    const s = makeSupabase({
      companyByHsId: null,
      companyByDomain: null,
      insertErrors: [{ code: '23502', message: 'not-null violation' }],
      // Would-be retry lookup — must never be consulted.
      afterConflict: { companyByHsId: { id: 'should-not-see' } },
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    expect(s.inserts).toHaveLength(1) // no second insert
    expect(s.updates).toHaveLength(0)
  })

  it('does not loop forever: a second 23505 on the retry degrades to skip', async () => {
    const s = makeSupabase({
      // Both attempts find no match and both inserts conflict (pathological).
      companyByHsId: null,
      companyByDomain: null,
      insertErrors: [
        { code: '23505', message: 'dup' },
        { code: '23505', message: 'dup again' },
      ],
      // No afterConflict rows → the retry also finds nothing and re-inserts.
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    // Exactly two inserts (original + one retry), then it gives up.
    expect(s.inserts).toHaveLength(2)
  })

  // FINDING 2 (company parity): a claim UPDATE tripping a 23505 on the provider
  // id must re-run the match path once rather than report a phantom 'updated'.
  it('re-runs the match path once when a company claim UPDATE hits a 23505', async () => {
    const s = makeSupabase({
      // First pass: domain match → claim UPDATE loses the race (23505).
      companyByHsId: null,
      companyByDomain: { id: 'dom-co', name: 'Acme', domain: 'acme.io', source_provider: null },
      updateErrors: [{ code: '23505', message: 'duplicate provider_company_id' }],
      // Retry: the raced row is now visible by hubspot id.
      afterConflict: {
        companyByHsId: { id: 'raced-co', name: 'Acme', domain: 'acme.io', industry: null, source_provider: 'hubspot' },
      },
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.companyId).toBe('raced-co')
    expect(s.inserts).toHaveLength(0)
  })

  it('reports skipped when a company UPDATE fails with a non-23505 error', async () => {
    const s = makeSupabase({
      companyByHsId: { id: 'local-co', name: 'Acme', domain: 'acme.io', industry: null, source_provider: 'hubspot' },
      updateErrors: [{ code: '08006', message: 'connection reset' }],
    })
    const res = await upsertHubspotCompany(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    expect(res.companyId).toBe('local-co')
    expect(s.updates).toHaveLength(1)
    expect(s.inserts).toHaveLength(0)
  })
})

describe('upsertHubspotContact — branch routing + no-email path', () => {
  const obj: HubspotObject = {
    id: 'hs-p-1',
    properties: { email: 'jane@acme.io', firstname: 'Jane', lastname: 'Doe' },
  }

  it('skips archived contacts', async () => {
    const s = makeSupabase({})
    const res = await upsertHubspotContact(s.client, 'ws-1', { ...obj, archived: true })
    expect(res.action).toBe('skipped')
  })

  it('updates via hubspot-id match', async () => {
    const s = makeSupabase({
      contactByHsId: { id: 'local-p', full_name: 'jane@acme.io', email: 'jane@acme.io', company_id: null },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.id).toBe('local-p')
    expect(s.updates[0].patch.full_name).toBe('Jane Doe') // placeholder recomputed
  })

  it('claims via email match and stamps provenance', async () => {
    const s = makeSupabase({
      contactByHsId: null,
      contactByEmail: { id: 'email-p', full_name: 'Jane Doe', email: 'jane@acme.io', provider_contact_id: null },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(s.updates[0].patch.source_provider).toBe(HUBSPOT_SOURCE_PROVIDER)
    expect(s.updates[0].patch.provider_contact_id).toBe('hs-p-1')
  })

  it('inserts with hubspot_sync source when no match', async () => {
    const s = makeSupabase({ contactByHsId: null, contactByEmail: null, insertedId: 'ins-p' })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('inserted')
    expect(s.inserts[0].row.source).toBe(HUBSPOT_CONTACT_SOURCE)
    expect(s.inserts[0].row.email).toBe('jane@acme.io')
  })

  it('no-email contact: matches by hubspot-id only, inserts with null email', async () => {
    const noEmail: HubspotObject = { id: 'hs-p-2', properties: { firstname: 'No', lastname: 'Email' } }
    const s = makeSupabase({ contactByHsId: null, contactByEmail: null, insertedId: 'ins-p2' })
    const res = await upsertHubspotContact(s.client, 'ws-1', noEmail)
    expect(res.action).toBe('inserted')
    expect(s.inserts[0].row.email).toBeNull()
    expect(s.inserts[0].row.full_name).toBe('No Email')
  })

  // FINDING 2: SELECT-then-INSERT race for contacts (e.g. email-sync creating
  // the same email between our lookup and INSERT → UNIQUE(workspace_id,email)).
  it('retries once on a 23505 insert conflict and updates the now-visible row', async () => {
    const s = makeSupabase({
      contactByHsId: null,
      contactByEmail: null,
      insertErrors: [{ code: '23505', message: 'duplicate email' }],
      // Retry: the raced row is now visible by email → claim + fill-empty.
      afterConflict: {
        contactByEmail: { id: 'raced-p', full_name: 'Jane Doe', email: 'jane@acme.io', provider_contact_id: null },
      },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.id).toBe('raced-p')
    expect(s.inserts).toHaveLength(1)
    expect(s.updates[0].patch.provider_contact_id).toBe('hs-p-1') // provenance claimed on retry
  })

  it('does NOT retry a non-23505 contact insert error (skips)', async () => {
    const s = makeSupabase({
      contactByHsId: null,
      contactByEmail: null,
      insertErrors: [{ code: '23514', message: 'check violation' }],
      afterConflict: { contactByHsId: { id: 'should-not-see' } },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    expect(s.inserts).toHaveLength(1)
    expect(s.updates).toHaveLength(0)
  })

  it('does not loop forever: a second 23505 on the contact retry degrades to skip', async () => {
    const s = makeSupabase({
      contactByHsId: null,
      contactByEmail: null,
      insertErrors: [
        { code: '23505', message: 'dup' },
        { code: '23505', message: 'dup again' },
      ],
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    expect(s.inserts).toHaveLength(2)
  })

  // FINDING 2: an UPDATE (not just an INSERT) can trip a unique violation — a
  // concurrent writer claims the same provider id on contact_hubspot_id_key
  // between our email-match SELECT and the claim UPDATE. applyUpdate must surface
  // the 23505 so the full match path re-runs ONCE, landing on the now-visible
  // hubspot-id match instead of silently reporting a phantom 'updated'.
  it('re-runs the match path once when the claim UPDATE hits a 23505', async () => {
    const s = makeSupabase({
      // First pass: no hubspot-id match, but an email match → claim UPDATE, which
      // loses the race to contact_hubspot_id_key (23505).
      contactByHsId: null,
      contactByEmail: { id: 'email-p', full_name: 'Jane Doe', email: 'jane@acme.io', provider_contact_id: null },
      updateErrors: [{ code: '23505', message: 'duplicate provider_contact_id' }],
      // Retry: the concurrent writer's row is now visible by hubspot id, so the
      // second pass updates it (a fill-empty no-op here) and reports 'updated'.
      afterConflict: {
        contactByHsId: { id: 'raced-p', full_name: 'Jane Doe', email: 'jane@acme.io', company_id: null, source_provider: 'hubspot', provider_contact_id: 'hs-p-1' },
      },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('updated')
    expect(res.id).toBe('raced-p') // the now-visible raced row, not the stale email match
    // First pass attempted the claim UPDATE on the email match; the retry landed
    // on the hubspot-id branch.
    expect(s.updates[0].id).toBe('email-p')
    expect(s.inserts).toHaveLength(0)
  })

  it('reports skipped (not updated) when the claim UPDATE fails with a non-23505 error', async () => {
    const s = makeSupabase({
      contactByHsId: null,
      contactByEmail: { id: 'email-p', full_name: 'Jane Doe', email: 'jane@acme.io', provider_contact_id: null },
      updateErrors: [{ code: '08006', message: 'connection reset' }],
      // Would-be retry lookup — must never be consulted (no re-match on non-23505).
      afterConflict: { contactByHsId: { id: 'should-not-see' } },
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    // The update did not land, so the record is 'skipped', NOT falsely 'updated'.
    expect(res.action).toBe('skipped')
    expect(res.id).toBe('email-p')
    // No re-match — exactly one update attempt, no inserts.
    expect(s.updates).toHaveLength(1)
    expect(s.inserts).toHaveLength(0)
  })

  it('degrades to skip when the claim UPDATE 23505s on BOTH passes (no infinite loop)', async () => {
    const s = makeSupabase({
      // Both passes see the same email match and both claim UPDATEs conflict.
      contactByHsId: null,
      contactByEmail: { id: 'email-p', full_name: 'Jane Doe', email: 'jane@acme.io', provider_contact_id: null },
      updateErrors: [
        { code: '23505', message: 'dup' },
        { code: '23505', message: 'dup again' },
      ],
      // No afterConflict hubspot-id row → the retry re-hits the email branch.
    })
    const res = await upsertHubspotContact(s.client, 'ws-1', obj)
    expect(res.action).toBe('skipped')
    // Exactly two update attempts (original + one retry), then it gives up.
    expect(s.updates).toHaveLength(2)
  })
})
