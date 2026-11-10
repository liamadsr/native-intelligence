/**
 * POST /api/account/contacts/[id]/enrich — the Enrich button. The work is
 * startContactEnrichment (src/lib/crm/manual-enrichment.ts), shared with the
 * chat's enrich_contact tool; this pins the route's HTTP behaviour over it:
 *   - 401 without a session, 400 without a workspace, 404 for a row outside
 *     the workspace (the SELECT under the caller's own client), 500 on a read
 *     or mark error;
 *   - 409 ENRICHMENT_PERMANENTLY_FAILED for a permanently-failed row, with no
 *     mark, no Activity row and no event;
 *   - 202 { status: 'pending' }: the row marked pending, the Activity row
 *     opened for the clicker, crm/enrich-contact.manual sent with its run key
 *     and allowSelf; an already-enriched row is a refresh, not refused;
 *   - a failed send settles the Activity row failed and throws (a 500).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  inngestSend: vi.fn(),
  openManualEnrichment: vi.fn(),
  settleManualEnrichment: vi.fn(),
  row: null as Record<string, unknown> | null,
  selectError: null as { message: string } | null,
  updateError: null as { message: string } | null,
  claimedNone: false,
  updates: [] as Array<Record<string, unknown>>,
  filters: [] as Array<[string, unknown]>,
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: hoisted.getUser },
    from: (table: string) => {
      if (table !== 'contact') throw new Error(`unexpected table ${table}`)
      return {
        select: () => ({
          eq: (k: string, v: unknown) => {
            hoisted.filters.push([k, v])
            return {
              eq: (k2: string, v2: unknown) => {
                hoisted.filters.push([k2, v2])
                return { maybeSingle: () => Promise.resolve({ data: hoisted.row, error: hoisted.selectError }) }
              },
            }
          },
        }),
        // The claim: update … .eq(id).eq(workspace).or(not pending).select('id').
        update: (patch: Record<string, unknown>) => {
          hoisted.updates.push(patch)
          const claimed = { data: hoisted.updateError || hoisted.claimedNone ? [] : [{ id: 'ct-1' }], error: hoisted.updateError }
          return { eq: () => ({ eq: () => ({ or: () => ({ select: () => Promise.resolve(claimed) }) }) }) }
        },
      }
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

const { POST } = await import('@/app/api/account/contacts/[id]/enrich/route')

function post(id = 'ct-1') {
  const req = buildRequest({ url: `https://nativeintelligence.dev/api/account/contacts/${id}/enrich`, method: 'POST' }) as unknown as NextRequest
  return POST(req, { params: Promise.resolve({ id }) })
}

const CONTACT = { id: 'ct-1', full_name: 'Dana Lee', email: 'dana@acme.com', metadata: {} }

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
  hoisted.openManualEnrichment.mockResolvedValue('manual:contact:ct-1:run')
  hoisted.settleManualEnrichment.mockResolvedValue(undefined)
  hoisted.row = { ...CONTACT }
  hoisted.selectError = null
  hoisted.updateError = null
  hoisted.claimedNone = false
  hoisted.updates = []
  hoisted.filters = []
})

describe('POST /api/account/contacts/[id]/enrich', () => {
  it('401 without a session, 400 without a workspace, 404 outside the workspace', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await post()).status).toBe(401)
    hoisted.getCurrentWorkspaceId.mockResolvedValueOnce(null)
    expect((await post()).status).toBe(400)
    hoisted.row = null
    const res = await post()
    expect(res.status).toBe(404)
    expect((await res.json()).error).toBe('Contact not found')
    expect(hoisted.updates).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('500 on a read error or a failed pending mark', async () => {
    hoisted.selectError = { message: 'read failed' }
    let res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('read failed')
    hoisted.selectError = null
    hoisted.updateError = { message: 'mark failed' }
    res = await post()
    expect(res.status).toBe(500)
    expect((await res.json()).error).toBe('mark failed')
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('409 for a permanently-failed contact: no mark, no Activity row, no event', async () => {
    hoisted.row = { ...CONTACT, metadata: { enrichment: { status: 'failed', permanent: true } } }
    const res = await post()
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({
      error: 'This contact previously failed enrichment in a way that will not succeed on retry.',
      code: 'ENRICHMENT_PERMANENTLY_FAILED',
    })
    expect(hoisted.updates).toEqual([])
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('202: marks pending, opens the Activity row, sends the manual event with its run key', async () => {
    const res = await post()
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
    expect(hoisted.filters).toEqual([
      ['id', 'ct-1'],
      ['workspace_id', 'ws-1'],
    ])
    expect(hoisted.updates).toEqual([{ enrichment_status: 'pending' }])
    expect(hoisted.openManualEnrichment).toHaveBeenCalledWith(
      { service: true },
      { workspaceId: 'ws-1', userId: 'user-1', table: 'contact', recordId: 'ct-1', name: 'Dana Lee' },
    )
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/enrich-contact.manual',
      data: { contactId: 'ct-1', workspaceId: 'ws-1', userId: 'user-1', allowSelf: true, workRunKey: 'manual:contact:ct-1:run' },
    })
  })

  it('an already-enriched contact is a refresh, not refused; no Activity row still sends', async () => {
    hoisted.row = { ...CONTACT, full_name: null, metadata: { enrichment: { status: 'enriched', applied_fields: ['job_title'] } } }
    hoisted.openManualEnrichment.mockResolvedValueOnce(null)
    const res = await post()
    expect(res.status).toBe(202)
    expect(hoisted.openManualEnrichment.mock.calls[0][1]).toMatchObject({ name: 'dana@acme.com' })
    expect(hoisted.inngestSend.mock.calls[0][0].data.workRunKey).toBeNull()
  })

  it('202 without a second run when another request claimed the contact first (one paid search)', async () => {
    hoisted.claimedNone = true
    const res = await post()
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ status: 'pending' })
    expect(hoisted.openManualEnrichment).not.toHaveBeenCalled()
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a failed send settles the Activity row failed and throws', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    await expect(post()).rejects.toThrow('inngest down')
    expect(hoisted.settleManualEnrichment).toHaveBeenCalledWith(
      { service: true },
      'manual:contact:ct-1:run',
      { status: 'failed', error: 'The search could not be queued' },
      { workspaceId: 'ws-1', table: 'contact', recordId: 'ct-1' },
    )
  })
})
