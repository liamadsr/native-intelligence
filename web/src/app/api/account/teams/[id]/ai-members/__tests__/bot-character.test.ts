/**
 * Bot faces on the ai-members routes (docs/plans/bot-characters.md, "Step 3";
 * migration 294's `ai_team_member.bot_character`).
 *
 *   • POST and PATCH take `bot_character`: one of the eighteen, else a 400
 *     naming the field. A POST without one leaves it off the insert, so the
 *     database's insert default gives the starting face.
 *   • Faces are where teammates start, not rules: a system teammate's face
 *     changes like anyone's (and its name), its persona still doesn't (409).
 *   • A face another teammate wears is allowed. The picker warns; the routes
 *     never refuse a duplicate.
 *   • An update RLS refuses writes no rows and no error: the route says so
 *     (403) instead of answering success.
 *   • The GET hands back each row's face, and every face worn in the
 *     workspace, other teams and system teammates included, with no name for a
 *     teammate the caller can't see.
 *   • PATCH takes `voice` (bots-v4 B2, migration 308): one voice id, or null
 *     for Automatic; anything else is a 400 naming the field. A voice another
 *     bot chose is allowed. It's written as the face is, under the same manage
 *     rule (RLS), and an agent's work bot's follows its agent's rule.
 *
 * A small in-memory table stands in for Supabase: the session client sees
 * what RLS would let it (no hidden rows, no writes without the manage right),
 * the service client sees every row.
 */
import { builtBotId } from '@/lib/bots/bot-faces'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'

type Row = Record<string, unknown>

const db = vi.hoisted(() => ({
  members: [] as Row[],
  /** Teammates RLS hides from the caller's session (a private team it isn't on). */
  hidden: new Set<string>(),
  /** The RLS manage right (workspace admin, or a lead of the team). */
  canManage: true,
  serviceFails: false,
  recipes: [
    { id: 'r-mine', category: 'agent', workspace_id: 'ws-1' },
    { id: 's-1', category: 'skill', workspace_id: 'ws-1' },
    // Another member's agent, with a work bot (bots-v3 Phase 6): it's its author's.
    { id: 'r-theirs', category: 'agent', workspace_id: 'ws-1', is_system: false, created_by: 'user-2' },
  ] as Row[],
  inserted: [] as Row[],
  updated: [] as Array<{ patch: Row; ids: string[] }>,
}))

function fakeClient(client: 'session' | 'service') {
  return {
    auth: { getUser: async () => ({ data: { user: { id: 'user-1' } } }) },
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      let op: 'select' | 'insert' | 'update' | 'delete' = 'select'
      let payload: Row = {}
      const run = (): { data: Row[] | null; error: { message: string } | null } => {
        const pick = (rows: Row[]) => rows.filter((r) => filters.every((f) => f(r)))
        if (table === 'team') return { data: pick([{ id: 'team-1', workspace_id: 'ws-1' }]), error: null }
        if (table === 'recipe') return { data: pick(db.recipes), error: null }
        if (table === 'ai_team_member_skill') return { data: [], error: null }
        if (table !== 'ai_team_member') return { data: [], error: null }

        if (client === 'service' && db.serviceFails) return { data: null, error: { message: 'service down' } }
        const pool = client === 'session' ? db.members.filter((m) => !db.hidden.has(m.id as string)) : db.members
        if (op === 'select') return { data: pick(pool), error: null }
        if (op === 'insert') {
          if (client === 'session' && !db.canManage) {
            return { data: null, error: { message: 'new row violates row-level security policy for table "ai_team_member"' } }
          }
          const row = { id: 'ai-new', ...payload }
          db.members.push(row)
          db.inserted.push(payload)
          return { data: [row], error: null }
        }
        if (op === 'update') {
          const matched = client === 'session' && !db.canManage ? [] : pick(pool)
          for (const r of matched) Object.assign(r, payload)
          db.updated.push({ patch: payload, ids: matched.map((r) => r.id as string) })
          return { data: matched.map((r) => ({ id: r.id })), error: null }
        }
        return { data: [], error: null }
      }
      const b: Record<string, unknown> = {}
      Object.assign(b, {
        select: () => b,
        eq: (col: string, val: unknown) => (filters.push((r) => r[col] === val), b),
        neq: (col: string, val: unknown) => (filters.push((r) => r[col] !== val), b),
        in: (col: string, vals: unknown[]) => (filters.push((r) => vals.includes(r[col])), b),
        not: (col: string, operator: string, val: unknown) => (
          filters.push((r) => (operator === 'is' && val === null ? r[col] != null : r[col] !== val)), b
        ),
        or: () => b,
        order: () => b,
        limit: () => b,
        insert: (p: Row) => ((op = 'insert'), (payload = p), b),
        update: (p: Row) => ((op = 'update'), (payload = p), b),
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
  }
}

vi.mock('@/lib/workspace', () => ({ getCurrentWorkspaceId: async () => 'ws-1' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => fakeClient('session') }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => fakeClient('service') }))

const { GET, POST } = await import('../route')
const { PATCH } = await import('../[aiMemberId]/route')

function teammate(over: Row): Row {
  return {
    workspace_id: 'ws-1',
    team_id: 'team-1',
    avatar_url: null,
    team_role: 'member',
    created_at: '2026-09-01T00:00:00Z',
    is_system: false,
    system_key: null,
    agent_recipe_id: 'r-mine',
    agent: null,
    ai_team_member_skill: [],
    ...over,
  }
}

beforeEach(() => {
  db.members = [
    teammate({ id: 'ai-1', name: 'Riley', bot_character: 'chat' }),
    teammate({ id: 'sys-triage', name: 'Triage', is_system: true, system_key: 'triage', bot_character: 'triage' }),
    // On another team of the same workspace.
    teammate({ id: 'ai-writer', team_id: 'team-2', name: 'Writer', bot_character: 'writer' }),
    // On a private team the caller isn't on.
    teammate({ id: 'ai-secret', team_id: 'team-3', name: 'Secret', bot_character: 'research' }),
    // No face.
    teammate({ id: 'ai-bare', team_id: 'team-2', name: 'Bare', bot_character: null }),
    // Another workspace entirely.
    teammate({ id: 'ai-other', workspace_id: 'ws-2', team_id: 'team-9', name: 'Elsewhere', bot_character: 'nova' }),
  ]
  db.hidden = new Set(['ai-secret'])
  db.canManage = true
  db.serviceFails = false
  db.inserted = []
  db.updated = []
})

describe('POST /teams/[id]/ai-members: bot_character', () => {
  const params = Promise.resolve({ id: 'team-1' })
  const post = (body: Row) => POST(buildRequest({ body }) as unknown as NextRequest, { params })
  const base = { name: 'Atlas', agent_recipe_id: 'r-mine' }

  it('writes a valid face onto the new teammate', async () => {
    const res = await post({ ...base, bot_character: 'live' })
    expect(res.status).toBe(201)
    expect(db.inserted).toHaveLength(1)
    expect(db.inserted[0]).toMatchObject({ name: 'Atlas', bot_character: 'live' })
  })

  it.each([['dragon'], ['Writer'], [''], [42], [null], [{ type: 'writer' }]])(
    'refuses %j with a 400 naming the field, and inserts nothing',
    async (bad) => {
      const res = await post({ ...base, bot_character: bad })
      expect(res.status).toBe(400)
      const body = await readJson<{ error: string; code: string; details: { field: string } }>(res)
      expect(body.error).toMatch(/bot_character/)
      expect(body.details).toEqual({ field: 'bot_character' })
      expect(db.inserted).toEqual([])
    },
  )

  it('without a face, leaves it off the insert so the database’s default picks the starting one', async () => {
    const res = await post(base)
    expect(res.status).toBe(201)
    expect(db.inserted).toHaveLength(1)
    expect('bot_character' in db.inserted[0]).toBe(false)
  })

  it('allows a face another teammate of the workspace already wears', async () => {
    // Writer (another team) wears Ghost; Riley (this team) wears Clover.
    for (const face of ['writer', 'research']) {
      const res = await post({ ...base, bot_character: face })
      expect(res.status).toBe(201)
    }
    expect(db.inserted.map((r) => r.bot_character)).toEqual(['writer', 'research'])
  })

  it('refuses the assistant’s own face on a new teammate (one face), naming the field, and inserts nothing', async () => {
    const res = await post({ ...base, bot_character: 'chat' })
    expect(res.status).toBe(400)
    const body = await readJson<{ error: string; details: { field: string } }>(res)
    expect(body.error).toMatch(/^bot_character "chat" is your assistant’s own character/)
    expect(body.details).toEqual({ field: 'bot_character' })
    expect(db.inserted).toEqual([])
  })

  it('an RLS refusal (not an admin or lead) comes back as the create error the dialog shows', async () => {
    db.canManage = false
    const res = await post({ ...base, bot_character: 'live' })
    expect(res.status).toBe(500)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/row-level security/)
  })
})

describe('PATCH /teams/[id]/ai-members/[aiMemberId]: bot_character', () => {
  const patch = (aiMemberId: string, body: Row) =>
    PATCH(buildRequest({ method: 'PATCH', body }) as unknown as NextRequest, {
      params: Promise.resolve({ id: 'team-1', aiMemberId }),
    })

  it('changes the face', async () => {
    const res = await patch('ai-1', { bot_character: 'nova' })
    expect(res.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { bot_character: 'nova' }, ids: ['ai-1'] }])
  })

  it.each([['dragon'], [null], [7]])('refuses %j with a 400 naming the field, and writes nothing', async (bad) => {
    const res = await patch('ai-1', { name: 'Renamed', bot_character: bad })
    expect(res.status).toBe(400)
    expect(await readJson<{ details: unknown }>(res)).toMatchObject({ details: { field: 'bot_character' } })
    expect(db.updated).toEqual([])
  })

  it('allows a face another teammate of the workspace already wears', async () => {
    const res = await patch('ai-1', { bot_character: 'writer' })
    expect(res.status).toBe(200)
    expect(db.members.find((m) => m.id === 'ai-1')?.bot_character).toBe('writer')
    expect(db.members.find((m) => m.id === 'ai-writer')?.bot_character).toBe('writer')
  })

  it('the assistant’s own face goes only on the Assistant (one face): refused on anyone else, nothing written', async () => {
    db.members.push(teammate({ id: 'sys-agent', name: 'Assistant', is_system: true, system_key: 'assistant', bot_character: 'nova' }))
    const refused = await patch('ai-1', { bot_character: 'chat' })
    expect(refused.status).toBe(400)
    expect(await readJson<{ details: unknown }>(refused)).toMatchObject({ details: { field: 'bot_character' } })
    const triage = await patch('sys-triage', { bot_character: 'chat' })
    expect(triage.status).toBe(400)
    expect(db.updated).toEqual([])
    const agent = await patch('sys-agent', { bot_character: 'chat' })
    expect(agent.status).toBe(200)
  })

  it('a system teammate’s face and name change like anyone’s', async () => {
    const res = await patch('sys-triage', { name: 'Sorter', bot_character: 'ember' })
    expect(res.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { name: 'Sorter', bot_character: 'ember' }, ids: ['sys-triage'] }])
  })

  it('a system teammate’s persona still can’t change (409), face or not, and nothing is written', async () => {
    const res = await patch('sys-triage', { agent_recipe_id: 'r-mine', bot_character: 'ember' })
    expect(res.status).toBe(409)
    expect(await readJson<{ code: string }>(res)).toMatchObject({ code: 'SYSTEM_TEAMMATE' })
    expect(db.updated).toEqual([])
  })

  it('an update RLS refuses (no rows written) is a 403 the dialog can show, not a success', async () => {
    db.canManage = false
    const res = await patch('ai-1', { bot_character: 'nova' })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/admins and this team’s leads/)
    expect(db.members.find((m) => m.id === 'ai-1')?.bot_character).toBe('chat')
  })

  it('a teammate not on this team (or not visible) is a 404', async () => {
    const res = await patch('ai-writer', { bot_character: 'nova' })
    expect(res.status).toBe(404)
    expect(db.updated).toEqual([])
  })
})

describe('GET /teams/[id]/ai-members: faces', () => {
  const get = () => GET(buildRequest({ method: 'GET' }) as unknown as NextRequest, { params: Promise.resolve({ id: 'team-1' }) })

  it('returns each row’s face, and every face worn in the workspace', async () => {
    const res = await get()
    expect(res.status).toBe(200)
    const body = await readJson<{
      aiMembers: Array<{ id: string; bot_character: string | null }>
      workspace_faces: Array<{ id: string; name: string | null; bot_character: string }>
    }>(res)
    expect(body.aiMembers.map((m) => [m.id, m.bot_character])).toEqual([
      ['ai-1', 'chat'],
      ['sys-triage', 'triage'],
    ])
    // Other teams and system teammates count; a private team's teammate counts
    // without its name; a faceless one and another workspace's don't.
    expect(body.workspace_faces).toEqual([
      { id: 'ai-1', name: 'Riley', bot_character: 'chat' },
      { id: 'sys-triage', name: 'Triage', bot_character: 'triage' },
      { id: 'ai-writer', name: 'Writer', bot_character: 'writer' },
      { id: 'ai-secret', name: null, bot_character: 'research' },
    ])
  })

  it('a failed service read falls back to the faces the caller can see', async () => {
    db.serviceFails = true
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await get()
    expect(res.status).toBe(200)
    const body = await readJson<{ workspace_faces: Array<{ id: string }> }>(res)
    expect(body.workspace_faces.map((f) => f.id)).toEqual(['ai-1', 'sys-triage', 'ai-writer'])
    errorSpy.mockRestore()
  })
})

describe('built bots through the ai-members routes (bots-v3 Phase 6: the builder saves here)', () => {
  const BUILT = builtBotId({ body: 'ember', glasses: 'hearts', worn: 'crown', wornColor: '#5B7BFF' })!
  const params = Promise.resolve({ id: 'team-1' })
  const post = (body: Row) => POST(buildRequest({ body }) as unknown as NextRequest, { params })
  const patch = (aiMemberId: string, body: Row) =>
    PATCH(buildRequest({ method: 'PATCH', body }) as unknown as NextRequest, {
      params: Promise.resolve({ id: 'team-1', aiMemberId }),
    })

  it('saves a built bot’s id on create and on edit', async () => {
    const created = await post({ name: 'Atlas', agent_recipe_id: 'r-mine', bot_character: BUILT })
    expect(created.status).toBe(201)
    expect(db.inserted[0]).toMatchObject({ bot_character: BUILT })
    const edited = await patch('ai-1', { bot_character: BUILT })
    expect(edited.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { bot_character: BUILT }, ids: ['ai-1'] }])
  })

  // The shape of a built id, but not a recipe: a letter past its list's end, a
  // colour for nothing worn, the classic eyes spelled out, too short.
  it.each([['xzzaaaaa'], ['xaaaaaab'], ['xaaabaaa'], ['xaaaaaa'], ['XAAAAAAA']])('refuses %j with a 400 and writes nothing', async (bad) => {
    const created = await post({ name: 'Atlas', agent_recipe_id: 'r-mine', bot_character: bad })
    expect(created.status).toBe(400)
    const edited = await patch('ai-1', { bot_character: bad })
    expect(edited.status).toBe(400)
    expect(db.inserted).toEqual([])
    expect(db.updated).toEqual([])
  })
})

describe('PATCH /teams/[id]/ai-members/[aiMemberId]: voice (bots-v4 B2)', () => {
  const patch = (aiMemberId: string, body: Row) =>
    PATCH(buildRequest({ method: 'PATCH', body }) as unknown as NextRequest, {
      params: Promise.resolve({ id: 'team-1', aiMemberId }),
    })
  const voiceOf = (id: string) => db.members.find((m) => m.id === id)?.voice

  it('takes one voice id, and null for Automatic', async () => {
    let res = await patch('ai-1', { voice: 'lori' })
    expect(res.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { voice: 'lori' }, ids: ['ai-1'] }])
    res = await patch('ai-1', { voice: null })
    expect(res.status).toBe(200)
    expect(db.updated[1]).toEqual({ patch: { voice: null }, ids: ['ai-1'] })
    expect(voiceOf('ai-1')).toBeNull()
  })

  it.each([['Lori'], [''], ['lori bot'], ['-lori'], ['x'.repeat(33)], [42], [false], [{ id: 'lori' }], [['lori']]])(
    'refuses %j with a 400 naming the field, and writes nothing',
    async (bad) => {
      const res = await patch('ai-1', { name: 'Renamed', voice: bad })
      expect(res.status).toBe(400)
      expect(await readJson<{ details: unknown }>(res)).toMatchObject({ details: { field: 'voice' } })
      expect(db.updated).toEqual([])
    },
  )

  it('leaves the voice alone when the body doesn’t name it', async () => {
    const res = await patch('ai-1', { bot_character: 'nova' })
    expect(res.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { bot_character: 'nova' }, ids: ['ai-1'] }])
  })

  it('a voice another bot chose is allowed: the bot’s own, its face and name alongside', async () => {
    db.members.find((m) => m.id === 'sys-triage')!.voice = 'lori'
    const res = await patch('ai-1', { name: 'Rae', bot_character: 'nova', voice: 'lori' })
    expect(res.status).toBe(200)
    expect(db.updated).toEqual([{ patch: { name: 'Rae', bot_character: 'nova', voice: 'lori' }, ids: ['ai-1'] }])
    expect(voiceOf('sys-triage')).toBe('lori')
  })

  it('a system teammate’s voice changes like its face', async () => {
    const res = await patch('sys-triage', { voice: 'tana' })
    expect(res.status).toBe(200)
    expect(voiceOf('sys-triage')).toBe('tana')
  })

  it('under the same manage rule as its face: an update RLS refuses is a 403, nothing written', async () => {
    db.canManage = false
    const res = await patch('ai-1', { voice: 'lori' })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/admins and this team’s leads/)
    expect(voiceOf('ai-1')).toBeUndefined()
  })

  it('an agent’s work bot’s voice is its agent’s: someone not its author, an owner or an admin gets a 403', async () => {
    db.members.push(teammate({ id: 'their-bot', name: 'Their bot', fronts_only: true, agent_recipe_id: 'r-theirs', bot_character: 'dew' }))
    const res = await patch('their-bot', { voice: 'lori' })
    expect(res.status).toBe(403)
    expect(db.updated).toEqual([])
    expect(voiceOf('their-bot')).toBeUndefined()
  })
})
