/**
 * Tests for the publish-to-Discover role gate on the agent routes.
 *
 * Migration 191 opened recipe writes to every workspace member so they can
 * author their own agents/skills — but visibility='public' publishes an item to
 * EVERY Native Intelligence user, platform-wide. RLS can't tell "publish" from an ordinary
 * write, so the routes gate it: only owner/admin may CREATE-as-public (POST) or
 * TRANSITION a non-public row to public (PATCH). Non-public writes are unaffected.
 *
 * We assert the 403 (with the exact message the client surfaces in its toast) and
 * that a member CAN still create a non-public agent. The skills routes share the
 * same helper (canPublishPublic) and guard shape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { NextRequest } from 'next/server'
import { buildRequest, readJson } from '@/test/integration'
import { PUBLISH_ROLE_ERROR } from '@/lib/library/queries'
import { PERSONAL_WITH_BOTS_ERROR } from '@/lib/library/agent-bot'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'

const hoisted = vi.hoisted(() => ({
  requireWorkspaceMember: vi.fn(),
  service: null as unknown as FakeSupabase,
}))

vi.mock('@/lib/api-auth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-auth')>()),
  requireWorkspaceMember: hoisted.requireWorkspaceMember,
}))
// The service client: an agent's bots (made with it, and read before it may go personal).
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => hoisted.service }))

// Analytics is fire-and-forget; stub so the happy path doesn't touch PostHog.
vi.mock('@/lib/posthog', () => ({ trackServerEvent: vi.fn() }))

import { POST } from '@/app/api/account/agents/route'
import { PATCH } from '@/app/api/account/agents/[id]/route'

/** A chainable Supabase fake whose terminal `.single()` resolves to `result`. */
function chain(result: unknown) {
  const handler: ProxyHandler<object> = {
    get(_t, prop: string) {
      if (prop === 'single' || prop === 'maybeSingle') return () => Promise.resolve(result)
      if (prop === 'then') return undefined
      return () => new Proxy({}, handler)
    },
  }
  return new Proxy({}, handler)
}

function authAs(role: string, opts: { existingVisibility?: string; insertResult?: unknown } = {}) {
  return {
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role },
    supabase: {
      from: () =>
        chain({
          data: opts.insertResult ?? {
            id: 'rec-1',
            name: 'Planner',
            visibility: 'workspace',
            is_system: false,
            category: 'agent',
            created_by: 'user-1',
            workspace_id: 'ws-1',
          },
          error: null,
        }),
    },
  }
}

const params = Promise.resolve({ id: 'rec-1' })

beforeEach(() => {
  hoisted.requireWorkspaceMember.mockReset()
  hoisted.service = makeFakeSupabase()
})

describe('agent publish role gate', () => {
  it('POST → 403 when a non-admin member creates with visibility=public', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member'))
    const res = await POST(
      buildRequest({ body: { name: 'Public Agent', visibility: 'public' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(403)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe(PUBLISH_ROLE_ERROR)
  })

  it('POST → allows a non-admin member to create a non-public agent', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member'))
    const res = await POST(
      buildRequest({ body: { name: 'Team Agent', visibility: 'workspace' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
  })

  it('POST → allows an owner to create a public agent', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(
      authAs('owner', { insertResult: { id: 'rec-1', name: 'Planner', visibility: 'public' } }),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Public Agent', visibility: 'public' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
  })

  it('PATCH → 403 when a non-admin transitions a workspace agent to public', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(
      authAs('member', {
        insertResult: { is_system: false, category: 'agent', visibility: 'workspace', created_by: 'user-1', workspace_id: 'ws-1' },
      }),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { visibility: 'public' } }) as unknown as NextRequest,
      { params },
    )
    expect(res.status).toBe(403)
    const body = await readJson<{ error: string }>(res)
    expect(body.error).toBe(PUBLISH_ROLE_ERROR)
  })

  it('PATCH → a member re-saving an ALREADY-public agent is not blocked by the gate', async () => {
    // existing.visibility === 'public' → no transition, so the gate doesn't fire.
    hoisted.requireWorkspaceMember.mockResolvedValue(
      authAs('member', {
        insertResult: { is_system: false, category: 'agent', visibility: 'public', created_by: 'user-1', workspace_id: 'ws-1' },
      }),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { visibility: 'public', name: 'Renamed' } }) as unknown as NextRequest,
      { params },
    )
    // Not a 403 — the update proceeds (the fake returns the row).
    expect(res.status).toBe(200)
  })
})

/**
 * Who may edit an agent (bots-v4 B1): the recipe's rule, said plainly. Its
 * instructions and tools are shared by every bot on it (decision 11), so only
 * its author or a workspace owner or admin changes them; and an agent with
 * bots stays shared (a personal agent has no bot).
 */
describe('agent edit rules', () => {
  const agentRow = (over: Record<string, unknown> = {}) => ({
    is_system: false,
    category: 'agent',
    visibility: 'workspace',
    created_by: 'user-author',
    workspace_id: 'ws-1',
    ...over,
  })

  it('PATCH → a member who isn’t the agent’s author gets a 403 that says who may', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('member', { insertResult: agentRow() }))
    const res = await PATCH(buildRequest({ method: 'PATCH', body: { system_prompt: 'Be ruthless.' } }) as unknown as NextRequest, { params })
    expect(res.status).toBe(403)
    expect((await readJson<{ error: string }>(res)).error).toBe('Only the persona’s author, or a workspace owner or admin, can change it.')
  })

  it('PATCH → an owner may edit anyone’s agent', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', { insertResult: agentRow() }))
    const res = await PATCH(buildRequest({ method: 'PATCH', body: { system_prompt: 'Be kind.' } }) as unknown as NextRequest, { params })
    expect(res.status).toBe(200)
  })

  it('PATCH → an agent with bots stays shared: personal is a 409', async () => {
    hoisted.service.seed('ai_team_member', [{ id: 'riley', workspace_id: 'ws-1', agent_recipe_id: 'rec-1', is_system: false }])
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', { insertResult: agentRow() }))
    const res = await PATCH(buildRequest({ method: 'PATCH', body: { visibility: 'personal' } }) as unknown as NextRequest, { params })
    expect(res.status).toBe(409)
    expect(await readJson(res)).toMatchObject({ error: PERSONAL_WITH_BOTS_ERROR, code: 'AGENT_HAS_BOTS' })
  })

  it('PATCH → an agent with no bot may go personal', async () => {
    hoisted.requireWorkspaceMember.mockResolvedValue(authAs('owner', { insertResult: agentRow() }))
    const res = await PATCH(buildRequest({ method: 'PATCH', body: { visibility: 'personal' } }) as unknown as NextRequest, { params })
    expect(res.status).toBe(200)
  })
})

/**
 * Slug hygiene on the agent routes. Agents aren't slash-invoked, so the editor
 * never sends a slug — but the routes honor one DEFENSIVELY if supplied (a
 * forked agent that carried a slug, an API caller), normalizing + de-colliding
 * it exactly like skills. Needs a slug-aware Supabase fake (the `chain()` proxy
 * above can't serve `ensureUniqueSlug`'s awaited namespace read).
 */
interface Captured {
  inserted?: Record<string, unknown>
  updated?: Record<string, unknown>
}

function slugSupabase(
  taken: { id: string; slug: string | null }[],
  existing: Record<string, unknown>,
  captured: Captured,
) {
  function builder(op: 'read' | 'insert' | 'update', payload?: Record<string, unknown>) {
    let neqId: string | undefined
    const b: any = {
      select: () => b,
      eq: () => b,
      or: () => b,
      not: () => b,
      limit: () => b,
      neq: (_col: string, val: string) => {
        neqId = val
        return b
      },
      single: () => {
        if (op === 'insert') {
          captured.inserted = payload
          return Promise.resolve({ data: { ...existing, ...payload }, error: null })
        }
        if (op === 'update') {
          captured.updated = payload
          return Promise.resolve({ data: { ...existing, ...payload }, error: null })
        }
        return Promise.resolve({ data: existing, error: null })
      },
      then: (resolve: (v: { data: unknown }) => unknown) => {
        const data = neqId ? taken.filter((r) => r.id !== neqId) : taken
        return Promise.resolve(resolve({ data }))
      },
    }
    return b
  }
  return {
    from: () => ({
      select: () => builder('read').select(),
      insert: (payload: Record<string, unknown>) => builder('insert', payload),
      update: (payload: Record<string, unknown>) => builder('update', payload),
    }),
  }
}

function slugAuth(
  taken: { id: string; slug: string | null }[],
  existing: Record<string, unknown>,
  captured: Captured,
) {
  return {
    user: { id: 'user-1', email: 'm@dial8.ai' },
    workspaceId: 'ws-1',
    member: { id: 'mem-1', role: 'owner' },
    supabase: slugSupabase(taken, existing, captured),
  }
}

describe('agent slug hygiene', () => {
  it('POST → does not set a slug when none is supplied (agents are not slash-invoked)', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      slugAuth([], { id: 'rec-1', category: 'agent', visibility: 'workspace' }, captured),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Planner Agent' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(captured.inserted && 'slug' in captured.inserted).toBe(false)
  })

  it('POST → normalizes and de-collides a supplied slug', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      slugAuth(
        [{ id: 'other', slug: 'my-agent' }],
        { id: 'rec-1', category: 'agent', visibility: 'workspace' },
        captured,
      ),
    )
    const res = await POST(
      buildRequest({ body: { name: 'Anything', slug: 'My Agent!' } }) as unknown as NextRequest,
    )
    expect(res.status).toBe(200)
    expect(captured.inserted?.slug).toBe('my-agent-2')
  })

  it('PATCH → suffixes when edited onto a slug another row holds', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      slugAuth(
        [
          { id: 'rec-1', slug: 'planner' },
          { id: 'sibling', slug: 'taken' },
        ],
        { id: 'rec-1', is_system: false, category: 'agent', visibility: 'workspace', slug: 'planner', workspace_id: 'ws-1' },
        captured,
      ),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { slug: 'taken' } }) as unknown as NextRequest,
      { params },
    )
    expect(res.status).toBe(200)
    expect(captured.updated?.slug).toBe('taken-2')
  })

  it('PATCH → leaves an unchanged slug untouched', async () => {
    const captured: Captured = {}
    hoisted.requireWorkspaceMember.mockResolvedValue(
      slugAuth(
        [{ id: 'rec-1', slug: 'planner' }],
        { id: 'rec-1', is_system: false, category: 'agent', visibility: 'workspace', slug: 'planner', workspace_id: 'ws-1' },
        captured,
      ),
    )
    const res = await PATCH(
      buildRequest({ method: 'PATCH', body: { slug: 'planner', name: 'Renamed' } }) as unknown as NextRequest,
      { params },
    )
    expect(res.status).toBe(200)
    expect(captured.updated && 'slug' in captured.updated).toBe(false)
  })
})
