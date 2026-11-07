/**
 * Tests for DELETE /api/account/teams/[id] — specifically the last-team guard.
 *
 * Every workspace must keep at least one team: action/board creation resolves
 * the "default team" (the oldest one), and a teamless workspace makes the agent
 * report "No team found in workspace". The DELETE route counts the workspace's
 * teams and refuses (409) when this is the only one.
 *
 * What we lock in:
 *   - 409 and NO delete issued when the workspace has exactly one team
 *   - 200 and delete issued when the workspace has more than one team
 *   - 409, the same answer, when the database refuses the delete because the
 *     team holds the workspace's system teammates and no other team is left
 *     (migration 311's team_keep_system_teammates, restrict_violation 23001):
 *     a race past the count, or a team the caller can't see
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { readJson } from '@/test/integration'

const hoisted = vi.hoisted(() => ({
  getCurrentWorkspaceId: vi.fn(),
  // Count returned by the team `select(..., { count: 'exact', head: true })`.
  teamCount: 1,
  // What the delete answers (the database's refusal, migration 311).
  deleteError: null as { code?: string; message: string } | null,
  // Rows the delete matched (0 = RLS refused it, or the team is gone).
  deletedCount: 1,
  // Whether the visibility re-read after a 0-row delete still sees the team.
  teamVisible: true,
  // Spy so we can assert the destructive delete was (not) attempted.
  teamDelete: vi.fn(() => ({
    eq: () => ({
      eq: () => Promise.resolve({ error: hoisted.deleteError, count: hoisted.deleteError ? null : hoisted.deletedCount }),
    }),
  })),
}))

// Minimal Supabase double: the route only calls `.from('team')` with either a
// head-count select or a delete chain, plus auth.getUser.
function makeFakeSupabase() {
  return {
    from: (_table: string) => ({
      // select('id', { count: 'exact', head: true }).eq('workspace_id', ws)
      // or, after a 0-row delete, select('id').eq().eq().maybeSingle()
      select: () => ({
        eq: () => ({
          then: (cb: (v: unknown) => unknown) =>
            Promise.resolve({ count: hoisted.teamCount, error: null }).then(cb),
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({ data: hoisted.teamVisible ? { id: 'team-1' } : null, error: null }),
          }),
        }),
      }),
      // delete().eq('id', id).eq('workspace_id', ws)
      delete: hoisted.teamDelete,
    }),
    auth: { getUser: vi.fn(async () => ({ data: { user: { id: 'user-1' } } })) },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => makeFakeSupabase(),
}))

vi.mock('@/lib/workspace', () => ({
  getCurrentWorkspaceId: hoisted.getCurrentWorkspaceId,
}))

const { DELETE } = await import('@/app/api/account/teams/[id]/route')

function delReq(): NextRequest {
  return new Request('http://localhost/api/account/teams/team-1', {
    method: 'DELETE',
  }) as unknown as NextRequest
}

const params = Promise.resolve({ id: 'team-1' })

describe('DELETE /api/account/teams/[id] — last-team guard', () => {
  beforeEach(() => {
    hoisted.getCurrentWorkspaceId.mockResolvedValue('ws-1')
    hoisted.teamDelete.mockClear()
    hoisted.teamCount = 1
    hoisted.deleteError = null
    hoisted.deletedCount = 1
    hoisted.teamVisible = true
  })

  it('refuses (409) and does not delete when it is the only team', async () => {
    hoisted.teamCount = 1
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toContain('only team')
    expect(hoisted.teamDelete).not.toHaveBeenCalled()
  })

  it('deletes (200) when the workspace has more than one team', async () => {
    hoisted.teamCount = 2
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(200)
    expect(hoisted.teamDelete).toHaveBeenCalledTimes(1)
  })

  it('answers 409 when the database refuses: the system teammates have no other team to move to', async () => {
    hoisted.teamCount = 2
    hoisted.deleteError = { code: '23001', message: 'a workspace keeps one team for its system teammates' }
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; code?: string }>(res)
    expect(body).toMatchObject({ code: 'LAST_TEAM' })
    expect(body.error).toContain('only team')
  })

  it.each(['23503', '40P01'])('answers 409 "try again" when a concurrent team delete raced the move (%s)', async (code) => {
    hoisted.teamCount = 2
    hoisted.deleteError = { code, message: 'raced' }
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(409)
    expect(await readJson<{ code?: string }>(res)).toMatchObject({ code: 'TEAM_CHANGED' })
  })

  it('keeps any other database error a 500', async () => {
    hoisted.teamCount = 2
    hoisted.deleteError = { code: '42501', message: 'permission denied' }
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(500)
  })

  // team delete RLS is owner/admin only (migration 017): a refused delete
  // matches 0 rows with no error and must not answer success.
  it('answers 403 when the delete matched no row but the team is visible', async () => {
    hoisted.teamCount = 2
    hoisted.deletedCount = 0
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(403)
  })

  it('answers 404 when the delete matched no row and the team is not visible', async () => {
    hoisted.teamCount = 2
    hoisted.deletedCount = 0
    hoisted.teamVisible = false
    const res = await DELETE(delReq(), { params })
    expect(res.status).toBe(404)
  })
})
