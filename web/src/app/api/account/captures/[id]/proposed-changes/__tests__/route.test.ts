/**
 * Tests for GET /api/account/captures/[id]/proposed-changes.
 *
 * This endpoint is polled every 25s during a recording AND refetched on every
 * proposed_change realtime burst, so the perf phase 2 change it locks in is
 * the SLIM SELECT: the route must never regress to select('*') — the dropped
 * columns (workspace_id, status_from, team_id, labels, anchor_text,
 * applied_at, applied_by) are server-side apply-engine concerns no client
 * consumer of this endpoint reads, while everything ProposalCard/SmartText/
 * derive-ui/the reconcile watermark touch must stay in the list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  /** The select string the proposed_change query was built with. */
  selectFields: null as string | null,
  rows: [] as { status: string }[],
  error: null as { message: string } | null,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      if (table !== 'proposed_change') throw new Error(`unexpected table: ${table}`)
      return {
        select: (fields: string) => {
          hoisted.selectFields = fields
          const chain: Record<string, unknown> = {
            then: (cb: (v: unknown) => unknown) =>
              Promise.resolve({ data: hoisted.error ? null : hoisted.rows, error: hoisted.error }).then(cb),
          }
          return new Proxy(chain, {
            get(target, prop: string) {
              if (prop in target) return target[prop]
              return () => new Proxy(chain, this)
            },
          })
        },
      }
    },
  }
}

const { GET } = await import('@/app/api/account/captures/[id]/proposed-changes/route')

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/captures/capture-1/proposed-changes',
    method: 'GET',
  }) as unknown as NextRequest
}

const fakeParams = { params: Promise.resolve({ id: 'capture-1' }) }

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.selectFields = null
  hoisted.error = null
  hoisted.rows = [
    { status: 'pending' },
    { status: 'pending' },
    { status: 'applied' },
    { status: 'dismissed' },
  ]
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

describe('GET /api/account/captures/[id]/proposed-changes', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(401)
    expect(hoisted.selectFields).toBeNull()
  })

  it('selects only the client-rendered columns — never *', async () => {
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)

    const fields = hoisted.selectFields
    expect(fields).not.toBeNull()
    expect(fields).not.toBe('*')

    const columns = fields!.split(',').map((c) => c.trim())
    // Everything the cards/reconcile actually read must stay present.
    for (const required of [
      'id',
      'display_text',
      'change_type',
      'entity_type',
      'entity_id',
      'title',
      'status',
      'status_to',
      'sort_order',
      'extra',
      'confidence',
      'auto_accepted',
      'result_entity_id',
      'error_message',
      'created_at',
      'updated_at',
    ]) {
      expect(columns).toContain(required)
    }
    // The polled payload must not regain the server-only columns.
    for (const dropped of [
      'workspace_id',
      'status_from',
      'team_id',
      'labels',
      'anchor_text',
      'applied_at',
      'applied_by',
    ]) {
      expect(columns).not.toContain(dropped)
    }
  })

  it('returns changes plus status counts', async () => {
    const res = await GET(getReq(), fakeParams)
    const body = await readJson<{
      changes: unknown[]
      counts: { pending: number; applied: number; dismissed: number; total: number }
    }>(res)
    expect(body.changes).toHaveLength(4)
    expect(body.counts).toEqual({ pending: 2, applied: 1, dismissed: 1, total: 4 })
  })

  it('500s a query failure with the standard error shape', async () => {
    hoisted.error = { message: 'db down' }
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(500)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.error).toBe('db down')
    expect(body.code).toBe('INTERNAL')
  })
})
