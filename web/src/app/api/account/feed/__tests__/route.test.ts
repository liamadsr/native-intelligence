/**
 * GET /api/account/feed: the filter is read before anything else (a bad one
 * is a 400 and reads nothing), the feed is read for the signed-in member on
 * their own session client, and a failed read is a 500 that says nothing of
 * why. The feed's filters and fences are src/lib/entities/__tests__/feed.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  loadFeed: vi.fn(),
  auth: vi.fn(),
}))
vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: h.auth }))
vi.mock('@/lib/entities/feed', () => ({ loadFeed: h.loadFeed }))

import { GET } from '../route'

const WS = '11111111-1111-4111-8111-111111111111'
const session = { from: vi.fn() }

beforeEach(() => {
  h.loadFeed.mockReset()
  h.auth.mockReset()
  h.auth.mockResolvedValue({ supabase: session, user: { id: 'user-ana' }, workspaceId: WS, member: { id: 'member-ana' } })
})

const call = (q: string) => GET(new NextRequest(`http://localhost/api/account/feed${q}`))

describe('GET /api/account/feed', () => {
  it('reads the feed for the member, on their session client, under the filter asked for', async () => {
    h.loadFeed.mockResolvedValue({ entries: [], next_cursor: null })
    const res = await call('?assigned_to=me&mentioned=me&limit=5')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ entries: [], next_cursor: null, workspace_id: WS })
    const [client, viewer, filter] = h.loadFeed.mock.calls[0]
    expect(client).toBe(session)
    expect(viewer).toEqual({ workspaceId: WS, userId: 'user-ana', memberId: 'member-ana' })
    expect(filter).toMatchObject({ assignedToMe: true, mentionedMe: true, limit: 5, group: 'entity' })
  })

  it('refuses a filter it can’t read before reading anything', async () => {
    const res = await call('?kinds=email')
    expect(res.status).toBe(400)
    expect(h.auth).not.toHaveBeenCalled()
    expect(h.loadFeed).not.toHaveBeenCalled()
  })

  it('passes a signed-out request’s refusal through', async () => {
    h.auth.mockResolvedValue(new Response('no', { status: 401 }))
    expect((await call('')).status).toBe(401)
    expect(h.loadFeed).not.toHaveBeenCalled()
  })

  it('answers a failed read with a 500 that keeps the reason to the log', async () => {
    h.loadFeed.mockResolvedValue({ error: 'relation "entity_activity" does not exist' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await call('')
    expect(res.status).toBe(500)
    expect(JSON.stringify(await res.json())).not.toContain('entity_activity')
  })
})
