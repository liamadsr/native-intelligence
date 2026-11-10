/**
 * ni_create_agent with `bot_character` (bots-v3 Phase 6): the agent's
 * teammate is made with it, by the caller's role (a full teammate for an
 * owner, admin or lead; a work bot for anyone else). The MCP server is on the
 * service role, so these checks are the only fence. A face that isn't a
 * character or a built bot is refused before anything is written.
 */
import { describe, it, expect } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import { builtBotId } from '@/lib/bots/bot-faces'
import { registerLibraryTools } from '../library'

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

function world(role: string): FakeSupabase {
  const db = makeFakeSupabase()
  db.seed('recipe', [{ id: 'anchor', slug: 'loop-work-bot', category: 'agent', workspace_id: null, is_system: false }])
  db.seed('member', [{ id: 'm-1', workspace_id: 'ws-1', user_id: 'user-1', role }])
  db.seed('team', [{ id: 'team-1', workspace_id: 'ws-1', is_private: false, created_at: '2026-01-01T00:00:00Z' }])
  db.seed('team_member', [{ team_id: 'team-1', member_id: 'm-1', team_role: 'member' }])
  return db
}

/** The double's `.single()` answers a select with a list; the real client answers one row (fetchEditable reads one). */
function oneRowSingles(db: FakeSupabase): SupabaseClient {
  return {
    ...db,
    from: (table: string) => {
      const builder = db.from(table) as unknown as Record<string, unknown>
      const single = builder.single as () => Promise<{ data: unknown }>
      builder.single = async () => {
        const r = await single()
        return Array.isArray(r.data) ? { ...r, data: r.data[0] ?? null } : r
      }
      return builder
    },
  } as unknown as SupabaseClient
}

async function call(db: FakeSupabase, args: Record<string, unknown>, tool = 'ni_create_agent') {
  const server = new McpServer({ name: 'ni-test', version: '0.0.0' })
  registerLibraryTools(server, 'user-1', oneRowSingles(db), 'ws-1', 'Test Workspace')
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
  const res = await registered[tool].handler(args, {})
  return { ...res, body: JSON.parse(res.content[0].text) as Record<string, unknown> }
}

describe('ni_create_agent: give it a bot', () => {
  it('makes an admin’s agent a full teammate wearing the face', async () => {
    const db = world('admin')
    const res = await call(db, { name: 'Coach', system_prompt: 'x', visibility: 'workspace', bot_character: 'coach' })
    expect(res.isError).toBeFalsy()
    const json = JSON.stringify(res.body)
    expect(json).toContain('"bot_kind":"full"')
    const mate = db.rows('ai_team_member')[0]
    expect(mate).toMatchObject({ name: 'Coach', bot_character: 'coach', team_id: 'team-1' })
    expect(mate.fronts_only).not.toBe(true)
  })

  it('makes a plain member’s agent a work bot built on the agent, with a built face', async () => {
    const db = world('member')
    const built = builtBotId({ body: 'cloud', eyes: 'sparkle' })!
    await call(db, { name: 'Helper', system_prompt: 'x', visibility: 'workspace', bot_character: built })
    const agent = db.rows('recipe').find((r) => r.name === 'Helper')!
    expect(db.rows('ai_team_member')[0]).toMatchObject({ fronts_only: true, agent_recipe_id: agent.id, bot_character: built, autonomy: 'propose' })
  })

  it('refuses a face that is not a bot, and writes nothing', async () => {
    const db = world('admin')
    const res = await call(db, { name: 'Nope', system_prompt: 'x', bot_character: 'xzzaaaaa' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.body)).toContain('INVALID_BOT_CHARACTER')
    expect(db.rows('recipe').some((r) => r.name === 'Nope')).toBe(false)
    expect(db.rows('ai_team_member')).toHaveLength(0)
  })

  it('makes no teammate without a face', async () => {
    const db = world('admin')
    await call(db, { name: 'Bare', system_prompt: 'x' })
    expect(db.rows('ai_team_member')).toHaveLength(0)
  })
})

describe('ni_create_agent: every shared agent gets its bot (bots-v4 B1)', () => {
  it('a shared agent made with no face gets its bot on the first free face', async () => {
    const db = world('admin')
    const res = await call(db, { name: 'Coach', system_prompt: 'x', visibility: 'workspace' })
    expect(res.isError).toBeFalsy()
    const agent = db.rows('recipe').find((r) => r.name === 'Coach')!
    const [mate] = db.rows('ai_team_member')
    expect(mate).toMatchObject({ agent_recipe_id: agent.id, name: 'Coach' })
    expect(typeof mate.bot_character).toBe('string')
  })
})

describe('ni_update_agent: an agent with bots stays shared (bots-v4 B1)', () => {
  it('refuses making it personal while it has a bot, and changes nothing', async () => {
    const db = world('admin')
    await call(db, { name: 'Coach', system_prompt: 'x', visibility: 'workspace', bot_character: 'coach' })
    const agent = db.rows('recipe').find((r) => r.name === 'Coach')!
    const res = await call(db, { id: agent.id, visibility: 'personal' }, 'ni_update_agent')
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.body)).toContain('AGENT_HAS_BOTS')
    expect(db.rows('recipe').find((r) => r.id === agent.id)?.visibility).toBe('workspace')
  })
})

describe('ni_create_agent: a personal agent has no bot', () => {
  it('refuses a bot for a personal agent (the default), and writes nothing', async () => {
    const db = world('member')
    const res = await call(db, { name: 'Mine', system_prompt: 'x', bot_character: 'notes' })
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.body)).toContain('PERSONAL_AGENT_BOT')
    expect(db.rows('recipe').some((r) => r.name === 'Mine')).toBe(false)
    expect(db.rows('ai_team_member')).toHaveLength(0)
  })
})

describe('ni_delete_agent: an agent with a bot', () => {
  it('deletes a plain member’s agent and its bot with it', async () => {
    const db = world('member')
    await call(db, { name: 'Helper', system_prompt: 'x', visibility: 'workspace', bot_character: 'notes' })
    const agent = db.rows('recipe').find((r) => r.name === 'Helper')!
    const res = await call(db, { id: agent.id }, 'ni_delete_agent')
    expect(res.isError).toBeFalsy()
    expect(db.rows('ai_team_member').filter((r) => r.agent_recipe_id === agent.id)).toHaveLength(0)
    expect(db.rows('recipe').some((r) => r.id === agent.id)).toBe(false)
  })

  it('refuses, by name, while a full teammate is built on it', async () => {
    const db = world('admin')
    await call(db, { name: 'Coach', system_prompt: 'x', visibility: 'workspace', bot_character: 'coach' })
    const agent = db.rows('recipe').find((r) => r.name === 'Coach')!
    const res = await call(db, { id: agent.id }, 'ni_delete_agent')
    expect(res.isError).toBe(true)
    expect(JSON.stringify(res.body)).toContain('AGENT_FIELDED')
    expect(db.rows('recipe').some((r) => r.id === agent.id)).toBe(true)
  })
})

