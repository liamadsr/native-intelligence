/**
 * flowTeammateId (bots-v3 Phase 3): who a loop run is attributed to, in the
 * plan's order: the seed, then the loop's own bot (flow.ai_team_member_id)
 * while the run-as member can reach it, then Captures for a verdict skill
 * (Triage until migration 318), then (bots-v4 Phase 5) the work with no
 * teammate's order: the teammate that holds one of its skills, else the face
 * of its skills' area (one-agent S3), else the Assistant. None only when even
 * the Assistant can't be read. And flowAttribution's area. Against the
 * in-memory database double.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { flowAttribution, flowTeammateId } from '../system-teammates'
import { makeFakeSupabase } from './fake-supabase'

const WS = 'ws-1'

function world(opts: { assistant?: boolean; holder?: boolean } = {}) {
  const db = makeFakeSupabase({ project: true, rpc: { seed_system_teammates: () => ({ data: 0, error: null }) } })
  db.seed('recipe', [
    { id: 'skill-verdict', category: 'skill', workspace_id: WS, is_system: false, agent_config: { output_contract: 'verdict' } },
    { id: 'skill-prose', category: 'skill', workspace_id: WS, is_system: false, agent_config: { output_contract: 'prose' } },
    { id: 'skill-mail', category: 'skill', workspace_id: WS, is_system: false, area: 'mail', agent_config: { output_contract: 'prose' } },
    { id: 'skill-mail-2', category: 'skill', workspace_id: WS, is_system: false, area: 'mail', agent_config: {} },
    { id: 'skill-calendar', category: 'skill', workspace_id: WS, is_system: false, area: 'calendar', agent_config: {} },
  ])
  db.seed('team', [
    { id: 'team-open', workspace_id: WS, is_private: false },
    { id: 'team-private', workspace_id: WS, is_private: true },
  ])
  db.seed('team_member', [{ team_id: 'team-private', member_id: 'm-insider' }])
  db.seed('ai_team_member', [
    { id: 'tm-captures', workspace_id: WS, team_id: 'team-open', system_key: 'captures', is_system: true },
    { id: 'tm-mail', workspace_id: WS, team_id: 'team-open', system_key: 'mail', is_system: true },
    { id: 'ember', workspace_id: WS, team_id: 'team-open', system_key: null, is_system: false, fronts_only: true },
    { id: 'secret', workspace_id: WS, team_id: 'team-private', system_key: null, is_system: false, fronts_only: true },
    { id: 'elsewhere', workspace_id: 'ws-2', team_id: 'team-x', system_key: null, is_system: false },
    ...(opts.assistant === false ? [] : [{ id: 'tm-assistant', workspace_id: WS, team_id: 'team-open', system_key: 'assistant', is_system: true }]),
    ...(opts.holder
      ? [
          { id: 'coach', workspace_id: WS, team_id: 'team-open', system_key: null, is_system: false, created_at: '2026-09-02T00:00:00Z' },
          { id: 'coach-secret', workspace_id: WS, team_id: 'team-private', system_key: null, is_system: false, created_at: '2026-09-01T00:00:00Z' },
        ]
      : []),
  ])
  if (opts.holder) {
    // Each hold with its teammate embedded, as the `ai_team_member!inner(...)` read returns it.
    const hold = (id: string) => ({ ai_team_member_id: id, skill_recipe_id: 'skill-prose', ai_team_member: db.rows('ai_team_member').find((m) => m.id === id) })
    db.seed('ai_team_member_skill', [
      hold('coach'),
      hold('coach-secret'),
      // A system teammate holding the skill speaks for its own job, never this loop.
      hold('tm-captures'),
    ])
  }
  return db as unknown as SupabaseClient
}

const verdict = [{ type: 'run_skill', enabled: true, config: { skill_id: 'skill-verdict' } }]
const prose = [{ type: 'run_skill', enabled: true, config: { skill_id: 'skill-prose' } }]

describe('flowTeammateId: seed, then the column, then verdict → Captures, then the skill holder, then the area face, then the Assistant', () => {
  it('keeps a seeded loop on its system teammate, whatever its column says', async () => {
    expect(await flowTeammateId(world(), WS, { seed_key: 'seed:reconcile', ai_team_member_id: 'ember', actions: prose }, 'm-1')).toBe(
      'tm-captures',
    )
  })

  it('names the loop’s own bot over the verdict stopgap', async () => {
    expect(await flowTeammateId(world(), WS, { seed_key: null, ai_team_member_id: 'ember', actions: verdict }, 'm-1')).toBe('ember')
  })

  it('names a private-team bot only for a run-as member on that team', async () => {
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: 'secret', actions: prose }, 'm-insider')).toBe('secret')
  })

  it('falls back when the run-as member can’t reach the bot: Captures for verdict, else the Assistant', async () => {
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: 'secret', actions: verdict }, 'm-1')).toBe('tm-captures')
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: 'secret', actions: prose }, 'm-1')).toBe('tm-assistant')
  })

  it('falls back for a bot in another workspace or one that is gone', async () => {
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: 'elsewhere', actions: prose }, 'm-1')).toBe('tm-assistant')
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: 'deleted', actions: verdict }, 'm-1')).toBe('tm-captures')
  })

  it('gives a loop nobody fronts (a person’s own skill run) to the teammate holding its skill, reachable, never a system one', async () => {
    expect(await flowTeammateId(world({ holder: true }), WS, { ai_team_member_id: null, actions: prose }, 'm-1')).toBe('coach')
    // The older holder is on a private team: only its members get it.
    expect(await flowTeammateId(world({ holder: true }), WS, { ai_team_member_id: null, actions: prose }, 'm-insider')).toBe('coach-secret')
  })

  it('gives a loop with no bot, no verdict skill and no skill holder to the Assistant; none when even it can’t be read', async () => {
    expect(await flowTeammateId(world(), WS, { ai_team_member_id: null, actions: prose }, 'm-1')).toBe('tm-assistant')
    expect(await flowTeammateId(world({ assistant: false }), WS, { ai_team_member_id: null, actions: prose }, 'm-1')).toBeNull()
  })
})

describe('flowAttribution: the loop’s area, and its face when nobody fronts it (one-agent S3)', () => {
  const mail = [{ type: 'run_skill', enabled: true, config: { skill_id: 'skill-mail' } }]
  const twoMail = [...mail, { type: 'run_skill', enabled: true, config: { skill_id: 'skill-mail-2' } }]
  const mixed = [...mail, { type: 'run_skill', enabled: true, config: { skill_id: 'skill-calendar' } }]
  const calendar = [{ type: 'run_skill', enabled: true, config: { skill_id: 'skill-calendar' } }]

  it('a seeded loop is Captures’, on its face', async () => {
    expect(await flowAttribution(world(), WS, { seed_key: 'seed:triage', actions: prose }, 'm-1')).toEqual({ teammateId: 'tm-captures', area: 'captures' })
    expect(await flowAttribution(world(), WS, { seed_key: 'seed:reconcile', actions: prose }, 'm-1')).toEqual({ teammateId: 'tm-captures', area: 'captures' })
  })

  it('a verdict loop nobody fronts is Captures’ too', async () => {
    expect(await flowAttribution(world(), WS, { actions: verdict }, 'm-1')).toEqual({ teammateId: 'tm-captures', area: 'captures' })
  })

  it('a loop nobody fronts whose skills agree on an area comes from that area’s face', async () => {
    expect(await flowAttribution(world(), WS, { actions: mail }, 'm-1')).toEqual({ teammateId: 'tm-mail', area: 'mail' })
    expect(await flowAttribution(world(), WS, { actions: twoMail }, 'm-1')).toEqual({ teammateId: 'tm-mail', area: 'mail' })
  })

  it('skills that disagree have no area, and the Assistant keeps the run', async () => {
    expect(await flowAttribution(world(), WS, { actions: mixed }, 'm-1')).toEqual({ teammateId: 'tm-assistant', area: null })
  })

  it('an area with no face of its own records the area, and the Assistant shows it', async () => {
    expect(await flowAttribution(world(), WS, { actions: calendar }, 'm-1')).toEqual({ teammateId: 'tm-assistant', area: 'calendar' })
  })

  it('a loop’s own bot keeps the run, and the row still records the area', async () => {
    expect(await flowAttribution(world(), WS, { ai_team_member_id: 'ember', actions: mail }, 'm-1')).toEqual({ teammateId: 'ember', area: 'mail' })
  })
})
