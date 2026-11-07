/**
 * GET /api/account/contacts/[id]/card — a person's card for the live agent's
 * HUD (lib/crm/person-card.ts). Pinned:
 *   - the card's shape from one contact row (role · company, relationship,
 *     one line of background);
 *   - workspace-fenced, merge tombstones followed to the survivor;
 *   - the contact visibility fence: a contact the caller can't see is a 404,
 *     like a missing one;
 *   - auth failures pass through.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  rows: new Map<string, Record<string, unknown>>(),
  eqs: [] as Array<[string, unknown]>,
  visible: new Set<string>(),
  rpc: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

function makeSupabase() {
  return {
    from: (table: string) => {
      expect(table).toBe('contact')
      const filters: Record<string, unknown> = {}
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, value: unknown) => {
          hoisted.eqs.push([col, value])
          filters[col] = value
          return chain
        },
        maybeSingle: async () => {
          const row = hoisted.rows.get(filters.id as string)
          return { data: row && row.workspace_id === filters.workspace_id ? row : null, error: null }
        },
      }
      return chain
    },
    rpc: hoisted.rpc,
  }
}

const { GET } = await import('@/app/api/account/contacts/[id]/card/route')

function call(id: string) {
  const request = buildRequest({ url: `https://dial8.ai/api/account/contacts/${id}/card`, method: 'GET' }) as unknown as NextRequest
  return GET(request, { params: Promise.resolve({ id }) })
}

const SAM = {
  id: 'c-sam',
  workspace_id: 'ws-1',
  full_name: 'Sam Rivera',
  email: 'sam@acme.test',
  job_title: 'VP Sales',
  relationship_type: 'customer',
  relationship_strength: 'warm',
  notes: 'Met at the summit.',
  metadata: { enrichment: { summary: 'Sam leads sales at Acme. Before that, six years at Initech.' } },
  merged_into_contact_id: null,
  company: { name: 'Acme' },
}

beforeEach(() => {
  hoisted.rows.clear()
  hoisted.eqs = []
  hoisted.visible = new Set(['c-sam'])
  hoisted.rpc.mockReset()
  hoisted.rpc.mockImplementation(async (fn: string, args: { p_contact_id: string; p_user_id: string }) => {
    expect(fn).toBe('contact_visible_to')
    expect(args.p_user_id).toBe('user-1')
    return { data: hoisted.visible.has(args.p_contact_id), error: null }
  })
  hoisted.rows.set('c-sam', SAM)
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspace.mockResolvedValue({ supabase: makeSupabase(), user: { id: 'user-1' }, workspaceId: 'ws-1' })
})

describe('GET contacts/[id]/card', () => {
  it("returns the person's card", async () => {
    const res = await call('c-sam')
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({
      person: {
        id: 'c-sam',
        name: 'Sam Rivera',
        role: 'VP Sales',
        company: 'Acme',
        relationship: 'Customer · Warm',
        background: 'Sam leads sales at Acme.',
      },
    })
    expect(hoisted.eqs).toContainEqual(['workspace_id', 'ws-1'])
  })

  it('follows a merged contact to its survivor', async () => {
    hoisted.rows.set('c-old', { ...SAM, id: 'c-old', merged_into_contact_id: 'c-sam' })
    const res = await call('c-old')
    expect(res.status).toBe(200)
    expect((await readJson<{ person: { id: string } }>(res)).person.id).toBe('c-sam')
  })

  it('404s a contact the caller cannot see, like a missing one or another workspace’s', async () => {
    hoisted.visible.clear()
    expect((await call('c-sam')).status).toBe(404)
    hoisted.visible.add('c-sam')
    expect((await call('c-nope')).status).toBe(404)
    hoisted.rows.set('c-far', { ...SAM, id: 'c-far', workspace_id: 'ws-2' })
    hoisted.visible.add('c-far')
    expect((await call('c-far')).status).toBe(404)
  })

  it('a visibility check that errors fails closed', async () => {
    hoisted.rpc.mockResolvedValue({ data: null, error: { message: 'boom' } })
    expect((await call('c-sam')).status).toBe(404)
  })

  it('passes an auth failure through', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('{"error":"Unauthorized"}', { status: 401 }))
    expect((await call('c-sam')).status).toBe(401)
  })
})
