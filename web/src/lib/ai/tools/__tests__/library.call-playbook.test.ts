/**
 * create_skill / update_skill `call_playbook`: the one agent_config key a
 * model may set. It marks the skill a live call playbook (the in-call copilot
 * lists it, src/lib/live-agent/call-playbooks.ts), refuses tool_categories,
 * and caps the body at the copilot's limit. Any member may save one.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'

vi.mock('@/lib/library/slug', () => ({
  normalizeSlug: (s: string) => s,
  ensureUniqueSlug: async (_s: unknown, _w: unknown, base: string) => base,
}))
vi.mock('@/lib/editions', () => ({
  featureGatedRecipeExclusions: () => [],
  resolveWorkspaceEdition: async () => 'default',
}))

import { createLibraryTools } from '../library'
import { MAX_PLAYBOOK_BODY_CHARS } from '@/lib/live-agent/call-playbooks'

const USER = 'user-1'
const WS = 'ws-1'
const SKILL = 'skill-1'
const EXEC = { toolCallId: 'c', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

type Row = Record<string, unknown>

/** A table-aware double: reads filter by eq, writes are captured. */
function db(seed: Record<string, Row[]>) {
  const writes: Array<{ table: string; op: 'insert' | 'update'; payload: Row }> = []
  const from = (table: string) => {
    const preds: Array<(r: Row) => boolean> = []
    let write: { op: 'insert' | 'update'; payload: Row } | null = null
    let proxy: Record<string, unknown>
    const rows = () => (seed[table] ?? []).filter((r) => preds.every((p) => p(r)))
    const settle = () => {
      if (write) {
        writes.push({ table, ...write })
        return { data: { id: SKILL, ...write.payload }, error: null }
      }
      return { data: rows(), error: null }
    }
    const self: Record<string, unknown> = {
      eq: (c: string, v: unknown) => ((preds.push((r) => r[c] === v)), proxy),
      insert: (p: Row) => ((write = { op: 'insert', payload: p }), proxy),
      update: (p: Row) => ((write = { op: 'update', payload: p }), proxy),
      single: async () => {
        const r = settle()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }
      },
      maybeSingle: async () => {
        const r = settle()
        return { data: Array.isArray(r.data) ? (r.data[0] ?? null) : r.data, error: null }
      },
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
    }
    proxy = new Proxy(self, { get: (t, p: string) => (p in t ? t[p] : () => proxy) })
    return proxy
  }
  return { client: { from } as never, writes }
}

const base = (extra: Record<string, Row[]> = {}, role = 'admin') => ({
  member: [{ user_id: USER, workspace_id: WS, role, id: 'm-1', workspace: { id: WS, name: 'WS' } }],
  recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', agent_config: { authored_by: 'agent' } }],
  ...extra,
})

const run = async (client: never, name: 'create_skill' | 'update_skill', args: Record<string, unknown>) =>
  (await (createLibraryTools(USER, client, WS)[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, EXEC))

const playbook = { name: 'Renewal call', slug: 'renewal-call', description: 'A renewal conversation with an existing customer.', system_prompt: 'You are beside the person on a renewal.' }

describe('create_skill call_playbook', () => {
  it('saves the flag beside the agent marker, and says where it shows up', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'create_skill', { ...playbook, call_playbook: true })
    expect(res.success).toBe(true)
    expect(writes[0].payload.agent_config).toEqual({ authored_by: 'agent', live_playbook: true })
    expect(writes[0].payload.slug).toBe('renewal-call')
    expect(String(res.message)).toContain('live call playbook "renewal-call"')
  })

  it('without it, an ordinary skill: no flag', async () => {
    const { client, writes } = db(base())
    await run(client, 'create_skill', playbook)
    expect(writes[0].payload.agent_config).toEqual({ authored_by: 'agent' })
  })

  it('refuses tool_categories: a playbook is instructions only', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'create_skill', { ...playbook, call_playbook: true, tool_categories: ['emails'] })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('takes no tools')
    expect(writes).toEqual([])
  })

  it('refuses a body over the copilot cap, nothing written', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'create_skill', { ...playbook, call_playbook: true, system_prompt: 'x'.repeat(MAX_PLAYBOOK_BODY_CHARS + 1) })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain(`capped at ${MAX_PLAYBOOK_BODY_CHARS}`)
    expect(writes).toEqual([])
  })

  it('any member may save one', async () => {
    const { client, writes } = db(base({}, 'member'))
    const res = await run(client, 'create_skill', { ...playbook, call_playbook: true })
    expect(res.success).toBe(true)
    expect(writes[0].payload.agent_config).toEqual({ authored_by: 'agent', live_playbook: true })
  })
})

describe('update_skill call_playbook', () => {
  it('turns a skill into a playbook, keeping the rest of its config', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'update_skill', { id: SKILL, call_playbook: true })
    expect(res.success).toBe(true)
    expect(writes.find((w) => w.op === 'update')!.payload.agent_config).toEqual({ authored_by: 'agent', live_playbook: true })
  })

  it('turns one off', async () => {
    const { client, writes } = db(
      base({ recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', agent_config: { authored_by: 'agent', live_playbook: true } }] }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, call_playbook: false })
    expect(res.success).toBe(true)
    expect(writes.find((w) => w.op === 'update')!.payload.agent_config).toEqual({ authored_by: 'agent', live_playbook: false })
  })

  it('caps a new body on a stored playbook even without the flag in the call', async () => {
    const { client, writes } = db(
      base({ recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', system_prompt: 'short', agent_config: { live_playbook: true } }] }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, system_prompt: 'x'.repeat(MAX_PLAYBOOK_BODY_CHARS + 1) })
    expect(res.success).toBe(false)
    expect(writes).toEqual([])
  })

  it('refuses turning a skill with an over-cap body into a playbook', async () => {
    const { client, writes } = db(
      base({ recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', system_prompt: 'x'.repeat(MAX_PLAYBOOK_BODY_CHARS + 1), agent_config: { authored_by: 'agent' } }] }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, call_playbook: true })
    expect(res.success).toBe(false)
    expect(writes).toEqual([])
  })

  it('refuses tool_categories on a stored playbook, even without the flag in the call', async () => {
    const { client, writes } = db(
      base({ recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', system_prompt: 'short', agent_config: { authored_by: 'agent', live_playbook: true } }] }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, tool_categories: ['emails'] })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('takes no tools')
    expect(writes).toEqual([])
  })

  it('a skill that becomes a playbook drops its tools', async () => {
    const { client, writes } = db(
      base({ recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', system_prompt: 'short', agent_config: { authored_by: 'agent', enabled_tools: ['emails'] } }] }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, call_playbook: true })
    expect(res.success).toBe(true)
    expect(writes.find((w) => w.op === 'update')!.payload.agent_config).toEqual({ authored_by: 'agent', live_playbook: true })
  })

  it('a long body on an ordinary skill is fine', async () => {
    const { client } = db(base())
    const res = await run(client, 'update_skill', { id: SKILL, system_prompt: 'x'.repeat(MAX_PLAYBOOK_BODY_CHARS + 1) })
    expect(res.success).toBe(true)
  })
})
