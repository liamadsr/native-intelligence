/**
 * DELETE /api/account/team-chat/messages/<id> on a meeting guest's message
 * (migration 670): nobody's own, so any member who may read the conversation
 * takes it down, through 670's meeting_guest_chat_remove (the service role's,
 * which checks the member again). A member who may not read it, another
 * workspace's message, a member's or an agent's message: never this way (404,
 * the function not called). The person's own message still goes the usual way.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'

const WS = '11111111-1111-4111-8111-111111111111'
const ANA = '33333333-3333-4333-8333-333333333333'
const CH = '55555555-5555-4555-8555-555555555555'
const MSG = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

const h = vi.hoisted(() => ({
  /** What the person's own delete (RLS: their own only) finds. */
  own: null as { paths: string[] } | null,
  /** The row as the person may read it (RLS), or null. */
  message: null as Record<string, unknown> | null,
  channel: null as Record<string, unknown> | null,
  removed: true,
  rpcs: [] as Array<[string, Record<string, unknown>]>,
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: {}, user: { id: 'u-ana' }, workspaceId: WS, member: { id: ANA } }),
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ rpc: async (name: string, args: Record<string, unknown>) => (h.rpcs.push([name, args]), { data: h.removed, error: null }) }),
}))
vi.mock('@/lib/team-chat/record-mentions', () => ({ fenceRecordMentions: async () => [], storedRecordMentions: async () => [], syncMessageMentions: async () => undefined }))
vi.mock('@/lib/team-chat/store', async (orig) => ({
  ...(await orig<typeof import('@/lib/team-chat/store')>()),
  deleteMessage: async () => h.own,
  getMessage: async () => h.message,
  getChannel: async () => h.channel,
  removeFiles: async () => undefined,
}))

const { DELETE } = await import('../messages/[id]/route')

const del = () => DELETE(new NextRequest(`http://localhost/api/account/team-chat/messages/${MSG}`, { method: 'DELETE' }), { params: Promise.resolve({ id: MSG }) })
const row = (over: Record<string, unknown>) => ({ id: MSG, channel_id: CH, author_kind: 'guest', author_member_id: null, guest_name: 'Sam Ruiz', deleted_at: null, ...over })

beforeEach(() => {
  h.own = null
  h.message = row({})
  h.channel = { id: CH, workspace_id: WS, kind: 'meeting' }
  h.removed = true
  h.rpcs = []
})

describe('a member takes a meeting guest’s message down', () => {
  it('a member who may read the conversation: taken down by 670’s function, as them', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(h.rpcs).toEqual([['meeting_guest_chat_remove', { target_message: MSG, by_member: ANA }]])
  })

  it('a member the function says may not read it: 404', async () => {
    h.removed = false
    expect((await del()).status).toBe(404)
  })

  it('a message they may not read (RLS), or another workspace’s: 404, the function not called', async () => {
    h.message = null
    expect((await del()).status).toBe(404)
    h.message = row({})
    h.channel = { id: CH, workspace_id: '99999999-9999-4999-8999-999999999999', kind: 'meeting' }
    expect((await del()).status).toBe(404)
    expect(h.rpcs).toEqual([])
  })

  it('someone else’s message, an agent’s reply, or one already gone: never this way', async () => {
    for (const over of [{ author_kind: 'member', author_member_id: '44444444-4444-4444-8444-444444444444', guest_name: null }, { author_kind: 'agent', agent_name: 'Juniper', guest_name: null }, { deleted_at: '2026-11-19T10:00:00Z' }]) {
      h.message = row(over)
      expect((await del()).status, JSON.stringify(over)).toBe(404)
    }
    expect(h.rpcs).toEqual([])
  })

  it('their own message still goes the usual way, never through the guest’s function', async () => {
    h.own = { paths: [] }
    expect((await del()).status).toBe(200)
    expect(h.rpcs).toEqual([])
  })
})
