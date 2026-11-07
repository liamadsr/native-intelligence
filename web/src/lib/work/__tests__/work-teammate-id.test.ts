/**
 * Work with no teammate comes from a bot (docs/plans/bots-v4.md Phase 5,
 * decision 2): workTeammateId's order for each kind of work, the skill holder,
 * then the workspace's role teammate (the Researcher for prospecting,
 * enrichment and onboarding research; the Developer for coding runs and
 * evals), then the Assistant. Steps one and two only pick a teammate the
 * run's owner can reach. Against the in-memory database double, projecting
 * the columns each read selects.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { ROUTED_WORK_AREAS, ROUTED_WORK_ROLES, workTeammateId, type RoutedWorkKind } from '../system-teammates'
import { makeFakeSupabase, type FakeSupabase } from './fake-supabase'

const WS = 'ws-1'

interface WorldOpts {
  assistant?: boolean
  researcher?: boolean
  developer?: boolean
  holder?: boolean
  /** The Assistant is missing until the seed RPC makes it (the self-heal). */
  seedMakesAssistant?: boolean
  /** The area faces (migration 318): Prospecting, Evals, CRM and Mail. */
  faces?: boolean
}

function world(opts: WorldOpts = {}): FakeSupabase {
  const db: FakeSupabase = makeFakeSupabase({
    project: true,
    rpc: {
      seed_system_teammates: () => {
        if (opts.seedMakesAssistant) {
          db.seed('ai_team_member', [{ id: 'tm-assistant-new', workspace_id: WS, team_id: 'team-open', system_key: 'assistant', is_system: true }])
          return { data: 1, error: null }
        }
        return { data: 0, error: null }
      },
    },
  })
  db.seed('team', [
    { id: 'team-open', workspace_id: WS, is_private: false },
    { id: 'team-private', workspace_id: WS, is_private: true },
  ])
  db.seed('team_member', [{ team_id: 'team-private', member_id: 'm-insider' }])
  const mate = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: WS,
    team_id: 'team-open',
    role: null,
    is_system: false,
    system_key: null,
    fronts_only: false,
    created_at: '2026-09-10T00:00:00Z',
    ...over,
  })
  db.seed('ai_team_member', [
    mate('tm-triage', { is_system: true, system_key: 'captures', created_at: '2026-01-01T00:00:00Z' }),
    ...(opts.faces
      ? (['prospecting', 'evals', 'crm', 'mail'] as const).map((key) => mate(`tm-${key}`, { is_system: true, system_key: key, created_at: '2026-01-01T00:00:00Z' }))
      : []),
    ...(opts.assistant === false ? [] : [mate('tm-assistant', { is_system: true, system_key: 'assistant', created_at: '2026-01-01T00:00:00Z' })]),
    ...(opts.researcher
      ? [
          // The oldest Researcher sits on a private team: only its members get it.
          mate('researcher-private', { role: 'researcher', team_id: 'team-private', created_at: '2026-09-01T00:00:00Z' }),
          mate('researcher', { role: 'researcher', created_at: '2026-09-02T00:00:00Z' }),
          mate('researcher-elsewhere', { role: 'researcher', workspace_id: 'ws-2', created_at: '2026-08-01T00:00:00Z' }),
        ]
      : []),
    ...(opts.developer ? [mate('developer', { role: 'developer', autonomy: 'off' })] : []),
    ...(opts.holder
      ? [
          mate('coach', { created_at: '2026-09-05T00:00:00Z' }),
          mate('coach-elsewhere', { workspace_id: 'ws-2', created_at: '2026-08-01T00:00:00Z' }),
        ]
      : []),
  ])
  if (opts.holder) {
    db.seed('ai_team_member_skill', [
      hold(db, 'coach', 'skill-x'),
      hold(db, 'coach-elsewhere', 'skill-x'),
      // A system teammate's own skill never makes it the face of other work.
      hold(db, 'tm-triage', 'skill-x'),
    ])
  }
  return db
}

/** A skill held, with its teammate embedded as the `ai_team_member!inner(...)` read returns it (the live row). */
function hold(db: FakeSupabase, mateId: string, skillId: string) {
  return { ai_team_member_id: mateId, skill_recipe_id: skillId, ai_team_member: db.rows('ai_team_member').find((m) => m.id === mateId) ?? null }
}

const route = (db: FakeSupabase, kind: RoutedWorkKind, over: { memberId?: string | null; skillIds?: string[]; area?: string | null } = {}) =>
  workTeammateId(db as unknown as SupabaseClient, {
    workspaceId: WS,
    kind,
    memberId: over.memberId === undefined ? 'm-1' : over.memberId,
    skillIds: over.skillIds,
    ...(over.area !== undefined ? { area: over.area as never } : {}),
  })

const ALL_KINDS = Object.keys(ROUTED_WORK_ROLES) as RoutedWorkKind[]

describe('which work comes from a bot', () => {
  it('is the AI work alone: prospecting, evals, onboarding research, enrichment, and a person’s own coding, work and loop runs', () => {
    expect(ALL_KINDS.sort()).toEqual(['coding_run', 'crm_enrichment', 'eval', 'flow_run', 'onboarding_research', 'prospecting', 'work_run'])
    for (const kind of ['sequence_enrolment', 'crm_import', 'email_import', 'extraction', 'email_drafts']) {
      expect(Object.hasOwn(ROUTED_WORK_ROLES, kind)).toBe(false)
    }
  })

  it('names the role each kind goes to (decision 2)', () => {
    expect(ROUTED_WORK_ROLES).toEqual({
      prospecting: 'researcher',
      crm_enrichment: 'researcher',
      onboarding_research: 'researcher',
      eval: 'developer',
      coding_run: 'developer',
      work_run: null,
      flow_run: null,
    })
  })
})

describe('workTeammateId: the skill holder, then the role teammate, then the Assistant', () => {
  it('gives every kind to the Assistant in a workspace with no holder and no role teammates', async () => {
    for (const kind of ALL_KINDS) expect(await route(world(), kind, { skillIds: ['skill-x'] }), kind).toBe('tm-assistant')
  })

  it('gives prospecting, enrichment and onboarding research to the Researcher the owner can reach, oldest first', async () => {
    const db = world({ researcher: true, developer: true })
    for (const kind of ['prospecting', 'crm_enrichment', 'onboarding_research'] as const) {
      expect(await route(db, kind), kind).toBe('researcher')
      expect(await route(db, kind, { memberId: 'm-insider' }), kind).toBe('researcher-private')
    }
  })

  it('gives coding runs and evals to the Developer, whatever its autonomy (a face for work already running)', async () => {
    const db = world({ researcher: true, developer: true })
    expect(await route(db, 'coding_run')).toBe('developer')
    expect(await route(db, 'eval')).toBe('developer')
  })

  it('gives a person’s own work run and a loop run nobody fronts to the Assistant, never a role teammate', async () => {
    const db = world({ researcher: true, developer: true })
    expect(await route(db, 'work_run')).toBe('tm-assistant')
    expect(await route(db, 'flow_run')).toBe('tm-assistant')
  })

  it('puts the skill holder first, in its own workspace, never a system teammate', async () => {
    const db = world({ researcher: true, developer: true, holder: true })
    expect(await route(db, 'eval', { skillIds: ['skill-x'] })).toBe('coach')
    expect(await route(db, 'flow_run', { skillIds: ['skill-x'] })).toBe('coach')
    // No skill named, or one nobody holds: the role, then the Assistant.
    expect(await route(db, 'eval')).toBe('developer')
    expect(await route(db, 'eval', { skillIds: ['skill-nobody'] })).toBe('developer')
    expect(await route(world({ holder: false }), 'eval', { skillIds: ['skill-x'] })).toBe('tm-assistant')
  })

  it('skips a holder or role teammate the owner can’t reach, and with no owner goes straight to the Assistant', async () => {
    const db = world({ researcher: true })
    db.rows('ai_team_member').find((m) => m.id === 'researcher')!.team_id = 'team-private'
    expect(await route(db, 'prospecting')).toBe('tm-assistant')
    expect(await route(world({ researcher: true, holder: true }), 'prospecting', { memberId: null, skillIds: ['skill-x'] })).toBe('tm-assistant')
  })

  it('seeds the Assistant once when the workspace lost it (the self-heal), and is null only when it can’t be had', async () => {
    const healed = world({ assistant: false, seedMakesAssistant: true })
    expect(await route(healed, 'work_run')).toBe('tm-assistant-new')
    expect(healed.rpcCalls).toEqual([{ fn: 'seed_system_teammates', args: { p_workspace_id: WS } }])
    expect(await route(world({ assistant: false }), 'work_run')).toBeNull()
  })

  it('is fail-soft: a failed holder or role read logs and falls through to the next step', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = world({ researcher: true, holder: true })
    const realFrom = db.from
    db.from = (table: string) => {
      if (table === 'ai_team_member_skill') {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'in', 'eq', 'limit']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: null, error: { message: 'skills down' } }).then(resolve)
        return chain
      }
      return realFrom(table)
    }
    expect(await route(db, 'prospecting', { skillIds: ['skill-x'] })).toBe('researcher')
    expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toContain('skills down')
    warn.mockRestore()
  })

  it('reads the holders in one query, fenced to the workspace and to non-system teammates in the join', async () => {
    const db = world({ researcher: true, holder: true })
    await route(db, 'eval', { skillIds: ['skill-x'] })
    expect(db.selects.filter((s) => s.table === 'ai_team_member_skill')).toEqual([
      { table: 'ai_team_member_skill', columns: 'ai_team_member!inner(id, team_id, created_at, workspace_id, is_system)' },
    ])
    const read = db.calls.find((c) => c.table === 'ai_team_member_skill')!
    expect(read.filters).toEqual(expect.arrayContaining([['ai_team_member.workspace_id', WS], ['ai_team_member.is_system', false]]))
  })

  it('only ever reads, and writes nothing but the Assistant’s self-heal seed', async () => {
    const db = world({ researcher: true, developer: true, holder: true })
    for (const kind of ALL_KINDS) await route(db, kind, { skillIds: ['skill-x'] })
    expect(db.calls.filter((c) => c.op !== 'select')).toEqual([])
  })
})

describe('the Assistant’s catch-all work goes to its area’s face (one-agent S3, migration 318)', () => {
  it('names each kind’s area: prospecting, evals and enrichment have one; the rest take the run’s, or none', () => {
    expect(ROUTED_WORK_AREAS).toEqual({
      prospecting: 'prospecting',
      crm_enrichment: 'crm',
      onboarding_research: null,
      eval: 'evals',
      coding_run: null,
      work_run: null,
      flow_run: null,
    })
  })

  it('with no skill holder and no role teammate, prospecting, evals and enrichment come from their face, not the Assistant', async () => {
    const db = world({ faces: true })
    expect(await route(db, 'prospecting')).toBe('tm-prospecting')
    expect(await route(db, 'eval')).toBe('tm-evals')
    expect(await route(db, 'crm_enrichment')).toBe('tm-crm')
    // No area: the Assistant keeps it.
    expect(await route(db, 'onboarding_research')).toBe('tm-assistant')
    expect(await route(db, 'work_run')).toBe('tm-assistant')
  })

  it('a run whose area the writer knows comes from that area’s face; an area with no face stays the Assistant’s', async () => {
    const db = world({ faces: true })
    expect(await route(db, 'work_run', { area: 'mail' })).toBe('tm-mail')
    expect(await route(db, 'flow_run', { area: 'calendar' })).toBe('tm-assistant')
  })

  it('the skill holder and the role teammate still come first: custom agents and role bots keep their work', async () => {
    const db = world({ faces: true, researcher: true, developer: true, holder: true })
    expect(await route(db, 'prospecting', { skillIds: ['skill-x'] })).toBe('coach')
    expect(await route(db, 'prospecting')).toBe('researcher')
    expect(await route(db, 'eval')).toBe('developer')
  })

  it('a workspace without its face yet (before 318) still lands on the Assistant', async () => {
    const db = world()
    expect(await route(db, 'prospecting')).toBe('tm-assistant')
  })
})
