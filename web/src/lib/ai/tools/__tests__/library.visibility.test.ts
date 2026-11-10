/**
 * Recipe VISIBILITY on the service-role tool surfaces.
 *
 * The chat, skill-run and work-run tool routes and the MCP server hand their
 * tools a SERVICE client, so `recipe_select_visibility` (migration 079) never
 * fires. A query scoped only to `is_system OR workspace_id = <ws>` then listed
 * every member's PERSONAL skills and agents to their teammates — names and
 * descriptions in a list, the full prompt in a get. The rule now lives in
 * src/lib/library/visibility.ts, the one `rebuildChatSkills` applies:
 *   system rows (less feature-gated ones), this workspace's 'workspace' /
 *   'public' rows, and the caller's OWN 'personal' rows.
 *
 * The fake below EVALUATES the PostgREST filters it is handed (eq / in / is /
 * not-in / ilike and nested or/and groups) against an in-memory table and
 * returns every row on an unfiltered read, as the service role does. So each
 * assertion fails unless the query itself excludes the row.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createLibraryTools, SKILL_NOT_EDITABLE_ERROR } from '../library'
import { createCaptureTools } from '../captures'
import { registerLibraryTools } from '@/lib/mcp/tools/library'
import { recipeIsVisible } from '@/app/api/account/evals/suites/target-recipe'
import { isRecipeVisibleTo, visibleRecipesFilter } from '@/lib/library/visibility'
import { offOverrides } from '@/test/editions'

const ME = 'user-me'
const OTHER = 'user-other'
const WS = 'ws-1'
const FOREIGN_WS = 'ws-2'
/** `/create-eval` (migration 253): gated while Evals is off, as it is in this workspace. */
const GATED_SYSTEM_ID = '6b3f1d02-91ac-4e57-8c24-0a5f7d3e9b18'

const EXEC = { toolCallId: 'c', messages: [], context: {} } as never

type Row = Record<string, unknown>

const recipe = (id: string, fields: Row): Row => ({
  id,
  name: id,
  slug: id,
  description: `${id} description`,
  system_prompt: `${id} prompt`,
  sort_order: 0,
  is_default: false,
  ...fields,
})

const ROWS = {
  systemSkill: recipe('system-skill', { category: 'skill', is_system: true, workspace_id: null, visibility: 'workspace', created_by: null }),
  gatedSystemSkill: recipe(GATED_SYSTEM_ID, { name: 'create-eval', category: 'skill', is_system: true, workspace_id: null, visibility: 'workspace', created_by: null }),
  sharedSkill: recipe('shared-skill', { category: 'skill', is_system: false, workspace_id: WS, visibility: 'workspace', created_by: OTHER }),
  publicSkill: recipe('public-skill', { category: 'skill', is_system: false, workspace_id: WS, visibility: 'public', created_by: OTHER }),
  myPersonalSkill: recipe('my-personal-skill', { category: 'skill', is_system: false, workspace_id: WS, visibility: 'personal', created_by: ME }),
  theirPersonalSkill: recipe('their-personal-skill', { category: 'skill', is_system: false, workspace_id: WS, visibility: 'personal', created_by: OTHER }),
  foreignSkill: recipe('foreign-skill', { category: 'skill', is_system: false, workspace_id: FOREIGN_WS, visibility: 'workspace', created_by: OTHER }),
  foreignPublicSkill: recipe('foreign-public-skill', { category: 'skill', is_system: false, workspace_id: FOREIGN_WS, visibility: 'public', created_by: OTHER }),
  systemAgent: recipe('system-agent', { category: 'agent', is_system: true, workspace_id: null, visibility: 'workspace', created_by: null }),
  sharedAgent: recipe('shared-agent', { category: 'agent', is_system: false, workspace_id: WS, visibility: 'workspace', created_by: OTHER }),
  myPersonalAgent: recipe('my-personal-agent', { category: 'agent', is_system: false, workspace_id: WS, visibility: 'personal', created_by: ME }),
  theirPersonalAgent: recipe('their-personal-agent', { name: 'Their Coach', category: 'agent', is_system: false, workspace_id: WS, visibility: 'personal', created_by: OTHER }),
} satisfies Record<string, Row>

const VISIBLE_SKILLS = ['system-skill', 'shared-skill', 'public-skill', 'my-personal-skill']
const VISIBLE_AGENTS = ['system-agent', 'shared-agent', 'my-personal-agent']

// ── A PostgREST filter evaluator ────────────────────────────────────────────

/** Split a filter list on its top-level commas (not inside parens or quotes). */
function splitTopLevel(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let quoted = false
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (quoted) {
      cur += c
      if (c === '\\') cur += s[++i]
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') quoted = true
    else if (c === '(') depth++
    else if (c === ')') depth--
    if (c === ',' && depth === 0) {
      out.push(cur)
      cur = ''
    } else cur += c
  }
  out.push(cur)
  return out
}

const unquote = (v: string) =>
  v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1).replace(/\\(.)/g, '$1') : v

const listValues = (v: string) => splitTopLevel(v.replace(/^\(|\)$/g, '')).map(unquote)

function matchesCondition(row: Row, col: string, op: string, value: string): boolean {
  const cell = row[col]
  const text = cell === null || cell === undefined ? null : String(cell)
  switch (op) {
    case 'eq':
      return text === unquote(value)
    case 'neq':
      return text !== unquote(value)
    case 'is':
      return value === 'null' ? cell === null || cell === undefined : text === value
    case 'in':
      return text !== null && listValues(value).includes(text)
    case 'ilike': {
      const pattern = unquote(value).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*')
      return text !== null && new RegExp(`^${pattern}$`).test(text.toLowerCase())
    }
    default:
      throw new Error(`fake: unsupported operator ${op}`)
  }
}

/** Evaluate one `or(...)` group, as `.or(<group>)` hands it over. */
function matchesOr(row: Row, group: string): boolean {
  return splitTopLevel(group).some((term) => matchesTerm(row, term))
}

function matchesTerm(row: Row, term: string): boolean {
  if (term.startsWith('and(')) return splitTopLevel(term.slice(4, -1)).every((t) => matchesTerm(row, t))
  if (term.startsWith('or(')) return matchesOr(row, term.slice(3, -1))
  const [col, op, ...rest] = term.split('.')
  return matchesCondition(row, col, op, rest.join('.'))
}

// ── The fake client ─────────────────────────────────────────────────────────

type Tables = Record<string, Row[]>

function fakeClient(tables: Tables) {
  const writes: Array<{ table: string; op: 'update' | 'delete'; ids: unknown[]; payload?: Row }> = []
  const ors: string[] = []

  const from = (table: string) => {
    const filters: Array<(row: Row) => boolean> = []
    let op: 'select' | 'update' | 'delete' = 'select'
    let payload: Row | undefined
    let limit: number | undefined

    const run = () => {
      let rows = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)))
      if (limit !== undefined) rows = rows.slice(0, limit)
      if (op !== 'select') {
        writes.push({ table, op, ids: rows.map((r) => r.id), payload })
        if (op === 'update') rows = rows.map((r) => Object.assign(r, payload))
      }
      return rows
    }

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Row) => ((op = 'update'), (payload = p), b),
      delete: () => ((op = 'delete'), b),
      eq: (c: string, v: unknown) => (filters.push((r) => matchesCondition(r, c, 'eq', String(v))), b),
      neq: (c: string, v: unknown) => (filters.push((r) => matchesCondition(r, c, 'neq', String(v))), b),
      is: (c: string, v: unknown) => (filters.push((r) => matchesCondition(r, c, 'is', String(v))), b),
      in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
      not: (c: string, o: string, v: string) => (filters.push((r) => !matchesCondition(r, c, o, v)), b),
      or: (group: string) => (ors.push(group), filters.push((r) => matchesOr(r, group)), b),
      order: () => b,
      limit: (n: number) => ((limit = n), b),
      single: async () => {
        const rows = run()
        return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } }
      },
      maybeSingle: async () => ({ data: run()[0] ?? null, error: null }),
      then: (resolve: (r: unknown) => unknown) => Promise.resolve({ data: run(), error: null }).then(resolve),
    }
    return b
  }

  return { supabase: { from } as unknown as SupabaseClient, writes, ors }
}

/** A fresh copy of every table, so a write in one test never leaks into the next.
 *  The workspace has Evals switched off, so `/create-eval` is a gated row. */
function world(role: 'member' | 'admin' = 'member') {
  return fakeClient({
    recipe: Object.values(ROWS).map((r) => ({ ...r })),
    workspace: [{ id: WS, settings: { feature_overrides: offOverrides(['evals']) } }],
    member: [
      { user_id: ME, workspace_id: WS, role },
      { user_id: OTHER, workspace_id: WS, role: 'member' },
    ],
  })
}

const ids = (rows: unknown) => ((rows ?? []) as Row[]).map((r) => r.id).sort()

// ── The rule itself ─────────────────────────────────────────────────────────

describe('visibleRecipesFilter / isRecipeVisibleTo', () => {
  it('the query filter and the row predicate are the same rule, row for row', () => {
    for (const row of Object.values(ROWS)) {
      expect(matchesOr(row, visibleRecipesFilter(WS, ME)), String(row.id)).toBe(isRecipeVisibleTo(row, WS, ME))
    }
  })

  it('hides another member\'s personal row and shows the caller\'s own', () => {
    expect(isRecipeVisibleTo(ROWS.theirPersonalSkill, WS, ME)).toBe(false)
    expect(isRecipeVisibleTo(ROWS.myPersonalSkill, WS, ME)).toBe(true)
    // …which is the other member's to see.
    expect(isRecipeVisibleTo(ROWS.theirPersonalSkill, WS, OTHER)).toBe(true)
  })

  it('shows workspace and public rows of THIS workspace, and system rows', () => {
    expect(isRecipeVisibleTo(ROWS.sharedSkill, WS, ME)).toBe(true)
    expect(isRecipeVisibleTo(ROWS.publicSkill, WS, ME)).toBe(true)
    expect(isRecipeVisibleTo(ROWS.systemSkill, WS, ME)).toBe(true)
  })

  it('hides another workspace\'s rows, public ones included', () => {
    expect(isRecipeVisibleTo(ROWS.foreignSkill, WS, ME)).toBe(false)
    expect(isRecipeVisibleTo(ROWS.foreignPublicSkill, WS, ME)).toBe(false)
  })

  it('fails closed on a missing row or one read without its visibility columns', () => {
    expect(isRecipeVisibleTo(null, WS, ME)).toBe(false)
    expect(isRecipeVisibleTo({ is_system: false, workspace_id: WS }, WS, ME)).toBe(false)
  })
})

// ── Chat tools (createLibraryTools) ─────────────────────────────────────────

describe('chat list_skills', () => {
  it('lists system, workspace, public and the caller\'s own personal skills — never another member\'s, never a gated one', async () => {
    const { supabase } = world()
    const res = (await createLibraryTools(ME, supabase, WS).list_skills.execute!({}, EXEC)) as { skills: Row[] }
    expect(ids(res.skills)).toEqual([...VISIBLE_SKILLS].sort())
  })

  it('mine_only stays the caller\'s own rows', async () => {
    const { supabase } = world()
    const res = (await createLibraryTools(ME, supabase, WS).list_skills.execute!({ mine_only: true }, EXEC)) as {
      skills: Row[]
    }
    expect(ids(res.skills)).toEqual(['my-personal-skill'])
  })
})

describe('chat get_skill', () => {
  const get = async (id: string) => {
    const { supabase } = world()
    return (await createLibraryTools(ME, supabase, WS).get_skill.execute!({ id }, EXEC)) as {
      success: boolean
      skill?: Row
      error?: string
    }
  }

  it('reads another member\'s personal skill as not found', async () => {
    expect(await get('their-personal-skill')).toEqual({ success: false, error: 'Skill not found' })
  })

  it('reads the caller\'s own personal skill, and workspace / public / system ones', async () => {
    for (const id of VISIBLE_SKILLS) {
      const res = await get(id)
      expect(res.success, id).toBe(true)
      expect(res.skill?.system_prompt).toBe(`${id} prompt`)
    }
  })

  it('reads a gated system skill as not found', async () => {
    expect(await get(GATED_SYSTEM_ID)).toEqual({ success: false, error: 'Skill not found' })
  })
})

describe('chat list_agents / get_agent', () => {
  it('list_agents hides another member\'s personal agent', async () => {
    const { supabase } = world()
    const res = (await createLibraryTools(ME, supabase, WS).list_agents.execute!({}, EXEC)) as { agents: Row[] }
    expect(ids(res.agents)).toEqual([...VISIBLE_AGENTS].sort())
  })

  it('get_agent by id reads another member\'s personal agent as not found, the caller\'s own as found', async () => {
    const tools = createLibraryTools(ME, world().supabase, WS)
    const theirs = (await tools.get_agent.execute!({ id: 'their-personal-agent' }, EXEC)) as { success: boolean }
    expect(theirs.success).toBe(false)
    const mine = (await tools.get_agent.execute!({ id: 'my-personal-agent' }, EXEC)) as { success: boolean }
    expect(mine.success).toBe(true)
  })

  it('get_agent by name cannot reach another member\'s personal agent either', async () => {
    const res = (await createLibraryTools(ME, world().supabase, WS).get_agent.execute!({ name: 'their coach' }, EXEC)) as {
      success: boolean
      error?: string
    }
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/No AGENT named/)
  })
})

describe('chat update_skill', () => {
  const update = async (id: string, role: 'member' | 'admin' = 'member') => {
    const w = world(role)
    const res = (await createLibraryTools(ME, w.supabase, WS).update_skill.execute!(
      { id, description: 'Rewritten.' },
      EXEC,
    )) as { success: boolean; error?: string }
    return { res, writes: w.writes }
  }

  it('reads another member\'s personal skill as not found, even to an admin, and writes nothing', async () => {
    for (const role of ['member', 'admin'] as const) {
      const { res, writes } = await update('their-personal-skill', role)
      expect(res, role).toEqual({ success: false, error: 'Skill not found' })
      expect(writes).toEqual([])
    }
  })

  it('refuses a plain member editing a teammate\'s shared skill (migration 191\'s rule)', async () => {
    const { res, writes } = await update('shared-skill')
    expect(res).toEqual({ success: false, error: SKILL_NOT_EDITABLE_ERROR })
    expect(writes).toEqual([])
  })

  it('lets an owner/admin edit a teammate\'s shared skill', async () => {
    const { res, writes } = await update('shared-skill', 'admin')
    expect(res.success).toBe(true)
    expect(writes).toEqual([{ table: 'recipe', op: 'update', ids: ['shared-skill'], payload: { description: 'Rewritten.' } }])
  })

  it('lets the creator edit their own personal skill', async () => {
    const { res, writes } = await update('my-personal-skill')
    expect(res.success).toBe(true)
    expect(writes.map((w) => w.ids)).toEqual([['my-personal-skill']])
  })
})

describe('chat list_recipes (captures.ts)', () => {
  it('hides other members\' personal skills and agents, and gated system recipes', async () => {
    const { supabase } = world()
    const tools = createCaptureTools(ME, supabase, WS)
    const res = (await tools.list_recipes.execute!({ include_system: true }, EXEC)) as { recipes: Row[] }
    expect(ids(res.recipes)).toEqual(
      ['my-personal-agent', 'my-personal-skill', 'public-skill', 'shared-agent', 'shared-skill', 'system-agent', 'system-skill'].sort(),
    )
  })
})

describe('recipeIsVisible (eval suite targets)', () => {
  it('refuses another member\'s personal agent as a target, accepts the caller\'s own', async () => {
    const { supabase } = world()
    expect(await recipeIsVisible(supabase, 'their-personal-agent', WS, ME)).toBe(false)
    expect(await recipeIsVisible(supabase, 'my-personal-agent', WS, ME)).toBe(true)
    expect(await recipeIsVisible(supabase, 'shared-agent', WS, ME)).toBe(true)
  })
})

// ── The MCP mirror (registerLibraryTools) ───────────────────────────────────

type Handler = (args: Record<string, unknown>) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

function mcp(role: 'member' | 'admin' = 'member') {
  const w = world(role)
  const handlers: Record<string, Handler> = {}
  const server = {
    tool: (...args: unknown[]) => {
      handlers[args[0] as string] = args[args.length - 1] as Handler
    },
  }
  registerLibraryTools(server as never, ME, w.supabase, WS)
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await handlers[name](args)
    return { isError: res.isError === true, body: JSON.parse(res.content[0].text) as Record<string, unknown> }
  }
  return { call, writes: w.writes }
}

describe('MCP library tools', () => {
  it('ni_list_skills and ni_list_agents hide other members\' personal rows and gated ones', async () => {
    const { call } = mcp()
    expect(ids((await call('ni_list_skills', {})).body.skills)).toEqual([...VISIBLE_SKILLS].sort())
    expect(ids((await call('ni_list_agents', {})).body.agents)).toEqual([...VISIBLE_AGENTS].sort())
  })

  it('ni_get_skill / ni_get_agent read another member\'s personal row as not found', async () => {
    const { call } = mcp()
    expect((await call('ni_get_skill', { id: 'their-personal-skill' })).isError).toBe(true)
    expect((await call('ni_get_agent', { id: 'their-personal-agent' })).isError).toBe(true)
    expect((await call('ni_get_skill', { id: 'my-personal-skill' })).isError).toBe(false)
    expect((await call('ni_get_agent', { id: 'my-personal-agent' })).isError).toBe(false)
  })

  it('an admin cannot update or delete another member\'s personal skill', async () => {
    const { call, writes } = mcp('admin')
    const upd = await call('ni_update_skill', { id: 'their-personal-skill', description: 'x' })
    expect(upd).toEqual({ isError: true, body: { error: 'Not found', code: 'NOT_EDITABLE' } })
    const del = await call('ni_delete_skill', { id: 'their-personal-skill' })
    expect(del).toEqual({ isError: true, body: { error: 'Not found', code: 'NOT_DELETABLE' } })
    expect(writes).toEqual([])
  })

  it('an admin still manages a teammate\'s shared skill', async () => {
    const { call, writes } = mcp('admin')
    expect((await call('ni_update_skill', { id: 'shared-skill', description: 'x' })).isError).toBe(false)
    expect(writes.map((w) => [w.op, w.ids])).toEqual([['update', ['shared-skill']]])
  })
})
