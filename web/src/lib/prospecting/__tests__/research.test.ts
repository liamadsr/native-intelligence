/**
 * `fireIcpCard` — idempotence, own-domain anchoring, and the additive merge.
 *
 * `deepSearch` is mocked; nothing here touches the network. The three
 * properties under test are the three the function is built around:
 *   1. it fires ONCE (decision 4) — a re-run costs nothing;
 *   2. it is anchored by `includeDomains`, so it can never describe a namesake;
 *   3. it only ADDS to the blob, and it never claims to be a CRM enrichment run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, hasWorkspaceFilter, type Captured } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ deepSearch: vi.fn(), chatgptPlanFor: vi.fn(async (_userId: unknown) => false) }))

// Whether the person is on their own ChatGPT plan (the free tier), and the
// web-research agent's answer when they are.
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.chatgptPlanFor }))
vi.mock('server-only', () => ({}))
const runUtilityTask = vi.hoisted(() => vi.fn())
vi.mock('@/lib/eve/utility/run-utility', () => ({ runUtilityTask }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: vi.fn(async () => ({})) }))

vi.mock('@/lib/exa/deep-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/exa/deep-search')>()
  return { ...actual, deepSearch: hoisted.deepSearch }
})

const { fireIcpCard } = await import('../research')

const WS = 'ws-1'

/** An Exa response shaped the way `parseDeepSearchResponse` produces one. */
function exaResult(
  content: Record<string, unknown>,
  opts: { cost?: number; confidence?: 'high' | 'medium' | 'low' } = {},
) {
  return {
    requestId: 'req-1',
    content,
    grounding: Object.keys(content).map((field) => ({
      field,
      confidence: opts.confidence ?? 'high',
      citations: [{ url: `https://acme.test/${field}`, title: field }],
    })),
    results: [{ url: 'https://acme.test/about', title: 'About' }],
    costDollars: opts.cost ?? 0.012,
  }
}

interface WorldOpts {
  company?: Record<string, unknown> | null
  writeError?: { message: string } | null
  /**
   * Metadata the SECOND company SELECT returns — the re-read `fireIcpCard`
   * does immediately before merging. Models a concurrent writer (the CRM's
   * `enrichCompany`) landing on the same blob while the ICP search was in
   * flight. Absent means "nothing changed": the same row comes back twice.
   */
  metadataAfterSearch?: unknown
}

function world(opts: WorldOpts = {}) {
  const writes: Captured[] = []
  let selects = 0
  const fake = makeFakeSupabase((q) => {
    if (q.table !== 'company') return { data: null }
    if (q.op === 'update') {
      writes.push(q)
      return { data: null, error: opts.writeError ?? null }
    }
    selects++
    const row =
      opts.company === undefined
        ? { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: null }
        : opts.company
    if (selects > 1 && row && 'metadataAfterSearch' in opts) {
      return { data: { ...row, metadata: opts.metadataAfterSearch } }
    }
    return { data: row }
  })
  return { ...fake, writes, selectCount: () => selects }
}

beforeEach(() => {
  hoisted.deepSearch.mockReset()
})

describe('fireIcpCard — the skip paths', () => {
  it("a person on their own ChatGPT plan gets the card from their plan, on the company's own site, never Exa", async () => {
    hoisted.chatgptPlanFor.mockResolvedValueOnce(true)
    runUtilityTask.mockResolvedValueOnce({
      text: '', model: 'chatgpt-plan/gpt-6-luna', usage: { inputTokens: 1, outputTokens: 1 },
      object: {
        content: { targetCustomer: 'Sales teams' },
        grounding: [{ field: 'targetCustomer', citations: [{ url: 'https://acme.test/customers', title: 'Customers' }], confidence: 'high' }],
        sources: [],
      },
    })
    const { client } = world()
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toMatchObject({ status: 'fired', cost: 0, fired: true })
    expect(hoisted.chatgptPlanFor).toHaveBeenCalledWith('u1', { attempts: 2, failClosed: true })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
    const call = runUtilityTask.mock.calls[0][0] as { kind: string; message: string }
    expect(call.kind).toBe('plan_web_search')
    expect(JSON.parse(call.message).onlySites).toEqual(['acme.test'])
  })

  it("fails the card when the person's plan can't be read, never running it on Exa", async () => {
    hoisted.chatgptPlanFor.mockRejectedValueOnce(new Error('ChatGPT plan check failed: boom'))
    const { client } = world()
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toMatchObject({ status: 'failed', fired: false })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('skips a company that is not in this workspace', async () => {
    const { client } = world({ company: null })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({ status: 'skipped', reason: 'not_found', cost: 0, fired: false, fields_count: 0 })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('skips a domain-less company — there is nothing to anchor to', async () => {
    const { client } = world({ company: { id: 'co-1', name: 'Acme', domain: null, metadata: null } })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({ status: 'skipped', reason: 'no_domain', cost: 0, fired: false, fields_count: 0 })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('IS IDEMPOTENT: a blob stamped with icp_card_at costs nothing', async () => {
    const { client } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: {
          enrichment: {
            icp_card_at: '2026-09-04T00:00:00.000Z',
            fields: { target_customer: { value: 'Sales teams' } },
          },
        },
      },
    })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({
      status: 'skipped',
      reason: 'already_present',
      cost: 0,
      fired: false,
      fields_count: 0,
    })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('the guard is the STAMP, not a data field — a thin prior run still suppresses', async () => {
    // COMPANY_CARD_ICP declares `required: []` and groundedFields drops
    // absent/non-answer/low-grounding values, so a paid, successful run can
    // leave `target_customer` unset. Keying idempotence on that field would
    // leave the guard unarmed and re-bill $0.012 on every press — and this is
    // the ONLY spend control on POST /api/account/prospecting/source.
    const { client } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: {
          enrichment: {
            icp_card_at: '2026-09-04T00:00:00.000Z',
            fields: { use_cases: { value: ['Onboarding'] } }, // no target_customer
          },
        },
      },
    })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({
      status: 'skipped',
      reason: 'already_present',
      cost: 0,
      fired: false,
      fields_count: 0,
    })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('a blob with FIELDS but no stamp still fires — an old blob is not a prior run', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'Sales teams' }))
    const { client } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: { enrichment: { fields: { target_customer: { value: 'From CRM enrichment' } } } },
      },
    })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out.status).toBe('fired')
  })

  it('force overrides idempotence for an explicit refresh', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'Fresh answer' }))
    const { client } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: {
          enrichment: {
            icp_card_at: '2026-09-04T00:00:00.000Z',
            fields: { target_customer: { value: 'Stale' } },
          },
        },
      },
    })
    const out = await fireIcpCard(client, {
      workspaceId: WS,
      userId: 'u1',
      companyId: 'co-1',
      force: true,
    })
    expect(out.status).toBe('fired')
  })
})

describe('fireIcpCard — the search', () => {
  it('is own-domain ANCHORED and asks for the ICP card', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'Sales teams' }))
    const { client } = world()
    await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })

    const args = hoisted.deepSearch.mock.calls[0][0]
    expect(args.includeDomains).toEqual(['acme.test'])
    expect(args.category).toBe('company')
    expect(Object.keys(args.outputSchema.properties)).toContain('targetCustomer')
  })

  it('normalizes the domain before anchoring', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'x' }))
    const { client } = world({
      company: { id: 'co-1', name: 'Acme', domain: 'https://WWW.Acme.test/about', metadata: null },
    })
    await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(hoisted.deepSearch.mock.calls[0][0].includeDomains).toEqual(['acme.test'])
  })

  it('reports an empty card but STILL STAMPS — Exa was paid either way', async () => {
    // A thin answer is not a failure (`required: []`), and it is also not free.
    // The write carries no new fields, only the `icp_card_at` stamp and the
    // cost — which is what arms the spend guard against a second press.
    hoisted.deepSearch.mockResolvedValue(exaResult({}, { cost: 0.01 }))
    const { client, writes } = world()
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({ status: 'empty', cost: 0.01, fired: false, fields_count: 0 })
    expect(writes).toHaveLength(1)
    const enrichment = (writes[0].payload as { metadata: { enrichment: Record<string, unknown> } })
      .metadata.enrichment
    expect(typeof enrichment.icp_card_at).toBe('string')
    expect(enrichment.fields).toEqual({})
    expect(enrichment.total_cost_dollars).toBe(0.01)
  })

  it('an empty card is idempotent END TO END — the second press costs nothing', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({}, { cost: 0.01 }))
    const first = world()
    await fireIcpCard(first.client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    const written = (first.writes[0].payload as { metadata: unknown }).metadata

    // Replay the row as the next request would load it.
    const second = world({
      company: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: written },
    })
    hoisted.deepSearch.mockClear()
    const out = await fireIcpCard(second.client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toEqual({
      status: 'skipped',
      reason: 'already_present',
      cost: 0,
      fired: false,
      fields_count: 0,
    })
    expect(hoisted.deepSearch).not.toHaveBeenCalled()
  })

  it('never throws when Exa does — a list creation must survive Exa being down', async () => {
    hoisted.deepSearch.mockRejectedValue(new Error('Exa deep search failed (503)'))
    const { client, writes } = world()
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out.status).toBe('failed')
    expect(writes).toHaveLength(0)
  })
})

describe('fireIcpCard — the pre-merge RE-READ', () => {
  /*
   * The one caller kicks the full three-card CRM enrichment immediately before
   * this card, and that enrichment writes the SAME blob when it finishes.
   * Merging onto the row as loaded BEFORE the search would drop whatever
   * landed in between — the mirror image of the bug that lost the ICP fields
   * on dial8.ai's own row.
   */
  it('re-reads the row after the search and merges onto what is there NOW', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'Sales teams' }))
    const { client, writes, selectCount } = world({
      company: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: null },
      // The CRM enrichment finished mid-search and wrote its three cards.
      metadataAfterSearch: {
        company_autolinked: true,
        enrichment: {
          status: 'enriched',
          applied_fields: ['industry', 'description'],
          fields: { industry: { value: 'Developer Tools', confidence: 'high' } },
          sources: [{ url: 'https://acme.test/pricing' }],
          total_cost_dollars: 0.036,
        },
      },
    })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out.status).toBe('fired')
    // Two reads: the guard read, then the pre-merge re-read.
    expect(selectCount()).toBe(2)

    const metadata = ((writes[0].payload as Record<string, unknown>).metadata ?? {}) as Record<
      string,
      unknown
    >
    const enrichment = metadata.enrichment as Record<string, unknown>
    const fields = enrichment.fields as Record<string, { value: string }>
    // The concurrent run's field survives…
    expect(fields.industry.value).toBe('Developer Tools')
    // …alongside this card's own.
    expect(fields.target_customer.value).toBe('Sales teams')
    // …and so does every bit of its bookkeeping and its sibling keys.
    expect(enrichment.status).toBe('enriched')
    expect(enrichment.applied_fields).toEqual(['industry', 'description'])
    expect(enrichment.total_cost_dollars).toBeCloseTo(0.048, 6)
    expect((enrichment.sources as Array<{ url: string }>).map((s) => s.url)).toContain(
      'https://acme.test/pricing',
    )
    expect(metadata.company_autolinked).toBe(true)
  })

  it('falls back to the row it already holds when the re-read comes back empty', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'Sales teams' }))
    const { client, writes } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: { enrichment: { fields: { industry: { value: 'Developer Tools' } } } },
      },
      // A row that reads back with no metadata at all must not blank the blob.
      metadataAfterSearch: null,
    })
    await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    const metadata = ((writes[0].payload as Record<string, unknown>).metadata ?? {}) as Record<
      string,
      unknown
    >
    const fields = (metadata.enrichment as Record<string, unknown>).fields as Record<
      string,
      { value: string }
    >
    expect(fields.industry.value).toBe('Developer Tools')
    expect(fields.target_customer.value).toBe('Sales teams')
  })

  it('reports fired + fields_count so the caller can say whether anything landed', async () => {
    hoisted.deepSearch.mockResolvedValue(
      exaResult({ targetCustomer: 'Sales teams', buyerTitles: 'VP Sales' }),
    )
    const { client } = world()
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out).toMatchObject({ status: 'fired', fired: true, fields_count: 2 })
  })
})

describe('fireIcpCard — the write', () => {
  async function fire(existingMetadata: unknown, content: Record<string, unknown>) {
    hoisted.deepSearch.mockResolvedValue(exaResult(content))
    const { client, writes, queries } = world({
      company: { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: existingMetadata },
    })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    const payload = (writes[0]?.payload ?? {}) as Record<string, unknown>
    const metadata = (payload.metadata ?? {}) as Record<string, unknown>
    return {
      out,
      payload,
      enrichment: (metadata.enrichment ?? {}) as Record<string, unknown>,
      metadata,
      queries,
      writes,
    }
  }

  it('writes the card fields snake-cased into the blob', async () => {
    const { out, enrichment } = await fire(null, {
      targetCustomer: 'Series A-C sales teams',
      buyerTitles: 'VP Sales',
    })
    expect(out.status).toBe('fired')
    const fields = enrichment.fields as Record<string, { value: string }>
    expect(fields.target_customer.value).toBe('Series A-C sales teams')
    expect(fields.buyer_titles.value).toBe('VP Sales')
  })

  it('is ADDITIVE: fields an earlier enrichment found survive untouched', async () => {
    const { enrichment } = await fire(
      {
        enrichment: {
          status: 'enriched',
          applied_fields: ['industry'],
          fields: { industry: { value: 'Developer Tools', confidence: 'high', found_at: '2026-01-01' } },
        },
      },
      { targetCustomer: 'Sales teams' },
    )
    const fields = enrichment.fields as Record<string, { value: string; found_at?: string }>
    expect(fields.industry.value).toBe('Developer Tools')
    expect(fields.industry.found_at).toBe('2026-01-01')
    expect(fields.target_customer.value).toBe('Sales teams')
  })

  it('never displaces a higher-confidence fact with a lower-confidence one', async () => {
    hoisted.deepSearch.mockResolvedValue(
      exaResult({ targetCustomer: 'A guess' }, { confidence: 'low' }),
    )
    const { client, writes } = world({
      company: {
        id: 'co-1',
        name: 'Acme',
        domain: 'acme.test',
        metadata: {
          enrichment: { fields: { target_customer: { value: 'Verified', confidence: 'high' } } },
        },
      },
    })
    await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1', force: true })
    const metadata = ((writes[0].payload as Record<string, unknown>).metadata ?? {}) as Record<string, unknown>
    const fields = (metadata.enrichment as Record<string, unknown>).fields as Record<
      string,
      { value: string }
    >
    expect(fields.target_customer.value).toBe('Verified')
  })

  it('does NOT claim to be a CRM enrichment run', async () => {
    const { payload, enrichment } = await fire(
      { enrichment: { status: 'failed', attempts: 2, applied_fields: ['industry'] } },
      { targetCustomer: 'Sales teams' },
    )
    // No column write, no enrichment_status / enriched_at churn: a $0.012
    // side-search must not look like the full three-card pipeline completing.
    expect(payload.enrichment_status).toBeUndefined()
    expect(payload.enriched_at).toBeUndefined()
    // …and the existing enrichment bookkeeping survives.
    expect(enrichment.status).toBe('failed')
    expect(enrichment.attempts).toBe(2)
    expect(enrichment.applied_fields).toEqual(['industry'])
    expect(typeof enrichment.icp_card_at).toBe('string')
  })

  it('preserves sibling metadata keys that live beside enrichment', async () => {
    const { metadata } = await fire(
      { company_autolinked: true, hubspot_push_error: 'nope' },
      { targetCustomer: 'Sales teams' },
    )
    expect(metadata.company_autolinked).toBe(true)
    expect(metadata.hubspot_push_error).toBe('nope')
  })

  it('accumulates the cost total across runs', async () => {
    const { enrichment } = await fire(
      { enrichment: { total_cost_dollars: 0.05 } },
      { targetCustomer: 'Sales teams' },
    )
    expect(enrichment.total_cost_dollars).toBeCloseTo(0.062, 6)
  })

  it('merges citations ahead of the existing ones, de-duplicated', async () => {
    const { enrichment } = await fire(
      { enrichment: { sources: [{ url: 'https://old.test' }, { url: 'https://acme.test/about' }] } },
      { targetCustomer: 'Sales teams' },
    )
    const urls = (enrichment.sources as Array<{ url: string }>).map((s) => s.url)
    expect(urls[0]).toBe('https://acme.test/targetCustomer')
    expect(urls.filter((u) => u === 'https://acme.test/about')).toHaveLength(1)
    expect(urls).toContain('https://old.test')
  })

  it('reports a write failure rather than claiming success', async () => {
    hoisted.deepSearch.mockResolvedValue(exaResult({ targetCustomer: 'x' }))
    const { client } = world({ writeError: { message: 'permission denied' } })
    const out = await fireIcpCard(client, { workspaceId: WS, userId: 'u1', companyId: 'co-1' })
    expect(out.status).toBe('failed')
  })

  it('scopes both the read and the write to the workspace', async () => {
    const { queries } = await fire(null, { targetCustomer: 'x' })
    for (const q of queries.filter((q) => q.table === 'company')) {
      expect(hasWorkspaceFilter(q, WS)).toBe(true)
    }
  })
})
