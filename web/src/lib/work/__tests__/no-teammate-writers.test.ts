/**
 * The writers of work with no teammate name its bot on the LEDGER row
 * (docs/plans/bots-v4.md Phase 5): the prospecting, eval, onboarding-research
 * and enrichment mirrors, a person's own coding and work runs, and (Liam,
 * 2026-10-08: work with no bot is the Assistant's) the CRM and email imports
 * and any agent run another path started that names no one. Each stamps the
 * recorder's `aiTeamMemberId` only; the agent run's own `ai_team_member_id`
 * (its persona, limits, grants and memory) is never written. Sequence sends
 * keep no teammate. Against the in-memory database double, projecting
 * selected columns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
import { ensureWorkForAgentRun, resetAgentRunMirrorCaches } from '../agent-run-mirror'
import { mirrorProspectingRunQueued } from '../prospecting-run-mirror'
import { mirrorEvalRunQueued } from '../eval-run-mirror'
import { mirrorOnboardingResearchStarted } from '../onboarding-research-mirror'
import { openManualEnrichment } from '../enrichment-mirror'
import { openEmailImport, openHubspotImport } from '../import-mirror'

const W = 'w1'

function world(opts: { researcher?: boolean; developer?: boolean; holder?: boolean } = {}): FakeSupabase {
  const db = makeFakeSupabase({ project: true, unique: { tracked_job: ['kind,run_key'] } })
  db.seed('member', [{ id: 'm1', workspace_id: W, user_id: 'u1' }])
  db.seed('team', [{ id: 'team-open', workspace_id: W, is_private: false }])
  const mate = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: W,
    team_id: 'team-open',
    role: null,
    is_system: false,
    system_key: null,
    created_at: '2026-09-10T00:00:00Z',
    ...over,
  })
  db.seed('ai_team_member', [
    mate('tm-assistant', { is_system: true, system_key: 'assistant', created_at: '2026-01-01T00:00:00Z' }),
    ...(opts.researcher ? [mate('researcher', { role: 'researcher' })] : []),
    ...(opts.developer ? [mate('developer', { role: 'developer' })] : []),
    ...(opts.holder ? [mate('coach')] : []),
  ])
  if (opts.holder) {
    // The hold with its teammate embedded, as the `ai_team_member!inner(...)` read returns it.
    db.seed('ai_team_member_skill', [
      { ai_team_member_id: 'coach', skill_recipe_id: 'skill-triage', ai_team_member: db.rows('ai_team_member').find((m) => m.id === 'coach') },
    ])
  }
  db.seed('prospect_list', [{ id: 'list-1', workspace_id: W, name: 'Fintech CFOs', created_by: 'u1' }])
  db.seed('eval_suite', [
    { id: 'suite-skill', workspace_id: W, name: 'Discovery calls', target_kind: 'skill', target_recipe_id: 'skill-triage' },
    { id: 'suite-agent', workspace_id: W, name: 'Coach', target_kind: 'agent', target_recipe_id: 'agent-coach' },
  ])
  return db
}

const ledger = (db: FakeSupabase, kind: string) => db.rows('tracked_job').filter((r) => r.kind === kind)

beforeEach(() => {
  resetAgentRunMirrorCaches()
  hoisted.createNotification.mockClear()
})

describe('the mirrors stamp the bot their work comes from', () => {
  it('prospecting: the Researcher, else the Assistant', async () => {
    const run = { id: 'pr-1', workspace_id: W, list_id: 'list-1', kind: 'discover' as const, started_by: 'u1' }
    const plain = world()
    await mirrorProspectingRunQueued(plain as never, run)
    expect(ledger(plain, 'prospecting')[0]).toMatchObject({ member_id: 'm1', ai_team_member_id: 'tm-assistant' })
    const staffed = world({ researcher: true, developer: true })
    await mirrorProspectingRunQueued(staffed as never, run)
    expect(ledger(staffed, 'prospecting')[0]).toMatchObject({ ai_team_member_id: 'researcher' })
  })

  it('evals: the holder of the skill a suite evaluates, else the Developer, else the Assistant', async () => {
    const run = (suite: string) => ({ id: `ev-${suite}`, workspace_id: W, suite_id: suite, mode: 'batch', started_by: 'u1' })
    const db = world({ researcher: true, developer: true, holder: true })
    await mirrorEvalRunQueued(db as never, run('suite-skill'))
    await mirrorEvalRunQueued(db as never, run('suite-agent'))
    const rows = ledger(db, 'eval')
    expect(rows.find((r) => r.run_key === 'ev-suite-skill')).toMatchObject({ ai_team_member_id: 'coach', title: 'Evaluating Discovery calls (batch)' })
    // An agent's suite names no skill: its Developer.
    expect(rows.find((r) => r.run_key === 'ev-suite-agent')).toMatchObject({ ai_team_member_id: 'developer' })
    const plain = world()
    await mirrorEvalRunQueued(plain as never, run('suite-skill'))
    expect(ledger(plain, 'eval')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant' })
  })

  it('onboarding research: the Researcher, else the Assistant', async () => {
    const plain = world()
    await mirrorOnboardingResearchStarted(plain as never, { workspaceId: W, memberId: 'm1', sessionId: 'sess-1' })
    expect(ledger(plain, 'onboarding_research')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant' })
    const staffed = world({ researcher: true })
    await mirrorOnboardingResearchStarted(staffed as never, { workspaceId: W, memberId: 'm1', sessionId: 'sess-1' })
    expect(ledger(staffed, 'onboarding_research')[0]).toMatchObject({ ai_team_member_id: 'researcher' })
  })

  it('enrichment: the Researcher, else the Assistant', async () => {
    const db = world()
    await openManualEnrichment(db as never, { workspaceId: W, userId: 'u1', table: 'contact', recordId: 'c1', name: 'Dana Lee' })
    expect(ledger(db, 'crm_enrichment').map((r) => r.ai_team_member_id)).toEqual(['tm-assistant'])
    const staffed = world({ researcher: true })
    await openManualEnrichment(staffed as never, { workspaceId: W, userId: 'u1', table: 'company', recordId: 'co1', name: 'Acme' })
    expect(ledger(staffed, 'crm_enrichment')[0]).toMatchObject({ ai_team_member_id: 'researcher' })
  })

  it('imports, HubSpot and mailbox alike: the Assistant, even with role teammates there', async () => {
    const db = world({ researcher: true, developer: true, holder: true })
    await openHubspotImport(db as never, { accountId: 'acct-hub', workspaceId: W, userId: 'u1', startedAt: '2026-10-08T09:00:00.000Z' }, true)
    await openEmailImport(db as never, { workspaceId: W, userId: 'u1', provider: 'google', accountId: 'acct-mail' }, '2026-10-08T09:00:00.000Z')
    expect(ledger(db, 'crm_import')[0]).toMatchObject({ member_id: 'm1', ai_team_member_id: 'tm-assistant' })
    expect(ledger(db, 'email_import')[0]).toMatchObject({ member_id: 'm1', ai_team_member_id: 'tm-assistant' })
  })

  it('an import with no Assistant to read starts with no teammate, as before (fail-soft)', async () => {
    const db = world()
    db.rows('ai_team_member').splice(0)
    await openHubspotImport(db as never, { accountId: 'acct-hub', workspaceId: W, userId: 'u1', startedAt: '2026-10-08T09:00:00.000Z' }, true)
    expect(ledger(db, 'crm_import')).toHaveLength(1)
    expect(ledger(db, 'crm_import')[0].ai_team_member_id ?? null).toBeNull()
  })
})

describe('a person’s own agent runs: the ledger row is named, the agent run never', () => {
  const RUN = { id: 'run-1', workspace_id: W, status: 'queued', triggered_by: 'u1', task_prompt: 'Ship the fix', action_id: 'act-1' }

  function withRun(db: FakeSupabase, over: Record<string, unknown> = {}) {
    db.seed('agent_run', [{ id: 'run-1', workspace_id: W, ai_team_member_id: null, agent_recipe_id: null, origin: 'user', ...over }])
    return db
  }

  it('a coding run with no teammate comes from the Developer, else the Assistant; the agent run keeps no teammate', async () => {
    const db = withRun(world({ developer: true }))
    await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'coding' })
    expect(ledger(db, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'developer', agent_run_id: 'run-1' })
    expect(db.rows('agent_run')[0].ai_team_member_id).toBeNull()
    expect(db.calls.filter((c) => c.table === 'agent_run' && c.op !== 'select')).toEqual([])

    resetAgentRunMirrorCaches()
    const plain = withRun(world())
    await ensureWorkForAgentRun(plain as never, { ...RUN, kind: 'coding' })
    expect(ledger(plain, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant' })
  })

  it('a work run of the person’s own comes from the Assistant, even with role teammates there', async () => {
    const db = withRun(world({ researcher: true, developer: true }))
    await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'workspace' })
    expect(ledger(db, 'work_run')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant' })
    expect(db.rows('agent_run')[0].ai_team_member_id).toBeNull()
    expect(db.calls.filter((c) => c.table === 'agent_run' && c.op !== 'select')).toEqual([])
  })

  it('names the run’s own teammate from its stored row when the caller didn’t pass it (the coding route, a log beat)', async () => {
    const db = withRun(world({ developer: true }), { ai_team_member_id: 'coach-run' })
    await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'coding' })
    expect(ledger(db, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'coach-run' })
  })

  it('never routes on a guess when the run’s row can’t be read: only a caller that says the run is the person’s own', async () => {
    const failing = (db: FakeSupabase) => {
      const real = db.from
      db.from = (table: string) => {
        if (table !== 'agent_run') return real(table)
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq']) chain[m] = () => chain
        chain.maybeSingle = async () => ({ data: null, error: { message: 'agent_run down' } })
        return chain
      }
      return db
    }
    // A log beat (no origin passed) for a run that may be a loop's, an attempt's or a chat's:
    // never the Developer on a guess; the Assistant fronts it, for attribution only.
    const beat = failing(world({ developer: true }))
    await ensureWorkForAgentRun(beat as never, { ...RUN, kind: 'workspace' })
    expect(ledger(beat, 'work_run')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant', source: { teammate_routed: true } })

    // A caller that says origin 'user': routed as before.
    resetAgentRunMirrorCaches()
    const own = failing(world({ developer: true }))
    await ensureWorkForAgentRun(own as never, { ...RUN, kind: 'coding', origin: 'user' })
    expect(ledger(own, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'developer', source: { teammate_routed: true } })

    // A person's own coding run from the start-agent route (no origin, no persona): the Developer, as before, not the Assistant.
    resetAgentRunMirrorCaches()
    const started = failing(world({ developer: true }))
    await ensureWorkForAgentRun(started as never, { ...RUN, kind: 'coding' })
    expect(ledger(started, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'developer', source: { teammate_routed: true } })

    // A coding run another path says it started (a loop's): the Assistant, never the Developer.
    resetAgentRunMirrorCaches()
    const loop = failing(world({ developer: true }))
    await ensureWorkForAgentRun(loop as never, { ...RUN, kind: 'coding', origin: 'loop' })
    expect(ledger(loop, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant', source: { teammate_routed: true } })
  })

  it('marks a routed row as the person’s own run, and a named one not', async () => {
    const routed = withRun(world())
    await ensureWorkForAgentRun(routed as never, { ...RUN, kind: 'workspace' })
    expect(ledger(routed, 'work_run')[0].source).toMatchObject({ agent_run_id: 'run-1', teammate_routed: true })
    resetAgentRunMirrorCaches()
    const named = withRun(world(), { ai_team_member_id: 'writer' })
    await ensureWorkForAgentRun(named as never, { ...RUN, kind: 'workspace' })
    expect(ledger(named, 'work_run')[0].source).not.toHaveProperty('teammate_routed')
  })

  it('gives a run another path started (an attempt, a handoff, a loop, a chat) that names no one to the Assistant, never a role teammate', async () => {
    for (const origin of ['attempt', 'delegation', 'loop', 'chat'] as const) {
      resetAgentRunMirrorCaches()
      const db = withRun(world({ developer: true, researcher: true }), { origin })
      await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'coding', origin })
      // Attribution only: its chat stays the run's own (teammate_routed), and the agent run keeps no teammate.
      expect(ledger(db, 'coding_run')[0], origin).toMatchObject({ ai_team_member_id: 'tm-assistant', source: { teammate_routed: true } })
      expect(db.rows('agent_run')[0].ai_team_member_id, origin).toBeNull()
      expect(db.calls.filter((c) => c.table === 'agent_run' && c.op !== 'select'), origin).toEqual([])
    }
  })

  it('with no Assistant to read, a run another path started that names no one stays unattributed (fail-soft)', async () => {
    const db = withRun(world(), { origin: 'loop' })
    db.rows('ai_team_member').splice(0)
    await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'workspace', origin: 'loop' })
    expect(ledger(db, 'work_run')[0]?.ai_team_member_id ?? null).toBeNull()
    expect(ledger(db, 'work_run')[0]?.source).not.toHaveProperty('teammate_routed')
  })

  it('keeps a run’s own teammate first, and a run done as a persona is its teammate’s, else the Assistant’s', async () => {
    const db = withRun(world({ developer: true }))
    await ensureWorkForAgentRun(db as never, { ...RUN, kind: 'coding', ai_team_member_id: 'writer' })
    expect(ledger(db, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'writer' })

    // A loop's run_agent with no assignee carries a persona with no teammate here:
    // never routed to the Developer; the Assistant fronts it, and the agent run keeps its persona alone.
    resetAgentRunMirrorCaches()
    const persona = withRun(world({ developer: true }), { agent_recipe_id: 'agent-nobody', origin: 'loop' })
    await ensureWorkForAgentRun(persona as never, { ...RUN, kind: 'coding', agent_recipe_id: 'agent-nobody' })
    expect(ledger(persona, 'coding_run')[0]).toMatchObject({ ai_team_member_id: 'tm-assistant', source: { teammate_routed: true } })
    expect(persona.rows('agent_run')[0]).toMatchObject({ ai_team_member_id: null, agent_recipe_id: 'agent-nobody' })
  })
})
