/**
 * Tests for POST /api/account/captures/[id]/transcript-append.
 *
 * The delta-append auto-save: the live-recording client POSTs only the NEW tail
 * of the transcript plus a base_length optimistic-concurrency token; the route
 * calls the append_capture_transcript RPC (migration 192), which does the
 * compare-and-swap append atomically in SQL. This is the product's most
 * data-loss-sensitive path, so the tests lock in:
 *   - happy append (RPC 'applied' → 200 + new_length)
 *   - base mismatch (RPC 'base_mismatch' → 409 BASE_LENGTH_MISMATCH + server_length)
 *   - CAS lost to a racing writer (RPC 'conflict' → 409 CONCURRENT_WRITE + server_length)
 *   - ended / locked capture (RPC 'locked' → terminal 409 TRANSCRIPT_LOCKED)
 *   - a mid-write DB lock trigger (RPC raises P0001 → same terminal 409)
 *   - capture not in workspace (RPC 'not_found' → 404)
 *   - empty / oversized / bad append or base rejected (400) — before the RPC
 *   - unauthenticated → 401 (whatever requireWorkspace returns)
 *   - an unexpected RPC error → 500
 *
 * ── REGRESSION GUARD (the 2026-07-10 outage) ──
 * The route must NEVER predicate the write on the full transcript text via a
 * supabase filter — that serialized the whole transcript into the PostgREST URL,
 * and once it passed the proxy's URL limit every append 500'd forever. We assert
 * the route goes through `supabase.rpc(...)` (full text travels in the JSON body,
 * never a URL query string) and never calls `.from('captures').update(...)`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  rpcSpy: vi.fn(),
  fromSpy: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

const CAPTURE_ID = 'cap-append-1'
const WORKSPACE_ID = 'ws-test-1'

interface FakeOpts {
  /** The RPC's returned row: { status, server_length }. Postgres RETURNS TABLE
   *  surfaces as an array of rows via supabase-js; we model a single-row result. */
  rpcResult?: { status: string; server_length: number | null } | null
  /** A thrown/returned RPC error (e.g. a P0001 lock-trigger exception, or a
   *  generic failure). When set, `data` is null and `error` carries it. */
  rpcError?: { code?: string; message?: string } | null
}

function makeFakeSupabase(opts: FakeOpts = {}) {
  const { rpcResult = { status: 'applied', server_length: 0 }, rpcError = null } = opts

  return {
    // The route MUST use rpc(), not .from('captures').update(...). fromSpy is
    // wired so any accidental table write surfaces in the assertions.
    from: (...args: unknown[]) => {
      hoisted.fromSpy(...args)
      throw new Error('route must not touch tables directly — it must call rpc()')
    },
    rpc: async (fn: string, params: Record<string, unknown>) => {
      hoisted.rpcSpy(fn, params)
      return {
        data: rpcError ? null : rpcResult ? [rpcResult] : [],
        error: rpcError,
      }
    },
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
  }
}

function auth(opts: FakeOpts = {}) {
  return {
    supabase: makeFakeSupabase(opts),
    user: { id: 'user-1' },
    workspaceId: WORKSPACE_ID,
    member: { id: 'member-1', role: 'owner' },
  }
}

function appendReq(body: unknown): NextRequest {
  return buildRequest({
    url: `https://dial8.ai/api/account/captures/${CAPTURE_ID}/transcript-append`,
    method: 'POST',
    body,
  }) as unknown as NextRequest
}

const ctx = { params: Promise.resolve({ id: CAPTURE_ID }) }

const { POST } = await import('@/app/api/account/captures/[id]/transcript-append/route')

const BASE = '[remote_1] hello there this is the first chunk of the transcript'
const CHUNK = '\n[remote_1] and here is the next chunk of speech'

describe('POST transcript-append', () => {
  beforeEach(() => {
    hoisted.rpcSpy.mockClear()
    hoisted.fromSpy.mockClear()
    hoisted.requireWorkspace.mockResolvedValue(auth())
  })

  it('calls the append_capture_transcript RPC with the append text in the BODY (never a URL filter)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'applied', server_length: BASE.length + CHUNK.length } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(200)
    // The RPC carries the delta + base length as JSON args — no table write, so
    // the full transcript can never end up serialized into a PostgREST URL.
    expect(hoisted.rpcSpy).toHaveBeenCalledTimes(1)
    expect(hoisted.rpcSpy).toHaveBeenCalledWith('append_capture_transcript', {
      p_capture_id: CAPTURE_ID,
      p_workspace_id: WORKSPACE_ID,
      p_append: CHUNK,
      p_base_length: BASE.length,
    })
    expect(hoisted.fromSpy).not.toHaveBeenCalled()
  })

  it('returns 200 + new_length when the RPC applies the append', async () => {
    const newLen = BASE.length + CHUNK.length
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'applied', server_length: newLen } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(200)
    const json = await readJson<{ new_length: number }>(res)
    expect(json.new_length).toBe(newLen)
  })

  it('appends onto an empty transcript (base_length 0)', async () => {
    const first = '[remote_1] first ever chunk'
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'applied', server_length: first.length } }),
    )
    const res = await POST(appendReq({ append_text: first, base_length: 0 }), ctx)
    expect(res.status).toBe(200)
    const json = await readJson<{ new_length: number }>(res)
    expect(json.new_length).toBe(first.length)
    expect(hoisted.rpcSpy).toHaveBeenCalledWith(
      'append_capture_transcript',
      expect.objectContaining({ p_append: first, p_base_length: 0 }),
    )
  })

  it('returns 409 BASE_LENGTH_MISMATCH + server_length on a base-length mismatch', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'base_mismatch', server_length: BASE.length } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: 5 }), ctx)
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string; server_length: number }>(res)
    expect(json.code).toBe('BASE_LENGTH_MISMATCH')
    expect(json.server_length).toBe(BASE.length)
  })

  it('returns 409 CONCURRENT_WRITE + true length when the CAS loses to a racing write', async () => {
    const raced = BASE.length + 40
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'conflict', server_length: raced } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string; server_length: number }>(res)
    expect(json.code).toBe('CONCURRENT_WRITE')
    // The re-read length reflects the racing writer's transcript — the client resyncs.
    expect(json.server_length).toBe(raced)
  })

  it('returns a TERMINAL 409 when the capture is ended / locked (RPC status "locked")', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'locked', server_length: BASE.length } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string }>(res)
    expect(json.code).toBe('TRANSCRIPT_LOCKED')
  })

  it('maps a mid-write DB lock trigger exception (P0001) to the TERMINAL 409', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({
        rpcError: { code: 'P0001', message: 'Transcript is locked after capture has ended' },
      }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(409)
    const json = await readJson<{ code: string }>(res)
    expect(json.code).toBe('TRANSCRIPT_LOCKED')
  })

  it('returns 404 when the RPC reports the capture is not in the workspace', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'not_found', server_length: null } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: 0 }), ctx)
    expect(res.status).toBe(404)
  })

  it('returns 500 on an unexpected RPC error (and never claims success)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcError: { message: 'connection reset' } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(500)
  })

  it('returns 500 on an unexpected/empty RPC status (never a silent bad success)', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      auth({ rpcResult: { status: 'weird_unknown', server_length: 0 } }),
    )
    const res = await POST(appendReq({ append_text: CHUNK, base_length: BASE.length }), ctx)
    expect(res.status).toBe(500)
  })

  // ── Input validation — all rejected BEFORE the RPC (no DB call) ──

  it('rejects an empty append_text (400, no RPC)', async () => {
    const res = await POST(appendReq({ append_text: '', base_length: BASE.length }), ctx)
    expect(res.status).toBe(400)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
  })

  it('rejects a non-string append_text (400, no RPC)', async () => {
    const res = await POST(appendReq({ append_text: 123, base_length: BASE.length }), ctx)
    expect(res.status).toBe(400)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
  })

  it('rejects an oversized append_text (400, no RPC)', async () => {
    const huge = 'x'.repeat(256 * 1024 + 1)
    const res = await POST(appendReq({ append_text: huge, base_length: BASE.length }), ctx)
    expect(res.status).toBe(400)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
  })

  it('rejects a negative / non-integer base_length (400, no RPC)', async () => {
    const neg = await POST(appendReq({ append_text: CHUNK, base_length: -1 }), ctx)
    expect(neg.status).toBe(400)
    const frac = await POST(appendReq({ append_text: CHUNK, base_length: 1.5 }), ctx)
    expect(frac.status).toBe(400)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
  })

  it('returns 401 when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(new Response('Unauthorized', { status: 401 }))
    const res = await POST(appendReq({ append_text: CHUNK, base_length: 0 }), ctx)
    expect(res.status).toBe(401)
  })

  it('returns 400 on invalid JSON body', async () => {
    const req = buildRequest({
      url: `https://dial8.ai/api/account/captures/${CAPTURE_ID}/transcript-append`,
      method: 'POST',
      body: '{ not valid json',
      raw: true,
    }) as unknown as NextRequest
    const res = await POST(req, ctx)
    expect(res.status).toBe(400)
    expect(hoisted.rpcSpy).not.toHaveBeenCalled()
  })
})
