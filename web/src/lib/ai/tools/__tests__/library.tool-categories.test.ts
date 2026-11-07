/**
 * F1: create_skill / update_skill take `tool_categories` (validated against
 * the registry, stored as enabled_tools) and stamp every skill the agent
 * writes as authored_by 'agent'. update_skill refuses to WIDEN a skill's tools
 * while an enabled act-mode loop runs it; narrowing is always fine.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { z } from 'zod'

vi.mock('@/lib/library/slug', () => ({
  normalizeSlug: (s: string) => s,
  ensureUniqueSlug: async (_s: unknown, _w: unknown, base: string) => base,
}))
vi.mock('@/lib/editions', () => ({
  featureGatedRecipeExclusions: () => [],
  resolveWorkspaceEdition: async () => 'default',
}))

import { createLibraryTools } from '../library'

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

const base = (extra: Record<string, Row[]> = {}) => ({
  member: [{ user_id: USER, workspace_id: WS, role: 'member', id: 'm-1', workspace: { id: WS, name: 'WS' } }],
  recipe: [{ id: SKILL, is_system: false, category: 'skill', workspace_id: WS, created_by: USER, visibility: 'personal', agent_config: { authored_by: 'agent' } }],
  ...extra,
})

const run = async (client: never, name: 'create_skill' | 'update_skill', args: Record<string, unknown>) =>
  (await (createLibraryTools(USER, client, WS)[name] as unknown as { execute: (a: unknown, o: unknown) => Promise<Record<string, unknown>> }).execute(args, EXEC))

describe('create_skill', () => {
  it('without categories: the agent-authored marker only (reads and drafts)', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'create_skill', { name: 'Brief', description: 'd', system_prompt: 'p' })
    expect(res.success).toBe(true)
    expect(writes[0].payload.agent_config).toEqual({ authored_by: 'agent' })
  })

  it('with categories: validated, stored as enabled_tools', async () => {
    const { client, writes } = db(base())
    await run(client, 'create_skill', { name: 'Mailer', description: 'd', system_prompt: 'p', tool_categories: ['emails', 'documents'] })
    expect(writes[0].payload.agent_config).toEqual({ authored_by: 'agent', enabled_tools: ['emails', 'documents'] })
  })

  it('an unknown category is refused and nothing is written', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'create_skill', { name: 'Bad', description: 'd', system_prompt: 'p', tool_categories: ['all'] })
    expect(res).toMatchObject({ success: false })
    expect(String(res.error)).toContain('not a tool category')
    expect(writes).toEqual([])
  })

  it('the schema takes tool_categories and still refuses agent_config', () => {
    const schema = (createLibraryTools(USER, { from: vi.fn() } as never, WS).create_skill as unknown as { inputSchema: z.ZodTypeAny }).inputSchema
    expect(schema.safeParse({ name: 'S', description: 'd', system_prompt: 'p', tool_categories: ['emails'] }).success).toBe(true)
    expect(schema.safeParse({ name: 'S', description: 'd', system_prompt: 'p', agent_config: {} }).success).toBe(false)
  })
})

describe('update_skill tool_categories', () => {
  it('narrowing (or no loop running it) writes the categories, keeping the marker', async () => {
    const { client, writes } = db(base())
    const res = await run(client, 'update_skill', { id: SKILL, tool_categories: ['documents'] })
    expect(res.success).toBe(true)
    expect(writes.find((w) => w.op === 'update')!.payload.agent_config).toEqual({ authored_by: 'agent', enabled_tools: ['documents'] })
  })

  it('widening while an enabled act-mode loop runs the skill is refused, nothing written', async () => {
    const { client, writes } = db(
      base({
        flow: [{ id: 'f-1', name: 'Nightly', workspace_id: WS, enabled: true, actions: [{ type: 'run_skill', config: { skill_id: SKILL, mode: 'act' } }] }],
      }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, tool_categories: ['actions'] })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('"Nightly" runs it in act mode')
    expect(writes).toEqual([])
  })

  it('[] or null resets the skill to reads and drafts only (the agent-made default)', async () => {
    for (const reset of [[], null]) {
      const { client, writes } = db(base({ recipe: [{ ...base().recipe[0], agent_config: { enabled_tools: ['emails'], context_rules: ['x'] } }] }))
      const res = await run(client, 'update_skill', { id: SKILL, tool_categories: reset })
      expect(res.success, String(reset)).toBe(true)
      expect(writes.find((w) => w.op === 'update')!.payload.agent_config).toEqual({ context_rules: ['x'], authored_by: 'agent' })
    }
  })

  it("rewriting the prompt of a skill an enabled act-mode loop runs is refused; the same prompt, or no such loop, saves", async () => {
    const running = { flow: [{ id: 'f-1', name: 'Nightly', workspace_id: WS, enabled: true, actions: [{ type: 'run_skill', config: { skill_id: SKILL, mode: 'act' } }] }] }
    const withPrompt = (extra: Record<string, Row[]>) =>
      db(base({ recipe: [{ ...base().recipe[0], system_prompt: 'Old playbook' }], ...extra }))
    const refused = withPrompt(running)
    const res = await run(refused.client, 'update_skill', { id: SKILL, system_prompt: 'New playbook' })
    expect(res.success).toBe(false)
    expect(String(res.error)).toContain('"Nightly" runs this skill in act mode')
    expect(refused.writes).toEqual([])
    const same = withPrompt(running)
    expect((await run(same.client, 'update_skill', { id: SKILL, system_prompt: 'Old playbook', name: 'Renamed' })).success).toBe(true)
    const free = withPrompt({})
    expect((await run(free.client, 'update_skill', { id: SKILL, system_prompt: 'New playbook' })).success).toBe(true)
  })

  it('a report-mode or switched-off loop does not block a widening', async () => {
    const { client, writes } = db(
      base({
        flow: [
          { id: 'f-1', name: 'Report', workspace_id: WS, enabled: true, actions: [{ type: 'run_skill', config: { skill_id: SKILL, mode: 'report' } }] },
          { id: 'f-2', name: 'Off', workspace_id: WS, enabled: false, actions: [{ type: 'run_skill', config: { skill_id: SKILL, mode: 'act' } }] },
        ],
      }),
    )
    const res = await run(client, 'update_skill', { id: SKILL, tool_categories: ['actions'] })
    expect(res.success).toBe(true)
    expect(writes).toHaveLength(1)
  })
})
