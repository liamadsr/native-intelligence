import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/crm-enrichment.ts via the createFunction-capture
 * pattern (canonical: hubspot-push-sweep.test.ts).
 *
 * This module registers TWO functions, one per entity, and nothing else:
 * enrichment runs only when a person asks (the Enrich button, the chat's
 * enrich_contact, Prospecting establishing a company). The background lane
 * the half-hourly sweep fed is gone, and its events must stay unregistered.
 *
 * Invariants locked in:
 *  - Exactly two registrations, with the expected ids and one `.manual`
 *    trigger each.
 *  - Both keep the SHARED retry count and per-workspace concurrency limit 2.
 *    The retry count is asserted against ENRICHMENT_INNGEST_RETRIES rather
 *    than a literal 2 so the stub can't drift from the lib.
 *  - Neither is throttled: runs are human-paced.
 */

type Handler = (ctx: unknown) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  registrations: [] as Array<{ config: Record<string, unknown>; handler: Handler }>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, handler: Handler) => {
      hoisted.registrations.push({ config, handler })
      return { id: config.id }
    },
  },
}))

vi.mock('@/lib/inngest/usage-guard', () => ({
  guardBackgroundUsageOnPlan: vi.fn(async () => ({ chatgptPlan: false })),
}))

// The Activity row of a manual click (src/lib/work/enrichment-mirror.ts).
const hoistedLedger = vi.hoisted(() => ({
  stepManualEnrichment: vi.fn(async () => {}),
  settleManualEnrichment: vi.fn(async () => {}),
  db: { from: () => ({}) },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoistedLedger.db }))
// A refused run gives its row back (src/lib/crm/manual-enrichment.ts).
const hoistedRelease = vi.hoisted(() => ({ releasePendingEnrichment: vi.fn(async () => {}) }))
vi.mock('@/lib/crm/manual-enrichment', () => ({ releasePendingEnrichment: hoistedRelease.releasePendingEnrichment }))
vi.mock('@/lib/work/enrichment-mirror', () => ({
  stepManualEnrichment: hoistedLedger.stepManualEnrichment,
  settleManualEnrichment: hoistedLedger.settleManualEnrichment,
}))

// The retry count is REAL, not a stub: crm-enrichment.ts reads it from the lib.
// Omitting it here would make every `retries:` undefined and the assertion
// below vacuous.
vi.mock('@/lib/crm/enrichment', () => ({
  enrichContact: vi.fn(),
  enrichCompany: vi.fn(),
  ENRICHMENT_INNGEST_RETRIES: 2,
}))

const { ENRICHMENT_INNGEST_RETRIES } = await import('@/lib/crm/enrichment')
// The line above resolves to the MOCK, so it only anchors the assertion if the
// mock still matches the real module. Import the unmocked lib once and check.
const REAL_RETRIES = (
  await vi.importActual<typeof import('@/lib/crm/enrichment')>('@/lib/crm/enrichment')
).ENRICHMENT_INNGEST_RETRIES
await import('@/lib/inngest/crm-enrichment')

const byId = (id: string) => hoisted.registrations.find((r) => r.config.id === id)

describe('crm-enrichment — registration', () => {
  it('registers exactly the two on-request function ids', () => {
    expect(hoisted.registrations.map((r) => r.config.id).sort()).toEqual([
      'crm-enrich-company-manual',
      'crm-enrich-contact-manual',
    ])
  })

  it.each([
    ['crm-enrich-contact-manual', 'crm/enrich-contact.manual'],
    ['crm-enrich-company-manual', 'crm/enrich-company.manual'],
  ])('%s is triggered only by %s', (id, event) => {
    expect(byId(id)?.config.triggers).toEqual([{ event }])
  })

  it('registers nothing for the old background events (no automatic enrichment)', () => {
    const events = hoisted.registrations.flatMap((r) => (r.config.triggers as Array<{ event: string }>).map((t) => t.event))
    expect(events).not.toContain('crm/enrich-contact')
    expect(events).not.toContain('crm/enrich-company')
  })

  it('mocks the retry count faithfully — the stub must track the real module', () => {
    expect(ENRICHMENT_INNGEST_RETRIES).toBe(REAL_RETRIES)
  })

  it('keeps retries and the per-workspace concurrency ceiling, and no throttle', () => {
    expect(hoisted.registrations).toHaveLength(2)
    for (const { config } of hoisted.registrations) {
      expect(config.retries).toBe(ENRICHMENT_INNGEST_RETRIES)
      expect(config.concurrency).toEqual([{ limit: 2, key: 'event.data.workspaceId' }])
      expect(config.throttle).toBeUndefined()
    }
  })
})

const enrichLib = await import('@/lib/crm/enrichment')
const usageGuard = await import('@/lib/inngest/usage-guard')

describe('crm-enrichment — a manual click’s Activity row', () => {
  const enrichContact = vi.mocked(enrichLib.enrichContact)
  const enrichCompany = vi.mocked(enrichLib.enrichCompany)

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('starts the row, runs the search, and settles the row with its outcome', async () => {
    const outcome = { status: 'enriched', applied: [{ field: 'title' }] }
    enrichContact.mockResolvedValueOnce(outcome as never)
    const step = createStepMock()
    await byId('crm-enrich-contact-manual')!.handler({
      event: { data: { contactId: 'c1', workspaceId: 'w1', userId: 'u1', allowSelf: true, workRunKey: 'manual:contact:c1:k' } },
      step,
    })
    expect(step.run.mock.calls.map((c) => c[0])).toEqual(['ledger-start', 'enrich-contact', 'ledger-settle'])
    expect(hoistedLedger.stepManualEnrichment).toHaveBeenCalledWith(hoistedLedger.db, 'manual:contact:c1:k')
    expect(hoistedLedger.settleManualEnrichment).toHaveBeenCalledWith(hoistedLedger.db, 'manual:contact:c1:k', outcome, {
      workspaceId: 'w1',
      table: 'contact',
      recordId: 'c1',
    })
  })

  it('settles a company click against the company', async () => {
    enrichCompany.mockResolvedValueOnce({ status: 'failed', error: 'Exa 502' } as never)
    await byId('crm-enrich-company-manual')!.handler({
      event: { data: { companyId: 'co1', workspaceId: 'w1', userId: 'u1', workRunKey: 'manual:company:co1:k' } },
      step: createStepMock(),
    })
    expect(hoistedLedger.settleManualEnrichment).toHaveBeenCalledWith(
      hoistedLedger.db,
      'manual:company:co1:k',
      { status: 'failed', error: 'Exa 502' },
      { workspaceId: 'w1', table: 'company', recordId: 'co1' },
    )
  })

  it('a run with no run key (Prospecting establishing a company) touches no ledger row', async () => {
    enrichContact.mockResolvedValueOnce({ status: 'enriched', applied: [] } as never)
    const step = createStepMock()
    await byId('crm-enrich-contact-manual')!.handler({ event: { data: { contactId: 'c1', workspaceId: 'w1', userId: 'u1' } }, step })
    expect(step.run.mock.calls.map((c) => c[0])).toEqual(['enrich-contact'])
    expect(hoistedLedger.stepManualEnrichment).not.toHaveBeenCalled()
    expect(hoistedLedger.settleManualEnrichment).not.toHaveBeenCalled()
  })

  it('a click the usage guard blocks is skipped with the reason, and the block still throws', async () => {
    vi.mocked(usageGuard.guardBackgroundUsageOnPlan).mockRejectedValueOnce(new Error('Usage limit reached'))
    const step = createStepMock()
    await expect(
      byId('crm-enrich-contact-manual')!.handler({
        event: { data: { contactId: 'c1', workspaceId: 'w1', userId: 'u1', workRunKey: 'manual:contact:c1:k' } },
        step,
      }),
    ).rejects.toThrow('Usage limit reached')
    expect(step.run.mock.calls.map((c) => c[0])).toEqual(['release-blocked', 'ledger-blocked'])
    // The row was marked pending for a run that won't happen: given back.
    expect(hoistedRelease.releasePendingEnrichment).toHaveBeenCalledWith(hoistedLedger.db, { table: 'contact', id: 'c1', workspaceId: 'w1' })
    expect(hoistedLedger.settleManualEnrichment).toHaveBeenCalledWith(
      hoistedLedger.db,
      'manual:contact:c1:k',
      { status: 'skipped', reason: 'usage_limit_reached' },
      { workspaceId: 'w1', table: 'contact', recordId: 'c1' },
    )
    expect(enrichContact).not.toHaveBeenCalled()
  })
})
