/**
 * Tests for /api/account/voice-profile (GET / POST / DELETE).
 *
 * The route is the user-scoped voiceprint store
 * (docs/plans/voice-enrollment-implementation.md §3). It uses requireWorkspace()
 * + @/lib/api-errors (modern style). We drive the handlers end-to-end with a
 * Supabase fake:
 *   - GET  → `.from('user_voice_profile').select().eq().order()` (thenable rows)
 *   - GET ?include=prototypes also → `.from('member').select().eq().eq().maybeSingle()`
 *     then `.from('contact').select().eq().eq()` (thenable) for selfContactIds
 *   - POST → `.rpc('replace_user_voice_profile', { p_rows })`
 *   - DELETE → `.from('user_voice_profile').delete().eq()` (thenable)
 *
 * The RPC receives embeddings as the pgvector text form (JSON.stringify) after
 * a SERVER-side l2Normalize — asserted here so client-supplied magnitudes never
 * reach storage.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { EMBEDDING_DIM, MAX_ENROLLMENT_CHUNKS } from '@/lib/voice-profile/types'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspace,
}))

import { GET, POST, DELETE } from '@/app/api/account/voice-profile/route'

const USER_ID = 'user-1'

/** A valid unit-ish embedding of the right dimensionality. */
function vec(fill = 0.1): number[] {
  return new Array(EMBEDDING_DIM).fill(fill)
}

interface Captured {
  rpcName?: string
  rpcArgs?: Record<string, unknown>
  deletedFrom?: string
}

interface FakeOpts {
  selectError?: string
  rpcError?: string
  deleteError?: string
  /** Contact ids returned as the caller's own contacts (selfContactIds). */
  selfContactIds?: string[]
  /** null → the caller has no member row in the workspace. */
  memberId?: string | null
}

/**
 * Build a Supabase fake.
 * @param selectRows rows the GET voice-profile select() thenable resolves
 */
function makeSupabase(
  selectRows: Record<string, unknown>[],
  captured: Captured,
  opts: FakeOpts = {},
) {
  function selectChain() {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      order: () => b,
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(
          resolve(
            opts.selectError
              ? { data: null, error: { message: opts.selectError } }
              : { data: selectRows, error: null },
          ),
        ),
    })
    return b
  }
  function memberChain() {
    const b: Record<string, unknown> = {}
    const memberId = opts.memberId === undefined ? 'mem-1' : opts.memberId
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      maybeSingle: () =>
        Promise.resolve({ data: memberId == null ? null : { id: memberId }, error: null }),
    })
    return b
  }
  function contactChain() {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      then: (resolve: (v: { data: unknown; error: unknown }) => unknown) =>
        Promise.resolve(
          resolve({
            data: (opts.selfContactIds ?? []).map((id) => ({ id })),
            error: null,
          }),
        ),
    })
    return b
  }
  function deleteChain() {
    const b: Record<string, unknown> = {}
    Object.assign(b, {
      eq: () => b,
      then: (resolve: (v: { error: unknown }) => unknown) =>
        Promise.resolve(
          resolve(opts.deleteError ? { error: { message: opts.deleteError } } : { error: null }),
        ),
    })
    return b
  }
  return {
    from: (table: string) => {
      if (table === 'member') return memberChain()
      if (table === 'contact') return contactChain()
      return {
        select: () => selectChain(),
        delete: () => {
          captured.deletedFrom = table
          return deleteChain()
        },
      }
    },
    rpc: (name: string, args: Record<string, unknown>) => {
      captured.rpcName = name
      captured.rpcArgs = args
      return Promise.resolve(
        opts.rpcError ? { data: null, error: { message: opts.rpcError } } : { data: 3, error: null },
      )
    },
  }
}

function auth(
  selectRows: Record<string, unknown>[],
  captured: Captured,
  opts?: FakeOpts,
) {
  return {
    supabase: makeSupabase(selectRows, captured, opts),
    user: { id: USER_ID, email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role: 'owner' },
  }
}

function req(opts: { url?: string; method?: string; body?: unknown }): NextRequest {
  return buildRequest({
    url: opts.url ?? 'https://nativeintelligence.dev/api/account/voice-profile',
    method: opts.method ?? 'GET',
    body: opts.body,
  }) as unknown as NextRequest
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
})

describe('GET /api/account/voice-profile', () => {
  it('reports not enrolled when there are no rows', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const res = await GET(req({}))
    expect(res.status).toBe(200)
    const body = await readJson<{ enrolled: boolean; quality: number | null; chunkCount: number; createdAt: string | null }>(res)
    expect(body.enrolled).toBe(false)
    expect(body.quality).toBeNull()
    expect(body.chunkCount).toBe(0)
    expect(body.createdAt).toBeNull()
  })

  it('reports enrolled with mean quality and chunk count', async () => {
    const rows = [
      { quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:02Z' },
      { quality: 0.7, session_id: 's1', created_at: '2026-07-15T10:00:01Z' },
    ]
    hoisted.requireWorkspace.mockResolvedValue(auth(rows, {}))
    const res = await GET(req({}))
    expect(res.status).toBe(200)
    const body = await readJson<{ enrolled: boolean; quality: number; chunkCount: number; createdAt: string }>(res)
    expect(body.enrolled).toBe(true)
    expect(body.quality).toBeCloseTo(0.8, 5)
    expect(body.chunkCount).toBe(2)
    // Rows are newest-first; createdAt is the oldest (enrollment moment).
    expect(body.createdAt).toBe('2026-07-15T10:00:01Z')
  })

  it('describes only the Settings enrollment; meeting-learned rows feed prototypes only (issue 11)', async () => {
    const rows = [
      { embedding: vec(0.3), quality: 0.99, session_id: 'cap-1', created_at: '2026-09-29T15:00:00Z', source: 'session_confirm' },
      { embedding: vec(0.1), quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:02Z', source: 'settings_training' },
      { embedding: vec(0.1), quality: 0.7, session_id: 's1', created_at: '2026-07-15T10:00:01Z', source: 'settings_training' },
    ]
    hoisted.requireWorkspace.mockResolvedValue(auth(rows, {}))
    const body = await readJson<{ enrolled: boolean; quality: number; chunkCount: number; createdAt: string; prototypes: number[][] }>(
      await GET(req({ url: 'https://nativeintelligence.dev/api/account/voice-profile?include=prototypes' })),
    )
    expect(body.quality).toBeCloseTo(0.8, 5)
    expect(body.chunkCount).toBe(2)
    expect(body.createdAt).toBe('2026-07-15T10:00:01Z')
    expect(body.prototypes.length).toBe(2)

    // Learned rows alone: matching still has prototypes, but Settings reads "not trained".
    hoisted.requireWorkspace.mockResolvedValue(auth([rows[0]], {}))
    const learnedOnly = await readJson<{ enrolled: boolean; chunkCount: number; prototypes: number[][] }>(
      await GET(req({ url: 'https://nativeintelligence.dev/api/account/voice-profile?include=prototypes' })),
    )
    expect(learnedOnly.enrolled).toBe(false)
    expect(learnedOnly.chunkCount).toBe(0)
    expect(learnedOnly.prototypes.length).toBe(1)
  })

  it('adds prototypes with ?include=prototypes', async () => {
    const rows = [
      { embedding: vec(0.1), quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:02Z' },
      { embedding: vec(0.1), quality: 0.8, session_id: 's2', created_at: '2026-07-15T10:00:01Z' },
    ]
    hoisted.requireWorkspace.mockResolvedValue(auth(rows, {}))
    const res = await GET(
      req({ url: 'https://nativeintelligence.dev/api/account/voice-profile?include=prototypes' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ prototypes: number[][]; selfContactIds: string[] }>(res)
    expect(Array.isArray(body.prototypes)).toBe(true)
    // 2 sessions → 2 prototypes, each unit-norm and 512-dim.
    expect(body.prototypes.length).toBe(2)
    expect(body.prototypes[0].length).toBe(EMBEDDING_DIM)
    // selfContactIds is always present with ?include=prototypes (empty here).
    expect(body.selfContactIds).toEqual([])
  })

  it('returns the caller\'s own contact ids as selfContactIds (finding 3)', async () => {
    const rows = [
      { embedding: vec(0.1), quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:02Z' },
    ]
    hoisted.requireWorkspace.mockResolvedValue(
      auth(rows, {}, { memberId: 'mem-7', selfContactIds: ['c-1', 'c-2'] }),
    )
    const res = await GET(
      req({ url: 'https://nativeintelligence.dev/api/account/voice-profile?include=prototypes' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ selfContactIds: string[] }>(res)
    expect(body.selfContactIds).toEqual(['c-1', 'c-2'])
  })

  it('selfContactIds is empty when the caller has no member row', async () => {
    const rows = [
      { embedding: vec(0.1), quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:02Z' },
    ]
    hoisted.requireWorkspace.mockResolvedValue(
      auth(rows, {}, { memberId: null, selfContactIds: ['c-1'] }),
    )
    const res = await GET(
      req({ url: 'https://nativeintelligence.dev/api/account/voice-profile?include=prototypes' }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ selfContactIds: string[] }>(res)
    // No member → no self-contact lookup → empty.
    expect(body.selfContactIds).toEqual([])
  })

  it('does NOT query contacts on the status-only path (no ?include)', async () => {
    const rows = [{ quality: 0.9, session_id: 's1', created_at: '2026-07-15T10:00:01Z' }]
    hoisted.requireWorkspace.mockResolvedValue(auth(rows, {}))
    const res = await GET(req({}))
    expect(res.status).toBe(200)
    const body = await readJson<{ enrolled: boolean; selfContactIds?: string[] }>(res)
    expect(body.enrolled).toBe(true)
    // Status shape carries no selfContactIds.
    expect(body.selfContactIds).toBeUndefined()
  })

  it('500s on a select error', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}, { selectError: 'boom' }))
    const res = await GET(req({}))
    expect(res.status).toBe(500)
  })

  it('returns the auth Response when unauthorized', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await GET(req({}))
    expect(res.status).toBe(401)
  })
})

describe('POST /api/account/voice-profile', () => {
  function goodChunk(sessionId = 's1') {
    return { embedding: vec(2), quality: 0.8, sessionId }
  }

  it('stores server-normalized rows via the RPC', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspace.mockResolvedValue(auth([], captured))
    const res = await POST(
      req({
        method: 'POST',
        body: { chunks: [goodChunk('s1'), goodChunk('s2')], source: 'settings_training' },
      }),
    )
    expect(res.status).toBe(200)
    const body = await readJson<{ enrolled: boolean; chunkCount: number; quality: number }>(res)
    expect(body.enrolled).toBe(true)
    expect(body.chunkCount).toBe(2)
    expect(body.quality).toBeCloseTo(0.8, 5)

    expect(captured.rpcName).toBe('replace_user_voice_profile')
    const rpcRows = (captured.rpcArgs?.p_rows as { embedding: string; quality: number; session_id: string; source: string }[])
    expect(rpcRows.length).toBe(2)
    // Embedding is the pgvector text form of an l2-normalized vector: the input
    // was all-2s (magnitude ≠ 1); every stored component must be normalized.
    const parsed = JSON.parse(rpcRows[0].embedding) as number[]
    const mag = Math.sqrt(parsed.reduce((s, v) => s + v * v, 0))
    expect(mag).toBeCloseTo(1, 5)
    expect(rpcRows[0].session_id).toBe('s1')
    expect(rpcRows[0].source).toBe('settings_training')
  })

  it('rejects an empty chunks array', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const res = await POST(req({ method: 'POST', body: { chunks: [], source: 'settings_training' } }))
    expect(res.status).toBe(400)
  })

  it(`rejects more than ${MAX_ENROLLMENT_CHUNKS} chunks`, async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    // One over the shared max, all one session so the length gate (not the
    // session gate) is what trips — the length check runs first.
    const chunks = new Array(MAX_ENROLLMENT_CHUNKS + 1).fill(0).map(() => goodChunk('s1'))
    const res = await POST(req({ method: 'POST', body: { chunks, source: 'settings_training' } }))
    expect(res.status).toBe(400)
  })

  it(`accepts exactly ${MAX_ENROLLMENT_CHUNKS} chunks (the new self-enrollment envelope)`, async () => {
    const captured: Captured = {}
    hoisted.requireWorkspace.mockResolvedValue(auth([], captured))
    // 60 chunks spread across 3 sessions (20 each) — a full store-everything read.
    const chunks = new Array(MAX_ENROLLMENT_CHUNKS)
      .fill(0)
      .map((_v, i) => goodChunk(`s${(i % 3) + 1}`))
    const res = await POST(req({ method: 'POST', body: { chunks, source: 'settings_training' } }))
    expect(res.status).toBe(200)
    const body = await readJson<{ chunkCount: number }>(res)
    expect(body.chunkCount).toBe(MAX_ENROLLMENT_CHUNKS)
    const rpcRows = captured.rpcArgs?.p_rows as unknown[]
    expect(rpcRows.length).toBe(MAX_ENROLLMENT_CHUNKS)
  })

  it('rejects an embedding of the wrong dimensionality', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const res = await POST(
      req({
        method: 'POST',
        body: { chunks: [{ embedding: [1, 2, 3], quality: 0.8, sessionId: 's1' }], source: 'settings_training' },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects a non-finite embedding value', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const bad = vec(0.1)
    bad[0] = Number.POSITIVE_INFINITY
    const res = await POST(
      req({
        method: 'POST',
        body: { chunks: [{ embedding: bad, quality: 0.8, sessionId: 's1' }], source: 'settings_training' },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects a quality out of [0,1]', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const res = await POST(
      req({
        method: 'POST',
        body: { chunks: [{ embedding: vec(0.1), quality: 1.4, sessionId: 's1' }], source: 'settings_training' },
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects more than 6 distinct sessions', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const chunks = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((s) => goodChunk(s))
    const res = await POST(req({ method: 'POST', body: { chunks, source: 'settings_training' } }))
    expect(res.status).toBe(400)
  })

  it('rejects an unknown source', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}))
    const res = await POST(
      req({ method: 'POST', body: { chunks: [goodChunk()], source: 'hacker' } }),
    )
    expect(res.status).toBe(400)
  })

  it('500s on an RPC error', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}, { rpcError: 'db down' }))
    const res = await POST(
      req({ method: 'POST', body: { chunks: [goodChunk()], source: 'settings_training' } }),
    )
    expect(res.status).toBe(500)
  })
})

describe('DELETE /api/account/voice-profile', () => {
  it('removes the profile and reports not enrolled', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspace.mockResolvedValue(auth([], captured))
    const res = await DELETE()
    expect(res.status).toBe(200)
    const body = await readJson<{ enrolled: boolean; chunkCount: number }>(res)
    expect(body.enrolled).toBe(false)
    expect(body.chunkCount).toBe(0)
    expect(captured.deletedFrom).toBe('user_voice_profile')
  })

  it('500s on a delete error', async () => {
    hoisted.requireWorkspace.mockResolvedValue(auth([], {}, { deleteError: 'nope' }))
    const res = await DELETE()
    expect(res.status).toBe(500)
  })
})
