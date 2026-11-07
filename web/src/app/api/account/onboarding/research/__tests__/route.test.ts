import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for POST /api/account/onboarding/research — the kickoff route for the
 * Phase-1 onboarding research agent.
 *
 * Covered: 401 when unauthenticated; idempotence (existing sessionId returned,
 * no new eve session started); the CLAIM-BEFORE-CREATE ordering (an atomic claim
 * placeholder is written before any eve session is created); a lost claim
 * returns the winner's state and starts NO second session; seedDefaultLoops
 * invoked with the right scope on the fresh path; the happy path starts an eve
 * session, persists running state via the merge RPC, and returns { sessionId };
 * an eve-start failure releases the claim to a re-claimable `error` state; and
 * a STALE `starting` claim (owner died mid-kickoff) is re-claimed while a fresh
 * one is treated as an in-flight peer.
 */

const hoisted = vi.hoisted(() => ({
  requireWorkspace: vi.fn(),
  getServiceClient: vi.fn(),
  seedDefaultLoops: vi.fn(async () => ({ seeded: [], skippedMissingSkill: [], alreadyPresent: [] })),
  clientFetch: vi.fn(),
  clientCtor: vi.fn(),
  mirrorStarted: vi.fn(async () => ({})),
  // Whether the caller is on their own ChatGPT plan (the free tier).
  chatgptPlanFor: vi.fn(async (_userId: unknown, _opts?: unknown) => false),
}))

vi.mock('@/lib/api-auth', () => ({
  requireWorkspace: hoisted.requireWorkspace,
}))
vi.mock('@/lib/admin', () => ({
  getServiceClient: hoisted.getServiceClient,
}))
vi.mock('@/lib/flows/seed-default-loops', () => ({
  seedDefaultLoops: hoisted.seedDefaultLoops,
}))
// The run's Activity row (Sequence row 6); the mirror's own suite covers what
// it writes. Here: started once, only on the path that started a session.
vi.mock('@/lib/work/onboarding-research-mirror', () => ({
  mirrorOnboardingResearchStarted: hoisted.mirrorStarted,
}))
vi.mock('eve/client', () => ({
  Client: class {
    constructor(opts: unknown) {
      hoisted.clientCtor(opts)
    }
    fetch(path: string, init?: RequestInit) {
      return hoisted.clientFetch(path, init)
    }
  },
}))
vi.mock('@/lib/chatgpt/plan-route', () => ({ chatgptPlanFor: hoisted.chatgptPlanFor }))
vi.mock('@/lib/api-errors', () => ({
  serverError: (msg: string) => new Response(JSON.stringify({ error: msg }), { status: 500 }),
  forbidden: (msg = 'Forbidden') => new Response(JSON.stringify({ error: msg }), { status: 403 }),
}))

import { POST } from '../route'

// ── Service-role fake: the route reads member.onboarding_progress and CAS-writes
//    the `starting` claim placeholder through this client. It models one member
//    row; the CAS UPDATE lands unless `claimWins` is forced false (loser path).
function makeService(opts: {
  initialResearch?: Record<string, unknown> | null
  claimWins?: boolean
  // The research state a LOSER re-reads (what the winner wrote). Defaults to a
  // running run so the loser reports it.
  winnerResearch?: Record<string, unknown>
}) {
  const claimWins = opts.claimWins ?? true
  const state = {
    research: opts.initialResearch ?? null,
  }
  const updateCalls: unknown[] = []

  const service = {
    from(_table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return {
                    maybeSingle: async () => ({
                      data: {
                        onboarding_progress: state.research
                          ? { research: state.research }
                          : {},
                      },
                      error: null,
                    }),
                  }
                },
              }
            },
          }
        },
        update(payload: unknown) {
          updateCalls.push(payload)
          // update(...).eq(user).eq(ws).is|eq(sessionId).is|eq(claimNonce).select()
          const terminal = {
            select: async () => {
              if (claimWins) {
                // Winner: the claim landed; a later re-read would see it.
                state.research = (payload as { onboarding_progress: { research: Record<string, unknown> } })
                  .onboarding_progress.research
                return { data: [{ user_id: 'user-1' }], error: null }
              }
              // Loser: zero rows; the route re-reads the winner's state.
              state.research = opts.winnerResearch ?? { status: 'running', claimNonce: 'other' }
              return { data: [], error: null }
            },
          }
          const chain2 = { is: () => terminal, eq: () => terminal }
          const chain1 = { is: () => chain2, eq: () => chain2 }
          return { eq: () => ({ eq: () => chain1 }) }
        },
      }
    },
  }
  return { service, updateCalls, state }
}

// ── Supabase (user-JWT) stub the route drives: member/workspace selects + rpc. ──
function makeSupabase(opts: {
  member?: Record<string, unknown> | null
  workspaceName?: string | null
  rpcError?: { message: string } | null
}) {
  const rpc = vi.fn(async () => ({ data: null, error: opts.rpcError ?? null }))
  // The owner-only gate reads member.role + onboarding_completed_at. Every
  // fixture here models a genuine new-signup OWNER unless it explicitly sets
  // those fields, so default-fill them (role 'owner', onboarding not completed)
  // to keep the happy paths passing the gate. The forbidden-case tests override.
  const member =
    opts.member == null
      ? opts.member
      : {
          role: 'owner',
          onboarding_completed_at: null,
          ...opts.member,
        }
  const supabase = {
    from(table: string) {
      return {
        select() {
          return {
            eq() {
              return {
                eq() {
                  return { maybeSingle: async () => ({ data: member, error: null }) }
                },
                maybeSingle: async () => ({
                  data: table === 'workspace' ? { name: opts.workspaceName ?? null } : null,
                  error: null,
                }),
              }
            },
          }
        },
      }
    },
    rpc,
  }
  return { supabase, rpc }
}

function req() {
  return new Request('https://app.dial8.ai/api/account/onboarding/research', {
    method: 'POST',
    headers: { cookie: 'sb-access-token=abc', 'x-forwarded-host': 'app.dial8.ai', 'x-forwarded-proto': 'https' },
  }) as never
}

/** A kickoff request carrying an optional priming body ({ role, focus }). */
function reqWithBody(body: unknown) {
  return new Request('https://app.dial8.ai/api/account/onboarding/research', {
    method: 'POST',
    headers: {
      cookie: 'sb-access-token=abc',
      'content-type': 'application/json',
      'x-forwarded-host': 'app.dial8.ai',
      'x-forwarded-proto': 'https',
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }) as never
}

beforeEach(() => {
  vi.clearAllMocks()
  // The secret the kickoff vouches for a session create with (the researcher
  // refuses any other create), and the deployment origin it dispatches to.
  vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', 'agent-run-secret')
  vi.stubEnv('VERCEL_URL', 'app.dial8.ai')
  hoisted.clientFetch.mockResolvedValue({ ok: true, json: async () => ({ ok: true, sessionId: 'wrun_NEW' }) })
  hoisted.getServiceClient.mockReturnValue(makeService({ initialResearch: null }).service)
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('POST /api/account/onboarding/research', () => {
  it('401s when unauthenticated', async () => {
    hoisted.requireWorkspace.mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.seedDefaultLoops).not.toHaveBeenCalled()
  })

  it('is idempotent: returns the existing sessionId without starting a new session', async () => {
    const { supabase } = makeSupabase({
      member: {
        display_name: 'Liam',
        onboarding_progress: { research: { sessionId: 'wrun_EXISTING', status: 'running' } },
      },
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ sessionId: 'wrun_EXISTING', status: 'running' })
    // No new run, no seeding on the idempotent short-circuit.
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.seedDefaultLoops).not.toHaveBeenCalled()
    // …and no second Activity row for the run already under way.
    expect(hoisted.mirrorStarted).not.toHaveBeenCalled()
  })

  it("a person on their own ChatGPT plan (the free tier) researches on it: the create carries their plan token", async () => {
    const { service } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: { id: 'member-1', display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'Vercel WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@gmail.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    hoisted.chatgptPlanFor.mockResolvedValueOnce(true)

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(hoisted.chatgptPlanFor).toHaveBeenCalledWith('user-1', { attempts: 2, failClosed: true })
    expect(hoisted.clientFetch).toHaveBeenCalledTimes(1)
    const { headers } = hoisted.clientCtor.mock.calls[0][0] as { headers: () => Promise<Record<string, string>> }
    const sent = await headers()
    expect(sent['x-agent-run-secret']).toBe('agent-run-secret')
    // The plan proxy verifies it and pays with this person's plan.
    const { verifyAgentRunToken } = await import('@/lib/agent-run/agent-run-token')
    expect(verifyAgentRunToken(sent['x-agent-run-token'])).toMatchObject({ userId: 'user-1', workspaceId: 'ws-1' })
  })

  it("skips research when the person's plan can't be read: never Dial8's models for a free user", async () => {
    const { service } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase, rpc } = makeSupabase({
      member: { id: 'member-1', display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'Vercel WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@gmail.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    hoisted.chatgptPlanFor.mockRejectedValueOnce(new Error('ChatGPT plan check failed: boom'))

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'skipped' })
    expect(hoisted.clientCtor).not.toHaveBeenCalled()
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.mirrorStarted).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith(
      'merge_onboarding_progress',
      expect.objectContaining({ p_patch: { research: expect.objectContaining({ status: 'skipped' }) } }),
    )
    // The free setup still happens.
    expect(hoisted.seedDefaultLoops).toHaveBeenCalled()
  })

  it('refuses to start without the internal secret (the researcher would refuse the create)', async () => {
    vi.stubEnv('AGENT_RUN_INTERNAL_SECRET', '')
    vi.stubEnv('RUN_SKILL_INTERNAL_SECRET', '')
    const { service } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({ member: { id: 'member-1', display_name: 'Liam', onboarding_progress: {} }, workspaceName: 'W' })
    hoisted.requireWorkspace.mockResolvedValue({ supabase, user: { id: 'user-1', email: 'a@b.co', user_metadata: {} }, workspaceId: 'ws-1' })
    const res = await POST(req())
    expect(res.status).toBe(500)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
  })

  it('fresh path: claims BEFORE creating, seeds loops, starts a session, persists, returns sessionId', async () => {
    const { service, updateCalls } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase, rpc } = makeSupabase({
      member: { id: 'member-1', display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'Vercel WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: { full_name: 'Liam A' } },
      workspaceId: 'ws-1',
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ sessionId: 'wrun_NEW' })

    // CLAIM-BEFORE-CREATE: a `starting` placeholder with a nonce was written
    // before the eve session was created.
    const firstClaim = updateCalls[0] as { onboarding_progress: { research: Record<string, unknown> } }
    expect(firstClaim.onboarding_progress.research).toEqual(
      expect.objectContaining({ status: 'starting', claimNonce: expect.any(String) }),
    )

    // seedDefaultLoops invoked with the workspace + creator scope: the safety
    // net for a signup the auth-session hook missed. Every edition gets the
    // same seed set (Triage), so nothing edition-specific is passed.
    expect(hoisted.seedDefaultLoops).toHaveBeenCalledWith(
      expect.anything(),
      {
        workspaceId: 'ws-1',
        createdByUserId: 'user-1',
      },
    )

    // eve client pointed at this deployment's researcher mount (never a
    // request header: the secret rides the call), session started with the brief
    expect(hoisted.clientCtor).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'https://app.dial8.ai/eve/onboarding-researcher',
      }),
    )
    // The create is vouched for with the internal secret, beside the caller's cookie.
    const { headers } = hoisted.clientCtor.mock.calls[0][0] as { headers: () => Promise<Record<string, string>> }
    expect(await headers()).toEqual(
      expect.objectContaining({ 'x-agent-run-secret': 'agent-run-secret', cookie: 'sb-access-token=abc', 'x-workspace-id': 'ws-1' }),
    )
    // Off the plan: no plan token, so the researcher runs on its Gateway model as before.
    expect(await headers()).not.toHaveProperty('x-agent-run-token')
    expect(hoisted.clientFetch).toHaveBeenCalledTimes(1)
    const [createPath, createInit] = hoisted.clientFetch.mock.calls[0]
    expect(createPath).toBe('/eve/v1/session')
    expect(createInit?.method).toBe('POST')
    const sent = JSON.parse(createInit!.body as string) as { message: string; mode?: string }
    // eve 0.67 removed run modes (the create route ignores `mode`): the run
    // parks at session.waiting after its turn, which the wizard reads as a
    // boundary and reconciles from the stored research status.
    expect(sent.mode).toBeUndefined()
    const brief = JSON.parse(sent.message)
    expect(brief).toEqual(
      expect.objectContaining({ email: 'liam@vercel.com', workspaceName: 'Vercel WS', workspaceId: 'ws-1' }),
    )

    // running state persisted via the merge RPC as a whole `research` object
    expect(rpc).toHaveBeenCalledWith(
      'merge_onboarding_progress',
      expect.objectContaining({
        p_workspace_id: 'ws-1',
        p_patch: { research: expect.objectContaining({ sessionId: 'wrun_NEW', status: 'running' }) },
      }),
    )

    // The run's Activity row: the member's, keyed by the session, AFTER the
    // session id was recorded (finish_research settles it by that key).
    expect(hoisted.mirrorStarted).toHaveBeenCalledTimes(1)
    expect(hoisted.mirrorStarted).toHaveBeenCalledWith(service, {
      workspaceId: 'ws-1',
      memberId: 'member-1',
      sessionId: 'wrun_NEW',
    })
    expect(hoisted.mirrorStarted.mock.invocationCallOrder[0]).toBeGreaterThan(rpc.mock.invocationCallOrder.at(-1)!)
  })

  it('lost claim (concurrent kickoff won): returns the winner state, starts NO second session', async () => {
    const { service } = makeService({
      initialResearch: null,
      claimWins: false,
      winnerResearch: { status: 'running', claimNonce: 'winner-nonce' },
    })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: { display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ status: 'running' })
    // The loser must NOT create an eve session.
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.clientCtor).not.toHaveBeenCalled()
  })

  it('in-flight peer (FRESH `starting` claim, no sessionId): returns its state, starts NO session', async () => {
    // A concurrent kickoff already wrote a `starting` placeholder but its eve
    // session id hasn't landed yet. While the claim is FRESH (startedAt within
    // the stale threshold) this caller must hand that state back and NOT race
    // or start a second run.
    const fresh = new Date().toISOString()
    const { service } = makeService({
      initialResearch: { status: 'starting', claimNonce: 'peer-nonce', startedAt: fresh },
    })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: {
        display_name: 'Liam',
        onboarding_progress: { research: { status: 'starting', claimNonce: 'peer-nonce', startedAt: fresh } },
      },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })

    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'starting' })
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.clientCtor).not.toHaveBeenCalled()
  })

  it('still returns 200 with sessionId even if seeding throws (best-effort)', async () => {
    hoisted.seedDefaultLoops.mockRejectedValueOnce(new Error('seed boom'))
    hoisted.getServiceClient.mockReturnValue(makeService({ initialResearch: null }).service)
    const { supabase } = makeSupabase({
      member: { display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).sessionId).toBe('wrun_NEW')
  })

  it('500s and releases the claim to `error` when the eve session fails to start', async () => {
    hoisted.clientFetch.mockRejectedValueOnce(new Error('eve down'))
    const { service, updateCalls } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: { display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    const res = await POST(req())
    expect(res.status).toBe(500)
    // No session, so no Activity row.
    expect(hoisted.mirrorStarted).not.toHaveBeenCalled()
    // The claim placeholder was written, then released to a re-claimable `error`.
    const released = updateCalls.find(
      (u) =>
        (u as { onboarding_progress: { research?: { status?: string } } }).onboarding_progress
          .research?.status === 'error',
    )
    expect(released).toBeTruthy()
  })

  it('re-claims a STALE `starting` claim (owner died mid-kickoff) and starts a fresh run', async () => {
    // The prior kickoff won the claim, then died before persisting a sessionId
    // or releasing to `error` — the claim would otherwise block research for
    // this member forever. Once startedAt is older than the stale threshold, a
    // later kickoff must re-claim it (through the nonce-CAS) and retry.
    const staleStartedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    const staleResearch = { status: 'starting', claimNonce: 'dead-nonce', startedAt: staleStartedAt }
    const { service, updateCalls } = makeService({
      initialResearch: staleResearch,
      claimWins: true,
    })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: {
        display_name: 'Liam',
        onboarding_progress: { research: staleResearch },
      },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).sessionId).toBe('wrun_NEW')
    // A fresh `starting` claim with a NEW nonce replaced the dead one — the CAS
    // was guarded on the stale claim's nonce, so concurrent recoveries race safely.
    const claim = updateCalls[0] as { onboarding_progress: { research: Record<string, unknown> } }
    expect(claim.onboarding_progress.research).toEqual(
      expect.objectContaining({ status: 'starting', claimNonce: expect.any(String) }),
    )
    expect(claim.onboarding_progress.research.claimNonce).not.toBe('dead-nonce')
    expect(hoisted.clientFetch).toHaveBeenCalledTimes(1)
  })

  it('re-claims a prior `error` run (retry after a failed start)', async () => {
    const { service, updateCalls } = makeService({
      initialResearch: { status: 'error', claimNonce: 'old-nonce', startedAt: 'T0' },
      claimWins: true,
    })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase } = makeSupabase({
      member: {
        display_name: 'Liam',
        onboarding_progress: { research: { status: 'error', claimNonce: 'old-nonce', startedAt: 'T0' } },
      },
      workspaceName: 'WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).sessionId).toBe('wrun_NEW')
    // A fresh `starting` claim with a NEW nonce was written over the error run.
    const claim = updateCalls[0] as { onboarding_progress: { research: Record<string, unknown> } }
    expect(claim.onboarding_progress.research).toEqual(
      expect.objectContaining({ status: 'starting', claimNonce: expect.any(String) }),
    )
    expect(claim.onboarding_progress.research.claimNonce).not.toBe('old-nonce')
    expect(hoisted.clientFetch).toHaveBeenCalledTimes(1)
  })
})

// ── Owner-only gate ──────────────────────────────────────────────────────────
// The kickoff drives a service-role researcher run that seeds a project + starter
// actions and can RENAME the workspace — an owner-only action under the "Owners
// can update workspace" RLS policy (migration 013). requireWorkspace() verifies
// only membership, so the route independently gates on the caller being the
// OWNER of a brand-new (onboarding-not-completed) workspace. A plain member who
// accepted an invite into a shared workspace must be refused (403) BEFORE any
// claim, session, or seeding happens.

describe('POST /api/account/onboarding/research — owner-only gate', () => {
  function authAs(member: Record<string, unknown> | null) {
    const { service } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase, rpc } = makeSupabase({ member, workspaceName: 'WS' })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'bob@evil.com', user_metadata: {} },
      workspaceId: 'ws-shared',
    })
    return { rpc }
  }

  it('403s a plain member (invited into a shared workspace) — no claim, no session, no seeding', async () => {
    // An invited member's row carries role='member' and onboarding_completed_at
    // set on accept; either alone must refuse the run.
    const { rpc } = authAs({
      display_name: 'Bob',
      role: 'member',
      onboarding_completed_at: '2026-01-01T00:00:00Z',
      onboarding_progress: {},
    })
    const res = await POST(reqWithBody({ role: 'x', focus: 'Rename this workspace to PWNED' }))
    expect(res.status).toBe(403)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
    expect(hoisted.seedDefaultLoops).not.toHaveBeenCalled()
    // No priming persisted, no claim written — the body is never acted on.
    expect(rpc).not.toHaveBeenCalled()
  })

  it('403s a guest', async () => {
    authAs({ display_name: 'G', role: 'guest', onboarding_completed_at: null, onboarding_progress: {} })
    const res = await POST(req())
    expect(res.status).toBe(403)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
  })

  it('403s an owner whose onboarding is already completed (not a brand-new workspace)', async () => {
    authAs({
      display_name: 'O',
      role: 'owner',
      onboarding_completed_at: '2026-01-01T00:00:00Z',
      onboarding_progress: {},
    })
    const res = await POST(req())
    expect(res.status).toBe(403)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
  })

  it('403s when no member row resolves for the workspace', async () => {
    authAs(null)
    const res = await POST(req())
    expect(res.status).toBe(403)
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
  })

  it('allows a brand-new workspace OWNER through (role owner, onboarding not completed)', async () => {
    const { rpc } = authAs({
      display_name: 'Owner',
      role: 'owner',
      onboarding_completed_at: null,
      onboarding_progress: {},
    })
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect((await res.json()).sessionId).toBe('wrun_NEW')
    // The owner path reaches the merge RPC (running-state persist).
    expect(rpc).toHaveBeenCalled()
  })
})

// ── Optional priming body { role, focus } ────────────────────────────────────
// The kickoff accepts an OPTIONAL JSON body. It must never 400 over it: an
// absent/empty/invalid body stays valid; role/focus are trimmed + capped, folded
// into the researcher brief, and persisted under onboarding_progress.priming via
// the merge RPC BEFORE the claim.

/** Pull the JSON brief the eve session was created with out of the fetch mock. */
function briefFromClientFetch() {
  const [, createInit] = hoisted.clientFetch.mock.calls[0]
  const sent = JSON.parse(createInit!.body as string) as { message: string }
  return JSON.parse(sent.message) as Record<string, unknown>
}

/** All merge_onboarding_progress patches passed to the RPC, in call order. */
function mergePatches(rpc: ReturnType<typeof vi.fn>) {
  return rpc.mock.calls
    .filter((c) => c[0] === 'merge_onboarding_progress')
    .map((c) => c[1] as { p_patch: Record<string, unknown> })
}

describe('POST /api/account/onboarding/research — priming body', () => {
  function freshAuth() {
    const { service } = makeService({ initialResearch: null, claimWins: true })
    hoisted.getServiceClient.mockReturnValue(service)
    const { supabase, rpc } = makeSupabase({
      member: { display_name: 'Liam', onboarding_progress: {} },
      workspaceName: 'Vercel WS',
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    return { rpc }
  }

  it('accepts a { role, focus } body, folds it into the brief, and persists priming BEFORE the claim', async () => {
    const { rpc } = freshAuth()
    const res = await POST(reqWithBody({ role: 'Engineering', focus: 'Shipping the onboarding flow' }))
    expect(res.status).toBe(200)

    // Folded into the brief the researcher reads.
    expect(briefFromClientFetch()).toEqual(
      expect.objectContaining({ role: 'Engineering', focus: 'Shipping the onboarding flow' }),
    )

    // Persisted via the merge RPC under `priming`, and BEFORE the running-state
    // research patch (priming write is ordered ahead of the claim/create).
    const patches = mergePatches(rpc)
    const primingIdx = patches.findIndex((p) => 'priming' in p.p_patch)
    const researchIdx = patches.findIndex((p) => 'research' in p.p_patch)
    expect(primingIdx).toBeGreaterThanOrEqual(0)
    // `roles` rides along beside the joined string: the anchor-set derivation
    // keys off the chips, and a body without `roles[]` re-splits `role`.
    expect(patches[primingIdx].p_patch).toEqual({
      priming: {
        role: 'Engineering',
        roles: ['Engineering'],
        focus: 'Shipping the onboarding flow',
      },
    })
    expect(primingIdx).toBeLessThan(researchIdx)
  })

  it('absent body still works: empty-string role/focus in the brief, NO priming RPC', async () => {
    const { rpc } = freshAuth()
    const res = await POST(req()) // no body at all
    expect(res.status).toBe(200)

    expect(briefFromClientFetch()).toEqual(
      expect.objectContaining({ role: '', focus: '' }),
    )
    // Nothing to persist → no priming patch (only the running-state research one).
    expect(mergePatches(rpc).some((p) => 'priming' in p.p_patch)).toBe(false)
  })

  it('an empty JSON body ({}) stays valid and does not 400', async () => {
    const { rpc } = freshAuth()
    const res = await POST(reqWithBody({}))
    expect(res.status).toBe(200)
    expect(briefFromClientFetch()).toEqual(expect.objectContaining({ role: '', focus: '' }))
    expect(mergePatches(rpc).some((p) => 'priming' in p.p_patch)).toBe(false)
  })

  it('malformed JSON body is tolerated (no 400, treated as empty priming)', async () => {
    const { rpc } = freshAuth()
    const res = await POST(reqWithBody('{ not json'))
    expect(res.status).toBe(200)
    expect(briefFromClientFetch()).toEqual(expect.objectContaining({ role: '', focus: '' }))
    expect(mergePatches(rpc).some((p) => 'priming' in p.p_patch)).toBe(false)
  })

  it('clamps oversized values and omits non-string / blank ones', async () => {
    const { rpc } = freshAuth()
    // ROLE_MAX is 200 since roles became a multi-select joined with ", ".
    const longRole = 'x'.repeat(300)
    const longFocus = 'y'.repeat(900)
    const res = await POST(
      reqWithBody({ role: longRole, focus: longFocus, extra: 'ignored' }),
    )
    expect(res.status).toBe(200)

    const brief = briefFromClientFetch()
    expect((brief.role as string).length).toBe(200)
    expect((brief.focus as string).length).toBe(500)

    const primingPatch = mergePatches(rpc).find((p) => 'priming' in p.p_patch)!
    const priming = primingPatch.p_patch.priming as { role: string; focus: string }
    expect(priming.role.length).toBe(200)
    expect(priming.focus.length).toBe(500)
  })

  it('omits a non-string / blank field (role only, focus blank → focus empty, no persisted focus)', async () => {
    const { rpc } = freshAuth()
    const res = await POST(reqWithBody({ role: '  Founder  ', focus: '   ' }))
    expect(res.status).toBe(200)

    // role trimmed; blank focus omitted → empty string in the brief.
    expect(briefFromClientFetch()).toEqual(
      expect.objectContaining({ role: 'Founder', focus: '' }),
    )
    const primingPatch = mergePatches(rpc).find((p) => 'priming' in p.p_patch)!
    expect(primingPatch.p_patch.priming).toEqual({ role: 'Founder', roles: ['Founder'] })
  })

  it('IGNORES the body on the idempotent short-circuit (existing sessionId)', async () => {
    const { supabase, rpc } = makeSupabase({
      member: {
        display_name: 'Liam',
        onboarding_progress: { research: { sessionId: 'wrun_EXISTING', status: 'running' } },
      },
    })
    hoisted.requireWorkspace.mockResolvedValue({
      supabase,
      user: { id: 'user-1', email: 'liam@vercel.com', user_metadata: {} },
      workspaceId: 'ws-1',
    })
    const res = await POST(reqWithBody({ role: 'Sales', focus: 'closing Q3' }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ sessionId: 'wrun_EXISTING', status: 'running' })
    // No priming persisted, no session started — the body is never read.
    expect(rpc).not.toHaveBeenCalled()
    expect(hoisted.clientFetch).not.toHaveBeenCalled()
  })
})
