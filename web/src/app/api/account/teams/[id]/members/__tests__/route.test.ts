/**
 * GET /api/account/teams/[id]/members: a member's email is their sign-in
 * address, resolved through listMemberEmails (there is no member.email, and
 * the legacy user_profiles table has no email column, so the read this route
 * once made always came back empty and every email was '').
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'

const hoisted = vi.hoisted(() => ({
  tables: {} as Record<string, unknown>,
  listMemberEmails: vi.fn(),
  read: [] as string[],
}))

function fakeSupabase() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      hoisted.read.push(table)
      const api: Record<string, unknown> = {}
      api.select = () => api
      api.eq = () => api
      api.in = () => api
      api.order = () => api
      api.single = async () => ({ data: hoisted.tables[table] ?? null, error: hoisted.tables[table] ? null : { message: 'none' } })
      api.then = (resolve: (r: unknown) => unknown) => Promise.resolve({ data: hoisted.tables[table] ?? [], error: null }).then(resolve)
      return api
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeSupabase() }))
vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/workspace-member-emails', () => ({ listMemberEmails: hoisted.listMemberEmails }))

const { GET } = await import('../route')

beforeEach(() => {
  hoisted.read.length = 0
  hoisted.listMemberEmails.mockReset()
  hoisted.tables = {
    team: { id: 'team-1' },
    team_member: [
      { id: 'tm-1', team_role: 'lead', joined_at: '2026-01-01', member: { id: 'm-1', display_name: 'Dana', avatar_url: null, role: 'admin', user_id: 'user-dana' } },
      { id: 'tm-2', team_role: 'member', joined_at: '2026-01-02', member: { id: 'm-2', display_name: 'Sam', avatar_url: null, role: 'member', user_id: 'user-sam' } },
    ],
  }
})

describe('GET /api/account/teams/[id]/members', () => {
  it("returns each member's sign-in email, by member id, and never reads user_profiles", async () => {
    hoisted.listMemberEmails.mockResolvedValue([{ id: 'm-1', userId: 'user-dana', displayName: 'Dana', email: 'dana@dial8.ai' }])
    const res = await GET({} as NextRequest, { params: Promise.resolve({ id: 'team-1' }) })
    const body = (await res.json()) as { members: Array<{ member_id: string; email: string }> }
    expect(hoisted.listMemberEmails).toHaveBeenCalledWith('ws-1')
    expect(body.members.map((m) => [m.member_id, m.email])).toEqual([
      ['m-1', 'dana@dial8.ai'],
      // An address that could not be resolved stays empty, as before.
      ['m-2', ''],
    ])
    expect(hoisted.read).not.toContain('user_profiles')
  })

  it('does not look emails up for a team with no members', async () => {
    hoisted.tables.team_member = []
    await GET({} as NextRequest, { params: Promise.resolve({ id: 'team-1' }) })
    expect(hoisted.listMemberEmails).not.toHaveBeenCalled()
  })
})
