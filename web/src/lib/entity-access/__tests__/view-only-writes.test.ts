/**
 * A per-item grant (migration 492) is VIEW ONLY. Two routes read a record
 * with the person's own client and then write it with the service role, so a
 * grant that let them read it would have let them write it:
 *   - POST /api/account/contacts/[id]/merge (merge_contacts, service role);
 *   - POST /api/account/companies/[id]/enrich (the enrichment run writes the
 *     company back service-role).
 * And the service-role contact write tools gate on the contact twin without
 * its grant arm (since 498, contact_editable_by: the EDIT rule). This pins:
 *   - anySeenOnlyByGrant asks entity_grant_only (494) per id and fails closed;
 *   - isContactWritableTo asks contact_editable_by and fails closed;
 *   - the merge refuses (404, no merge) when either contact is grant-only;
 *   - the company enrich goes ahead only when its claim marked a row (494's
 *     restrictive update policy marks none for a grant-only reader): 404, no
 *     Activity row, no event.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  inngestSend: vi.fn(),
  openManualEnrichment: vi.fn(),
  settleManualEnrichment: vi.fn(),
  mergeContactPair: vi.fn(),
  grantOnly: new Set<string>(),
  rpcCalls: [] as Array<{ fn: string; args: Record<string, unknown> }>,
  contactRows: [] as Array<Record<string, unknown>>,
  company: null as Record<string, unknown> | null,
  companyMarks: 1,
}))

function chainOf(result: () => { data: unknown; error: null }) {
  const c: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'update']) c[m] = () => c
  c.maybeSingle = () => Promise.resolve(result())
  c.single = () => Promise.resolve(result())
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve)
  return c
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      hoisted.rpcCalls.push({ fn, args })
      if (fn === 'entity_grant_only') return { data: hoisted.grantOnly.has(args.p_id as string), error: null }
      return { data: null, error: { message: `unexpected rpc ${fn}` } }
    },
    from: (table: string) => {
      if (table === 'member') return chainOf(() => ({ data: { id: 'm-1' }, error: null }))
      if (table === 'contact') return chainOf(() => ({ data: hoisted.contactRows, error: null }))
      if (table === 'company') {
        // The read answers the row; the claim (update … select) answers the rows it marked.
        let updating = false
        const c: Record<string, unknown> = {}
        for (const m of ['eq', 'in']) c[m] = () => c
        c.select = () => c
        c.update = () => {
          updating = true
          return c
        }
        c.maybeSingle = () => Promise.resolve({ data: hoisted.company, error: null })
        c.then = (resolve: (v: unknown) => unknown) =>
          Promise.resolve({
            data: updating ? Array.from({ length: hoisted.companyMarks }, () => ({ id: 'co-1' })) : hoisted.company,
            error: null,
          }).then(resolve)
        return c
      }
      throw new Error(`unexpected table ${table}`)
    },
  }),
}))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.inngestSend } }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ service: true }) }))
vi.mock('@/lib/work/enrichment-mirror', () => ({
  openManualEnrichment: hoisted.openManualEnrichment,
  settleManualEnrichment: hoisted.settleManualEnrichment,
}))
vi.mock('@/lib/crm/contact-dedup', () => ({ mergeContactPair: hoisted.mergeContactPair }))

const { anySeenOnlyByGrant } = await import('../grants')
const { isContactWritableTo } = await import('@/lib/crm/contact-visibility')
const { POST: mergePOST } = await import('@/app/api/account/contacts/[id]/merge/route')
const { POST: enrichPOST } = await import('@/app/api/account/companies/[id]/enrich/route')

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  hoisted.mergeContactPair.mockResolvedValue({ ok: true, targetId: 'ct-a' })
  hoisted.openManualEnrichment.mockResolvedValue('run-1')
  hoisted.inngestSend.mockResolvedValue(undefined)
  hoisted.grantOnly = new Set()
  hoisted.rpcCalls = []
  hoisted.contactRows = [
    { id: 'ct-a', merged_into_contact_id: null },
    { id: 'ct-b', merged_into_contact_id: null },
  ]
  hoisted.company = { id: 'co-1', metadata: {}, name: 'Fernhill Studio' }
  hoisted.companyMarks = 1
})

const rpcClient = (answer: (fn: string, args: Record<string, unknown>) => unknown) =>
  ({ rpc: vi.fn(async (fn: string, args: Record<string, unknown>) => answer(fn, args)) }) as unknown as SupabaseClient

describe('anySeenOnlyByGrant (entity_grant_only, migration 494)', () => {
  it('asks once per distinct id and is true when any one is grant-only', async () => {
    const supabase = rpcClient((_fn, args) => ({ data: args.p_id === 'ct-b', error: null }))
    expect(await anySeenOnlyByGrant(supabase, 'contact', ['ct-a', 'ct-b', 'ct-a'])).toBe(true)
    expect((supabase.rpc as ReturnType<typeof vi.fn>).mock.calls).toEqual([
      ['entity_grant_only', { p_type: 'contact', p_id: 'ct-a' }],
      ['entity_grant_only', { p_type: 'contact', p_id: 'ct-b' }],
    ])
    expect(await anySeenOnlyByGrant(rpcClient(() => ({ data: false, error: null })), 'contact', ['ct-a'])).toBe(false)
  })

  it('fails closed: an error, a non-boolean or a throw counts as grant-only', async () => {
    expect(await anySeenOnlyByGrant(rpcClient(() => ({ data: null, error: { message: 'down' } })), 'company', ['co-1'])).toBe(true)
    expect(await anySeenOnlyByGrant(rpcClient(() => ({ data: null, error: null })), 'company', ['co-1'])).toBe(true)
    const thrown = rpcClient(() => {
      throw new Error('boom')
    })
    expect(await anySeenOnlyByGrant(thrown, 'company', ['co-1'])).toBe(true)
  })
})

describe('isContactWritableTo (contact_editable_by, migration 498)', () => {
  it('asks the edit rule for the user, keeps only `true`, and fails closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const yes = rpcClient(() => ({ data: true, error: null }))
    expect(await isContactWritableTo(yes, 'ct-a', 'user-1')).toBe(true)
    expect((yes.rpc as ReturnType<typeof vi.fn>).mock.calls[0]).toEqual([
      'contact_editable_by',
      { p_contact_id: 'ct-a', p_user_id: 'user-1' },
    ])
    expect(await isContactWritableTo(rpcClient(() => ({ data: 'yes', error: null })), 'ct-a', 'user-1')).toBe(false)
    expect(await isContactWritableTo(rpcClient(() => ({ data: null, error: { message: 'down' } })), 'ct-a', 'user-1')).toBe(false)
  })
})

describe('POST /api/account/contacts/[id]/merge', () => {
  const merge = () =>
    mergePOST(
      buildRequest({ url: 'https://dial8.ai/api/account/contacts/ct-a/merge', method: 'POST', body: { source_id: 'ct-b' } }) as unknown as NextRequest,
      { params: Promise.resolve({ id: 'ct-a' }) },
    )

  it('merges two contacts the person may write', async () => {
    const res = await merge()
    expect(res?.status).toBe(200)
    expect(hoisted.mergeContactPair).toHaveBeenCalledTimes(1)
  })

  it('refuses when either contact is readable only through a grant: 404, nothing merged', async () => {
    for (const id of ['ct-a', 'ct-b']) {
      hoisted.grantOnly = new Set([id])
      const res = await merge()
      expect(res?.status, id).toBe(404)
    }
    expect(hoisted.mergeContactPair).not.toHaveBeenCalled()
  })
})

describe('POST /api/account/companies/[id]/enrich', () => {
  const enrich = () =>
    enrichPOST(buildRequest({ url: 'https://dial8.ai/api/account/companies/co-1/enrich', method: 'POST' }) as unknown as NextRequest, {
      params: Promise.resolve({ id: 'co-1' }),
    })

  it('queues the run when its claim marked the row', async () => {
    const res = await enrich()
    expect(res.status).toBe(202)
    expect(hoisted.inngestSend).toHaveBeenCalledTimes(1)
  })

  it('a claim that marks nothing (a grant-only reader) is 404: no Activity row, no event', async () => {
    hoisted.companyMarks = 0
    const res = await enrich()
    expect(res.status).toBe(404)
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })
})
