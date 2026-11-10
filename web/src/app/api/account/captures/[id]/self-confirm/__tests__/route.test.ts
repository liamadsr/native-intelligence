/**
 * POST /api/account/captures/[id]/self-confirm — the user says which voice is
 * theirs, as they link an attendee's voice to a contact (followups issue 11).
 * Pins: ownership; body validation; "mine" releases the label from other rows
 * and binds the self row as 'confirmed'; learning appends the voice's
 * embeddings as meeting-learned profile rows only when most are close to the
 * profile (or there is no profile yet), never failing the bind; "not_mine"
 * unbinds only a self row bound to that label.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { EMBEDDING_DIM, MAX_SESSION_CONFIRM_ROWS } from '@/lib/voice-profile/types'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn() }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))

import { POST } from '@/app/api/account/captures/[id]/self-confirm/route'

const USER_ID = 'user-1'
const CAPTURE_ID = 'cap-1'

function basis(k: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[k] = 1
  return v
}
/** Unit vector at cosine `c` to basis(0). */
function near(c: number): number[] {
  const v = new Array(EMBEDDING_DIM).fill(0)
  v[0] = c
  v[1] = Math.sqrt(1 - c * c)
  return v
}

interface Op {
  table: string
  kind: 'select' | 'update'
  payload?: Record<string, unknown>
  eq: Record<string, unknown>
}

interface Fake {
  ops: Op[]
  rpc: Array<{ fn: string; args: Record<string, unknown> }>
}

function makeSupabase(
  opts: {
    captureOwnerId?: string | null
    selfRow?: { id: string; speaker_label: string | null; self_binding: string } | null
    profileRows?: Array<{ embedding: number[]; quality: number; session_id: string; created_at: string; source: string }>
    confirmReturns?: Array<{ id: string }>
    unbindReturns?: Array<{ id: string }>
    rpcError?: { message: string }
  },
  fake: Fake,
) {
  return {
    rpc: (fn: string, args: Record<string, unknown>) => {
      fake.rpc.push({ fn, args })
      const rows = (args.p_rows as unknown[]) ?? []
      return Promise.resolve(opts.rpcError ? { data: null, error: opts.rpcError } : { data: rows.length, error: null })
    },
    from: (table: string) => {
      const op: Op = { table, kind: 'select', eq: {} }
      fake.ops.push(op)
      const b: Record<string, unknown> = {}
      const result = () => {
        if (table === 'captures') {
          return { data: opts.captureOwnerId == null ? null : { id: CAPTURE_ID, user_id: opts.captureOwnerId }, error: null }
        }
        if (table === 'user_voice_profile') return { data: opts.profileRows ?? [], error: null }
        if (op.kind === 'select') {
          return {
            data: opts.selfRow === undefined ? { id: 'self-1', speaker_label: null, self_binding: 'none' } : opts.selfRow,
            error: null,
          }
        }
        if (op.payload?.self_binding === 'confirmed') return { data: opts.confirmReturns ?? [{ id: 'self-1' }], error: null }
        if (op.payload?.self_binding === 'none') return { data: opts.unbindReturns ?? [], error: null }
        return { data: null, error: null } // label release
      }
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => {
          op.eq[col] = val
          return b
        },
        update: (payload: Record<string, unknown>) => {
          op.kind = 'update'
          op.payload = payload
          return b
        },
        maybeSingle: () => Promise.resolve(result()),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(result()).then(resolve),
      })
      return b
    },
  }
}

function setup(opts: Parameters<typeof makeSupabase>[0]): Fake {
  const fake: Fake = { ops: [], rpc: [] }
  hoisted.requireWorkspace.mockResolvedValue({
    supabase: makeSupabase({ captureOwnerId: USER_ID, ...opts }, fake),
    user: { id: USER_ID },
    workspaceId: 'ws-1',
  })
  return fake
}

const req = (body: unknown) =>
  buildRequest({ url: `https://nativeintelligence.dev/api/account/captures/${CAPTURE_ID}/self-confirm`, method: 'POST', body }) as unknown as NextRequest
const params = Promise.resolve({ id: CAPTURE_ID })
const PROFILE = [
  { embedding: basis(0), quality: 0.9, session_id: 's1', created_at: '2026-08-05T10:00:00Z', source: 'settings_training' },
]
const updates = (fake: Fake) => fake.ops.filter((o) => o.table === 'capture_participant' && o.kind === 'update')

beforeEach(() => hoisted.requireWorkspace.mockReset())

describe('ownership and validation', () => {
  it('403 for someone else’s capture or a missing one; nothing is written', async () => {
    let fake = setup({ captureOwnerId: 'someone-else' })
    expect((await POST(req({ speaker_label: 'local_2', decision: 'mine' }), { params })).status).toBe(403)
    expect(updates(fake)).toHaveLength(0)
    fake = setup({ captureOwnerId: null })
    expect((await POST(req({ speaker_label: 'local_2', decision: 'mine' }), { params })).status).toBe(403)
    expect(updates(fake)).toHaveLength(0)
  })

  it('400 on a bad label, decision or embedding; 404 with no self row', async () => {
    setup({})
    expect((await POST(req({ speaker_label: '', decision: 'mine' }), { params })).status).toBe(400)
    expect((await POST(req({ speaker_label: 'local_2', decision: 'maybe' }), { params })).status).toBe(400)
    expect((await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [[1, 2]] }), { params })).status).toBe(400)
    const nine = Array.from({ length: 9 }, () => basis(0))
    expect((await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: nine }), { params })).status).toBe(400)
    setup({ selfRow: null })
    expect((await POST(req({ speaker_label: 'local_2', decision: 'mine' }), { params })).status).toBe(404)
  })
})

describe('mine', () => {
  it('releases the label from other rows and binds the self row as confirmed', async () => {
    const fake = setup({ profileRows: PROFILE })
    const res = await POST(req({ speaker_label: 'local_2', decision: 'mine' }), { params })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ bound: true, learned: 0 })
    const [release, bind] = updates(fake)
    expect(release.payload).toEqual({ speaker_label: null })
    expect(release.eq).toMatchObject({ capture_id: CAPTURE_ID, is_self: false, speaker_label: 'local_2' })
    expect(bind.payload).toEqual({ self_binding: 'confirmed', speaker_label: 'local_2' })
    expect(bind.eq).toMatchObject({ id: 'self-1', is_self: true })
    expect(fake.rpc).toHaveLength(0)
  })

  it('learns the voice when most of its embeddings are close to the profile', async () => {
    const fake = setup({ profileRows: PROFILE })
    const res = await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [near(0.72), near(0.65), near(0.3)] }), { params })
    // Two of three are close: the voice is learned, the far segment left out.
    expect(await readJson(res)).toEqual({ bound: true, learned: 2 })
    expect(fake.rpc).toHaveLength(1)
    const { fn, args } = fake.rpc[0]
    expect(fn).toBe('append_user_voice_profile')
    expect(args.p_user_id).toBe(USER_ID)
    expect(args.p_max_session_rows).toBe(MAX_SESSION_CONFIRM_ROWS)
    const rows = args.p_rows as Array<{ embedding: string; quality: number; session_id: string }>
    expect(rows.map((r) => r.session_id)).toEqual([CAPTURE_ID, CAPTURE_ID])
    expect(rows[0].quality).toBeCloseTo(0.72, 5)
    expect(JSON.parse(rows[0].embedding)).toHaveLength(EMBEDDING_DIM)
  })

  it('binds but does not learn a voice that is mostly unlike the profile (a misclick on someone else)', async () => {
    const fake = setup({ profileRows: PROFILE })
    const res = await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [near(0.2), near(0.3), near(0.65)] }), { params })
    expect(await readJson(res)).toEqual({ bound: true, learned: 0 })
    expect(fake.rpc).toHaveLength(0)
    expect(updates(fake).some((u) => u.payload?.self_binding === 'confirmed')).toBe(true)
  })

  it('with no profile yet, the first confirm teaches it (as an attendee’s first link enrolls them)', async () => {
    const fake = setup({ profileRows: [] })
    const res = await POST(req({ speaker_label: 'local_1', decision: 'mine', embeddings: [basis(3), basis(4)] }), { params })
    expect(await readJson(res)).toEqual({ bound: true, learned: 2 })
    expect((fake.rpc[0].args.p_rows as Array<{ quality: unknown }>).map((r) => r.quality)).toEqual([null, null])
  })

  it('a failed learn still leaves the voice bound', async () => {
    setup({ profileRows: PROFILE, rpcError: { message: 'boom' } })
    const res = await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [basis(0), basis(0)] }), { params })
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ bound: true, learned: 0 })
  })
})

describe('not_mine', () => {
  it('unbinds a self row bound to that label, and learns nothing', async () => {
    const fake = setup({ unbindReturns: [{ id: 'self-1' }], selfRow: { id: 'self-1', speaker_label: 'local_1', self_binding: 'position' } })
    const res = await POST(req({ speaker_label: 'local_1', decision: 'not_mine', embeddings: [basis(0)] }), { params })
    expect(await readJson(res)).toEqual({ unbound: true })
    const [unbind] = updates(fake)
    expect(unbind.payload).toEqual({ self_binding: 'none', speaker_label: null, voice_match_confidence: null })
    expect(unbind.eq).toMatchObject({ id: 'self-1', speaker_label: 'local_1' })
    expect(fake.rpc).toHaveLength(0)
  })

  it('reports nothing unbound when the self row is not on that label', async () => {
    setup({ unbindReturns: [] })
    const res = await POST(req({ speaker_label: 'local_3', decision: 'not_mine' }), { params })
    expect(await readJson(res)).toEqual({ unbound: false })
  })
})

describe('one log line per confirm says what was learned and why (issue 24)', () => {
  it('names a confirm that posted no samples, a guard refusal, and an append', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    try {
      setup({ profileRows: PROFILE })
      await POST(req({ speaker_label: 'local_2', decision: 'mine' }), { params })
      expect(info).toHaveBeenLastCalledWith(`[self-confirm] capture ${CAPTURE_ID}: posted 0, kept 0, learned 0 (no embeddings posted)`)

      setup({ profileRows: PROFILE })
      await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [near(0.2), near(0.3), near(0.65)] }), { params })
      expect(String(info.mock.lastCall?.[0])).toMatch(/posted 3, kept 1, learned 0 \(fewer than half at least/)

      setup({ profileRows: PROFILE })
      await POST(req({ speaker_label: 'local_2', decision: 'mine', embeddings: [near(0.72), near(0.65), near(0.3)] }), { params })
      expect(info).toHaveBeenLastCalledWith(`[self-confirm] capture ${CAPTURE_ID}: posted 3, kept 2, learned 2 (appended)`)
    } finally {
      info.mockRestore()
    }
  })
})
