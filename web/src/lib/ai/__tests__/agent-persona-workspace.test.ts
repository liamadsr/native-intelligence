/**
 * A work or coding run's persona is read with a service-role client, and a
 * teammate's agent recipe and skills are joined by id. loadAgentPersona and
 * loadAgentPersonaFromRecipe fence them to the run's workspace: only that
 * workspace's own recipes and system ones may shape its prompt.
 */
import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { loadAgentPersona, loadAgentPersonaFromRecipe } from '../agent-run-context'

type Row = Record<string, unknown>

/** The columns a select lists inside an embed such as `agent:agent_recipe_id(a, b)`, or null when it has none. */
function embedColumns(select: string, alias: string): string[] | null {
  const m = new RegExp(`${alias}:\\w+\\(([^()]*)\\)`).exec(select)
  return m ? m[1].split(',').map((c) => c.trim()).filter(Boolean) : null
}

function pick(obj: unknown, cols: string[] | null): unknown {
  if (!obj || typeof obj !== 'object' || !cols) return undefined
  return Object.fromEntries(cols.filter((c) => c in (obj as Row)).map((c) => [c, (obj as Row)[c]]))
}

/**
 * Like PostgREST, a teammate's embedded agent and skill rows come back with
 * only the columns the select names, so a select that stops asking for
 * workspace_id / is_system shows up here as every recipe fenced out.
 */
function project(row: Row, select: string): Row {
  const agentCols = embedColumns(select, 'agent')
  const skillCols = embedColumns(select, 'skill')
  const skills = row.ai_team_member_skill as Array<{ sort_order: number; skill: unknown }> | undefined
  return {
    ...row,
    agent: pick(row.agent, agentCols) ?? null,
    ...(skills ? { ai_team_member_skill: skills.map((s) => ({ sort_order: s.sort_order, skill: pick(s.skill, skillCols) ?? null })) } : {}),
  }
}

/** A fake client that applies .eq() filters and the `workspace_id.eq.X,is_system.eq.true` .or(). */
function fakeSupabase(tables: Record<string, Row[]>) {
  return {
    from(table: string) {
      const eqs: Record<string, unknown> = {}
      let orWorkspace: string | null = null
      let selected = ''
      const b = {
        select: (cols: string) => ((selected = cols), b),
        eq: (col: string, val: unknown) => ((eqs[col] = val), b),
        or: (expr: string) => {
          orWorkspace = /^workspace_id\.eq\.([^,]+),is_system\.eq\.true$/.exec(expr)?.[1] ?? '__unparsed__'
          return b
        },
        single: async () => {
          const rows = (tables[table] ?? []).filter(
            (r) =>
              Object.entries(eqs).every(([k, v]) => r[k] === v) &&
              (orWorkspace === null || r.is_system === true || r.workspace_id === orWorkspace),
          )
          if (rows.length !== 1) return { data: null, error: { message: 'no rows' } }
          return { data: table === 'ai_team_member' ? project(rows[0], selected) : rows[0], error: null }
        },
      }
      return b
    },
  } as unknown as SupabaseClient
}

const recipe = (name: string, workspace_id: string | null, is_system = false) => ({
  name,
  description: null,
  system_prompt: `${name} prompt`,
  workspace_id,
  is_system,
})

const MEMBER = {
  id: 'ai-1',
  workspace_id: 'ws-a',
  name: 'Atlas',
  agent: { system_prompt: 'Atlas persona', agent_config: null, workspace_id: 'ws-a', is_system: false },
  ai_team_member_skill: [
    { sort_order: 2, skill: recipe('Foreign private', 'ws-b') },
    { sort_order: 1, skill: recipe('Own skill', 'ws-a') },
    { sort_order: 3, skill: recipe('System skill', null, true) },
    { sort_order: 4, skill: recipe('Foreign public', 'ws-c') },
  ],
}

describe('loadAgentPersona — fenced to the run workspace', () => {
  it("keeps the workspace's own and system skills, in order, and drops every other workspace's", async () => {
    const persona = await loadAgentPersona(fakeSupabase({ ai_team_member: [MEMBER] }), 'ai-1', 'ws-a')
    expect(persona?.agentSystemPrompt).toBe('Atlas persona')
    expect(persona?.skills).toEqual([
      { name: 'Own skill', description: null, system_prompt: 'Own skill prompt' },
      { name: 'System skill', description: null, system_prompt: 'System skill prompt' },
    ])
    expect(JSON.stringify(persona)).not.toMatch(/Foreign|ws-b|ws-c/)
  })

  it('leaves out an agent recipe from another workspace (no agent prompt, as if unreadable)', async () => {
    const member = { ...MEMBER, agent: { system_prompt: 'Foreign persona', agent_config: { mode: 'x' }, workspace_id: 'ws-b', is_system: false } }
    const persona = await loadAgentPersona(fakeSupabase({ ai_team_member: [member] }), 'ai-1', 'ws-a')
    expect(persona?.agentSystemPrompt).toBeNull()
    expect(persona?.agentConfig).toBeNull()
    expect(persona?.name).toBe('Atlas')
  })

  it('keeps a system agent recipe', async () => {
    const member = { ...MEMBER, agent: { system_prompt: 'System persona', agent_config: null, workspace_id: null, is_system: true } }
    expect((await loadAgentPersona(fakeSupabase({ ai_team_member: [member] }), 'ai-1', 'ws-a'))?.agentSystemPrompt).toBe(
      'System persona',
    )
  })

  // bots-v4 B1: a bot's skills are written into everyone's chat with it; a personal skill's words are its author's alone.
  it('leaves out a personal skill, even this workspace’s own', async () => {
    const member = {
      ...MEMBER,
      ai_team_member_skill: [
        { sort_order: 1, skill: { ...recipe('Shared skill', 'ws-a'), visibility: 'workspace' } },
        { sort_order: 2, skill: { ...recipe('My notes', 'ws-a'), visibility: 'personal' } },
      ],
    }
    const persona = await loadAgentPersona(fakeSupabase({ ai_team_member: [member] }), 'ai-1', 'ws-a')
    expect(persona?.skills.map((s) => s.name)).toEqual(['Shared skill'])
    expect(JSON.stringify(persona)).not.toContain('My notes')
  })

  it('returns null for a teammate that belongs to another workspace', async () => {
    expect(await loadAgentPersona(fakeSupabase({ ai_team_member: [MEMBER] }), 'ai-1', 'ws-b')).toBeNull()
  })

  // bots-v4 B1: a personal agent has no bot; one bound before then doesn't speak its author's private words to others.
  it('leaves out a personal agent’s prompt, keeping its tool tree (which only narrows a run)', async () => {
    const config = { enabled_tools: ['search'] }
    const member = { ...MEMBER, agent: { system_prompt: 'Only mine', agent_config: config, workspace_id: 'ws-a', is_system: false, visibility: 'personal' } }
    const persona = await loadAgentPersona(fakeSupabase({ ai_team_member: [member] }), 'ai-1', 'ws-a')
    expect(persona?.agentSystemPrompt).toBeNull()
    expect(persona?.agentConfig).toEqual(config)
    expect(JSON.stringify(persona)).not.toContain('Only mine')
    // A shared agent's prompt is kept, as before.
    const shared = { ...MEMBER, agent: { ...member.agent, visibility: 'workspace' } }
    expect((await loadAgentPersona(fakeSupabase({ ai_team_member: [shared] }), 'ai-1', 'ws-a'))?.agentSystemPrompt).toBe('Only mine')
  })
})

describe('loadAgentPersonaFromRecipe — fenced to the run workspace', () => {
  const RECIPES = [
    { id: 'r-own', category: 'agent', name: 'Own', system_prompt: 'own', agent_config: null, workspace_id: 'ws-a', is_system: false },
    { id: 'r-sys', category: 'agent', name: 'Sys', system_prompt: 'sys', agent_config: null, workspace_id: null, is_system: true },
    { id: 'r-foreign', category: 'agent', name: 'Foreign', system_prompt: 'foreign', agent_config: null, workspace_id: 'ws-b', is_system: false },
  ]

  it("loads the workspace's own agent recipe and a system one", async () => {
    const db = fakeSupabase({ recipe: RECIPES })
    expect((await loadAgentPersonaFromRecipe(db, 'r-own', 'ws-a'))?.agentSystemPrompt).toBe('own')
    expect((await loadAgentPersonaFromRecipe(db, 'r-sys', 'ws-a'))?.agentSystemPrompt).toBe('sys')
  })

  it("refuses another workspace's agent recipe", async () => {
    expect(await loadAgentPersonaFromRecipe(fakeSupabase({ recipe: RECIPES }), 'r-foreign', 'ws-a')).toBeNull()
  })
})
