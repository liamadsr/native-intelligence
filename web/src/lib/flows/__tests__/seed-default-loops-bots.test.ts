/**
 * Every loop has a bot, seeded ones too (bots-v3 Phase 3): a new workspace's
 * Triage loop names the Captures face (migration 318). Seeding makes no
 * fronts_only work bot: the loops that used to get one (Weekly groom, Morning
 * brief) are no longer seeded.
 */
import { describe, it, expect } from 'vitest'
import { makeFakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { seedDefaultLoops } from '../seed-default-loops'

describe('seedDefaultLoops gives the seeded loop its bot', () => {
  it('Triage comes from Captures, and no work bot is made', async () => {
    const db = makeFakeSupabase({ rpc: { seed_system_teammates: () => ({ data: 0, error: null }) } })
    db.seed('recipe', [
      ...['triage', 'groom', 'reconcile', 'brief'].map((slug) => ({ id: `skill-${slug}`, slug, category: 'skill', is_system: true, workspace_id: null, agent_config: null })),
      { id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null },
    ])
    db.seed('member', [{ id: 'm-owner', workspace_id: 'ws-1', user_id: 'owner', role: 'owner' }])
    db.seed('team', [{ id: 'general', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-01' }])
    db.seed('team_member', [{ team_id: 'general', member_id: 'm-owner' }])
    db.seed('ai_team_member', [
      { id: 'tm-captures', workspace_id: 'ws-1', team_id: 'general', name: 'Captures', is_system: true, system_key: 'captures', bot_character: 'triage' },
      { id: 'tm-mail', workspace_id: 'ws-1', team_id: 'general', name: 'Mail', is_system: true, system_key: 'mail', bot_character: 'mail' },
    ])

    const result = await seedDefaultLoops(db as never, { workspaceId: 'ws-1', createdByUserId: 'owner' })
    expect(result.seeded).toEqual(['seed:triage'])

    const flows = db.rows('flow')
    expect(flows).toHaveLength(1)
    expect(flows[0]).toMatchObject({ seed_key: 'seed:triage', ai_team_member_id: 'tm-captures' })
    expect(db.rows('ai_team_member').map((m) => m.id).sort()).toEqual(['tm-captures', 'tm-mail'])
    expect(db.rows('ai_team_member').some((m) => m.fronts_only === true)).toBe(false)
  })
})
