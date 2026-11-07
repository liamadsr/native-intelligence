/**
 * POST /api/account/contacts/[id]/hubspot-hold — releasing the HubSpot push
 * HOLD an unattended run stamped (Sequence step 2, plan A.1):
 *   - a held contact: the marker is cleared (sibling metadata kept) and the
 *     same crm/hubspot-push-contact event the manual create sends goes out;
 *   - held but no email: released, nothing sent (the push function would
 *     no-op on no_email anyway; the row is now the sweep's to pick up);
 *   - not held: released:false, no write, no event;
 *   - auth: 401 without a session, 404 for a row outside the workspace.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getUser: vi.fn(),
  getCurrentWorkspaceId: vi.fn(),
  inngestSend: vi.fn(),
  row: null as Record<string, unknown> | null,
  selectError: null as { message: string } | null,
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
        update: (patch: Record<string, unknown>) => {
          hoisted.updates.push(patch)
          return { eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }
        },
      }
    },
  }),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: hoisted.inngestSend },
}))

const { POST } = await import('@/app/api/account/contacts/[id]/hubspot-hold/route')

function post(id = 'ct-1') {
  const req = buildRequest({ url: `https://dial8.ai/api/account/contacts/${id}/hubspot-hold`, method: 'POST' }) as unknown as NextRequest
  return POST(req, { params: Promise.resolve({ id }) })
}

const HELD = {
  id: 'ct-1',
  full_name: 'Ada',
  email: 'ada@example.com',
  metadata: { hubspot_push_hold: { at: '2026-09-01T00:00:00.000Z', by: 'unattended' }, enrichment: { sources: [] } },
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.getUser.mockResolvedValue({ data: { user: { id: 'user-1' } } })
  hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
  hoisted.inngestSend.mockResolvedValue({ ids: ['e'] })
  hoisted.row = { ...HELD }
  hoisted.selectError = null
  hoisted.updates = []
  hoisted.filters = []
})

describe('POST /api/account/contacts/[id]/hubspot-hold', () => {
  it('401 without a session; 404 when the row is not in the workspace', async () => {
    hoisted.getUser.mockResolvedValueOnce({ data: { user: null } })
    expect((await post()).status).toBe(401)
    hoisted.row = null
    expect((await post()).status).toBe(404)
    expect(hoisted.updates).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('releases a held contact: clears the marker, keeps sibling metadata, sends the push', async () => {
    const res = await post()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ released: true, pushed: true, contact: { id: 'ct-1', email: 'ada@example.com' } })
    expect(hoisted.updates).toEqual([{ metadata: { enrichment: { sources: [] } } }])
    expect(hoisted.inngestSend).toHaveBeenCalledWith({
      name: 'crm/hubspot-push-contact',
      data: { contactId: 'ct-1', workspaceId: 'ws-1' },
    })
    // The read is fenced on the workspace, under the caller's own client.
    expect(hoisted.filters).toEqual([
      ['id', 'ct-1'],
      ['workspace_id', 'ws-1'],
    ])
  })

  it('a held contact with no email is released without a push event', async () => {
    hoisted.row = { ...HELD, email: null }
    const body = await (await post()).json()
    expect(body).toMatchObject({ released: true, pushed: false })
    expect(hoisted.updates).toHaveLength(1)
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a contact that is not held: released:false, no write, no event (idempotent)', async () => {
    hoisted.row = { ...HELD, metadata: { enrichment: {} } }
    const body = await (await post()).json()
    expect(body).toMatchObject({ released: false, pushed: false })
    expect(hoisted.updates).toEqual([])
    expect(hoisted.inngestSend).not.toHaveBeenCalled()
  })

  it('a failed send never fails the release', async () => {
    hoisted.inngestSend.mockRejectedValueOnce(new Error('inngest down'))
    const res = await post()
    expect(res.status).toBe(200)
    expect((await res.json()).released).toBe(true)
  })
})
