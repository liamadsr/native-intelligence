/**
 * GET /api/account/flows/runs/[runId] — the flow a run belongs to, used by the
 * notification click resolver for legacy `flow_run` rows.
 *
 * What we lock in:
 *   - the lookup is fenced through the run's FLOW's workspace (an `!inner`
 *     embed filtered on flow.workspace_id), never by run id alone
 *   - 404 when nothing matches (a foreign run reads as not found)
 *   - the response carries flow_id + flow_name, whether PostgREST typed the
 *     embed as an object or a one-element array
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as null | { message: string } },
  eqCalls: [] as unknown[][],
  selectCalls: [] as string[],
}))

function makeFakeSupabase() {
  const chain = {
    select: vi.fn((cols: string) => {
      hoisted.selectCalls.push(cols)
      return chain
    }),
    eq: vi.fn((...args: unknown[]) => {
      hoisted.eqCalls.push(args)
      return chain
    }),
    maybeSingle: vi.fn(async () => hoisted.result),
  }
  return { from: vi.fn(() => chain) }
}

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: vi.fn(async () => ({
    supabase: makeFakeSupabase(),
    workspaceId: 'ws-1',
    user: { id: 'user-1' },
  })),
}))

const { GET } = await import('@/app/api/account/flows/runs/[runId]/route')

const req = new Request('http://localhost/api/account/flows/runs/run-9') as unknown as NextRequest
const params = Promise.resolve({ runId: 'run-9' })

beforeEach(() => {
  hoisted.eqCalls.length = 0
  hoisted.selectCalls.length = 0
  hoisted.result = { data: null, error: null }
})

describe('GET /api/account/flows/runs/[runId]', () => {
  it('returns the flow the run belongs to, fenced on the flow workspace', async () => {
    hoisted.result = {
      data: {
        id: 'run-9',
        flow_id: 'flow-1',
        status: 'success',
        fired_at: '2026-09-17T10:00:00Z',
        flow: { id: 'flow-1', name: 'Triage after every capture', workspace_id: 'ws-1' },
      },
      error: null,
    }
    const res = await GET(req, { params })
    expect(res.status).toBe(200)
    const body = await readJson<{ run: Record<string, unknown> }>(res)
    expect(body.run).toEqual({
      id: 'run-9',
      flow_id: 'flow-1',
      flow_name: 'Triage after every capture',
      status: 'success',
      fired_at: '2026-09-17T10:00:00Z',
    })
    expect(hoisted.selectCalls[0]).toContain('flow!inner(')
    expect(hoisted.eqCalls).toEqual([
      ['id', 'run-9'],
      ['flow.workspace_id', 'ws-1'],
    ])
  })

  it('reads an array-typed embed the same way', async () => {
    hoisted.result = {
      data: {
        id: 'run-9',
        flow_id: 'flow-1',
        status: 'failed',
        fired_at: '2026-09-17T10:00:00Z',
        flow: [{ id: 'flow-1', name: 'Weekly groom', workspace_id: 'ws-1' }],
      },
      error: null,
    }
    const res = await GET(req, { params })
    const body = await readJson<{ run: { flow_name: string } }>(res)
    expect(body.run.flow_name).toBe('Weekly groom')
  })

  it('404s when no run matches in this workspace', async () => {
    const res = await GET(req, { params })
    expect(res.status).toBe(404)
  })

  it('500s with the error shape when the query fails', async () => {
    hoisted.result = { data: null, error: { message: 'boom' } }
    const res = await GET(req, { params })
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe('boom')
  })
})
