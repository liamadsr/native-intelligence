/**
 * AI teammates pin to a persona the workspace controls (Sequence step 1):
 * `recipe.workspace_id = <this workspace> OR is_system`. RLS alone admitted any
 * PUBLIC persona from any workspace — a teammate bound to one would run a
 * prompt (and tool selection) another workspace's author can rewrite at will.
 * Both the create (POST) and the re-point (PATCH) queries carry the fence, for
 * the persona and for the teammate's skills alike: a skill's system prompt
 * rides every run the teammate does.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, replaceAiMemberSkillsRpc, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  /** The service client: the agent's other bots and their skills, and a teammate's persona kind. */
  service: null as unknown as FakeSupabase,
  recipeFilters: [] as Array<{ eqs: Record<string, unknown>; ors: string[] }>,
  /** What the recipe read returns AFTER the filters (null = fenced out). */
  recipeRow: null as Record<string, unknown> | null,
  inserted: [] as Array<Record<string, unknown>>,
  updated: [] as Array<Record<string, unknown>>,
  deleted: [] as string[],
  /** Whether the targeted teammate is a system one (row 4 guard). */
  isSystem: false,
  /** Whether the targeted teammate is a loop's work bot (fronts_only, migration 302). */
  frontsOnly: false,
  /** The persona the targeted teammate is built on (a loop's anchor unless a test says). */
  targetAgent: 'r-anchor',
  /** Filters on each skill-list read, and the rows it returns (after the filters). */
  skillFilters: [] as Array<{ eqs: Record<string, unknown>; ors: string[] }>,
  skillRows: [] as Array<{ id: string }>,
}))

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const eqs: Record<string, unknown> = {}
      const ors: string[] = []
      // An update or delete answers with the row it wrote (the route reads that
      // back to tell an RLS-refused write, which matches nothing, from a real one).
      let updating = false
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => ((eqs[col] = val), b),
        or: (expr: string) => (ors.push(expr), b),
        in: () => b,
        order: () => b,
        insert: (payload: Record<string, unknown>) => (hoisted.inserted.push({ table, ...payload }), b),
        update: (payload: Record<string, unknown>) => ((updating = true), hoisted.updated.push({ table, ...payload }), b),
        delete: () => ((updating = true), hoisted.deleted.push(table), b),
        maybeSingle: async () =>
          table === 'ai_team_member'
            ? { data: { is_system: hoisted.isSystem, fronts_only: hoisted.frontsOnly, agent_recipe_id: hoisted.targetAgent }, error: null }
            : { data: null, error: null },
        single: async () => {
          if (table === 'team') return { data: { id: 'team-1' }, error: null }
          if (table === 'recipe') {
            hoisted.recipeFilters.push({ eqs: { ...eqs }, ors: [...ors] })
            return hoisted.recipeRow ? { data: hoisted.recipeRow, error: null } : { data: null, error: { message: 'no rows' } }
          }
          if (table === 'ai_team_member') return { data: { id: 'ai-1' }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (table === 'recipe' && eqs.category === 'skill') {
            hoisted.skillFilters.push({ eqs: { ...eqs }, ors: [...ors] })
            return Promise.resolve(resolve({ data: hoisted.skillRows, error: null }))
          }
          return Promise.resolve(resolve({ data: updating ? [{ id: 'ai-1' }] : [], error: null }))
        },

      })
      return b
    },
  }),
}))

vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

const { POST } = await import('../route')
const { PATCH, DELETE } = await import('../[aiMemberId]/route')

const FENCE = 'workspace_id.eq.ws-1,is_system.eq.true'

beforeEach(() => {
  // A bot's skills are written by the database's one call (migration 305), on the service client.
  hoisted.service = makeFakeSupabase({
    project: true,
    rpc: { replace_ai_member_skills: replaceAiMemberSkillsRpc(() => hoisted.service) },
  })
  hoisted.service.seed('recipe', [
    { id: 'r-mine', category: 'agent', workspace_id: 'ws-1', is_system: false, visibility: 'workspace', created_by: 'user-author' },
    { id: 'r-anchor', category: 'agent', workspace_id: null, is_system: false, visibility: 'personal', created_by: null },
    { id: 's-1', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    { id: 's-mine', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'workspace' },
    { id: 's-theirs', category: 'skill', workspace_id: 'ws-1', is_system: false, visibility: 'personal' },
  ])
  // The teammate the routes act on ('ai-1': the session double's insert answers with it).
  hoisted.service.seed('ai_team_member', [{ id: 'ai-1', workspace_id: 'ws-1', agent_recipe_id: 'r-anchor', is_system: false, created_at: '0' }])
  hoisted.service.seed('member', [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'user-1', role: 'member' }])
  hoisted.targetAgent = 'r-anchor'
  hoisted.recipeFilters.length = 0
  hoisted.inserted.length = 0
  hoisted.updated.length = 0
  hoisted.deleted.length = 0
  hoisted.recipeRow = null
  hoisted.isSystem = false
  hoisted.frontsOnly = false
  hoisted.skillFilters.length = 0
  hoisted.skillRows = []
})

describe('POST /teams/[id]/ai-members', () => {
  const params = Promise.resolve({ id: 'team-1' })
  const post = (body: unknown) => POST(buildRequest({ body }) as unknown as NextRequest, { params })

  it('reads the persona with the workspace-or-system fence, and 400s when it is fenced out', async () => {
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-foreign-public' })
    expect(res.status).toBe(400)
    expect(await readJson<{ error: string }>(res)).toMatchObject({ error: expect.stringMatching(/Agent not found/) })
    expect(hoisted.recipeFilters).toEqual([{ eqs: { id: 'r-foreign-public', category: 'agent' }, ors: [FENCE] }])
    expect(hoisted.inserted).toEqual([])
  })

  // bots-v4 B1, decision 11: a new teammate's skills are its agent's.
  it('takes no skills from the caller: a new teammate starts with its agent’s', async () => {
    hoisted.recipeRow = { id: 'r-mine', category: 'agent' }
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-mine', skill_recipe_ids: ['s-1'] })
    expect(res.status).toBe(400)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'AGENT_SKILLS' })
    expect(hoisted.inserted).toEqual([])
  })

  it('creates the teammate when the persona is the workspace’s own (or a system one)', async () => {
    hoisted.recipeRow = { id: 'r-mine', category: 'agent' }
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(201)
    expect(hoisted.inserted[0]).toMatchObject({ table: 'ai_team_member', agent_recipe_id: 'r-mine', workspace_id: 'ws-1' })
    // An agent with no other bot: nothing to start with.
    expect(hoisted.inserted.some((i) => i.table === 'ai_team_member_skill')).toBe(false)
  })

  it('a new teammate starts with the skills its agent’s other bots always check (never a personal one)', async () => {
    hoisted.recipeRow = { id: 'r-mine', category: 'agent' }
    hoisted.service.seed('ai_team_member', [{ id: 'riley', workspace_id: 'ws-1', agent_recipe_id: 'r-mine', is_system: false, created_at: '1' }])
    hoisted.service.seed('ai_team_member_skill', [
      { ai_team_member_id: 'riley', skill_recipe_id: 's-theirs', sort_order: 0 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's-1', sort_order: 1 },
    ])
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(201)
    // Through the database's one write of a bot's skills, never the caller's client.
    expect(hoisted.inserted.some((i) => i.table === 'ai_team_member_skill')).toBe(false)
    expect(hoisted.service.rpcCalls).toEqual([{ fn: 'replace_ai_member_skills', args: { p_member_id: 'ai-1', p_skill_ids: ['s-1'] } }])
    expect(hoisted.service.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === 'ai-1').map((r) => r.skill_recipe_id)).toEqual(['s-1'])
  })

  it('a copy that fails takes the new teammate back out', async () => {
    hoisted.recipeRow = { id: 'r-mine', category: 'agent' }
    hoisted.service.seed('ai_team_member', [{ id: 'riley', workspace_id: 'ws-1', agent_recipe_id: 'r-mine', is_system: false, created_at: '1' }])
    hoisted.service.seed('ai_team_member_skill', [{ ai_team_member_id: 'riley', skill_recipe_id: 's-1', sort_order: 0 }])
    hoisted.service.rows('ai_team_member').splice(0, 1) // 'ai-1' gone: the database refuses the write
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/wasn’t added: its agent’s skills couldn’t be copied/)
    expect(hoisted.deleted).toEqual(['ai_team_member'])
  })

  it('a personal agent gets no teammate', async () => {
    hoisted.recipeRow = { id: 'r-private', category: 'agent', visibility: 'personal' }
    const res = await post({ name: 'Atlas', agent_recipe_id: 'r-private' })
    expect(res.status).toBe(400)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'PERSONAL_AGENT_BOT' })
    expect(hoisted.inserted).toEqual([])
  })
})

describe('PATCH /teams/[id]/ai-members/[aiMemberId]', () => {
  const params = Promise.resolve({ id: 'team-1', aiMemberId: 'ai-1' })
  const patch = (body: unknown) => PATCH(buildRequest({ body }) as unknown as NextRequest, { params })

  it('re-pointing at a persona outside the fence is a 400 and writes nothing', async () => {
    const res = await patch({ agent_recipe_id: 'r-foreign-public' })
    expect(res.status).toBe(400)
    expect(hoisted.recipeFilters[0]).toEqual({ eqs: { id: 'r-foreign-public', category: 'agent' }, ors: [FENCE] })
    expect(hoisted.updated).toEqual([])
  })

  it('a user-built teammate’s skills are its agent’s: this route refuses them (409) and writes nothing', async () => {
    hoisted.skillRows = [{ id: 's-mine' }]
    const res = await patch({ skill_recipe_ids: ['s-mine'] })
    expect(res.status).toBe(409)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'AGENT_SKILLS' })
    expect(hoisted.updated).toEqual([])
    expect(hoisted.inserted).toEqual([])
  })

  it('a system teammate’s skill the database won’t take (another workspace’s) is a 400, not a 500', async () => {
    hoisted.isSystem = true
    hoisted.service.seed('recipe', [{ id: 's-far', category: 'skill', workspace_id: 'ws-2', is_system: false, visibility: 'workspace' }])
    hoisted.skillRows = [{ id: 's-far' }]
    const res = await patch({ skill_recipe_ids: ['s-far'] })
    expect(res.status).toBe(400)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'INVALID_SKILLS' })
    expect(hoisted.service.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === 'ai-1')).toEqual([])
  })

  it('replacing a system teammate’s skills reads them with the fence; an in-fence set is written, a fenced-out one is a 400', async () => {
    hoisted.isSystem = true
    hoisted.skillRows = [{ id: 's-mine' }]
    expect((await patch({ skill_recipe_ids: ['s-mine'] })).status).toBe(200)
    expect(hoisted.skillFilters[0]).toEqual({ eqs: { category: 'skill' }, ors: [FENCE] })
    // The row is touched first (the manage check), then the list is replaced whole by the database.
    expect(hoisted.updated[0]).toMatchObject({ table: 'ai_team_member' })
    expect(hoisted.service.rpcCalls).toEqual([{ fn: 'replace_ai_member_skills', args: { p_member_id: 'ai-1', p_skill_ids: ['s-mine'] } }])
    expect(hoisted.inserted).toEqual([])
    hoisted.service.rpcCalls.length = 0
    hoisted.skillRows = []
    expect((await patch({ skill_recipe_ids: ['s-foreign'] })).status).toBe(400)
    expect(hoisted.service.rpcCalls).toEqual([])
  })

  it('re-pointing at an in-fence persona is written', async () => {
    hoisted.recipeRow = { id: 'r-mine' }
    const res = await patch({ agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(200)
    expect(hoisted.updated[0]).toMatchObject({ table: 'ai_team_member', agent_recipe_id: 'r-mine' })
  })

  // Decision 11: one list per agent. A full teammate moved onto an agent takes its bots' list.
  it('moved onto an agent with other bots, a full teammate takes the skills they share (pinnable ones only)', async () => {
    hoisted.recipeRow = { id: 'r-mine' }
    hoisted.service.seed('ai_team_member', [{ id: 'riley', workspace_id: 'ws-1', agent_recipe_id: 'r-mine', is_system: false, created_at: '1' }])
    hoisted.service.seed('ai_team_member_skill', [
      { ai_team_member_id: 'riley', skill_recipe_id: 's-theirs', sort_order: 0 },
      { ai_team_member_id: 'riley', skill_recipe_id: 's-1', sort_order: 1 },
      { ai_team_member_id: 'ai-1', skill_recipe_id: 's-mine', sort_order: 0 },
    ])
    expect((await patch({ agent_recipe_id: 'r-mine' })).status).toBe(200)
    expect(hoisted.service.rpcCalls).toEqual([{ fn: 'replace_ai_member_skills', args: { p_member_id: 'ai-1', p_skill_ids: ['s-1'] } }])
    expect(hoisted.service.rows('ai_team_member_skill').filter((r) => r.ai_team_member_id === 'ai-1').map((r) => r.skill_recipe_id)).toEqual(['s-1'])
  })

  it('moved onto an agent with no other bot (a copy made for it), it keeps its own', async () => {
    hoisted.recipeRow = { id: 'r-mine' }
    hoisted.service.seed('ai_team_member_skill', [{ ai_team_member_id: 'ai-1', skill_recipe_id: 's-mine', sort_order: 0 }])
    expect((await patch({ agent_recipe_id: 'r-mine' })).status).toBe(200)
    expect(hoisted.service.rpcCalls).toEqual([])
    expect(hoisted.service.rows('ai_team_member_skill').map((r) => r.skill_recipe_id)).toEqual(['s-mine'])
  })
})

describe('an agent’s work bot speaks for its agent (bots-v4 B1)', () => {
  const params = Promise.resolve({ id: 'team-1', aiMemberId: 'ai-1' })
  const patch = (body: unknown) => PATCH(buildRequest({ body }) as unknown as NextRequest, { params })
  const del = () => DELETE(buildRequest({}) as unknown as NextRequest, { params })
  beforeEach(() => {
    hoisted.frontsOnly = true
    hoisted.targetAgent = 'r-mine'
  })

  /** The service client, with every read of `table` failing. */
  function failReads(table: string) {
    const fake = hoisted.service
    const failing = () => {
      const b: Record<string, unknown> = {}
      const done = async () => ({ data: null, error: { message: `${table} read failed` } })
      for (const m of ['select', 'eq', 'in', 'neq', 'order', 'limit']) b[m] = () => b
      Object.assign(b, { maybeSingle: done, single: done, then: (resolve: (v: unknown) => unknown) => done().then(resolve) })
      return b
    }
    hoisted.service = { ...fake, from: (t: string) => (t === table ? failing() : fake.from(t)) } as FakeSupabase
  }

  it('fails closed when its agent can’t be read: never treated as a loop’s bot', async () => {
    hoisted.service.rows('recipe').find((r) => r.id === 'r-mine')!.created_by = 'someone-else'
    failReads('recipe')
    let res = await patch({ name: 'Mine now' })
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('recipe read failed')
    res = await del()
    expect(res.status).toBe(500)
    expect(hoisted.updated).toEqual([])
    expect(hoisted.deleted).toEqual([])
  })

  it('fails closed when the caller’s role can’t be read, removing it', async () => {
    failReads('member')
    expect((await del()).status).toBe(500)
    expect(hoisted.deleted).toEqual([])
  })

  it('a team lead who isn’t its agent’s author can’t rename, re-face or remove it', async () => {
    let res = await patch({ name: 'Mine now', bot_character: 'ember' })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/only the persona’s author, or a workspace owner or admin/)
    res = await patch({ team_role: 'lead' })
    expect(res.status).toBe(403)
    res = await del()
    expect(res.status).toBe(403)
    expect(hoisted.updated).toEqual([])
    expect(hoisted.deleted).toEqual([])
  })

  it('its agent’s author may, and so may an owner or admin', async () => {
    hoisted.service.rows('recipe').find((r) => r.id === 'r-mine')!.created_by = 'user-1'
    expect((await patch({ name: 'Coach' })).status).toBe(200)
    expect(hoisted.updated).toEqual([{ table: 'ai_team_member', name: 'Coach' }])
    hoisted.service.rows('recipe').find((r) => r.id === 'r-mine')!.created_by = 'user-author'
    hoisted.service.rows('member')[0].role = 'admin'
    expect((await patch({ name: 'Coach 2' })).status).toBe(200)
    expect((await del()).status).toBe(200)
    expect(hoisted.deleted).toEqual(['ai_team_member'])
  })
})

describe('system teammates (row 4): not removable, agent fixed', () => {
  const params = Promise.resolve({ id: 'team-1', aiMemberId: 'ai-1' })
  const patch = (body: unknown) => PATCH(buildRequest({ body }) as unknown as NextRequest, { params })
  const del = () => DELETE(buildRequest({}) as unknown as NextRequest, { params })

  it('DELETE of a system teammate is a 409 and deletes nothing', async () => {
    hoisted.isSystem = true
    const res = await del()
    expect(res.status).toBe(409)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'SYSTEM_TEAMMATE' })
    expect(hoisted.deleted).toEqual([])
  })

  it('DELETE of a user-built teammate still deletes it', async () => {
    const res = await del()
    expect(res.status).toBe(200)
    expect(hoisted.deleted).toEqual(['ai_team_member'])
  })

  it('re-pointing a system teammate at a persona is a 409 and writes nothing', async () => {
    hoisted.isSystem = true
    hoisted.recipeRow = { id: 'r-mine' }
    const res = await patch({ agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(409)
    expect(hoisted.updated).toEqual([])
  })

  it('renaming a system teammate is allowed', async () => {
    hoisted.isSystem = true
    const res = await patch({ name: 'Triage (ours)' })
    expect(res.status).toBe(200)
    expect(hoisted.updated).toEqual([{ table: 'ai_team_member', name: 'Triage (ours)' }])
  })
})

describe('a loop’s work bot (fronts_only, bots-v3 Phase 3): persona fixed to the anchor', () => {
  const params = Promise.resolve({ id: 'team-1', aiMemberId: 'ai-1' })
  const patch = (body: unknown) => PATCH(buildRequest({ body }) as unknown as NextRequest, { params })

  it('re-pointing a work bot at a persona is a 409 and writes nothing', async () => {
    hoisted.frontsOnly = true
    hoisted.recipeRow = { id: 'r-mine' }
    const res = await patch({ agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(409)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'WORK_BOT' })
    expect(hoisted.updated).toEqual([])
  })

  it('sending its own anchor back, with a rename, is no re-point', async () => {
    hoisted.frontsOnly = true
    const res = await patch({ agent_recipe_id: 'r-anchor', name: 'Ember' })
    expect(res.status).toBe(200)
    expect(hoisted.updated).toEqual([{ table: 'ai_team_member', name: 'Ember' }])
  })
})
