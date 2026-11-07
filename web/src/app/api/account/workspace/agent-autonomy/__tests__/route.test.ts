/**
 * GET/PATCH /api/account/workspace/agent-autonomy (plan Part 5 row 9):
 *  - any member reads the policy (attempt by default), whether they may edit,
 *    their visible non-system teammates and each role's default and breaker;
 *  - only owner/admin writes; a bad field is a 400 naming it, never a silent
 *    fall back to 'propose';
 *  - into 'attempt' (back on from Off): the role teammates are seeded first,
 *    and a failed seed stores nothing; already 'attempt', stored or by
 *    default: no seed;
 *  - into 'off': the cancel fan-out for unattended origins, reported;
 *  - the stored per-role resumes survive every policy write, and other
 *    settings keys are untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  auth: null as unknown,
  stored: {} as Record<string, unknown>,
  written: null as Record<string, unknown> | null,
  updatedRows: [{ id: 'ws-1' }] as unknown[],
  seedResult: { data: 4 as unknown, error: null as { message: string } | null },
  calls: [] as string[],
  offCalls: [] as unknown[],
  offThrows: false,
  roster: [] as unknown[],
}))

vi.mock('@/lib/api-auth', () => ({ requireWorkspaceMember: async () => h.auth }))
vi.mock('@/lib/work/agent-roster', () => ({
  loadAgentRoster: async () => ({ roster: h.roster, error: null }),
}))
vi.mock('@/lib/agent-run/cancel-workspace-runs', () => ({
  requestWorkspaceAutonomyOff: async (args: unknown) => {
    h.calls.push('off')
    if (h.offThrows) throw new Error('inngest down')
    h.offCalls.push(args)
  },
}))

function client(kind: 'session' | 'service') {
  return {
    rpc: async (name: string, args: unknown) => {
      h.calls.push(`rpc:${name}:${JSON.stringify(args)}`)
      return h.seedResult
    },
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.maybeSingle = async () => ({ data: { settings: h.stored }, error: null })
      chain.update = (vals: { settings: Record<string, unknown> }) => ({
        eq: () => ({
          select: async () => {
            h.calls.push(`write:${kind}`)
            h.written = vals.settings
            return { data: h.updatedRows, error: null }
          },
        }),
      })
      return chain
    },
  }
}
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => client('service') }))

import { GET, PATCH } from '../route'

function asRole(role: string) {
  h.auth = { supabase: client('session'), user: { id: 'user-1' }, workspaceId: 'ws-1', member: { id: 'm-1', role } }
}
const patch = (policy: unknown) =>
  PATCH(new Request('http://x/api/account/workspace/agent-autonomy', { method: 'PATCH', body: JSON.stringify({ policy }) }) as never)

beforeEach(() => {
  asRole('admin')
  h.stored = { feature_overrides: { evals: 'on' } }
  h.written = null
  h.updatedRows = [{ id: 'ws-1' }]
  h.seedResult = { data: 4, error: null }
  h.calls = []
  h.offCalls = []
  h.offThrows = false
  h.roster = []
})

describe('GET', () => {
  it('the policy, who may edit, the teammates and each role’s default and breaker', async () => {
    asRole('member')
    h.stored = { agent_autonomy: { mode: 'attempt', max_attempts_per_day: 4, role_breaker_resumed_at: { writer: '2026-09-01T00:00:00Z' } } }
    const base = { workspace_id: 'ws-1', team_id: 't1', avatar_url: null, allowed_side_effects: ['read'], system_key: null, breaker: null }
    h.roster = [
      { ...base, id: 'triage', name: 'Triage', role: null, autonomy: 'propose', is_system: true, system_key: 'triage' },
      { ...base, id: 'quill', name: 'Quill', role: 'writer', autonomy: 'attempt', is_system: false, allowed_side_effects: ['read', 'internal-write'], breaker: { paused: true, window: 3 } },
      { ...base, id: 'wren', name: 'Wren', role: 'writer', autonomy: 'propose', is_system: false, breaker: { paused: true, window: 3 } },
    ]
    const body = await (await GET()).json()
    expect(body.policy.mode).toBe('attempt')
    expect(body.policy.max_attempts_per_day).toBe(4)
    expect(body).not.toHaveProperty('attempts_enabled')
    expect(body.can_edit).toBe(false)
    expect(body.teammates.map((t: { id: string }) => t.id)).toEqual(['quill', 'wren'])
    const writer = body.roles.find((r: { role: string }) => r.role === 'writer')
    expect(writer).toEqual({ role: 'writer', attemptable: true, default_teammate_id: 'quill', breaker: { paused: true, window: 3 }, resumed_at: '2026-09-01T00:00:00.000Z' })
    const developer = body.roles.find((r: { role: string }) => r.role === 'developer')
    expect(developer).toMatchObject({ attemptable: false, default_teammate_id: null, breaker: null })
  })
})

describe('GET: the default', () => {
  it('a workspace with no stored policy reads as attempting', async () => {
    h.stored = {}
    const body = await (await GET()).json()
    expect(body.policy.mode).toBe('attempt')
  })
})

describe('PATCH', () => {
  it('members and guests may not write', async () => {
    for (const role of ['member', 'guest']) {
      asRole(role)
      expect((await patch({ max_attempts_per_day: 3 })).status).toBe(403)
    }
    expect(h.written).toBeNull()
  })

  it('a bad field is a 400 naming it, and nothing is written', async () => {
    for (const bad of [{ mode: 'yolo' }, { max_attempts_per_day: -1 }, { max_attempts_per_day: 1.5 }, { max_attempts_per_capture: '2' }, { role_breaker_quiet_days: 91 }]) {
      const res = await patch(bad)
      expect(res.status, JSON.stringify(bad)).toBe(400)
      expect((await res.json()).error).toMatch(/mode|max_attempts|role_breaker/)
    }
    expect((await patch(null)).status).toBe(400)
    expect(h.written).toBeNull()
  })

  it('merges a number over the stored policy, keeps the resumes and every other settings key', async () => {
    h.stored = {
      feature_overrides: { evals: 'on' },
      agent_autonomy: { mode: 'propose', max_attempts_per_capture: 2, role_breaker_resumed_at: { writer: '2026-09-01T00:00:00.000Z' } },
    }
    const res = await patch({ max_attempts_per_day: 7, role_breaker_resumed_at: { writer: '1999-01-01T00:00:00.000Z' } })
    expect(res.status).toBe(200)
    expect(h.written?.feature_overrides).toEqual({ evals: 'on' })
    expect(h.written?.agent_autonomy).toMatchObject({
      mode: 'propose',
      max_attempts_per_capture: 2,
      max_attempts_per_day: 7,
      role_breaker_resumed_at: { writer: '2026-09-01T00:00:00.000Z' },
    })
    // The write goes through the service client (workspace UPDATE is owner-only under RLS).
    expect(h.calls).toEqual(['write:service'])
  })

  it('into attempt from off: seeds the role teammates first, as the person who flipped it', async () => {
    h.stored = { agent_autonomy: { mode: 'off' } }
    const res = await patch({ mode: 'attempt' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ policy: { mode: 'attempt' }, seeded: 4, stopped: null })
    expect(h.calls).toEqual([
      `rpc:seed_role_teammates:${JSON.stringify({ p_workspace_id: 'ws-1', p_created_by: 'user-1' })}`,
      'write:service',
    ])
  })

  it('a failed seed stores nothing: the workspace does not reach attempt without its teammates', async () => {
    h.stored = { agent_autonomy: { mode: 'off' } }
    h.seedResult = { data: null, error: { message: 'boom' } }
    const res = await patch({ mode: 'attempt' })
    expect(res.status).toBe(500)
    expect(h.written).toBeNull()
  })

  it('already attempting: no seed (a deleted teammate is not brought back by an unrelated save)', async () => {
    h.stored = { agent_autonomy: { mode: 'attempt' } }
    await patch({ mode: 'attempt', max_attempts_per_day: 3 })
    expect(h.calls).toEqual(['write:service'])
    // Unset is the default ('attempt'): the gate seeds on first need, not this save.
    h.calls = []
    h.stored = { feature_overrides: { evals: 'on' } }
    await patch({ mode: 'attempt' })
    expect(h.calls).toEqual(['write:service'])
  })

  it('into off: stops the unattended runs already going; a failed send is reported, the mode still stored', async () => {
    h.stored = { agent_autonomy: { mode: 'attempt' } }
    const res = await patch({ mode: 'off' })
    expect(await res.json()).toMatchObject({ policy: { mode: 'off' }, stopped: 'requested' })
    expect(h.offCalls).toEqual([{ workspaceId: 'ws-1', origins: ['attempt', 'delegation', 'chat'] }])
    expect(h.calls).toEqual(['write:service', 'off'])

    h.offThrows = true
    h.stored = { agent_autonomy: { mode: 'propose' } }
    const failed = await patch({ mode: 'off' })
    expect(failed.status).toBe(200)
    expect((await failed.json()).stopped).toBe('failed')
    expect((h.written?.agent_autonomy as { mode: string }).mode).toBe('off')
  })

  it('already off: no second fan-out', async () => {
    h.stored = { agent_autonomy: { mode: 'off' } }
    await patch({ mode: 'off' })
    expect(h.offCalls).toEqual([])
  })

  it('a 0-row write is a 500, not a silent success', async () => {
    h.updatedRows = []
    expect((await patch({ max_attempts_per_day: 3 })).status).toBe(500)
  })
})
