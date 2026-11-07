/**
 * Tests for POST /api/account/sequences — the timezone guard.
 *
 * Every send time is computed in the sequence's zone, so a name that is not an
 * IANA zone must be refused at create (400) instead of stored and left to break
 * scheduling later. A real zone, or none (the default), goes through.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  inserts: [] as Array<{ table: string; values: unknown }>,
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/sequences/mutations', () => ({
  normalizeSteps: () => ({ ok: true, steps: [] }),
  resolveOwnedEmailAccount: vi.fn(),
  defaultOwnedEmailAccount: vi.fn(async () => null),
}))

function makeSupabase() {
  return {
    from: (table: string) => {
      let values: unknown = null
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        insert: (v: unknown) => {
          values = v
          hoisted.inserts.push({ table, values: v })
          return chain
        },
        select: () => chain,
        single: async () => ({ data: { id: 'seq-1', ...(values as object) }, error: null }),
        then: (resolve: (r: unknown) => unknown) => resolve({ data: [], error: null }),
      })
      return chain
    },
  }
}

async function post(body: Record<string, unknown>) {
  const { POST } = await import('../route')
  const req = buildRequest({ url: 'http://localhost/api/account/sequences', method: 'POST', body }) as unknown as NextRequest
  return POST(req)
}

describe('POST /api/account/sequences — timezone', () => {
  beforeEach(() => {
    hoisted.inserts.length = 0
    hoisted.requireWorkspace.mockResolvedValue({
      supabase: makeSupabase(),
      user: { id: 'user-1' },
      workspaceId: 'ws-1',
    })
  })

  it('refuses a name that is not an IANA zone, and stores nothing', async () => {
    const res = await post({ name: 'Outbound', timezone: 'Mars/Olympus_Mons' })
    expect(res.status).toBe(400)
    const json = (await readJson(res)) as { error: string }
    expect(json.error).toMatch(/IANA/)
    expect(hoisted.inserts).toHaveLength(0)
  })

  it('stores a real zone as given', async () => {
    const res = await post({ name: 'Outbound', timezone: 'Europe/London' })
    expect(res.status).toBe(201)
    const seq = hoisted.inserts.find((i) => i.table === 'sequence')
    expect((seq?.values as { timezone: string }).timezone).toBe('Europe/London')
  })

  it('defaults to America/Los_Angeles when none is given', async () => {
    const res = await post({ name: 'Outbound' })
    expect(res.status).toBe(201)
    const seq = hoisted.inserts.find((i) => i.table === 'sequence')
    expect((seq?.values as { timezone: string }).timezone).toBe('America/Los_Angeles')
  })
})
