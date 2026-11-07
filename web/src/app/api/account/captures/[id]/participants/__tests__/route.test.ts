/**
 * Tests for GET /api/account/captures/[id]/participants — perf phase 2
 * migration to requireWorkspace + the parallel ownership-check/list fetch.
 *
 * Locked in: 401 passthrough, 404 when the capture is outside the workspace
 * (participant rows are discarded, never returned), and the flattened
 * participant shape the panel renders.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  captureRow: null as { id: string } | null,
  participantRows: [] as Record<string, unknown>[],
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))

function chain(result: unknown) {
  const target: Record<string, unknown> = {
    then: (cb: (v: unknown) => unknown) => Promise.resolve(result).then(cb),
  }
  const handler: ProxyHandler<Record<string, unknown>> = {
    get(t, prop: string) {
      if (prop in t) return t[prop]
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      return () => new Proxy(target, handler)
    },
  }
  return new Proxy(target, handler)
}

function makeFakeSupabase() {
  return {
    from: (table: string) => {
      if (table === 'captures') return chain({ data: hoisted.captureRow, error: null })
      if (table === 'capture_participant') return chain({ data: hoisted.participantRows, error: null })
      return chain({ data: null, error: null })
    },
  }
}

const { GET } = await import('@/app/api/account/captures/[id]/participants/route')

function getReq(): NextRequest {
  return buildRequest({
    url: 'https://dial8.ai/api/account/captures/capture-1/participants',
    method: 'GET',
  }) as unknown as NextRequest
}

const fakeParams = { params: Promise.resolve({ id: 'capture-1' }) }

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.captureRow = { id: 'capture-1' }
  hoisted.participantRows = [
    {
      id: 'part-1',
      capture_id: 'capture-1',
      member_id: 'member-1',
      contact_id: null,
      external_name: null,
      external_email: null,
      company: null,
      job_title: null,
      speaker_label: 'Speaker 1',
      role: 'host',
      joined_at: null,
      left_at: null,
      member: { id: 'member-1', display_name: 'Alice', avatar_url: null },
      contact: null,
    },
  ]
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeFakeSupabase(),
    user: { id: 'user-1' },
    workspaceId: 'workspace-1',
  })
})

describe('GET /api/account/captures/[id]/participants', () => {
  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'Unauthorized', code: 'UNAUTHORIZED' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    )
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(401)
  })

  it('returns 404 (and NO participant rows) when capture is outside the workspace', async () => {
    hoisted.captureRow = null
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(404)
    const body = await readJson<{ error: string; participants?: unknown }>(res)
    expect(body.error).toBe('Capture not found')
    expect(body.participants).toBeUndefined()
  })

  it('returns the flattened participant shape', async () => {
    const res = await GET(getReq(), fakeParams)
    expect(res.status).toBe(200)
    const body = await readJson<{ participants: Record<string, unknown>[] }>(res)
    expect(body.participants).toHaveLength(1)
    expect(body.participants[0]).toMatchObject({
      id: 'part-1',
      member_id: 'member-1',
      name: 'Alice',
      speaker_label: 'Speaker 1',
      role: 'host',
      is_member: true,
      source: 'calendar_event',
    })
  })
})
