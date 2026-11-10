/**
 * POST /api/account/agents/[id]/copy (bots-v4 B1, "Make a copy for this
 * bot"): a copy of a workspace or built-in agent, authored by the caller,
 * shared with the workspace, `forked_from` the original, with no slug and no
 * bot of its own (the editor points the bot it's for at it next).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const h = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspaceMember: async () => ({ supabase: h.db, user: { id: 'user-lead', email: 'l@dial8.ai' }, workspaceId: 'ws-1', member: { id: 'm-lead' } }),
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

const { POST } = await import('../route')

beforeEach(() => {
  h.db = makeFakeSupabase({ project: true })
  h.db.seed('recipe', [
    {
      id: 'researcher',
      name: 'Researcher',
      slug: 'role-researcher',
      category: 'agent',
      workspace_id: 'ws-1',
      is_system: false,
      visibility: 'workspace',
      created_by: 'user-owner',
      icon: '🔎',
      color: '#0ea5e9',
      description: 'Finds out what is true',
      system_prompt: 'You research.',
      agent_config: { enabled_tools: ['search'] },
      model: null,
    },
    { id: 'meeting', name: 'Meeting', category: 'agent', workspace_id: null, is_system: true, visibility: 'workspace', system_prompt: 'You sit in.' },
    { id: 'anchor', name: 'Work bot', category: 'agent', workspace_id: null, is_system: false, visibility: 'personal', system_prompt: 'Identity anchor' },
    { id: 'foreign', name: 'Elsewhere', category: 'agent', workspace_id: 'ws-2', is_system: false, visibility: 'public', system_prompt: 'x' },
  ])
})

const copy = (id: string, body: unknown = {}) =>
  POST(buildRequest({ url: `https://nativeintelligence.dev/api/account/agents/${id}/copy`, method: 'POST', body }) as unknown as NextRequest, {
    params: Promise.resolve({ id }),
  })

describe('POST /api/account/agents/[id]/copy', () => {
  it('copies the agent for the caller, shared, forked from the original, with no slug and no bot', async () => {
    const res = await copy('researcher', { name: 'Researcher for Riley' })
    expect(res.status).toBe(201)
    const { agent } = await readJson<{ agent: { id: string } }>(res)
    const row = h.db.rows('recipe').find((r) => r.id === agent.id)!
    expect(row).toMatchObject({
      name: 'Researcher for Riley',
      workspace_id: 'ws-1',
      category: 'agent',
      is_system: false,
      visibility: 'workspace',
      created_by: 'user-lead',
      forked_from: 'researcher',
      system_prompt: 'You research.',
      description: 'Finds out what is true',
      agent_config: { enabled_tools: ['search'] },
    })
    // A role persona's slug stays its own.
    expect(row.slug).toBeUndefined()
    expect(h.db.rows('ai_team_member')).toHaveLength(0)
  })

  it('carries only what an agent_config may hold: a key only a seed knows stays behind', async () => {
    h.db.rows('recipe').find((r) => r.id === 'meeting')!.agent_config = { enabled_tools: ['search'], preferred_tools: ['notes'] }
    const res = await copy('meeting')
    expect(res.status).toBe(201)
    const { agent } = await readJson<{ agent: { id: string } }>(res)
    expect(h.db.rows('recipe').find((r) => r.id === agent.id)!.agent_config).toEqual({ enabled_tools: ['search'] })
  })

  it('refuses to copy a config that doesn’t parse, making nothing', async () => {
    h.db.rows('recipe').find((r) => r.id === 'researcher')!.agent_config = { enabled_tools: 'search' }
    const before = h.db.rows('recipe').length
    const res = await copy('researcher')
    expect(res.status).toBe(400)
    expect(await readJson(res)).toMatchObject({ code: 'AGENT_CONFIG_INVALID' })
    expect(h.db.rows('recipe')).toHaveLength(before)
  })

  it('copies a built-in agent too, named "(copy)" by default', async () => {
    const res = await copy('meeting')
    expect(res.status).toBe(201)
    const { agent } = await readJson<{ agent: { id: string } }>(res)
    expect(h.db.rows('recipe').find((r) => r.id === agent.id)).toMatchObject({ name: 'Meeting (copy)', forked_from: 'meeting', is_system: false })
  })

  it('never copies an anchor or another workspace’s agent', async () => {
    expect((await copy('anchor')).status).toBe(404)
    expect((await copy('foreign')).status).toBe(404)
    expect((await copy('missing')).status).toBe(404)
  })
})
