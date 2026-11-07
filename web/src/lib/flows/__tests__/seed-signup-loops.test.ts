/**
 * seedSignupLoops: Triage lands in a new account's own workspace at signup,
 * through the real seeder, and nowhere else: not a workspace the account was
 * invited into, not an old workspace handed to it.
 */
import { describe, it, expect, vi } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { seedSignupLoops } from '../seed-signup-loops'

const NOW = Date.parse('2026-10-17T12:00:00.000Z')
const MIN = 60 * 1000

function world() {
  const db = makeFakeSupabase({ rpc: { seed_system_teammates: () => ({ data: 0, error: null }) } })
  db.seed('recipe', [
    { id: 'skill-triage', slug: 'triage', category: 'skill', is_system: true, workspace_id: null, agent_config: null },
    { id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null },
  ])
  db.seed('workspace', [
    // The signup trigger's workspace, made with the account a minute ago.
    { id: 'ws-own', created_at: new Date(NOW - 1 * MIN).toISOString() },
    // Someone else's workspace the new account was invited into.
    { id: 'ws-invited', created_at: new Date(NOW - 30 * MIN).toISOString() },
    // An old workspace whose ownership was handed to the new account.
    { id: 'ws-handed-over', created_at: '2026-01-01T00:00:00.000Z' },
  ])
  db.seed('member', [
    { id: 'm-own', workspace_id: 'ws-own', user_id: 'new-user', role: 'owner' },
    { id: 'm-invited', workspace_id: 'ws-invited', user_id: 'new-user', role: 'member' },
    { id: 'm-old', workspace_id: 'ws-handed-over', user_id: 'new-user', role: 'owner' },
  ])
  db.seed('team', ['ws-own', 'ws-invited', 'ws-handed-over'].map((w) => ({ id: `team-${w}`, workspace_id: w, is_private: false, created_at: '2026-01-01' })))
  db.seed('ai_team_member', ['ws-own', 'ws-invited', 'ws-handed-over'].map((w) => ({
    id: `captures-${w}`, workspace_id: w, team_id: `team-${w}`, name: 'Captures', is_system: true, system_key: 'captures', bot_character: 'triage',
  })))
  return db
}

describe('seedSignupLoops', () => {
  it("seeds Triage into the account's own fresh workspace only", async () => {
    const db = world()
    const res = await seedSignupLoops(db as never, { userId: 'new-user', nowMs: NOW })

    expect(res.workspaceIds).toEqual(['ws-own'])
    const flows = db.rows('flow')
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({
      workspace_id: 'ws-own',
      seed_key: 'seed:triage',
      enabled: true,
      created_by: 'new-user',
      ai_team_member_id: 'captures-ws-own',
    })
    // No fronts_only work bot was made for it.
    expect(db.rows('ai_team_member').some((m) => m.fronts_only === true)).toBe(false)
  })

  it('is idempotent across pings: a second call inserts nothing', async () => {
    const db = world()
    await seedSignupLoops(db as never, { userId: 'new-user', nowMs: NOW })
    await seedSignupLoops(db as never, { userId: 'new-user', nowMs: NOW + 5 * MIN })
    expect(db.rows('flow')).toHaveLength(1)
  })

  it('does nothing for a user who owns no workspace', async () => {
    const db = world()
    const res = await seedSignupLoops(db as never, { userId: 'nobody', nowMs: NOW })
    expect(res.workspaceIds).toEqual([])
    expect(db.rows('flow')).toHaveLength(0)
  })

  it('logs and carries on when one workspace fails to seed', async () => {
    const db = world()
    // The skill lookup fails: seedDefaultLoops throws for the workspace.
    const from = db.from.bind(db)
    const failing = {
      ...db,
      from: (table: string) => {
        if (table === 'recipe') throw new Error('recipe read failed')
        return from(table)
      },
    }
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await seedSignupLoops(failing as never, { userId: 'new-user', nowMs: NOW })
    expect(res.workspaceIds).toEqual(['ws-own'])
    expect(errorSpy).toHaveBeenCalledWith('[seed-signup-loops] seed-default-loops failed', expect.objectContaining({ workspaceId: 'ws-own' }))
    errorSpy.mockRestore()
  })

  it('throws when the memberships cannot be read', async () => {
    const failing = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'down' } }) }) }),
      }),
    }
    await expect(seedSignupLoops(failing as never, { userId: 'new-user', nowMs: NOW })).rejects.toThrow(/down/)
  })
})
