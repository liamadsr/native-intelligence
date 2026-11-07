/**
 * Skills on the ai-members routes, and what the editor can't read
 * (docs/plans/bot-characters.md, "Step 3", the edit dialog).
 *
 *   • A skills-only edit is manage-checked like any other: the route writes the
 *     row first (updated_at) and RLS filtering that write to nothing is a 403,
 *     before a skill is touched. It used to skip the check, and RLS then
 *     no-op'd the delete (unticking everything answered 200, nothing saved) or
 *     refused the insert with a raw 500.
 *   • The skills themselves are written by the database's one write of a
 *     bot's skills (replace_ai_member_skills, migration 305) on the service
 *     client, only after the row write passed: no client writes them. A
 *     refused write is a 500 that says why.
 *   • Another creator's `personal` persona or skill is hidden from the editor
 *     (recipe_select_visibility). The GET hands back the raw ids beside the
 *     readable joins; the PATCH keeps a skill already on the teammate without
 *     reading it (a new one must be readable), and the persona it already has
 *     is no re-point.
 *   • Since bots-v4 B1 (decision 11) only a SYSTEM teammate's skills change
 *     here, up to five and never a newly added personal one: any other bot's
 *     are its agent's, saved through PUT /api/account/agents/[id]/skills, so
 *     this route answers 409.
 *
 * A small in-memory store stands in for Supabase with RLS's behaviour: the
 * recipe reads see only readable recipes, a refused UPDATE or DELETE matches no
 * rows (no error), a refused INSERT errors with 42501. Its `rpc` is the skills
 * write, which RLS doesn't fence (security definer, service role only).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

type Row = Record<string, unknown>
type SkillRow = { ai_team_member_id: string; skill_recipe_id: string; sort_order: number }

const db = vi.hoisted(() => ({
  /** The RLS manage right (workspace admin, or a lead of the team). */
  canManage: true,
  /** The database refuses the skills write even though the row write went through. */
  skillsWriteRefused: false,
  member: {} as Record<string, unknown>,
  skills: [] as Array<{ ai_team_member_id: string; skill_recipe_id: string; sort_order: number }>,
  /** Every recipe, and which the caller can read. */
  recipes: [] as Array<{ id: string; name: string; category: string; readable: boolean; visibility?: string }>,
  memberWrites: [] as Array<Record<string, unknown>>,
  skillWrites: 0,
}))

function fakeClient() {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: unknown = null
      const pick = <T extends Row>(rows: T[]) => rows.filter((r) => filters.every((f) => f(r)))
      const readable = (id: unknown) => db.recipes.find((r) => r.id === id && r.readable) ?? null
      const run = (): { data: Row[] | null; error: { message: string; code?: string } | null } => {
        if (table === 'team') return { data: pick([{ id: 'team-1', workspace_id: 'ws-1' }]), error: null }
        if (table === 'recipe') return { data: pick(db.recipes.filter((r) => r.readable)), error: null }
        if (table === 'ai_team_member') {
          if (op === 'update') {
            const matched = db.canManage ? pick([db.member]) : []
            for (const r of matched) Object.assign(r, payload)
            if (matched.length) db.memberWrites.push(payload as Row)
            return { data: matched.map((r) => ({ id: r.id })), error: null }
          }
          // The GET's joins: null where the caller can't read the recipe.
          const m = db.member
          const row = {
            ...m,
            agent: readable(m.agent_recipe_id),
            ai_team_member_skill: db.skills
              .filter((s) => s.ai_team_member_id === m.id)
              .map((s) => ({ ...s, skill: readable(s.skill_recipe_id) })),
          }
          return { data: pick([row]), error: null }
        }
        if (table === 'ai_team_member_skill') {
          if (op === 'delete') {
            if (db.canManage) {
              const gone = new Set(pick(db.skills as unknown as Row[]))
              db.skills = db.skills.filter((s) => !gone.has(s as unknown as Row))
              db.skillWrites++
            }
            return { data: [], error: null }
          }
          if (op === 'insert') {
            if (!db.canManage) {
              return {
                data: null,
                error: { code: '42501', message: 'new row violates row-level security policy for table "ai_team_member_skill"' },
              }
            }
            db.skills.push(...(payload as SkillRow[]))
            db.skillWrites++
            return { data: [], error: null }
          }
          return { data: pick(db.skills as unknown as Row[]), error: null }
        }
        return { data: [], error: null }
      }
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), b),
        neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), b),
        in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), b),
        not: () => b,
        or: () => b,
        order: () => b,
        limit: () => b,
        insert: (p: unknown) => ((op = 'insert'), (payload = p), b),
        update: (p: unknown) => ((op = 'update'), (payload = p), b),
        delete: () => ((op = 'delete'), b),
        single: async () => {
          const { data, error } = run()
          return data && data.length > 0 ? { data: data[0], error } : { data: null, error: error ?? { message: 'no rows' } }
        },
        maybeSingle: async () => {
          const { data, error } = run()
          return { data: data?.[0] ?? null, error }
        },
        then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      })
      return b
    },
    // replace_ai_member_skills (migration 305): the bot's whole list, at most five.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn !== 'replace_ai_member_skills') return { data: null, error: { message: `no rpc ${fn}` } }
      if (db.skillsWriteRefused) return { data: null, error: { code: 'XX000', message: 'could not write the skills' } }
      const ids = [...new Set(args.p_skill_ids as string[])]
      if (ids.length > 5) return { data: null, error: { code: '23514', message: 'a bot always checks at most five skills' } }
      const botId = args.p_member_id as string
      db.skills = [
        ...db.skills.filter((s) => s.ai_team_member_id !== botId),
        ...ids.map((id, i) => ({ ai_team_member_id: botId, skill_recipe_id: id, sort_order: i })),
      ]
      db.skillWrites++
      return { data: null, error: null }
    },
  }
}

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient() }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fakeClient() }))

const { GET } = await import('../route')
const { PATCH } = await import('../[aiMemberId]/route')

const skillIds = () =>
  db.skills
    .filter((s) => s.ai_team_member_id === 'ai-1')
    .sort((a, b) => a.sort_order - b.sort_order)
    .map((s) => s.skill_recipe_id)

beforeEach(() => {
  db.canManage = true
  db.skillsWriteRefused = false
  db.member = {
    id: 'ai-1',
    workspace_id: 'ws-1',
    team_id: 'team-1',
    name: 'Riley',
    avatar_url: null,
    team_role: 'member',
    created_at: '2026-09-01T00:00:00Z',
    is_system: false,
    system_key: null,
    bot_character: 'chat',
    // Another creator's personal persona: the caller can't read it.
    agent_recipe_id: 'r-private',
  }
  db.recipes = [
    { id: 'r-private', name: 'Their persona', category: 'agent', readable: false },
    { id: 'r-mine', name: 'PM persona', category: 'agent', readable: true },
    { id: 's-1', name: 'Summarize', category: 'skill', readable: true },
    { id: 's-2', name: 'Draft email', category: 'skill', readable: true },
    { id: 's-private', name: 'Their skill', category: 'skill', readable: false },
    { id: 's-other-private', name: 'Someone else’s skill', category: 'skill', readable: false },
    // The caller's own personal skill: readable, but never one a bot always checks.
    { id: 's-mine-personal', name: 'My own skill', category: 'skill', readable: true, visibility: 'personal' },
    ...['s-3', 's-4', 's-5', 's-6'].map((id) => ({ id, name: id, category: 'skill', readable: true })),
  ]
  db.skills = [
    { ai_team_member_id: 'ai-1', skill_recipe_id: 's-private', sort_order: 0 },
    { ai_team_member_id: 'ai-1', skill_recipe_id: 's-1', sort_order: 1 },
  ]
  db.memberWrites = []
  db.skillWrites = 0
})

const patch = (body: Row) =>
  PATCH(buildRequest({ method: 'PATCH', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id: 'team-1', aiMemberId: 'ai-1' }),
  })

describe('PATCH: a skills-only edit is manage-checked', () => {
  // A system teammate: its skills are its own (bots-v4 B1).
  beforeEach(() => {
    db.member.is_system = true
  })

  it('as someone who can’t manage the team: a 403, and nothing changes', async () => {
    db.canManage = false
    const res = await patch({ skill_recipe_ids: ['s-private', 's-1', 's-2'] })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string; code: string }>(res)).error).toMatch(/admins and this team’s leads/)
    expect(skillIds()).toEqual(['s-private', 's-1'])
    expect(db.skillWrites).toBe(0)
  })

  it('unticking everything as someone who can’t manage is a 403, not a 200 that saved nothing', async () => {
    db.canManage = false
    const res = await patch({ skill_recipe_ids: [] })
    expect(res.status).toBe(403)
    expect(skillIds()).toEqual(['s-private', 's-1'])
  })

  it('as a manager: the skills are replaced, and the row is touched (updated_at) as the check', async () => {
    const res = await patch({ skill_recipe_ids: ['s-private', 's-2'] })
    expect(res.status).toBe(200)
    expect(skillIds()).toEqual(['s-private', 's-2'])
    expect(db.memberWrites).toHaveLength(1)
    expect(Object.keys(db.memberWrites[0])).toEqual(['updated_at'])
  })

  it('as a manager, unticking everything clears them', async () => {
    const res = await patch({ skill_recipe_ids: [] })
    expect(res.status).toBe(200)
    expect(skillIds()).toEqual([])
  })

  it('with other changes, those are the check: no extra updated_at write', async () => {
    const res = await patch({ name: 'Riley (PM)', skill_recipe_ids: ['s-1'] })
    expect(res.status).toBe(200)
    expect(db.memberWrites).toEqual([{ name: 'Riley (PM)' }])
    expect(skillIds()).toEqual(['s-1'])
  })

  it('a refused skills write is a 500 that says why, and the list stays as it was', async () => {
    db.skillsWriteRefused = true
    const res = await patch({ skill_recipe_ids: ['s-1', 's-2'] })
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toBe('could not write the skills')
    expect(skillIds()).toEqual(['s-private', 's-1'])
  })
})

describe('PATCH: what the editor can’t read', () => {
  it('keeps a private skill already on a system teammate, beside a new readable one, in the order sent', async () => {
    db.member.is_system = true
    const res = await patch({ skill_recipe_ids: ['s-private', 's-1', 's-2'] })
    expect(res.status).toBe(200)
    expect(skillIds()).toEqual(['s-private', 's-1', 's-2'])
  })

  it('refuses a private skill the teammate doesn’t already have (400), writing nothing', async () => {
    db.member.is_system = true
    const res = await patch({ skill_recipe_ids: ['s-private', 's-other-private'] })
    expect(res.status).toBe(400)
    expect(skillIds()).toEqual(['s-private', 's-1'])
    expect(db.memberWrites).toEqual([])
  })

  it('refuses a new id that isn’t a skill (400)', async () => {
    db.member.is_system = true
    const res = await patch({ skill_recipe_ids: ['s-1', 'r-mine'] })
    expect(res.status).toBe(400)
    expect(db.skillWrites).toBe(0)
  })

  it('the private persona it already has, sent back, is no re-point', async () => {
    const res = await patch({ name: 'Riley (PM)', agent_recipe_id: 'r-private' })
    expect(res.status).toBe(200)
    expect(db.memberWrites).toEqual([{ name: 'Riley (PM)' }])
    expect(db.member.agent_recipe_id).toBe('r-private')
  })

  it('re-pointing from it at a readable persona still works', async () => {
    const res = await patch({ agent_recipe_id: 'r-mine' })
    expect(res.status).toBe(200)
    expect(db.member.agent_recipe_id).toBe('r-mine')
  })
})

describe('PATCH: skills are the agent’s (bots-v4 B1, decision 11)', () => {
  it('a user-built teammate’s skills are its agent’s: this route refuses them (409), writing nothing', async () => {
    const res = await patch({ skill_recipe_ids: ['s-1', 's-2'] })
    expect(res.status).toBe(409)
    const body = await readJson<{ error: string; code: string }>(res)
    expect(body.code).toBe('AGENT_SKILLS')
    expect(body.error).toMatch(/persona’s editor/)
    expect(skillIds()).toEqual(['s-private', 's-1'])
    expect(db.memberWrites).toEqual([])
  })

  it('a system teammate checks up to five: a sixth is refused', async () => {
    db.member.is_system = true
    const res = await patch({ skill_recipe_ids: ['s-1', 's-2', 's-3', 's-4', 's-5', 's-6'] })
    expect(res.status).toBe(400)
    expect((await readJson<{ code: string }>(res)).code).toBe('TOO_MANY_SKILLS')
    expect(db.skillWrites).toBe(0)
  })

  it('never takes on a personal skill, even the caller’s own', async () => {
    db.member.is_system = true
    const res = await patch({ skill_recipe_ids: ['s-1', 's-mine-personal'] })
    expect(res.status).toBe(400)
    expect((await readJson<{ code: string }>(res)).code).toBe('PERSONAL_SKILL')
    expect(db.skillWrites).toBe(0)
  })
})

describe('GET: the raw ids beside the readable joins', () => {
  it('names only what the caller can read, and hands back every id', async () => {
    const res = await GET(buildRequest({ method: 'GET' }) as unknown as NextRequest, {
      params: Promise.resolve({ id: 'team-1' }),
    })
    expect(res.status).toBe(200)
    const { aiMembers } = await readJson<{
      aiMembers: Array<{ agent: unknown; agent_recipe_id: string; skills: Array<{ id: string }>; skill_recipe_ids: string[] }>
    }>(res)
    expect(aiMembers).toHaveLength(1)
    expect(aiMembers[0].agent).toBeNull()
    expect(aiMembers[0].agent_recipe_id).toBe('r-private')
    expect(aiMembers[0].skills.map((s) => s.id)).toEqual(['s-1'])
    expect(aiMembers[0].skill_recipe_ids).toEqual(['s-private', 's-1'])
  })
})
