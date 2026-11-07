/**
 * The "About you" routes (migration 328): the person's own facts, the same in
 * every workspace. RLS holds them to the caller on a real session; these pin
 * what the routes add: the list is the caller's live facts, an add is active
 * and `edited` (saveProfileFact, the writer `remember` uses), edit, accept and
 * delete reach only the caller's own facts, and errors name the fix.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), requireUser: vi.fn() }))
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
  requireUser: hoisted.requireUser,
}))

import { GET, POST } from '../profile/route'
import { PATCH, DELETE } from '../profile/[id]/route'

const W = 'ws-1'
const MINE = '00000000-0000-4000-8000-0000000000a1'
const GUESS = '00000000-0000-4000-8000-0000000000a2'
const THEIRS = '00000000-0000-4000-8000-0000000000a3'
const ME = 'user-me'

let db: FakeSupabase
function signIn() {
  db = makeFakeSupabase({ project: true, defaults: { profile_fact: { updated_at: '2026-10-14T00:00:00Z', superseded_by: null } } })
  db.seed('profile_fact', [
    { id: MINE, user_id: ME, text: 'Keep answers short', status: 'active', source: 'told', importance: 3, superseded_by: null, updated_at: '2026-10-01' },
    { id: GUESS, user_id: ME, text: 'Works early', status: 'proposed', source: 'learned', importance: 3, superseded_by: null, updated_at: '2026-10-02' },
    { id: THEIRS, user_id: 'user-other', text: 'Not mine', status: 'active', source: 'told', importance: 3, superseded_by: null, updated_at: '2026-10-01' },
  ])
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db, user: { id: ME }, workspaceId: W })
  hoisted.requireUser.mockResolvedValue({ supabase: db, user: { id: ME } })
}

const req = (url: string, method: string, body?: unknown) => buildRequest({ url: `https://dial8.ai${url}`, method, body }) as unknown as NextRequest
const params = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  signIn()
})

describe('GET /api/account/memory/profile', () => {
  it('lists only the caller’s live facts', async () => {
    const body = (await readJson(await GET(req('/api/account/memory/profile', 'GET')))) as { facts: Array<{ id: string }> }
    expect(body.facts.map((f) => f.id).sort()).toEqual([MINE, GUESS].sort())
  })
})

describe('POST /api/account/memory/profile', () => {
  it('adds a typed fact, active and edited, noting the workspace it was typed in', async () => {
    const res = await POST(req('/api/account/memory/profile', 'POST', { text: 'Prefers bullet points', importance: 4 }))
    expect(res.status).toBe(201)
    expect(db.rows('profile_fact').find((f) => f.text === 'Prefers bullet points')).toMatchObject({
      user_id: ME,
      status: 'active',
      source: 'edited',
      importance: 4,
      source_workspace_id: W,
    })
  })

  it('refuses contact details (400) and a malformed body, naming the fix', async () => {
    const bad = await POST(req('/api/account/memory/profile', 'POST', { text: 'Email liam@example.com' }))
    expect(bad.status).toBe(400)
    expect(((await readJson(bad)) as { error: string }).error).toMatch(/email address/)
    expect((await POST(req('/api/account/memory/profile', 'POST', { nope: 1 }))).status).toBe(400)
  })
})

describe('/api/account/memory/profile/[id]', () => {
  it('edits the caller’s own fact; another person’s is not found', async () => {
    const ok = await PATCH(req('/api/account/memory/profile/mine', 'PATCH', { text: 'Keep it brief' }), params(MINE))
    expect(ok.status).toBe(200)
    expect(db.rows('profile_fact').find((f) => f.id === MINE)).toMatchObject({ text: 'Keep it brief', source: 'edited' })
    expect((await PATCH(req('/x', 'PATCH', { text: 'mine now' }), params(THEIRS))).status).toBe(404)
  })

  it('accepts a proposal, and refuses any other status', async () => {
    expect((await PATCH(req('/x', 'PATCH', { status: 'active' }), params(GUESS))).status).toBe(200)
    expect(db.rows('profile_fact').find((f) => f.id === GUESS)?.status).toBe('active')
    expect((await PATCH(req('/x', 'PATCH', { status: 'proposed' }), params(MINE))).status).toBe(400)
  })

  it('deletes the caller’s own fact (the chip’s Undo); another person’s is not found', async () => {
    expect((await DELETE(req('/x', 'DELETE'), params(THEIRS))).status).toBe(404)
    expect((await DELETE(req('/x', 'DELETE'), params(MINE))).status).toBe(200)
    expect(db.rows('profile_fact').map((f) => f.id).sort()).toEqual([GUESS, THEIRS].sort())
  })

  it('answers 404 for an id that cannot be a fact, before the database sees it', async () => {
    for (const id of ['not-a-uuid', 'x; drop table profile_fact', '']) {
      expect((await DELETE(req('/x', 'DELETE'), params(id))).status).toBe(404)
      expect((await PATCH(req('/x', 'PATCH', { text: 'x' }), params(id))).status).toBe(404)
    }
    expect(db.calls).toHaveLength(0)
  })
})
