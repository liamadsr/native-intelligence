/**
 * The roster's `reachable` (bots-v4 Phase C): read for a user, each entry says
 * whether they may talk to it under the private-team rule (an unreachable
 * bot's work shows as the Assistant's, bot-owner.ts). RLS alone can't: an
 * owner or admin sees a private team's teammates they may not chat with. Read
 * beside the roster's own reads, on the session client; a failed read leaves
 * only system teammates reachable (the rest are unknown, `null`, which the
 * crew still draws), never the roster. Also carries the agent each teammate
 * is built on (`agent_recipe_id`).
 */
import { describe, it, expect } from 'vitest'
import { loadAgentRoster } from '../agent-roster'
import { makeFakeSupabase } from './fake-supabase'

function world() {
  const db = makeFakeSupabase({ project: true })
  db.seed('ai_team_member', [
    { id: 'triage', workspace_id: 'w1', team_id: null, name: 'Triage', role: null, is_system: true, system_key: 'triage', fronts_only: false, bot_character: 'triage', agent_recipe_id: 'anchor-triage', created_at: '1' },
    { id: 'writer', workspace_id: 'w1', team_id: 't-open', name: 'Writer', role: 'writer', is_system: false, fronts_only: false, bot_character: 'writer', agent_recipe_id: 'role-writer', created_at: '2' },
    { id: 'closer', workspace_id: 'w1', team_id: 't-private', name: 'Closer', role: null, is_system: false, fronts_only: false, bot_character: 'research', agent_recipe_id: null, created_at: '3' },
    { id: 'mine', workspace_id: 'w1', team_id: 't-mine', name: 'Mine', role: null, is_system: false, fronts_only: false, bot_character: 'dev', agent_recipe_id: null, created_at: '4' },
  ])
  db.seed('team', [
    { id: 't-open', workspace_id: 'w1', is_private: false },
    { id: 't-private', workspace_id: 'w1', is_private: true },
    { id: 't-mine', workspace_id: 'w1', is_private: true },
  ])
  db.seed('member', [{ id: 'm-1', user_id: 'user-1', workspace_id: 'w1' }])
  db.seed('team_member', [{ team_id: 't-mine', member_id: 'm-1' }])
  db.seed('flow', [])
  return db
}

describe('loadAgentRoster: reachable', () => {
  it('read for a user, each entry says whether they may talk to it, and names the agent it’s built on', async () => {
    const { roster, error } = await loadAgentRoster({ session: world() as never, service: null, workspaceIds: ['w1'], userId: 'user-1', now: new Date() })
    expect(error).toBeNull()
    expect(Object.fromEntries(roster.map((m) => [m.id, m.reachable]))).toEqual({ triage: true, writer: true, closer: false, mine: true })
    expect(roster.find((m) => m.id === 'writer')!.agent_recipe_id).toBe('role-writer')
  })

  it('without a user, no entry carries it (the autonomy page’s read)', async () => {
    const { roster } = await loadAgentRoster({ session: world() as never, service: null, workspaceIds: ['w1'], now: new Date() })
    for (const m of roster) expect(m).not.toHaveProperty('reachable')
  })

  it('a failed reach read keeps the roster: system teammates stay reachable, the rest are unknown (null)', async () => {
    const db = world()
    // The team read fails; every other read is the double's.
    const failing = { team: { select: () => ({ in: async () => ({ data: null, error: { message: 'down' } }) }) } }
    const session = { from: (table: string) => (table in failing ? failing[table as keyof typeof failing] : db.from(table)) }
    const { roster, error } = await loadAgentRoster({ session: session as never, service: null, workspaceIds: ['w1'], userId: 'user-1', now: new Date() })
    expect(error).toBeNull()
    expect(roster).toHaveLength(4)
    // Unknown, not unreachable: the agent's page still closes on
    // them (it reads `=== true`), but the crew draws them rather than losing
    // every custom and work bot until the next read (review of #650).
    expect(Object.fromEntries(roster.map((m) => [m.id, m.reachable]))).toEqual({ triage: true, writer: null, closer: null, mine: null })
  })
})
