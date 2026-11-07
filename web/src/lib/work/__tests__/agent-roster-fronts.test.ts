/**
 * The Agents page leads with each loop's bot (bots-v3 Phase 3): the roster
 * carries the loops each teammate's bot fronts and which teammates are work
 * bots, so a work bot shows its face and name with the loop's name under it.
 */
import { describe, it, expect } from 'vitest'
import { loadAgentRoster } from '../agent-roster'
import { makeFakeSupabase } from './fake-supabase'

describe('loadAgentRoster: fronted loops', () => {
  it('lists each teammate’s loops by name, oldest first, and marks work bots', async () => {
    const db = makeFakeSupabase()
    db.seed('ai_team_member', [
      { id: 'ember', workspace_id: 'w1', team_id: 't1', name: 'Ember', role: null, is_system: false, fronts_only: true, bot_character: 'ember', created_at: '1' },
      { id: 'writer', workspace_id: 'w1', team_id: 't1', name: 'Writer', role: 'writer', is_system: false, fronts_only: false, bot_character: 'writer', created_at: '2' },
    ])
    db.seed('flow', [
      { id: 'f2', workspace_id: 'w1', name: 'Digest', ai_team_member_id: 'ember', created_at: '2026-02-01' },
      { id: 'f1', workspace_id: 'w1', name: 'Weekly brief', ai_team_member_id: 'ember', created_at: '2026-01-01' },
      { id: 'f3', workspace_id: 'w1', name: 'Faceless', ai_team_member_id: null, created_at: '2026-01-01' },
    ])
    const { roster, error } = await loadAgentRoster({ session: db as never, service: null, workspaceIds: ['w1'], now: new Date() })
    expect(error).toBeNull()
    expect(roster.map((m) => [m.id, m.fronts_only, m.fronts])).toEqual([
      ['ember', true, ['Weekly brief', 'Digest']],
      ['writer', false, []],
    ])
  })
})

describe('loadAgentRoster: a custom agent’s bot (bots-v3 Phase 6)', () => {
  it('names the agent a work bot speaks for, and never a loop’s anchor, another workspace’s agent or a personal one', async () => {
    const db = makeFakeSupabase()
    db.seed('recipe', [
      { id: 'anchor', name: 'Work bot', workspace_id: null, category: 'agent', visibility: 'public' },
      { id: 'coach', name: 'Sales Coach', workspace_id: 'w1', category: 'agent', visibility: 'workspace' },
      { id: 'mine', name: 'My coach', workspace_id: 'w1', category: 'agent', visibility: 'personal' },
      { id: 'foreign', name: 'Elsewhere', workspace_id: 'w2', category: 'agent', visibility: 'workspace' },
    ])
    db.seed('ai_team_member', [
      { id: 'coach-bot', workspace_id: 'w1', team_id: 't1', name: 'Sales Coach', is_system: false, fronts_only: true, agent_recipe_id: 'coach', created_at: '1' },
      { id: 'loop-bot', workspace_id: 'w1', team_id: 't1', name: 'Ember', is_system: false, fronts_only: true, agent_recipe_id: 'anchor', created_at: '2' },
      { id: 'mine-bot', workspace_id: 'w1', team_id: 't1', name: 'My coach', is_system: false, fronts_only: true, agent_recipe_id: 'mine', created_at: '3' },
      { id: 'odd-bot', workspace_id: 'w1', team_id: 't1', name: 'Odd', is_system: false, fronts_only: true, agent_recipe_id: 'foreign', created_at: '4' },
      { id: 'coach-full', workspace_id: 'w1', team_id: 't1', name: 'Coach', is_system: false, fronts_only: false, agent_recipe_id: 'coach', created_at: '5' },
    ])
    const { roster } = await loadAgentRoster({ session: db as never, service: null, workspaceIds: ['w1'], now: new Date() })
    expect(Object.fromEntries(roster.map((m) => [m.id, m.speaks_for_agent ?? null]))).toEqual({
      'coach-bot': 'Sales Coach',
      'loop-bot': null,
      'mine-bot': null,
      'odd-bot': null,
      'coach-full': null,
    })
  })
})
