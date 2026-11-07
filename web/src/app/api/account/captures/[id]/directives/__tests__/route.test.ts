/**
 * /api/account/captures/[id]/directives — a typed `@notes …` in the meeting
 * chat (live-agent messaging L2). Pins: only the capture's owner, fenced on
 * the workspace; closed once the end-of-meeting pass wrote the record; the
 * text rules (trimmed, 1–500); the 20-pending cap per author; the row is the
 * user's (`source: 'user'`) and written with the service role; GET lists only
 * the caller's own rows on this capture, oldest first.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import {
  CAP,
  OTHER,
  OWNER,
  WS,
  directiveDb,
  liveCapture,
  type DirectiveDb,
} from '@/lib/live-agent/__tests__/helpers/directive-db'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), service: { current: null as unknown } }))
vi.mock('@/lib/api-auth', () => ({ requireWorkspace: hoisted.requireWorkspace }))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service.current }))

import { GET, POST } from '@/app/api/account/captures/[id]/directives/route'

let userDb: DirectiveDb
let serviceDb: DirectiveDb

function setup(seed: Parameters<typeof directiveDb>[0], userId = OWNER, opts: { insertError?: string } = {}) {
  // One store behind both clients: the user's session reads, the service role writes.
  serviceDb = directiveDb(seed, opts)
  userDb = serviceDb
  hoisted.service.current = serviceDb.client
  hoisted.requireWorkspace.mockResolvedValue({ supabase: userDb.client, user: { id: userId }, workspaceId: WS })
}

const params = (id = CAP) => ({ params: Promise.resolve({ id }) })
const post = (body: unknown, raw = false) =>
  POST(buildRequest({ body, raw }) as unknown as NextRequest, params())

beforeEach(() => {
  vi.clearAllMocks()
})

describe('POST — who may send', () => {
  it('the owner of a live capture: 201 with the row, written as the user’s', async () => {
    setup({ captures: [liveCapture()] })
    const res = await post({ text: '  Dana owns the budget  ' })
    expect(res.status).toBe(201)
    const { directive } = await readJson<{ directive: Record<string, unknown> }>(res)
    expect(directive).toMatchObject({ capture_id: CAP, source: 'user', text: 'Dana owns the budget', status: 'pending' })
    expect(serviceDb.tables.live_directive).toHaveLength(1)
    expect(serviceDb.tables.live_directive[0]).toMatchObject({ created_by: OWNER, workspace_id: WS })
  })

  it('another member: 403, nothing written', async () => {
    setup({ captures: [liveCapture()] }, OTHER)
    const res = await post({ text: 'x' })
    expect(res.status).toBe(403)
    expect(serviceDb.tables.live_directive).toHaveLength(0)
  })

  it('a capture in another workspace reads as not found: 403', async () => {
    setup({ captures: [liveCapture({ workspace_id: 'ws-other' })] })
    expect((await post({ text: 'x' })).status).toBe(403)
    expect(serviceDb.tables.live_directive).toHaveLength(0)
  })

  it('once the end-of-meeting pass wrote the record: 409 CAPTURE_CLOSED', async () => {
    setup({ captures: [liveCapture({ batch_processed_at: '2026-09-29T20:00:00Z' })] })
    const res = await post({ text: 'x' })
    expect(res.status).toBe(409)
    expect((await readJson<{ code: string }>(res)).code).toBe('CAPTURE_CLOSED')
    expect(serviceDb.tables.live_directive).toHaveLength(0)
  })
})

describe('POST — the text', () => {
  it.each([
    ['missing', {}],
    ['not a string', { text: 42 }],
    ['blank', { text: '   ' }],
    ['over 500 characters', { text: 'x'.repeat(501) }],
  ])('%s: 400, nothing written', async (_label, body) => {
    setup({ captures: [liveCapture()] })
    expect((await post(body)).status).toBe(400)
    expect(serviceDb.tables.live_directive).toHaveLength(0)
  })

  it('invalid JSON: 400', async () => {
    setup({ captures: [liveCapture()] })
    expect((await post('{nope', true)).status).toBe(400)
  })

  it('exactly 500 characters is fine', async () => {
    setup({ captures: [liveCapture()] })
    expect((await post({ text: 'x'.repeat(500) })).status).toBe(201)
  })
})

describe('POST — the pending cap', () => {
  const pending = (n: number, by = OWNER, status = 'pending') =>
    Array.from({ length: n }, (_, i) => ({
      id: `seed-${by}-${status}-${i}`,
      capture_id: CAP,
      workspace_id: WS,
      created_by: by,
      source: 'user',
      text: `t${i}`,
      status,
      created_at: `2026-09-29T19:00:${String(i).padStart(2, '0')}Z`,
      consumed_at: null,
    }))

  it('20 pending from this author: 429 DIRECTIVE_CAP', async () => {
    setup({ captures: [liveCapture()], live_directive: pending(20) })
    const res = await post({ text: 'one more' })
    expect(res.status).toBe(429)
    expect((await readJson<{ code: string }>(res)).code).toBe('DIRECTIVE_CAP')
    expect(serviceDb.tables.live_directive).toHaveLength(20)
  })

  it('counts only this author’s PENDING ones', async () => {
    setup({
      captures: [liveCapture()],
      live_directive: [...pending(19), ...pending(5, OWNER, 'consumed'), ...pending(5, OTHER)],
    })
    expect((await post({ text: 'the twentieth' })).status).toBe(201)
  })

  it('a failed write: 500', async () => {
    setup({ captures: [liveCapture()] }, OWNER, { insertError: 'down' })
    expect((await post({ text: 'x' })).status).toBe(500)
  })
})

describe('GET', () => {
  it('lists the caller’s own directives on this capture and workspace, oldest first', async () => {
    const row = (id: string, over: Record<string, unknown>) => ({
      id,
      capture_id: CAP,
      workspace_id: WS,
      created_by: OWNER,
      source: 'user',
      text: id,
      status: 'pending',
      consumed_at: null,
      ...over,
    })
    setup({
      captures: [liveCapture()],
      live_directive: [
        row('later', { created_at: '2026-09-29T20:05:00Z' }),
        row('earlier', { created_at: '2026-09-29T20:01:00Z' }),
        row('someone-else', { created_at: '2026-09-29T20:02:00Z', created_by: OTHER }),
        row('other-capture', { created_at: '2026-09-29T20:03:00Z', capture_id: 'cap-2' }),
        row('other-workspace', { created_at: '2026-09-29T20:04:00Z', workspace_id: 'ws-other' }),
      ],
    })
    const res = await GET(buildRequest({ method: 'GET' }) as unknown as NextRequest, params())
    expect(res.status).toBe(200)
    const { directives } = await readJson<{ directives: Array<{ id: string }> }>(res)
    expect(directives.map((d) => d.id)).toEqual(['earlier', 'later'])
  })
})
