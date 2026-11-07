/**
 * `establishAndResearchSourceCompany` — the "Learn about my company" sequence,
 * extracted from `POST /api/account/prospecting/source` so the route and the
 * Scout agent's `research_my_company` tool can share ONE implementation.
 *
 * These tests pin the behaviour the route's own suite used to pin at the HTTP
 * layer: the four steps happen in order, the enrichment is the SAME
 * mark-pending + interactive-lane event the CRM's Sparkles button sends, the
 * ICP card fires exactly once, the source is re-read AFTER the card, and a
 * personal-webmail caller with no domain gets NEEDS_DOMAIN rather than a
 * success that did nothing.
 *
 * The route tests (`src/app/api/account/prospecting/__tests__/routes.test.ts`)
 * still pass unchanged, because they mock the same lib modules this function
 * calls — which is the proof the extraction was behaviour-preserving.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const hoisted = vi.hoisted(() => ({
  resolveSourceCompany: vi.fn(),
  establishSourceCompany: vi.fn(),
  suggestedDomainFor: vi.fn(),
  fireIcpCard: vi.fn(),
  hasPermanentFailure: vi.fn(),
  inngestSend: vi.fn(),
  companyMaybeSingle: vi.fn(),
  companyUpdate: vi.fn(),
}))

vi.mock('@/lib/prospecting/source-company', () => ({
  resolveSourceCompany: hoisted.resolveSourceCompany,
  establishSourceCompany: hoisted.establishSourceCompany,
  suggestedDomainFor: hoisted.suggestedDomainFor,
}))
vi.mock('@/lib/prospecting/research', () => ({ fireIcpCard: hoisted.fireIcpCard }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))
vi.mock('@/lib/crm/enrichment', async () => ({
  ...(await vi.importActual<typeof import('@/lib/crm/enrichment')>('@/lib/crm/enrichment')),
  hasPermanentFailure: hoisted.hasPermanentFailure,
}))

const { establishAndResearchSourceCompany } = await import('../establish')

const WS = 'ws-1'
const USER = 'user-1'
const EMAIL = 'ada@acme.test'

const SOURCE = { id: 'co-1', name: 'Acme', domain: 'acme.test', metadata: null }

/** The only two things the function does on the client itself: read the
 *  company's enrichment status, and mark it pending. Both filters are
 *  recorded so a test can prove the workspace scope travelled. */
const filters: Array<{ op: string; args: unknown[][] }> = []

const service = {
  from: () => ({
    select: () => ({
      eq: (...a1: unknown[]) => ({
        eq: (...a2: unknown[]) => ({
          maybeSingle: async () => {
            filters.push({ op: 'select', args: [a1, a2] })
            return hoisted.companyMaybeSingle()
          },
        }),
      }),
    }),
    update: (payload: unknown) => ({
      eq: (...a1: unknown[]) => ({
        eq: async (...a2: unknown[]) => {
          filters.push({ op: 'update', args: [a1, a2] })
          return hoisted.companyUpdate(payload)
        },
      }),
    }),
  }),
} as unknown as SupabaseClient

const args = (over: Record<string, unknown> = {}) => ({
  workspaceId: WS,
  userId: USER,
  userEmail: EMAIL,
  ...over,
})

beforeEach(() => {
  for (const fn of Object.values(hoisted)) fn.mockReset()
  filters.length = 0
  hoisted.companyMaybeSingle.mockResolvedValue({
    data: { id: 'co-1', enrichment_status: null, metadata: null },
    error: null,
  })
  hoisted.companyUpdate.mockResolvedValue({ error: null })
  hoisted.hasPermanentFailure.mockReturnValue(false)
  hoisted.fireIcpCard.mockResolvedValue({
    status: 'fired',
    fields: ['target_customer'],
    cost: 0.012,
    fired: true,
    fields_count: 1,
  })
  hoisted.suggestedDomainFor.mockImplementation((email: string | null) =>
    email && email.endsWith('@acme.test') ? 'acme.test' : null,
  )
})

describe('establishAndResearchSourceCompany — the already-resolved path', () => {
  it('does NOT establish when a company resolves and no domain was given', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({
      company: SOURCE,
      resolved_by: 'self_contact',
    })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(hoisted.establishSourceCompany).not.toHaveBeenCalled()
    expect(out.established).toBe(false)
    expect(out.company_id).toBe('co-1')
  })

  it('re-reads the source AFTER the card, so callers seed from the row as it now stands', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'self_contact' })
      .mockResolvedValueOnce({
        company: {
          ...SOURCE,
          metadata: {
            enrichment: { fields: { target_customer: { value: 'B2B sales teams' } } },
          },
        },
        resolved_by: 'self_contact',
      })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // Two resolves: one before, one after. The RETURNED source is the second.
    expect(hoisted.resolveSourceCompany).toHaveBeenCalledTimes(2)
    expect((out.source as { metadata: unknown }).metadata).toBeTruthy()
    // And the card ran between them.
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)
  })

  it('reports the idempotent skip rather than pretending it searched', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.fireIcpCard.mockResolvedValue({
      status: 'skipped',
      reason: 'already_present',
      cost: 0,
      fired: false,
      fields_count: 0,
    })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.icp_card).toMatchObject({ status: 'skipped', reason: 'already_present', cost: 0 })
  })
})

describe('establishAndResearchSourceCompany — establishing', () => {
  it('establishes from the email domain when nothing resolved, then enriches and cards', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: null, resolved_by: 'none' })
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'is_workspace_company' })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: true,
      companyId: 'co-1',
      domain: 'acme.test',
      created: true,
      contactLinked: true,
    })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return

    expect(hoisted.establishSourceCompany.mock.calls[0][1]).toEqual({
      workspaceId: WS,
      userId: USER,
      domain: 'acme.test',
    })
    // The SAME mark-pending + interactive-lane event the Sparkles button sends.
    expect(hoisted.companyUpdate).toHaveBeenCalledWith({ enrichment_status: 'pending' })
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/enrich-company.manual',
      data: { companyId: 'co-1', workspaceId: WS, userId: USER },
    })
    expect(out.established).toBe(true)
    expect(out.enrichment).toBe('started')
  })

  it('an explicit domain wins over the email domain, and RE-POINTS an already-resolved workspace', async () => {
    hoisted.resolveSourceCompany
      .mockResolvedValueOnce({ company: SOURCE, resolved_by: 'is_workspace_company' })
      .mockResolvedValueOnce({
        company: { ...SOURCE, id: 'co-2', domain: 'dial8.ai' },
        resolved_by: 'is_workspace_company',
      })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: true,
      companyId: 'co-2',
      domain: 'dial8.ai',
      created: true,
      contactLinked: false,
    })

    const out = await establishAndResearchSourceCompany(service, args({ domain: ' dial8.ai ' }))
    expect(out.ok).toBe(true)
    if (!out.ok) return
    // Trimmed, and it ran even though a company already resolved.
    expect(hoisted.establishSourceCompany.mock.calls[0][1].domain).toBe('dial8.ai')
    // Everything downstream targets the NEW row.
    expect(hoisted.fireIcpCard.mock.calls[0][1].companyId).toBe('co-2')
    expect(out.company_id).toBe('co-2')
    expect(out.established).toBe(true)
  })

  it('every read and write carries the workspace filter', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    await establishAndResearchSourceCompany(service, args())
    expect(filters.length).toBeGreaterThan(0)
    for (const f of filters) {
      const flat = f.args.flat()
      expect(flat).toContain('workspace_id')
      expect(flat).toContain(WS)
    }
  })
})

describe('establishAndResearchSourceCompany — the refusals', () => {
  it('a personal-webmail caller with no domain gets NEEDS_DOMAIN, and nothing is billed', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.suggestedDomainFor.mockReturnValue(null)

    const out = await establishAndResearchSourceCompany(
      service,
      args({ userEmail: 'ada@gmail.com' }),
    )
    expect(out).toMatchObject({ ok: false, code: 'NEEDS_DOMAIN' })
    expect(hoisted.establishSourceCompany).not.toHaveBeenCalled()
    expect(hoisted.fireIcpCard).not.toHaveBeenCalled()
  })

  it('passes an establish refusal through with its code, spending nothing', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: null, resolved_by: 'none' })
    hoisted.establishSourceCompany.mockResolvedValue({
      ok: false,
      code: 'PERSONAL_DOMAIN',
      error: 'That is a personal email provider, not a company website',
    })

    const out = await establishAndResearchSourceCompany(service, args({ domain: 'gmail.com' }))
    expect(out).toMatchObject({ ok: false, code: 'PERSONAL_DOMAIN' })
    expect(hoisted.fireIcpCard).not.toHaveBeenCalled()
  })

  it('an empty-string domain is treated as "no domain given", not as a domain', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    const out = await establishAndResearchSourceCompany(service, args({ domain: '   ' }))
    expect(out.ok).toBe(true)
    // A blank string must not trigger the re-point path.
    expect(hoisted.establishSourceCompany).not.toHaveBeenCalled()
  })
})

describe('establishAndResearchSourceCompany — the enrichment side effect degrades', () => {
  it('does not re-bill an already-enriched company', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.companyMaybeSingle.mockResolvedValue({
      data: { id: 'co-1', enrichment_status: 'enriched', metadata: null },
      error: null,
    })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.enrichment).toBe('already')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    // The card still fires — it is a different, idempotent search.
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)
  })

  it('a permanent enrichment failure is skipped, not retried forever', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.hasPermanentFailure.mockReturnValue(true)

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.enrichment).toBe('skipped')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a failed pending-mark degrades to skipped rather than failing the whole sequence', async () => {
    hoisted.resolveSourceCompany.mockResolvedValue({ company: SOURCE, resolved_by: 'self_contact' })
    hoisted.companyUpdate.mockResolvedValue({ error: { message: 'nope' } })

    const out = await establishAndResearchSourceCompany(service, args())
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.enrichment).toBe('skipped')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
    // The ICP card still runs — the two are independent.
    expect(hoisted.fireIcpCard).toHaveBeenCalledTimes(1)
  })
})
