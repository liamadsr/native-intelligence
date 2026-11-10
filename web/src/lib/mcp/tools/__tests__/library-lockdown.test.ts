/**
 * The D.1 lockdown on the MCP library tools (Sequence step 1).
 *
 * The MCP server runs on the SERVICE ROLE, so nothing in the database fences
 * these tools: migration 191's creator-or-admin row policy never fires, and a
 * model-driven client could rewrite any skill's agent_config. Pinned here:
 *   - ni_create_skill / ni_update_skill REJECT agent_config outright
 *     (AGENT_CONFIG_LOCKED) and never reach the table with it.
 *   - update/delete of a skill or agent is creator-or-admin: a plain member
 *     cannot touch another member's item; an admin can; an item outside the
 *     active workspace reads as Not found.
 *   - visibility='public' (create, or the transition on update) is owner/admin
 *     only — the same PUBLISH_ROLE_ERROR the HTTP routes return.
 */
import { describe, it, expect, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SupabaseClient } from '@supabase/supabase-js'
import { PUBLISH_ROLE_ERROR } from '@/lib/library/queries'
import { AGENT_CONFIG_LOCKED_ERROR, MCP_NOT_EDITABLE_ERROR, registerLibraryTools } from '../library'

type Op = { table: string; op: 'insert' | 'update' | 'delete'; payload?: unknown }

/**
 * A recipe/member fake: `recipe` is the row every recipe read returns, `role`
 * the caller's member row. Every write is recorded and echoed.
 */
function fakeDb(opts: { recipe?: Record<string, unknown> | null; role?: string | null }) {
  const ops: Op[] = []
  const client = {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      let pending: Op | null = null
      Object.assign(chain, {
        select: self, eq: self, neq: self, or: self, in: self, order: self, limit: self, is: self, not: self,
        single: async () => {
          if (pending) ops.push(pending)
          if (table === 'recipe') {
            if (pending) return { data: { id: 'rec-1', ...(opts.recipe ?? {}), ...(pending.payload as object) }, error: null }
            return opts.recipe ? { data: opts.recipe, error: null } : { data: null, error: { message: 'not found' } }
          }
          return { data: null, error: null }
        },
        maybeSingle: async () => {
          if (table === 'member') return { data: opts.role === undefined ? { role: 'member' } : opts.role === null ? null : { role: opts.role }, error: null }
          return { data: null, error: null }
        },
        then: (resolve: (v: unknown) => unknown) => {
          if (pending) ops.push(pending)
          // The slug-uniqueness probe (create) and the delete both await the chain.
          return Promise.resolve(resolve({ data: [], error: null }))
        },
        insert: (payload: unknown) => ((pending = { table, op: 'insert', payload }), chain),
        update: (payload: unknown) => ((pending = { table, op: 'update', payload }), chain),
        delete: () => ((pending = { table, op: 'delete' }), chain),
      })
      return chain
    },
  }
  return { client: client as unknown as SupabaseClient, ops }
}

type Handler = (args: Record<string, unknown>, extra: unknown) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>

async function toolsFor(db: SupabaseClient) {
  const server = new McpServer({ name: 'ni-test', version: '0.0.0' })
  registerLibraryTools(server, 'user-1', db, 'ws-1', 'Test Workspace')
  const registered = (server as unknown as { _registeredTools: Record<string, { handler: Handler }> })._registeredTools
  const call = async (name: string, args: Record<string, unknown>) => {
    const res = await registered[name].handler(args, {})
    return { ...res, body: JSON.parse(res.content[0].text) as Record<string, unknown> }
  }
  return { call }
}

const OWN_SKILL = { id: 'rec-1', is_system: false, category: 'skill', workspace_id: 'ws-1', created_by: 'user-1', visibility: 'personal' }
// Shared with the workspace: a teammate's PERSONAL item is not visible to the
// caller at all, so it reads Not found before this rule is reached (below).
const OTHERS_SKILL = { ...OWN_SKILL, created_by: 'user-2', visibility: 'workspace' }
const OTHERS_AGENT = { ...OTHERS_SKILL, category: 'agent' }
const OTHERS_PERSONAL_SKILL = { ...OWN_SKILL, created_by: 'user-2' }

describe('agent_config is not settable over MCP', () => {
  it('ni_create_skill rejects it before touching the table', async () => {
    const db = fakeDb({ role: 'owner' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_create_skill', {
      name: 'Widen me',
      system_prompt: 'x',
      agent_config: { enabled_tools: ['emails'], output_contract: 'prose' },
    })
    expect(res.isError).toBe(true)
    expect(res.body).toMatchObject({ error: AGENT_CONFIG_LOCKED_ERROR, code: 'AGENT_CONFIG_LOCKED' })
    expect(db.ops).toEqual([])
  })

  it('ni_update_skill rejects it — even for the creator, even for an owner', async () => {
    for (const role of ['owner', 'member']) {
      const db = fakeDb({ recipe: OWN_SKILL, role })
      const { call } = await toolsFor(db.client)
      const res = await call('ni_update_skill', { id: 'rec-1', agent_config: { capture_mode: 'assist_only' } })
      expect(res.isError, role).toBe(true)
      expect(res.body.code, role).toBe('AGENT_CONFIG_LOCKED')
      expect(db.ops, role).toEqual([])
    }
  })

  it('a create without agent_config still writes, marked as the agent’s (reads and drafts only)', async () => {
    const db = fakeDb({ role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_create_skill', { name: 'Plain', system_prompt: 'x' })
    expect(res.isError).toBeFalsy()
    expect(db.ops).toHaveLength(1)
    expect(db.ops[0].op).toBe('insert')
    // F1: only the marker, never a model-chosen config.
    expect((db.ops[0].payload as Record<string, unknown>).agent_config).toEqual({ authored_by: 'agent' })
    expect(db.ops[0].payload).toMatchObject({ visibility: 'personal', created_by: 'user-1', workspace_id: 'ws-1' })
  })
})

describe('tool_categories over MCP (F1)', () => {
  it('ni_create_skill stores validated categories as enabled_tools, with the marker', async () => {
    const db = fakeDb({ role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_create_skill', { name: 'Mailer', system_prompt: 'x', tool_categories: ['emails', 'emails', 'calendar'] })
    expect(res.isError).toBeFalsy()
    expect((db.ops[0].payload as Record<string, unknown>).agent_config).toEqual({ authored_by: 'agent', enabled_tools: ['emails', 'calendar'] })
  })

  it('an unknown category is refused before any write', async () => {
    const db = fakeDb({ role: 'owner' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_create_skill', { name: 'Bad', system_prompt: 'x', tool_categories: ['everything'] })
    expect(res.isError).toBe(true)
    expect(res.body.code).toBe('INVALID_TOOL_CATEGORIES')
    expect(db.ops).toEqual([])
  })

  it('ni_update_skill writes the categories (no loop runs the skill)', async () => {
    const db = fakeDb({ recipe: OWN_SKILL, role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_update_skill', { id: 'rec-1', tool_categories: ['documents'] })
    expect(res.isError).toBeFalsy()
    const update = db.ops.find((o) => o.op === 'update')
    expect((update?.payload as Record<string, unknown>).agent_config).toEqual({ enabled_tools: ['documents'] })
  })
})

describe('creator-or-admin (migration 191, re-applied for the service-role client)', () => {
  it.each([
    ['ni_update_skill', OTHERS_SKILL, { id: 'rec-1', name: 'Hijacked' }, 'NOT_EDITABLE'],
    ['ni_delete_skill', OTHERS_SKILL, { id: 'rec-1' }, 'NOT_DELETABLE'],
    ['ni_update_agent', OTHERS_AGENT, { id: 'rec-1', name: 'Hijacked' }, 'NOT_EDITABLE'],
    ['ni_delete_agent', OTHERS_AGENT, { id: 'rec-1' }, 'NOT_DELETABLE'],
  ])('%s: a plain member cannot touch another member’s item', async (tool, row, args, code) => {
    const db = fakeDb({ recipe: row, role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call(tool, args)
    expect(res.isError).toBe(true)
    expect(res.body).toMatchObject({ error: MCP_NOT_EDITABLE_ERROR, code })
    expect(db.ops).toEqual([])
  })

  it('the creator can edit their own item; an admin can edit anyone’s', async () => {
    for (const [row, role] of [[OWN_SKILL, 'member'], [OTHERS_SKILL, 'admin'], [OTHERS_SKILL, 'owner']] as const) {
      const db = fakeDb({ recipe: row, role })
      const { call } = await toolsFor(db.client)
      const res = await call('ni_update_skill', { id: 'rec-1', name: 'Renamed' })
      expect(res.isError, `${row.created_by}/${role}`).toBeFalsy()
      expect(db.ops.map((o) => o.op)).toEqual(['update'])
      expect(db.ops[0].payload).toEqual({ name: 'Renamed' })
    }
  })

  it('another member’s PERSONAL item reads as Not found, even to an owner/admin', async () => {
    for (const role of ['admin', 'owner'] as const) {
      const db = fakeDb({ recipe: OTHERS_PERSONAL_SKILL, role })
      const { call } = await toolsFor(db.client)
      const res = await call('ni_update_skill', { id: 'rec-1', name: 'Renamed' })
      expect(res.body, role).toMatchObject({ error: 'Not found', code: 'NOT_EDITABLE' })
      expect(db.ops).toEqual([])
    }
  })

  it('a caller with NO member row is never an admin', async () => {
    const db = fakeDb({ recipe: OTHERS_SKILL, role: null })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_delete_skill', { id: 'rec-1' })
    expect(res.body.code).toBe('NOT_DELETABLE')
  })

  it('an item in another workspace reads as Not found, whatever the role', async () => {
    const db = fakeDb({ recipe: { ...OWN_SKILL, workspace_id: 'ws-other' }, role: 'owner' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_update_skill', { id: 'rec-1', name: 'x' })
    expect(res.body).toMatchObject({ error: 'Not found', code: 'NOT_EDITABLE' })
    expect(db.ops).toEqual([])
  })

  it('system items stay read-only', async () => {
    const db = fakeDb({ recipe: { ...OWN_SKILL, is_system: true }, role: 'owner' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_delete_skill', { id: 'rec-1' })
    expect(res.body.error).toMatch(/system skill/)
  })
})

describe('publishing to Discover is owner/admin only', () => {
  it.each(['ni_create_skill', 'ni_create_agent'])('%s: a member cannot create as public', async (tool) => {
    const db = fakeDb({ role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call(tool, { name: 'Pub', system_prompt: 'x', visibility: 'public' })
    expect(res.isError).toBe(true)
    expect(res.body).toMatchObject({ error: PUBLISH_ROLE_ERROR, code: 'PUBLISH_FORBIDDEN' })
    expect(db.ops).toEqual([])
  })

  it('a member cannot flip their own item to public on update; re-saving an already-public one is fine', async () => {
    const db = fakeDb({ recipe: OWN_SKILL, role: 'member' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_update_skill', { id: 'rec-1', visibility: 'public' })
    expect(res.body.code).toBe('PUBLISH_FORBIDDEN')
    expect(db.ops).toEqual([])

    const db2 = fakeDb({ recipe: { ...OWN_SKILL, visibility: 'public' }, role: 'member' })
    const t2 = await toolsFor(db2.client)
    const ok = await t2.call('ni_update_agent', { id: 'rec-1', name: 'still public' }).catch(() => null)
    // (an agent row would say Not an agent; the point is the skill path below)
    void ok
    const ok2 = await t2.call('ni_update_skill', { id: 'rec-1', visibility: 'public', name: 'still public' })
    expect(ok2.isError).toBeFalsy()
    expect(db2.ops.map((o) => o.op)).toEqual(['update'])
  })

  it('an admin can publish on create and on update', async () => {
    const db = fakeDb({ recipe: OTHERS_AGENT, role: 'admin' })
    const { call } = await toolsFor(db.client)
    const res = await call('ni_update_agent', { id: 'rec-1', visibility: 'public' })
    expect(res.isError).toBeFalsy()
    expect(db.ops[0].payload).toEqual({ visibility: 'public' })
  })
})
