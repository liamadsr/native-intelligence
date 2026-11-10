/**
 * /api/account/agent-memory (trust layer P2; decision 16 as apply with undo):
 * what the agents learned at work. Pins: only an owner or admin sees or
 * changes it (a member gets an empty answer and is refused a change; a
 * non-member is refused); the list is the caller's workspace's live entries
 * only, an outside-read one among them with the tools that brought it, never
 * one learned from a capture the caller can't see; remove and restore move
 * an entry, and nothing can be accepted or dismissed; bad input names the
 * fix; a failed read never leaks the database's error.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({ requireWorkspace: vi.fn(), service: null as unknown }))
vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => hoisted.service }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { GET, PATCH } from '../route'

const W = 'ws-1'
const ME = 'user-me'
const MATE = 'mate-1'

let db: FakeSupabase
function signIn(role: string | null) {
  db = makeFakeSupabase()
  if (role) db.seed('member', [{ workspace_id: W, user_id: ME, role }])
  db.seed('ai_team_member', [{ id: MATE, workspace_id: W, name: 'Quill' }])
  db.seed('captures', [{ id: 'cap-theirs', workspace_id: W, visibility: 'private', user_id: 'someone', is_eval: false }])
  db.seed('agent_memory', [
    { id: 'm-web', workspace_id: W, ai_team_member_id: MATE, kind: 'fact', text: 'Acme moved to annual billing.', salience: 1, status: 'active', source: { trust: 'agent_unattended', outside_reads: ['web_fetch'] }, agent_run_id: 'run-1', created_at: '2026-10-18T00:00:00Z' },
    { id: 'm-live', workspace_id: W, ai_team_member_id: MATE, kind: 'preference', text: 'Dana likes bullets.', salience: 1, status: 'active', source: { trust: 'person' }, created_at: '2026-10-17T00:00:00Z' },
    { id: 'm-private', workspace_id: W, ai_team_member_id: MATE, kind: 'fact', text: 'From their private call.', salience: 1, status: 'active', source: { capture_ids: ['cap-theirs'] }, created_at: '2026-10-18T00:00:00Z' },
    { id: 'm-other', workspace_id: 'ws-2', ai_team_member_id: 'mate-9', kind: 'fact', text: 'Not ours.', salience: 1, status: 'active', source: {}, created_at: '2026-10-18T00:00:00Z' },
  ])
  hoisted.service = db
  hoisted.requireWorkspace.mockResolvedValue({ supabase: db, user: { id: ME }, workspaceId: W })
}
const patch = (body: unknown) => PATCH(buildRequest({ url: 'https://nativeintelligence.dev/api/account/agent-memory', method: 'PATCH', body }) as unknown as NextRequest)
const statusOf = (id: string) => db.rows('agent_memory').find((r) => r.id === id)!.status

beforeEach(() => vi.clearAllMocks())

describe('GET /api/account/agent-memory', () => {
  it('an owner or admin gets the live entries, with the teammate’s name, when, and what outside text taught one, never one from a capture they can’t see', async () => {
    for (const role of ['owner', 'admin']) {
      signIn(role)
      const res = await GET()
      expect(res.status).toBe(200)
      const body = (await readJson(res)) as { canManage: boolean; entries: Array<Record<string, unknown>> } & Record<string, unknown>
      expect(body.canManage).toBe(true)
      expect(body).not.toHaveProperty('suggestions')
      expect(body.entries.map((e) => e.id)).toEqual(['m-web', 'm-live'])
      expect(body.entries[0]).toMatchObject({ teammateName: 'Quill', outsideReads: ['web_fetch'], text: 'Acme moved to annual billing.', createdAt: '2026-10-18T00:00:00Z' })
      expect(body.entries[1]).toMatchObject({ outsideReads: [] })
    }
  })

  it('a member gets nothing to show (no error); a non-member is refused', async () => {
    signIn('member')
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await readJson(res)).toEqual({ canManage: false, entries: [] })
    signIn(null)
    expect((await GET()).status).toBe(403)
  })

  it('N5: a failed read says so without the database’s words', async () => {
    signIn('admin')
    hoisted.service = { from: () => { throw new Error('relation "agent_memory" does not exist at secret-host:5432') } }
    const res = await GET()
    expect(res.status).toBe(500)
    expect(JSON.stringify(await readJson(res))).not.toMatch(/secret-host|relation/)
  })
})

describe('PATCH /api/account/agent-memory', () => {
  it('remove takes an outside-read entry out, and restore brings it back', async () => {
    signIn('owner')
    expect((await patch({ id: 'm-web', action: 'remove' })).status).toBe(200)
    expect(statusOf('m-web')).toBe('retired')
    expect((await patch({ id: 'm-web', action: 'restore' })).status).toBe(200)
    expect(statusOf('m-web')).toBe('active')
    expect((await patch({ id: 'm-web', action: 'restore' })).status).toBe(409)
  })

  it('there is no accept or dismiss any more', async () => {
    signIn('admin')
    expect((await patch({ id: 'm-live', action: 'accept' })).status).toBe(400)
    expect((await patch({ id: 'm-live', action: 'dismiss' })).status).toBe(400)
    expect(statusOf('m-live')).toBe('active')
  })

  it('another workspace’s entry, or one from a capture the caller can’t see, is not found; a member may not change; bad input names the fix', async () => {
    signIn('admin')
    expect((await patch({ id: 'm-other', action: 'remove' })).status).toBe(404)
    expect((await patch({ id: 'm-private', action: 'remove' })).status).toBe(404)
    expect(statusOf('m-private')).toBe('active')
    expect((await patch({ action: 'remove' })).status).toBe(400)
    signIn('member')
    expect((await patch({ id: 'm-live', action: 'remove' })).status).toBe(403)
    expect(statusOf('m-live')).toBe('active')
  })
})
