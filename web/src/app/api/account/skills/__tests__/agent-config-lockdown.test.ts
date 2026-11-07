/**
 * agent_config on the library HTTP routes — the only writers left after the
 * D.1 lockdown (Sequence step 1). Skills and agents share the policy:
 *   - POST validates against the canonical schema: an unknown key or a bad
 *     contract value is a 400, and the stored value is the PARSED config.
 *   - PATCH validates without stripping: a contract key the client omits is
 *     carried over from the stored row; a contract CHANGE is 403 for a plain
 *     member and written for an owner/admin.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { AGENT_CONFIG_CONTRACT_LOCKED_ERROR } from '@/lib/library/agent-config'

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  requireWorkspaceMember: vi.fn(),
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspace: hoisted.requireWorkspace,
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

import { POST as postSkill } from '@/app/api/account/skills/route'
import { PATCH as patchSkill } from '@/app/api/account/skills/[id]/route'
import { POST as postAgent } from '@/app/api/account/agents/route'
import { PATCH as patchAgent } from '@/app/api/account/agents/[id]/route'

interface Captured {
  inserted?: Record<string, unknown>
  updated?: Record<string, unknown>
}

/** Chainable recipe fake: reads return `existing`; writes are captured and echoed. */
function fakeSupabase(existing: Record<string, unknown>, captured: Captured) {
  function chain(op: 'read' | 'insert' | 'update', payload?: Record<string, unknown>) {
    const b: Record<string, unknown> = {}
    const self = () => b
    Object.assign(b, {
      select: self, eq: self, or: self, not: self, neq: self, limit: self, order: self,
      single: async () => {
        if (op === 'insert') {
          captured.inserted = payload
          return { data: { id: 'rec-1', ...payload }, error: null }
        }
        if (op === 'update') {
          captured.updated = payload
          return { data: { ...existing, ...payload }, error: null }
        }
        return { data: existing, error: null }
      },
      // ensureUniqueSlug awaits the builder directly: no taken slugs.
      then: (resolve: (v: unknown) => unknown) => Promise.resolve(resolve({ data: [], error: null })),
    })
    return b
  }
  return {
    from: () => ({
      select: () => chain('read'),
      insert: (payload: Record<string, unknown>) => chain('insert', payload),
      update: (payload: Record<string, unknown>) => chain('update', payload),
    }),
  }
}

function authAs(role: string, existing: Record<string, unknown>, captured: Captured) {
  return {
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role },
    supabase: fakeSupabase(existing, captured),
  }
}

const params = Promise.resolve({ id: 'rec-1' })
const req = (body: Record<string, unknown>) => buildRequest({ body }) as unknown as NextRequest

const STORED_SKILL = {
  id: 'rec-1', category: 'skill', is_system: false, visibility: 'workspace', slug: 'triage',
  agent_config: { enabled_tools: ['actions'], output_contract: 'verdict', preconditions: ['has_actions'] },
}
// The member is the agent's author: since bots-v4 B1 the agents PATCH says the
// recipe's rule (its author, or an owner or admin) itself, before the lockdown.
const STORED_AGENT = {
  id: 'rec-1', category: 'agent', is_system: false, visibility: 'workspace', slug: null,
  workspace_id: 'ws-1', created_by: 'user-1',
  agent_config: { enabled_tools: ['captures'], capture_mode: 'assist_only' },
}

beforeEach(() => {
  hoisted.requireWorkspace.mockReset()
  hoisted.requireWorkspaceMember.mockReset()
})

describe('POST validates agent_config against the one schema', () => {
  it.each([
    ['skill', postSkill],
    ['agent', postAgent],
  ] as const)('%s: an unknown key is a 400 and nothing is written', async (_kind, handler) => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', {}, captured))
    const res = await handler(req({ name: 'X', agent_config: { enabled_tools: [], is_system: true } }))
    expect(res.status).toBe(400)
    expect((await readJson<{ error: string }>(res)).error).toMatch(/agent_config is invalid/)
    expect(captured.inserted).toBeUndefined()
  })

  it('a bad contract value is a 400', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', {}, captured))
    const res = await postSkill(req({ name: 'X', agent_config: { output_contract: 'json' } }))
    expect(res.status).toBe(400)
  })

  it('a valid config — contract keys included — is stored as parsed', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', {}, captured))
    const cfg = { enabled_tools: ['actions'], output_contract: 'verdict', preconditions: ['has_actions'], response_style: 'terse' }
    const res = await postSkill(req({ name: 'Triage', agent_config: cfg }))
    expect(res.status).toBe(200)
    expect(captured.inserted?.agent_config).toEqual(cfg)
  })
})

describe('PATCH — contract keys are carried over and locked to owners/admins', () => {
  it.each([
    ['skill', patchSkill, STORED_SKILL, { enabled_tools: ['captures'] }, { output_contract: 'verdict', preconditions: ['has_actions'] }],
    ['agent', patchAgent, STORED_AGENT, { enabled_tools: ['emails'] }, { capture_mode: 'assist_only' }],
  ] as const)('%s: a member re-sending only the tool selection keeps the stored contract keys', async (_k, handler, stored, incoming, carried) => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', stored, captured))
    const res = await handler(req({ agent_config: incoming }), { params })
    expect(res.status).toBe(200)
    expect(captured.updated?.agent_config).toEqual({ ...incoming, ...carried })
  })

  it.each([
    ['skill', patchSkill, STORED_SKILL, { enabled_tools: ['actions'], output_contract: 'prose' }],
    ['skill (preconditions)', patchSkill, STORED_SKILL, { enabled_tools: ['actions'], preconditions: [] }],
    ['agent', patchAgent, STORED_AGENT, { enabled_tools: ['captures'], capture_mode: 'full' }],
  ] as const)('%s: a member changing a contract key is a 403 and nothing is written', async (_k, handler, stored, incoming) => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', stored, captured))
    const res = await handler(req({ agent_config: incoming }), { params })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe(AGENT_CONFIG_CONTRACT_LOCKED_ERROR)
    expect(captured.updated).toBeUndefined()
  })

  it.each(['owner', 'admin'])('%s can change a contract key', async (role) => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs(role, STORED_SKILL, captured))
    const res = await patchSkill(req({ agent_config: { enabled_tools: ['actions'], output_contract: 'prose' } }), { params })
    expect(res.status).toBe(200)
    expect(captured.updated?.agent_config).toEqual({
      enabled_tools: ['actions'],
      output_contract: 'prose',
      preconditions: ['has_actions'],
    })
  })

  it('an unknown key is a 400 on PATCH too', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', STORED_AGENT, captured))
    const res = await patchAgent(req({ agent_config: { enabled_tools: [], model: 'x' } }), { params })
    expect(res.status).toBe(400)
    expect(captured.updated).toBeUndefined()
  })

  it('null clears the config — 403 for a member when contract keys were stored, 200 for an owner', async () => {
    const c1: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', STORED_SKILL, c1))
    expect((await patchSkill(req({ agent_config: null }), { params })).status).toBe(403)
    expect(c1.updated).toBeUndefined()

    const c2: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', STORED_SKILL, c2))
    expect((await patchSkill(req({ agent_config: null }), { params })).status).toBe(200)
    expect(c2.updated).toEqual({ agent_config: null })
  })
})
