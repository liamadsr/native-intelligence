/**
 * The cloud route's PRE-MODEL gates (LIVE-AGENT-DESIGN §2A/§2B): the route's
 * model call is an eve task session (createTaskSession), and every one of these
 * must fire BEFORE it — so no session is ever created (or billed) for a turn
 * that should never have run. `sessions` counts createTaskSession calls.
 *
 *   §2A  checkUsageLimits runs right after authenticateUser, before the request
 *        body is even parsed.
 *   §2B1 a batch (Reprocess) from a non-owner is refused 403 before any
 *        destructive delete and before the model.
 *   §2B4 seedSelfParticipant is best-effort on every turn: a failure is warned
 *        and swallowed, and the turn proceeds.
 *
 * Plus the scaffold-level half: the eve mount never re-implements or bypasses
 * the usage gate — it has no usage/plan logic of its own at all.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createFakeSupabase, meetingFixture, FIX, type FixtureOptions } from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  usageLimit: null as Response | null,
  seedError: null as Error | null,
  seedCalls: 0,
  sessions: 0,
}))

vi.mock('@/lib/ai/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auth')>()),
  authenticateUser: async () => ({ user: { id: 'user-owner-1', email: 'owner@example.com' }, supabase: h.client }),
  checkUsageLimits: async () => {
    if (h.usageLimit) throw h.usageLimit
  },
  logUsage: async () => {},
  extractGatewayCost: () => null,
}))
vi.mock('@/lib/workspace', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspace')>()),
  getCurrentWorkspaceId: async () => 'ws-1',
}))
vi.mock('@/lib/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin')>()),
  getServiceClient: () => h.client,
}))
vi.mock('@/lib/crm/contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/contacts')>()),
  seedSelfParticipant: async () => {
    h.seedCalls++
    if (h.seedError) throw h.seedError
  },
}))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()),
  syncProposalsCard: async () => {},
}))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: async () => {} }))
vi.mock('@/lib/eve/task-session', async () => {
  const { fakeTaskResponse, quietTurn } = await import('@/lib/live-agent/__tests__/helpers/fake-eve-turn')
  return {
    createTaskSession: async () => {
      h.sessions++
      return fakeTaskResponse(quietTurn())
    },
    cancelTaskSession: async () => true,
  }
})

const { POST } = await import('../route')

function useDb(opts: FixtureOptions = {}) {
  const fake = createFakeSupabase(meetingFixture(opts))
  h.client = fake.client
  return fake
}

function post(body: Record<string, unknown>) {
  return new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  h.usageLimit = null
  h.seedError = null
  h.seedCalls = 0
  h.sessions = 0
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'test-live-secret'
  useDb()
})

describe('§2A — the usage gate runs before the body is parsed', () => {
  it('a plan/credit breach returns the gate’s own Response; the body, the DB and eve are never touched', async () => {
    h.usageLimit = Response.json({ error: 'limit reached' }, { status: 402 })
    const fake = useDb()
    const req = post({ capture_id: FIX.captureId, recent_chunks: ['a'] })
    const json = vi.spyOn(req, 'json')
    const res = await POST(req)
    expect(res.status).toBe(402)
    expect(json).not.toHaveBeenCalled()
    expect(fake.log).toEqual([])
    expect(h.sessions).toBe(0)
  })

  it('the source keeps the usage check (opted in to the ChatGPT plan) immediately after authenticateUser and before req.json()', () => {
    const src = readFileSync(join(process.cwd(), 'src/app/api/ai/live-agent/route.ts'), 'utf8')
    const auth = src.indexOf('await authenticateUser(req)')
    const gate = src.indexOf('await usageOnPlan(user.id)')
    const body = src.indexOf('await req.json()')
    expect(auth).toBeGreaterThan(-1)
    expect(gate).toBeGreaterThan(auth)
    expect(body).toBeGreaterThan(gate)
  })
})

describe('§2B1 — a non-owner batch (Reprocess) is refused before anything destructive', () => {
  it('403, no pending-proposal delete, no eve session', async () => {
    const fake = useDb({ ownerUserId: 'someone-else' })
    const res = await POST(post({ capture_id: FIX.captureId, mode: 'batch' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'Only the capture owner can reprocess this meeting' })
    expect(fake.log.some((q) => q.table === 'proposed_change' && q.op === 'delete')).toBe(false)
    expect(h.sessions).toBe(0)
  })

  it('the owner’s batch proceeds (and clears pending first)', async () => {
    const fake = useDb()
    const res = await POST(post({ capture_id: FIX.captureId, mode: 'batch' }))
    expect(res.status).toBe(200)
    expect(fake.log.some((q) => q.table === 'proposed_change' && q.op === 'delete')).toBe(true)
    expect(h.sessions).toBe(1)
  })
})

describe('§2B4 — seedSelfParticipant is best-effort on every turn', () => {
  it.each([
    ['copilot', { recent_chunks: ['a'] }],
    ['notes', { recent_chunks: ['a'], live_role: 'notes' }],
    ['batch', { mode: 'batch' }],
  ])('%s: a seed failure is warned + swallowed and the turn still runs', async (_label, extra) => {
    h.seedError = new Error('seed exploded')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await POST(post({ capture_id: FIX.captureId, ...extra }))
    expect(res.status).toBe(200)
    expect(h.seedCalls).toBe(1)
    expect(h.sessions).toBe(1)
    expect(warn).toHaveBeenCalledWith('[live-agent] seedSelfParticipant failed:', h.seedError)
    warn.mockRestore()
  })
})

describe('the eve mount never re-implements the usage gate', () => {
  function sources(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__' || entry === '.eve' || entry === 'node_modules') continue
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) out.push(...sources(full))
      else if (entry.endsWith('.ts')) out.push(full)
    }
    return out
  }

  it('agents/live-agent has no usage/plan gating of its own (the gate lives in the route, before the token is minted)', () => {
    const files = sources(join(process.cwd(), 'agents/live-agent'))
    expect(files.length).toBeGreaterThan(5)
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      expect(src, f).not.toMatch(/checkUsageLimits|usage-limit|usageLimit/)
    }
    expect(files.some((f) => f.includes(`${join('agents', 'live-agent', 'hooks')}`))).toBe(false)
  })
})
