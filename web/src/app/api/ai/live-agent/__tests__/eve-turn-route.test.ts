/**
 * POST /api/ai/live-agent on eve (LIVE-AGENT-DESIGN §12 Steps 3–5): the route's
 * model call is ONE eve task session; everything around it is unchanged.
 *
 *   - the RouteResponse is byte-identical in shape (incl. pair_notes, steps_used,
 *     finish_reason, duration_ms) and tool_call_details carries the call INPUT;
 *   - usage is logged once, summed across steps, feature 'live_agent', the
 *     route's model, eve's 0-cost dropped (→ RPC list pricing), with the
 *     cached-token counts the RPC prices cache-aware from + the Gateway
 *     generation ids; eval rows skipBilling + captureId + a realCostUsd from
 *     the real price row, cache split included; Exa spend harvested from the
 *     eve steps;
 *   - a batch deletes its stale pending proposals BY ID only after the session
 *     completed a step — every fail-closed path before that leaves them;
 *   - the step ceiling (turn-budget.ts: 8 per tick, 50 batch) cancels the
 *     session and finalizes like a normal end;
 *   - failures: a failed create logs nothing; a failed session logs what ran and
 *     applies nothing; both answer the same 500 as before; a turn eve has not
 *     reported over (no boundary, parked, unconfirmed ceiling cancel, the wall
 *     clock) is cancelled;
 *   - the per-turn run token carries exactly the turn's durable claims (a null
 *     member included), the message carries the per-turn content;
 *   - streaming: the SSE contract ({type:'text'|'tool'|'done'|'error'}) is
 *     unchanged, `done` carries the same payload, and a client disconnect cancels
 *     the session and finalizes in aborted mode.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { MessageStreamEvent } from 'eve/client'
import {
  createFakeSupabase,
  eqValue,
  meetingFixture,
  FIX,
  type FakeQuery,
  type FakeResolver,
  type FixtureOptions,
} from '@/lib/live-agent/__tests__/helpers/live-turn-fixture'
import { ev, fakeTaskResponse, quietTurn, type FakeTaskResponse } from '@/lib/live-agent/__tests__/helpers/fake-eve-turn'
import { verifyLiveAgentRunToken } from '@/lib/live-agent/live-agent-run-token'
import { LIVE_STEP_CEILING } from '@/lib/live-agent/eve-turn'
import { LIVE_TURN_BUDGETS, OUTPUT_CHARS_PER_TOKEN, RECORD_TURN_FAILED_NOTE } from '@/lib/live-agent/turn-budget'
import { clearProductDocCache } from '@/lib/workspace/product-doc'
import { PRODUCT_FACTS_HEADING } from '@/lib/live-agent/product-facts'

const h = vi.hoisted(() => ({
  client: null as unknown as SupabaseClient,
  /** When set, what getServiceClient() answers instead of `client`. */
  service: null as SupabaseClient | null,
  /** The client each loadLiveMcpContext call was handed. */
  mcpContextClients: [] as unknown[],
  /** Every query the route's client ran, in order. */
  log: [] as FakeQuery[],
  usage: [] as Array<Record<string, unknown>>,
  syncCards: 0,
  /** What the next createTaskSession answers with (or throws). */
  next: null as null | (() => FakeTaskResponse),
  created: [] as Array<{ message: string }>,
  clientArgs: [] as Array<{ runToken: string; workspaceId: string; userId: string; secret: string }>,
  sessionCancels: [] as string[],
  last: null as FakeTaskResponse | null,
  /**
   * When set, the create POST answers only once this settles — and, like a
   * real fetch, rejects if ITS signal (createSignal, else signal) aborts first.
   */
  createGate: null as Promise<void> | null,
  /** Work the route handed to next/server's after() (a create still pending past the grace). */
  afters: [] as Promise<unknown>[],
  /** HUD heads-ups the route broadcast (nudge-channel). */
  nudges: [] as Array<{ message: string; captureId: string; kind: string }>,
}))

vi.mock('@/lib/live-agent/nudge-channel', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/nudge-channel')>()),
  broadcastNudge: async (n: { message: string; captureId: string; kind: string }) => {
    h.nudges.push(n)
    return true
  },
}))

// after() needs a request scope; capture what the route defers instead.
vi.mock('next/server', async (orig) => ({
  ...(await orig<typeof import('next/server')>()),
  after: (task: Promise<unknown>) => {
    h.afters.push(task)
  },
}))

vi.mock('@/lib/ai/auth', async (orig) => ({
  ...(await orig<typeof import('@/lib/ai/auth')>()),
  authenticateUser: async () => ({ user: { id: FIX.userId, email: FIX.userEmail }, supabase: h.client }),
  checkUsageLimits: async () => {},
  logUsage: async (_uid: string, row: Record<string, unknown>) => {
    h.usage.push(row)
  },
}))
vi.mock('@/lib/workspace', async (orig) => ({
  ...(await orig<typeof import('@/lib/workspace')>()),
  getCurrentWorkspaceId: async () => FIX.workspaceId,
}))
vi.mock('@/lib/admin', async (orig) => ({
  ...(await orig<typeof import('@/lib/admin')>()),
  getServiceClient: () => h.service ?? h.client,
}))
vi.mock('@/lib/live-agent/turn-composition', async (orig) => {
  const actual = await orig<typeof import('@/lib/live-agent/turn-composition')>()
  return {
    ...actual,
    loadLiveMcpContext: (sb: Parameters<typeof actual.loadLiveMcpContext>[0], ...rest: unknown[]) => {
      h.mcpContextClients.push(sb)
      return (actual.loadLiveMcpContext as (...a: unknown[]) => ReturnType<typeof actual.loadLiveMcpContext>)(sb, ...rest)
    },
  }
})
vi.mock('@/lib/crm/contacts', async (orig) => ({
  ...(await orig<typeof import('@/lib/crm/contacts')>()),
  seedSelfParticipant: async () => {},
}))
vi.mock('@/lib/live-agent/conversation-writer', async (orig) => ({
  ...(await orig<typeof import('@/lib/live-agent/conversation-writer')>()),
  syncProposalsCard: async () => {
    h.syncCards++
  },
}))
vi.mock('@/lib/flows/emit-capture-processed', () => ({ emitCaptureProcessed: () => {} }))
vi.mock('@/lib/live-agent/eve-turn', async (orig) => {
  const actual = await orig<typeof import('@/lib/live-agent/eve-turn')>()
  return {
    ...actual,
    liveAgentEveClient: (a: Parameters<typeof actual.liveAgentEveClient>[0]) => {
      h.clientArgs.push(a)
      return actual.liveAgentEveClient(a)
    },
  }
})
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: async (
    _client: unknown,
    opts: { message: string; signal?: AbortSignal; createSignal?: AbortSignal },
  ) => {
    h.created.push({ message: opts.message })
    if (h.createGate) {
      const postSignal = opts.createSignal ?? opts.signal
      const gate = h.createGate
      await new Promise<void>((resolve, reject) => {
        if (postSignal?.aborted) return reject(new DOMException('aborted', 'AbortError'))
        postSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
        void gate.then(resolve)
      })
    }
    const res = h.next!()
    h.last = res
    return res
  },
  cancelTaskSession: async (_client: unknown, sessionId: string) => {
    h.sessionCancels.push(sessionId)
    return true
  },
}))

const { POST } = await import('../route')

/** The fixture meeting; `extra` answers first (e.g. an ai_model_costs row). */
function useDb(opts: FixtureOptions = {}, extra?: FakeResolver) {
  const base = meetingFixture(opts)
  const fake = createFakeSupabase((q) => extra?.(q) ?? base(q))
  h.client = fake.client
  h.log = fake.log
}

/** The batch's delete of the stale pending proposals, if the route ran it. */
const pendingDeletes = () => h.log.filter((q) => q.table === 'proposed_change' && q.op === 'delete')

function post(body: Record<string, unknown>) {
  return POST(new Request('https://app.test/api/ai/live-agent', { method: 'POST', body: JSON.stringify(body) }))
}

const LIVE = { capture_id: FIX.captureId, recent_chunks: ['Speaker 1: ship Friday'] }

/** A two-step turn: a propose_change + a record_commitment, then a closing step. */
function workingTurn(): MessageStreamEvent[] {
  return [
    ev.sessionStarted(),
    ev.turnStarted(),
    ev.stepStarted(0),
    ev.toolCall(0, 'c1', 'propose_change', { change_type: 'create', entity_type: 'action', title: 'Ship Friday' }),
    ev.toolCall(0, 'c2', 'record_commitment', { text: 'Priya sends the deck', owner_label: 'Speaker 2' }),
    ev.stepCompleted(0, 'tool-calls', { inputTokens: 9000, outputTokens: 120, costUsd: 0 }),
    ev.toolResult(0, 'c1', 'propose_change', { success: true, proposal_id: 'p-1' }),
    ev.toolResult(0, 'c2', 'record_commitment', { success: true, claim_id: 'claim-1' }),
    ev.stepStarted(1),
    ev.messageCompleted(1, 'Captured.'),
    ev.stepCompleted(1, 'stop', { inputTokens: 9300, outputTokens: 20, costUsd: 0 }),
    ev.turnCompleted(),
    ev.sessionCompleted(),
  ]
}

beforeEach(() => {
  process.env.LIVE_AGENT_INTERNAL_SECRET = 'route-secret'
  h.usage = []
  h.syncCards = 0
  h.created = []
  h.clientArgs = []
  h.sessionCancels = []
  h.last = null
  h.createGate = null
  h.afters = []
  h.nudges = []
  h.next = () => fakeTaskResponse(quietTurn())
  h.service = null
  h.mcpContextClients = []
  useDb()
})

describe('non-streaming turn (Step 3)', () => {
  it('returns the byte-identical RouteResponse, with tool_call_details args = the call INPUT', async () => {
    h.next = () => fakeTaskResponse(workingTurn())
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(Object.keys(json)).toEqual([
      'ok',
      'text',
      'tool_calls',
      'tool_call_details',
      'auto_applied',
      'auto_applied_details',
      'pair_notes',
      'steps_used',
      'finish_reason',
      'duration_ms',
    ])
    expect(json).toMatchObject({
      ok: true,
      text: 'Captured.',
      tool_calls: 2,
      auto_applied: 0,
      auto_applied_details: [],
      pair_notes: false,
      steps_used: 2,
      finish_reason: 'stop',
    })
    expect(json.tool_call_details).toEqual([
      { tool: 'propose_change', args: { change_type: 'create', entity_type: 'action', title: 'Ship Friday' } },
      { tool: 'record_commitment', args: { text: 'Priya sends the deck', owner_label: 'Speaker 2' } },
    ])
    expect(typeof json.duration_ms).toBe('number')
  })

  it('logs usage ONCE, summed across steps, feature live_agent, the route’s model, eve’s 0 cost dropped', async () => {
    h.next = () => fakeTaskResponse(workingTurn())
    await post(LIVE)
    expect(h.usage).toHaveLength(1)
    const row = h.usage[0]
    expect(row).toMatchObject({
      feature: 'live_agent',
      model: 'deepseek-v4-flash',
      inputTokens: 18300,
      outputTokens: 140,
    })
    expect(row.costUsd).toBeUndefined()
    expect(row).not.toHaveProperty('skipBilling')
    expect(h.syncCards).toBe(1)
  })

  it('harvests Exa spend from an eve web_search result into metadata.webSearchCostUsd (batch)', async () => {
    h.next = () =>
      fakeTaskResponse([
        ev.stepStarted(0),
        ev.toolCall(0, 'w1', 'web_search', { query: 'Acme funding round' }),
        ev.toolResult(0, 'w1', 'web_search', { results: [{ url: 'https://a.example', id: '1' }], costDollars: { total: 0.005 } }),
        // The Gateway's billed cost for that step IS the Exa charge (BYOK tokens bill 0).
        ev.stepCompleted(0, 'tool-calls', { inputTokens: 8000, outputTokens: 40, costUsd: 0.005 }),
        ev.toolCall(1, 's1', 'write_summary', { ai_summary: '## Summary' }),
        ev.stepCompleted(1, 'tool-calls'),
        ev.stepCompleted(2, 'stop'),
        ev.sessionCompleted(),
      ])
    const res = await post({ capture_id: FIX.captureId, mode: 'batch' })
    const json = (await res.json()) as Record<string, unknown>
    expect(json).not.toHaveProperty('pair_notes')
    expect(json.steps_used).toBe(3)
    const meta = h.usage[0].metadata as { webSearchCostUsd?: unknown }
    expect(typeof meta.webSearchCostUsd).toBe('number')
    expect(meta.webSearchCostUsd).toBeCloseTo(0.005)
    // …so eve's cost is not the token spend: dropped, and the RPC list-prices the tokens.
    expect(h.usage[0].costUsd).toBeUndefined()
    expect(h.usage[0].inputTokens).toBeGreaterThanOrEqual(8000)
  })

  it('an EVAL turn logs with skipBilling, the captureId readBackUsage filters on, and a REAL cost for the trial budget', async () => {
    useDb({ isEval: true })
    h.next = () => fakeTaskResponse(workingTurn())
    await post({ capture_id: FIX.captureId, mode: 'batch' })
    expect(h.usage[0]).toMatchObject({
      skipBilling: true,
      metadata: { eval: true, captureId: FIX.captureId },
    })
    // eve's cost is 0 (BYOK) → the tokens are list-priced app-side (the fixture
    // has no ai_model_costs row → log_ai_usage's $15/$75 per-M fallback), never
    // $0: a $0 trial could never trip max_cost_usd.
    const meta = h.usage[0].metadata as { realCostUsd: number }
    expect(meta.realCostUsd).toBeCloseTo((18300 / 1e6) * 15 + (140 / 1e6) * 75, 8)
  })

  it('an EVAL turn on a credits-path model carries eve’s real (non-zero) cost as-is', async () => {
    useDb({ isEval: true })
    const turn = workingTurn().map((e) =>
      e.type === 'step.completed' ? ({ ...e, data: { ...e.data, usage: { ...e.data.usage, costUsd: 0.004 } } } as typeof e) : e,
    )
    h.next = () => fakeTaskResponse(turn)
    await post({ capture_id: FIX.captureId, mode: 'batch' })
    expect((h.usage[0].metadata as { realCostUsd: number }).realCostUsd).toBeCloseTo(0.008)
    expect(h.usage[0].costUsd).toBeCloseTo(0.008)
  })

  it('cancels the session at the step ceiling and finalizes it as a normal (truncated) turn', async () => {
    const steps: MessageStreamEvent[] = [ev.turnStarted()]
    for (let i = 0; i < LIVE_STEP_CEILING; i++) {
      steps.push(ev.stepStarted(i), ev.toolCall(i, `c${i}`, 'find', { query: `q${i}` }), ev.stepCompleted(i, 'tool-calls'))
    }
    // A step N+1 that was already under way when the cancel landed: its tokens
    // are billed, but the turn still reports the ceiling as the AI-SDK stopWhen
    // did (run-trial reads steps_used at the ceiling + 'tool-calls' as TRUNCATED).
    const N = LIVE_STEP_CEILING
    h.next = () =>
      fakeTaskResponse(steps, {
        hangAfter: steps.length,
        afterCancel: [ev.stepStarted(N), ev.stepCompleted(N, 'stop', { inputTokens: 500, outputTokens: 5 }), ev.turnCancelled()],
      })
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(h.last!.cancelled()).toBe(1)
    expect(json.steps_used).toBe(N)
    expect(json.finish_reason).toBe('tool-calls')
    expect(json.budget_hit).toBe('steps')
    expect(h.syncCards).toBe(1) // not an abort: finalize ran its full tail
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0].inputTokens).toBe(N * 100 + 500)
    expect(h.usage[0].outputTokens).toBe(N * 10 + 5)
  })

  it('a failed session with no step run → the same 500, no usage row, nothing applied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () => fakeTaskResponse([ev.sessionStarted(), ev.sessionFailed('SPEC_UNAVAILABLE', 'no turn spec')])
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Live agent processing failed' })
    expect(h.usage).toHaveLength(0)
    expect(h.syncCards).toBe(0)
    error.mockRestore()
  })

  it('a session that fails AFTER a step → usage for what ran, mutations skipped, the same 500', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () =>
      fakeTaskResponse([ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls', { inputTokens: 50, outputTokens: 5 }), ev.sessionFailed()])
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0]).toMatchObject({ inputTokens: 50, outputTokens: 5 })
    expect(h.syncCards).toBe(0)
    error.mockRestore()
  })

  it('a failed session CREATE → the same 500 and no usage (nothing ran)', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () => {
      throw new Error('eve task-session create failed (503)')
    }
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Live agent processing failed' })
    expect(h.usage).toHaveLength(0)
    error.mockRestore()
  })
})

describe('connected MCP servers (migration 466)', () => {
  it('reads them with the service client, not the session-scoped one: a lookup turn builds GitHub from its token', async () => {
    const service = createFakeSupabase(meetingFixture()).client
    h.service = service
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    expect(h.mcpContextClients).toHaveLength(1)
    expect(h.mcpContextClients[0]).toBe(service)
    expect(h.mcpContextClients[0]).not.toBe(h.client)
  })
})

describe('the per-turn run token + the message (Steps 3/5)', () => {
  const claimsOf = () => verifyLiveAgentRunToken(h.clientArgs[0].runToken)!

  it.each([
    ['copilot', LIVE, 'copilot'],
    ['notes', { ...LIVE, live_role: 'notes' }, 'notes'],
    ['batch', { capture_id: FIX.captureId, mode: 'batch', live_role: 'notes' }, 'batch'],
  ] as const)('%s → turnType %s, tenancy + member from the route, signed with the internal secret', async (_l, body, turnType) => {
    await post(body)
    const claims = claimsOf()
    expect(claims).toMatchObject({
      captureId: FIX.captureId,
      workspaceId: FIX.workspaceId,
      userId: FIX.userId,
      currentMemberId: FIX.memberId,
      turnType,
      isEvalCapture: false,
      allowAutoArchive: false,
    })
    expect(claims).not.toHaveProperty('recipeId')
    expect(h.clientArgs[0]).toMatchObject({ workspaceId: FIX.workspaceId, userId: FIX.userId, secret: 'route-secret' })
  })

  it('carries the explicit recipe override and the eval flag stamped from the capture row', async () => {
    useDb({ isEval: true, recipes: { 'r-1': { system_prompt: 'P', agent_config: null, model: null } } })
    await post({ ...LIVE, recipe_id: 'r-1' })
    expect(claimsOf()).toMatchObject({ recipeId: 'r-1', isEvalCapture: true })
  })

  it('a caller with NO member row still gets a turn dispatched (currentMemberId null) — the internal routes decide', async () => {
    useDb({ memberRevoked: true })
    await post(LIVE)
    expect(h.created).toHaveLength(1)
    expect(claimsOf().currentMemberId).toBeNull()
  })

  it('the message carries the per-turn content; the token carries none of it but a talking tick\'s ≤600-character window tail', async () => {
    await post({
      ...LIVE,
      corrections_log: [{ field: 'title', agentProposed: 'Sync', userCorrected: 'Weekly sync' }],
      prior_transcript: 'Speaker 2: earlier bit',
    })
    const message = h.created[0].message
    expect(message).toContain('Weekly sync')
    expect(message).toContain('MEETING SO FAR — BACKGROUND CONTEXT ONLY')
    expect(message).toContain('Speaker 2: earlier bit')
    expect(message).toContain('New transcript:\nSpeaker 1: ship Friday')
    const token = h.clientArgs[0].runToken
    const payload = Buffer.from(token.split('.')[0], 'base64url').toString('utf8')
    expect(payload).not.toContain('Weekly sync')
    expect(payload).not.toContain('earlier bit')
    // The one exception (live-agent-run-token.ts recentTail): the window's
    // newest ≤600 characters, read only by the tool route's shadow nudge.worth
    // check. Never the corrections log or the meeting so far.
    expect(JSON.parse(payload).recentTail).toBe('Speaker 1: ship Friday')
    expect(payload.split('ship Friday')).toHaveLength(2)
  })

  it('no internal secret → no token, no session, the same 500', async () => {
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(h.created).toHaveLength(0)
    error.mockRestore()
  })
})

// ── Streaming (Step 4) ─────────────────────────────────────────────────────────

async function sseEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text()
  return text
    .split('\n\n')
    .filter((c) => c.startsWith('data: '))
    .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>)
}

describe('streaming turn (Step 4)', () => {
  it('relays write_summary as it is typed, then `done` with the same payload the JSON path returns', async () => {
    const turn = [
      ev.turnStarted(),
      ev.stepStarted(0),
      ev.text(0, 'Let me write that up.'),
      ev.inputDelta(0, 's1', 'write_summary', '{"ai_summary":"## Summary\\n'),
      ev.inputDelta(0, 's1', 'write_summary', '- Ship Friday"}'),
      ev.toolCall(0, 's1', 'write_summary', { ai_summary: '## Summary\n- Ship Friday' }),
      ev.toolCall(0, 'p1', 'propose_change', { change_type: 'create', entity_type: 'action' }),
      ev.stepCompleted(0, 'tool-calls'),
      ev.stepCompleted(1, 'stop'),
      ev.sessionCompleted(),
    ]
    h.next = () => fakeTaskResponse(turn)
    const res = await post({ ...LIVE, stream: true })
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const events = await sseEvents(res)
    expect(events[0]).toEqual({ type: 'tool', tool: 'write_summary' })
    const typed = events.filter((e) => e.type === 'text').map((e) => e.text).join('')
    expect(typed).toBe('## Summary\n- Ship Friday')
    expect(events).toContainEqual({ type: 'tool', tool: 'propose_change' })
    const done = events.at(-1)!
    expect(done.type).toBe('done')
    const payload = done.payload as Record<string, unknown>
    expect(Object.keys(payload)).toEqual([
      'ok',
      'text',
      'tool_calls',
      'tool_call_details',
      'auto_applied',
      'auto_applied_details',
      'pair_notes',
      'steps_used',
      'finish_reason',
      'duration_ms',
    ])
    expect(payload).toMatchObject({ tool_calls: 2, steps_used: 2, finish_reason: 'stop' })
    expect(h.usage).toHaveLength(1)
  })

  it('a turn that never calls write_summary still reaches `done`', async () => {
    const events = await sseEvents(await post({ ...LIVE, stream: true }))
    expect(events.map((e) => e.type)).toEqual(['done'])
  })

  it('a failed session → an `error` event (no `done`), usage logged for what ran, nothing applied', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () => fakeTaskResponse([ev.stepCompleted(0, 'tool-calls'), ev.sessionFailed()])
    const events = await sseEvents(await post({ ...LIVE, stream: true }))
    expect(events).toEqual([{ type: 'error', error: 'Live agent processing failed' }])
    expect(h.usage).toHaveLength(1)
    expect(h.syncCards).toBe(0)
    error.mockRestore()
  })

  it('a client disconnect cancels the eve session and finalizes in aborted mode (usage yes, mutations no)', async () => {
    h.next = () =>
      fakeTaskResponse(
        [ev.turnStarted(), ev.stepStarted(0), ev.inputDelta(0, 's1', 'write_summary', '{"ai_summary":"hi'), ev.stepCompleted(0, 'tool-calls')],
        { hangAfter: 4 },
      )
    const res = await post({ ...LIVE, stream: true })
    const reader = res.body!.getReader()
    await reader.read() // the tool announcement
    // Let the route consume the step.completed that follows it (the stream then
    // idles, waiting on eve) before the client walks away.
    await new Promise((r) => setTimeout(r, 20))
    await reader.cancel()
    await vi.waitFor(() => expect(h.usage).toHaveLength(1))
    // Let every remaining timer / microtask run: a second finalize (e.g. the
    // `finally` fallback without the once-guard) would log a second row here.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.usage).toHaveLength(1)
    expect(h.sessionCancels).toEqual(['sess-1'])
    expect(h.syncCards).toBe(0)
  })

  it('a disconnect while the create POST is in flight cancels the session that create started (no orphan)', async () => {
    // use-streaming-extraction aborts the in-flight stream on every new start;
    // the create window includes the mount's cold start. Were the POST on the
    // abandon signal, it would be aborted, its session id never learned, and
    // the durable session would run the whole turn unobserved and unbilled.
    let releaseCreate!: () => void
    h.createGate = new Promise<void>((r) => {
      releaseCreate = r
    })
    h.next = () => fakeTaskResponse(workingTurn(), { sessionId: 'sess-orphan' })
    const res = await post({ ...LIVE, stream: true })
    const reader = res.body!.getReader()
    await vi.waitFor(() => expect(h.created).toHaveLength(1))
    await reader.cancel()
    // The create answers only AFTER the client is gone.
    releaseCreate()
    await vi.waitFor(() => expect(h.sessionCancels).toEqual(['sess-orphan']))
    await new Promise((r) => setTimeout(r, 20))
    expect(h.sessionCancels).toEqual(['sess-orphan'])
    // Nothing of the session was read, so nothing ran that we can account for:
    // no usage row, no mutations.
    expect(h.usage).toHaveLength(0)
    expect(h.syncCards).toBe(0)
  })

  it('a disconnect while a COLD create outlasts the grace defers the cancel to after(), and the session is still cancelled', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      let releaseCreate!: () => void
      h.createGate = new Promise<void>((r) => {
        releaseCreate = r
      })
      h.next = () => fakeTaskResponse(workingTurn(), { sessionId: 'sess-cold' })
      const res = await post({ ...LIVE, stream: true })
      const reader = res.body!.getReader()
      await vi.waitFor(() => expect(h.created).toHaveLength(1))
      await reader.cancel()
      await vi.advanceTimersByTimeAsync(5_001)
      // The grace is over and the create is still pending: handed to after(),
      // not aborted (an aborted POST would reject the gate and never cancel).
      expect(h.afters).toHaveLength(1)
      expect(h.sessionCancels).toEqual([])
      await vi.advanceTimersByTimeAsync(40_000)
      releaseCreate()
      await h.afters[0]
      expect(h.sessionCancels).toEqual(['sess-cold'])
      expect(h.usage).toHaveLength(0)
      expect(h.syncCards).toBe(0)
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('was not cancelled'))
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('the stream runs the step ceiling too (cancel at the ceiling, `done` with finish_reason tool-calls)', async () => {
    const N = LIVE_STEP_CEILING
    const steps: MessageStreamEvent[] = [ev.turnStarted()]
    for (let i = 0; i < N; i++) steps.push(ev.stepCompleted(i, 'tool-calls'))
    h.next = () =>
      fakeTaskResponse(steps, {
        hangAfter: steps.length,
        afterCancel: [ev.stepCompleted(N, 'stop', { inputTokens: 500, outputTokens: 5 }), ev.turnCancelled()],
      })
    const events = await sseEvents(await post({ ...LIVE, stream: true }))
    const done = events.at(-1)!
    expect(done.type).toBe('done')
    expect(done.payload).toMatchObject({ steps_used: N, finish_reason: 'tool-calls', budget_hit: 'steps' })
    expect(h.last!.cancelled()).toBe(1)
    expect(h.usage[0].inputTokens).toBe(N * 100 + 500)
  })
})

// ── Billing: cached tokens + real price rows ──────────────────────────────────

const HAIKU = 'claude-haiku-4-5-20251001'
const HAIKU_RECIPE = { 'r-haiku': { system_prompt: 'P', agent_config: null, model: HAIKU } }

/** A two-step turn with the prompt-cache shape measured live (~0.9 read ratio). */
function cachedTurn(): MessageStreamEvent[] {
  return [
    ev.stepStarted(0),
    ev.toolCall(0, 'c1', 'propose_change', { change_type: 'create', entity_type: 'action', title: 'Ship Friday' }),
    ev.stepCompleted(0, 'tool-calls', { inputTokens: 19_500, outputTokens: 120, cacheReadTokens: 17_700, cacheWriteTokens: 1_700 }, 'gen-a'),
    ev.stepStarted(1),
    ev.stepCompleted(1, 'stop', { inputTokens: 19_800, outputTokens: 40, cacheReadTokens: 19_400, costUsd: 0 }, 'gen-b'),
    ev.sessionCompleted(),
  ]
}

/** An ai_model_costs row for exactly (provider, model), else fall through to the fixture. */
function priceRow(provider: string, model: string, inPerM: number, outPerM: number): FakeResolver {
  return (q) =>
    q.table === 'ai_model_costs'
      ? eqValue(q, 'provider') === provider && eqValue(q, 'model') === model
        ? { data: { input_cost_per_million: String(inPerM), output_cost_per_million: String(outPerM) }, error: null }
        : { data: null, error: null }
      : undefined
}

describe('usage billing on eve (cache-aware, as the Gateway marketCost was)', () => {
  it('a cached turn hands log_ai_usage the cached-token counts under the RPC’s own keys, + the generation ids; a recipe’s old model is ignored (Flash runs)', async () => {
    useDb({ recipes: HAIKU_RECIPE })
    h.next = () => fakeTaskResponse(cachedTurn())
    await post({ ...LIVE, recipe_id: 'r-haiku' })
    expect(h.usage).toHaveLength(1)
    const row = h.usage[0]
    // Auto model selection: the live agent's model is fixed (SURFACE_MODELS.live_agent).
    expect(row).toMatchObject({ provider: 'deepseek', model: 'deepseek-v4-flash', inputTokens: 39_300, outputTokens: 160 })
    expect(row.costUsd).toBeUndefined() // eve's BYOK 0 → RPC pricing
    expect(row.metadata).toMatchObject({
      cache_read_input_tokens: 37_100,
      cache_creation_input_tokens: 1_700,
      generationIds: ['gen-a', 'gen-b'],
    })
  })

  it('every row carries the turn measurement (kind, role, steps, largest step output) and nothing it did not do', async () => {
    h.next = () => fakeTaskResponse(workingTurn())
    await post(LIVE)
    expect(h.usage[0].metadata).toEqual({
      turn_kind: 'tick',
      live_role: 'copilot',
      steps: 2,
      max_step_output_tokens: 120,
      // The fixture attaches no packages, so the packages rider is cut (riders.ts).
      riders_omitted: ['packages'],
      // Each timed tool (request → result), with its count.
      tool_ms: { propose_change: { ms: expect.any(Number), n: 1 }, record_commitment: { ms: expect.any(Number), n: 1 } },
    })
  })

  it('an EVAL turn’s realCostUsd is priced from the model’s REAL ai_model_costs row (the key the usage row names)', async () => {
    useDb({ isEval: true }, priceRow('deepseek', 'deepseek-v4-flash', 0.3, 1.2))
    h.next = () => fakeTaskResponse(workingTurn())
    await post({ capture_id: FIX.captureId, mode: 'batch' })
    const meta = h.usage[0].metadata as { realCostUsd: number }
    expect(meta.realCostUsd).toBeCloseTo((18_300 / 1e6) * 0.3 + (140 / 1e6) * 1.2, 10)
  })

  it('a cached EVAL turn’s realCostUsd is priced from the Flash row (the Claude cache split is listPriceCostUsd’s, eve-turn.test.ts)', async () => {
    useDb({ isEval: true, recipes: HAIKU_RECIPE }, priceRow('deepseek', 'deepseek-v4-flash', 0.08, 0.18))
    h.next = () => fakeTaskResponse(cachedTurn())
    await post({ capture_id: FIX.captureId, mode: 'batch', recipe_id: 'r-haiku' })
    const meta = h.usage[0].metadata as Record<string, unknown>
    // Every input token at the input rate: only a 'claude' row takes the cache split.
    const expected = (39_300 * 0.08 + 160 * 0.18) / 1e6
    expect(meta.realCostUsd as number).toBeCloseTo(expected, 10)
    expect(meta).toMatchObject({ eval: true, captureId: FIX.captureId, cache_read_input_tokens: 37_100 })
    expect(h.usage[0].skipBilling).toBe(true)
  })
})

// ── A batch replaces pending proposals only once the session has run a step ──

describe('batch: the stale pending proposals survive every fail-closed path', () => {
  const BATCH = { capture_id: FIX.captureId, mode: 'batch' }

  it('a successful batch deletes exactly the pending rows it read, by id, after the first step', async () => {
    h.next = () => fakeTaskResponse(workingTurn())
    const res = await post(BATCH)
    expect(res.status).toBe(200)
    const deletes = pendingDeletes()
    expect(deletes).toHaveLength(1)
    expect(deletes[0].filters).toContainEqual(['in', 'id', ['pc-1']])
    expect(deletes[0].filters).toContainEqual(['eq', 'status', 'pending'])
    expect(deletes[0].filters).toContainEqual(['eq', 'capture_id', FIX.captureId])
    expect(deletes[0].filters).toContainEqual(['eq', 'workspace_id', FIX.workspaceId])
  })

  it('finalize (auto-apply + marker reads) waits for the stale-pending delete to LAND', async () => {
    // A Reprocess with the trust policy on (the default): were finalize to run
    // while the delete is in flight, its pending-candidates read would still
    // see pc-1 and auto-apply the very row the batch was meant to replace.
    let deleted = false
    let releaseDelete!: () => void
    const held = new Promise<void>((r) => {
      releaseDelete = r
    })
    const candidateReads: unknown[] = []
    useDb({}, (q) => {
      if (q.table !== 'proposed_change') return undefined
      if (q.op === 'delete') {
        return held.then(() => {
          deleted = true
          return { data: null, error: null }
        })
      }
      if (q.op === 'select' && q.columns === '*' && eqValue(q, 'status') === 'pending') {
        const rows = deleted ? [] : [{ id: 'pc-1', change_type: 'create', entity_type: 'action', status: 'pending' }]
        candidateReads.push(rows)
        return { data: rows, error: null }
      }
      return undefined
    })
    h.next = () => fakeTaskResponse(workingTurn())
    const pending = post(BATCH)
    await vi.waitFor(() => expect(pendingDeletes()).toHaveLength(1))
    // Held: the turn is over, but finalize must not have started.
    await new Promise((r) => setTimeout(r, 20))
    expect(h.usage).toHaveLength(0)
    expect(candidateReads).toHaveLength(0)
    releaseDelete()
    const json = (await (await pending).json()) as { auto_applied_details: Array<{ id: string }> }
    expect(h.usage).toHaveLength(1)
    expect(candidateReads).toEqual([[]])
    expect(json.auto_applied_details.map((d) => d.id)).not.toContain('pc-1')
  })

  it('no internal secret configured → 500 and the pending rows are untouched (no session either)', async () => {
    delete process.env.LIVE_AGENT_INTERNAL_SECRET
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await post(BATCH)
    expect(res.status).toBe(500)
    expect(h.created).toHaveLength(0)
    expect(pendingDeletes()).toHaveLength(0)
    error.mockRestore()
  })

  it('a session that fails closed before its first step (spec refusal) → 500, pending rows untouched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () =>
      fakeTaskResponse([ev.sessionStarted(), ev.stepStarted(0), ev.sessionFailed('MODEL_SELECTION_FAILED', 'no turn spec')])
    const res = await post(BATCH)
    expect(res.status).toBe(500)
    expect(pendingDeletes()).toHaveLength(0)
    error.mockRestore()
  })

  it('a failed session CREATE → pending rows untouched', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () => {
      throw new Error('eve task-session create failed (503)')
    }
    expect((await post(BATCH)).status).toBe(500)
    expect(pendingDeletes()).toHaveLength(0)
    error.mockRestore()
  })

  it('a caller with no member row → 403 before anything is dispatched or deleted', async () => {
    useDb({ memberRevoked: true })
    const res = await post(BATCH)
    expect(res.status).toBe(403)
    expect(h.created).toHaveLength(0)
    expect(pendingDeletes()).toHaveLength(0)
  })

  it('a live turn never deletes pending proposals', async () => {
    h.next = () => fakeTaskResponse(workingTurn())
    await post(LIVE)
    expect(pendingDeletes()).toHaveLength(0)
  })
})

// ── A turn eve has not reported over is cancelled ─────────────────────────────

describe('non-terminal outcomes cancel the eve session', () => {
  it.each([
    ['a stream that ends with no boundary', true, [ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls')]],
    ['a parked (waiting) session', true, [ev.stepCompleted(0, 'stop'), ev.sessionWaiting()]],
    ['a failed session (already terminal)', false, [ev.stepStarted(0), ev.sessionFailed()]],
    ['a completed session', false, quietTurn()],
  ] as const)('%s → cancel: %s', async (_label, cancels, events) => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () => fakeTaskResponse([...events])
    await post(LIVE)
    expect(h.sessionCancels).toEqual(cancels ? ['sess-1'] : [])
    error.mockRestore()
  })

  it('a ceiling cancel eve never confirms is retried through the session cancel before finalize', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const steps: MessageStreamEvent[] = []
      for (let i = 0; i < 20; i++) steps.push(ev.stepCompleted(i, 'tool-calls'))
      h.next = () => fakeTaskResponse(steps, { hangAfter: steps.length }) // no turn.cancelled, ever
      const pending = post(LIVE)
      await vi.advanceTimersByTimeAsync(10_001)
      const res = await pending
      expect(res.status).toBe(200)
      expect(h.last!.cancelled()).toBe(1)
      expect(h.sessionCancels).toEqual(['sess-1'])
      expect(h.usage).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── The wall clock (non-stream) ───────────────────────────────────────────────

describe('the wall clock under maxDuration', () => {
  it('stops reading at maxDuration − 30s, cancels the session, logs what ran ONCE, applies nothing, answers 500', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      h.next = () =>
        fakeTaskResponse([ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls', { inputTokens: 70, outputTokens: 7 }), ev.stepStarted(1)], {
          hangAfter: 3,
        })
      const pending = post({ capture_id: FIX.captureId, mode: 'batch' })
      await vi.advanceTimersByTimeAsync(569_000)
      expect(h.sessionCancels).toEqual([]) // still inside the budget
      await vi.advanceTimersByTimeAsync(1_001)
      const res = await pending
      expect(res.status).toBe(500)
      expect(h.sessionCancels).toEqual(['sess-1'])
      expect(h.usage).toHaveLength(1)
      expect(h.usage[0]).toMatchObject({ inputTokens: 70, outputTokens: 7 })
      expect(h.syncCards).toBe(0)
      // The stale pending rows were replaced (a step had run), as before the port.
      expect(pendingDeletes()).toHaveLength(1)
    } finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fires while the create POST is still in flight → the session it started is cancelled, nothing logged or deleted, 500', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      let releaseCreate!: () => void
      h.createGate = new Promise<void>((r) => {
        releaseCreate = r
      })
      h.next = () => fakeTaskResponse(workingTurn(), { sessionId: 'sess-x' })
      const pending = post({ capture_id: FIX.captureId, mode: 'batch' })
      await vi.waitFor(() => expect(h.created).toHaveLength(1))
      await vi.advanceTimersByTimeAsync(570_001)
      // The create answers only after the wall clock fired (inside the grace).
      releaseCreate()
      const res = await pending
      expect(res.status).toBe(500)
      expect(h.sessionCancels).toEqual(['sess-x'])
      expect(h.usage).toHaveLength(0)
      expect(h.syncCards).toBe(0)
      // No step ran, so the batch's stale pending rows are left in place.
      expect(pendingDeletes()).toHaveLength(0)
    } finally {
      error.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('directives: what the user asked to go into the record (L1, migration 290)', () => {
  const DIRECTIVES = [
    { id: 'd-1', source: 'user', text: 'Note that Dana owns the budget' },
    { id: 'd-2', source: 'talk_back', text: 'Record "ship Friday" as\nmy commitment' },
  ]
  const ASSIST = { 'r-assist': { system_prompt: 'Copilot', agent_config: { capture_mode: 'assist_only' }, model: null } }
  /** The fixture with pending directives answered for the live_directive read. */
  const useDbWithDirectives = (opts: FixtureOptions = {}, rows: unknown[] = DIRECTIVES, error: { message: string } | null = null) =>
    useDb(opts, (q) => (q.table === 'live_directive' && q.op === 'select' ? { data: error ? null : rows, error } : undefined))
  const reads = () => h.log.filter((q) => q.table === 'live_directive' && q.op === 'select')
  const writes = () => h.log.filter((q) => q.table === 'live_directive' && q.op === 'update')
  /** The directives section: its heading up to the next Block 2 separator. */
  const blockOf = (message: string) => {
    const at = message.indexOf('## Notes to record (directives)')
    if (at < 0) return null
    const end = message.indexOf('\n\n---', at)
    return message.slice(at, end < 0 ? undefined : end)
  }

  it('a live turn that writes the record reads the requester’s pending directives and carries them in Block 2', async () => {
    useDbWithDirectives()
    h.next = () => fakeTaskResponse(workingTurn())
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    expect(reads()).toHaveLength(1)
    const read = reads()[0]
    expect(eqValue(read, 'capture_id')).toBe(FIX.captureId)
    expect(eqValue(read, 'workspace_id')).toBe(FIX.workspaceId)
    expect(eqValue(read, 'created_by')).toBe(FIX.userId)
    expect(eqValue(read, 'status')).toBe('pending')
    const message = h.created[0].message
    const block = blockOf(message)
    expect(block).not.toBeNull()
    expect(block).toContain('- The user asked: "Note that Dana owns the budget"')
    // one line, quotes neutralised, source labelled
    expect(block).toContain('- The user asked in the meeting chat: "Record ”ship Friday” as my commitment"')
    // Block 2 (before the transcript separator), never in the transcript block
    expect(message.indexOf('## Notes to record')).toBeLessThan(message.indexOf('Speaker 1: ship Friday'))
  })

  it('a completed turn marks exactly the directives it read consumed, with its session', async () => {
    useDbWithDirectives()
    h.next = () => fakeTaskResponse(workingTurn())
    await post(LIVE)
    expect(writes()).toHaveLength(1)
    const w = writes()[0]
    expect(w.payload).toMatchObject({ status: 'consumed', consumed_session: 'sess-1' })
    expect(typeof (w.payload as { consumed_at?: unknown }).consumed_at).toBe('string')
    expect(w.filters).toContainEqual(['in', 'id', ['d-1', 'd-2']])
    expect(eqValue(w, 'status')).toBe('pending')
    expect(eqValue(w, 'capture_id')).toBe(FIX.captureId)
    expect(eqValue(w, 'workspace_id')).toBe(FIX.workspaceId)
  })

  it('a turn that fails leaves them pending for the next one', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    useDbWithDirectives()
    h.next = () =>
      fakeTaskResponse([ev.stepStarted(0), ev.stepCompleted(0, 'tool-calls', { inputTokens: 50, outputTokens: 5 }), ev.sessionFailed()])
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(h.created[0].message).toContain('## Notes to record')
    expect(writes()).toHaveLength(0)
    error.mockRestore()
  })

  it('nothing pending → no block and no write: the message is unchanged', async () => {
    useDbWithDirectives({}, [])
    await post(LIVE)
    expect(h.created[0].message).not.toContain('## Notes to record')
    expect(writes()).toHaveLength(0)
    // …and byte-identical to a turn where the read found nothing at all
    const withEmpty = h.created[0].message
    useDb()
    h.created = []
    await post(LIVE)
    expect(h.created[0].message).toBe(withEmpty)
  })

  it('an assist-only copilot never reads them; its paired notes turn does', async () => {
    useDbWithDirectives({ recipes: ASSIST })
    await post({ ...LIVE, recipe_id: 'r-assist' })
    expect(reads()).toHaveLength(0)
    expect(h.created[0].message).not.toContain('## Notes to record')

    useDbWithDirectives({ recipes: ASSIST })
    h.created = []
    await post({ ...LIVE, recipe_id: 'r-assist', live_role: 'notes' })
    expect(reads()).toHaveLength(1)
    expect(h.created[0].message).toContain('## Notes to record')
  })

  it('the batch pass reads and consumes them, then expires whatever is still pending', async () => {
    useDbWithDirectives({ transcript: 'Speaker 1: ship Friday' })
    h.next = () => fakeTaskResponse(workingTurn())
    await post({ capture_id: FIX.captureId, mode: 'batch' })
    expect(h.created[0].message).toContain('## Notes to record')
    const [consume, expire] = writes()
    expect(consume.payload).toMatchObject({ status: 'consumed' })
    expect(expire.payload).toEqual({ status: 'expired' })
    expect(eqValue(expire, 'status')).toBe('pending')
    expect(eqValue(expire, 'capture_id')).toBe(FIX.captureId)
    expect(expire.filters.some(([m]) => m === 'in')).toBe(false)
  })

  it('an eval capture reads the ones its eval driver injected, and consumes them like any turn (L5)', async () => {
    useDbWithDirectives({ isEval: true })
    h.next = () => fakeTaskResponse(workingTurn())
    await post(LIVE)
    expect(reads()).toHaveLength(1)
    expect(eqValue(reads()[0], 'created_by')).toBe(FIX.userId)
    expect(h.created[0].message).toContain('## Notes to record')
    expect(writes()).toHaveLength(1)
    expect(writes()[0].payload).toMatchObject({ status: 'consumed' })
  })

  it('a failed read runs the turn without them (they stay pending)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    useDbWithDirectives({}, [], { message: 'boom' })
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    expect(h.created[0].message).not.toContain('## Notes to record')
    expect(writes()).toHaveLength(0)
    expect(warn).toHaveBeenCalledWith('[live-directive] could not read pending directives', expect.objectContaining({ error: 'boom' }))
    warn.mockRestore()
  })

  describe('record_only: the out-of-cycle record turn (L3)', () => {
    it('with directives pending, runs the turn and says the transcript is context, not new', async () => {
      useDbWithDirectives()
      h.next = () => fakeTaskResponse(workingTurn())
      const res = await post({ ...LIVE, record_only: true })
      expect(res.status).toBe(200)
      const message = h.created[0].message
      expect(message).toContain('## Notes to record')
      expect(message).toContain('RECORD-ONLY TURN: there is no new transcript since the last turn.')
      expect(message).toContain('Recent transcript (already processed):\nSpeaker 1: ship Friday')
      expect(message).not.toContain('New transcript:')
      // …and consumes what it read, like any record turn.
      expect(writes()[0].payload).toMatchObject({ status: 'consumed' })
    })

    it('with nothing pending, runs no model at all (no session, no usage) and still answers pair_notes', async () => {
      useDbWithDirectives({}, [])
      const res = await post({ ...LIVE, record_only: true })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ ok: true, skipped: 'no_directives', tool_calls: 0, pair_notes: false })
      expect(h.created).toHaveLength(0)
      expect(h.usage).toHaveLength(0)
      expect(writes()).toHaveLength(0)
    })

    it('an assist-only copilot reads none, so it skips — telling a client that has not paired yet to run its notes turn', async () => {
      useDbWithDirectives({ recipes: ASSIST })
      const res = await post({ ...LIVE, recipe_id: 'r-assist', record_only: true })
      expect(await res.json()).toMatchObject({ skipped: 'no_directives', pair_notes: true })
      expect(h.created).toHaveLength(0)
    })

    it('the paired notes turn records them', async () => {
      useDbWithDirectives({ recipes: ASSIST })
      h.next = () => fakeTaskResponse(workingTurn())
      await post({ ...LIVE, recipe_id: 'r-assist', live_role: 'notes', record_only: true })
      expect(h.created).toHaveLength(1)
      expect(h.created[0].message).toContain('RECORD-ONLY TURN')
    })

    it('is ignored in batch mode', async () => {
      useDbWithDirectives({ transcript: 'Speaker 1: ship Friday' }, [])
      h.next = () => fakeTaskResponse(workingTurn())
      await post({ capture_id: FIX.captureId, mode: 'batch', record_only: true })
      expect(h.created).toHaveLength(1)
      expect(h.created[0].message).not.toContain('RECORD-ONLY TURN')
    })

    it('without the flag a turn is unchanged, directives or not', async () => {
      useDbWithDirectives({}, [])
      await post(LIVE)
      expect(h.created[0].message).toContain('New transcript:')
      expect(h.created[0].message).not.toContain('RECORD-ONLY')
    })
  })
})

// ── Turn budgets, the reduced-context retry, tick skipping (2026-10-15) ────────

describe('turn budgets, the reduced-context retry, and tick skipping', () => {
  const DIRECTIVES = [{ id: 'd-1', source: 'user', text: 'Note that Dana owns the budget' }]
  const useDbWithDirectives = (opts: FixtureOptions = {}) =>
    useDb(opts, (q) => (q.table === 'live_directive' && q.op === 'select' ? { data: DIRECTIVES, error: null } : undefined))
  /** A turn that fails with `code` before any step completed. */
  const failedTurn = (code = 'MODEL_CALL_FAILED') => [
    ev.sessionStarted(),
    ev.turnStarted(),
    ev.stepStarted(0),
    ev.sessionFailed(code, 'The model request was rejected. Check the request and try again.'),
  ]
  /** Answers each create in turn with the next response factory (the last one repeats). */
  const sequence = (...responses: Array<() => FakeTaskResponse>) => {
    let i = 0
    h.next = () => responses[Math.min(i++, responses.length - 1)]()
  }
  const stepsOf = (n: number) => {
    const steps: MessageStreamEvent[] = [ev.turnStarted()]
    for (let i = 0; i < n; i++) steps.push(ev.stepCompleted(i, 'tool-calls'))
    return steps
  }

  it('a person’s record turn runs at most its own small step budget (≤ 4)', async () => {
    useDbWithDirectives()
    h.next = () => fakeTaskResponse(stepsOf(20), { hangAfter: 21, afterCancel: [ev.turnCancelled()] })
    const json = (await (await post({ ...LIVE, record_only: true })).json()) as Record<string, unknown>
    expect(LIVE_TURN_BUDGETS.record.maxSteps).toBeLessThanOrEqual(4)
    expect(json).toMatchObject({ steps_used: LIVE_TURN_BUDGETS.record.maxSteps, budget_hit: 'steps' })
    expect(h.usage[0].metadata).toMatchObject({ turn_kind: 'record', live_role: 'copilot', budget_hit: 'steps' })
  })

  it('a tick runs at most the tick budget; the batch keeps its own', async () => {
    h.next = () => fakeTaskResponse(stepsOf(20), { hangAfter: 21, afterCancel: [ev.turnCancelled()] })
    const tick = (await (await post(LIVE)).json()) as Record<string, unknown>
    expect(tick).toMatchObject({ steps_used: LIVE_TURN_BUDGETS.tick.maxSteps, budget_hit: 'steps' })
    expect(h.usage[0].metadata).toMatchObject({ turn_kind: 'tick' })

    h.usage = []
    h.next = () => fakeTaskResponse([...stepsOf(20), ev.stepCompleted(20, 'stop'), ev.sessionCompleted()])
    const batch = (await (await post({ capture_id: FIX.captureId, mode: 'batch' })).json()) as Record<string, unknown>
    expect(batch.steps_used).toBe(21)
    expect(batch).not.toHaveProperty('budget_hit')
    expect(h.usage[0].metadata).toMatchObject({ turn_kind: 'batch', live_role: null, steps: 21 })
  })

  it('a runaway step (streamed output past the per-step cap) is cancelled before its tool runs; earlier steps stand', async () => {
    const cap = LIVE_TURN_BUDGETS.tick.maxStepOutputTokens * OUTPUT_CHARS_PER_TOKEN
    const turn: MessageStreamEvent[] = [
      ev.turnStarted(),
      ev.stepStarted(0),
      ev.toolCall(0, 'c1', 'propose_change', { change_type: 'create', entity_type: 'action', title: 'Ship Friday' }),
      ev.stepCompleted(0, 'tool-calls', { inputTokens: 9000, outputTokens: 120 }),
      ev.toolResult(0, 'c1', 'propose_change', { success: true, proposal_id: 'p-1' }),
      ev.stepStarted(1),
      ev.text(1, 'x'.repeat(cap / 2)),
      ev.text(1, 'x'.repeat(cap / 2 + 10)),
    ]
    h.next = () => fakeTaskResponse(turn, { hangAfter: turn.length, afterCancel: [ev.turnCancelled()] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(h.last!.cancelled()).toBe(1)
    expect(json).toMatchObject({ ok: true, steps_used: 1, tool_calls: 1, budget_hit: 'step-output' })
    expect(h.syncCards).toBe(1) // a normal end: the completed step's proposal is finalized
    expect(h.usage[0].metadata).toMatchObject({ turn_kind: 'tick', budget_hit: 'step-output', steps: 1, max_step_output_tokens: 120 })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('stopped at its step-output budget'))
    warn.mockRestore()
  })

  it('a rejected model call is retried ONCE with reduced context (no package manifest, no prime, the newest chunk only)', async () => {
    useDb({ packageIds: ['pk-1'] })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sequence(
      () => fakeTaskResponse(failedTurn(), { sessionId: 'sess-a' }),
      () => fakeTaskResponse(workingTurn(), { sessionId: 'sess-b' }),
    )
    const res = await post({
      ...LIVE,
      recent_chunks: ['Speaker 2: an older window about the budget', 'Speaker 1: ship Friday'],
      prior_transcript: 'Speaker 2: earlier bit',
    })
    expect(res.status).toBe(200)
    const json = (await res.json()) as Record<string, unknown>
    expect(json).toMatchObject({ ok: true, tool_calls: 2, retried: true })
    expect(h.created).toHaveLength(2)
    const [first, retry] = h.created.map((c) => c.message)
    expect(first).toContain('package_id: pk-1')
    expect(first).toContain('earlier bit')
    expect(first).toContain('an older window')
    expect(retry).not.toContain('package_id: pk-1')
    expect(retry).not.toContain('earlier bit')
    expect(retry).not.toContain('an older window')
    expect(retry).toContain('New transcript:\nSpeaker 1: ship Friday')
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0].metadata).toMatchObject({ retried: true, retry_reason: 'MODEL_CALL_FAILED' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('retrying once with reduced context'))
    warn.mockRestore()
  })

  it('the reduced-context retry keeps the product facts (the rule that stops a guess goes with both attempts)', async () => {
    clearProductDocCache()
    useDb({
      packageIds: ['pk-1'],
      settings: { product_doc: { document_id: 'doc-pf', set_by: FIX.memberId, set_at: '2026-09-01T00:00:00Z' } },
      productDoc: { id: 'doc-pf', content: 'Pro is $20 per seat.' },
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sequence(
      () => fakeTaskResponse(failedTurn(), { sessionId: 'sess-a' }),
      () => fakeTaskResponse(workingTurn(), { sessionId: 'sess-b' }),
    )
    const res = await post(LIVE)
    expect(res.status).toBe(200)
    const [first, retry] = h.created.map((c) => c.message)
    expect(first).toContain(PRODUCT_FACTS_HEADING)
    expect(retry).toContain(PRODUCT_FACTS_HEADING)
    expect(retry).toContain('Pro is $20 per seat.')
    expect(retry).not.toContain('package_id: pk-1')
    // One read for the turn: the retry reuses the section the first attempt built.
    expect(h.log.filter((q) => q.table === 'document' && eqValue(q, 'id') === 'doc-pf')).toHaveLength(1)
    warn.mockRestore()
  })

  it('never retries an attempt that already wrote (a retry could stage the same proposal twice) or a fail-closed refusal', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    h.next = () =>
      fakeTaskResponse([
        ev.stepStarted(0),
        ev.toolCall(0, 'c1', 'propose_change', { change_type: 'create', entity_type: 'action', title: 'Ship Friday' }),
        ev.stepCompleted(0, 'tool-calls', { inputTokens: 50, outputTokens: 5 }),
        ev.sessionFailed('MODEL_CALL_FAILED', 'rejected'),
      ])
    expect((await post(LIVE)).status).toBe(500)
    expect(h.created).toHaveLength(1)

    h.created = []
    h.next = () => fakeTaskResponse(failedTurn('MODEL_SELECTION_FAILED'))
    expect((await post(LIVE)).status).toBe(500)
    expect(h.created).toHaveLength(1)
    error.mockRestore()
  })

  it('a second failure keeps the meeting going: the route answers, logs both attempts’ spend, and logs the reason', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ranThenFailed = () =>
      fakeTaskResponse([
        ev.stepStarted(0),
        ev.stepCompleted(0, 'tool-calls', { inputTokens: 50, outputTokens: 5 }),
        ev.sessionFailed('MODEL_CALL_FAILED', 'rejected'),
      ])
    sequence(ranThenFailed, ranThenFailed)
    const res = await post(LIVE)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Live agent processing failed' })
    expect(h.created).toHaveLength(2)
    expect(h.usage).toHaveLength(1)
    expect(h.usage[0]).toMatchObject({ inputTokens: 100, outputTokens: 10 })
    expect(h.usage[0].metadata).toMatchObject({ retried: true, aborted: true })
    expect(h.syncCards).toBe(0)
    expect(error).toHaveBeenCalledWith(
      'Live agent session failed:',
      expect.stringContaining('MODEL_CALL_FAILED'),
      expect.objectContaining({ kind: 'tick', retried: true, firstFailure: 'MODEL_CALL_FAILED' }),
    )
    // A background tick says nothing in the HUD.
    expect(h.nudges).toHaveLength(0)
    error.mockRestore()
    warn.mockRestore()
  })

  it('a person’s record turn that fails twice tells them in the HUD, and its directives stay pending', async () => {
    useDbWithDirectives()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    h.next = () => fakeTaskResponse(failedTurn())
    const res = await post({ ...LIVE, record_only: true })
    expect(res.status).toBe(500)
    expect(h.created).toHaveLength(2)
    expect(h.nudges).toEqual([expect.objectContaining({ message: RECORD_TURN_FAILED_NOTE, captureId: FIX.captureId })])
    expect(h.log.filter((q) => q.table === 'live_directive' && q.op === 'update')).toHaveLength(0)
    error.mockRestore()
    warn.mockRestore()
  })

  it('the streaming path retries too, and its `done` carries the retried turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    sequence(() => fakeTaskResponse(failedTurn()), () => fakeTaskResponse(workingTurn()))
    const events = await sseEvents(await post({ ...LIVE, stream: true }))
    const done = events.at(-1)!
    expect(done.type).toBe('done')
    expect(done.payload).toMatchObject({ ok: true, retried: true })
    expect(h.created).toHaveLength(2)
    warn.mockRestore()
  })

  it('skips a tick whose newest window is only back-channel (no session, no usage) and still answers pair_notes', async () => {
    const res = await post({
      ...LIVE,
      recent_chunks: ['Speaker 1: ship Friday', '[local_1]: Yeah. Okay.\n[remote_1]: Mm-hmm, right.'],
    })
    expect(await res.json()).toEqual({ ok: true, skipped: 'nothing_new', tool_calls: 0, pair_notes: false })
    expect(h.created).toHaveLength(0)
    expect(h.usage).toHaveLength(0)
  })

  it('never skips a window with real speech, a pending directive, or a meeting-so-far prime', async () => {
    await post({ ...LIVE, recent_chunks: ['[local_1]: Can you send the deck by Friday?'] })
    expect(h.created).toHaveLength(1)
    await post({ ...LIVE, recent_chunks: ['[local_1]: Okay.'], prior_transcript: 'Speaker 2: earlier bit' })
    expect(h.created).toHaveLength(2)
    useDbWithDirectives()
    await post({ ...LIVE, recent_chunks: ['[local_1]: Okay.'] })
    expect(h.created).toHaveLength(3)
  })
})

describe('timeliness (Phase 6): window_age_ms → server-clock token claim + usage telemetry', () => {
  const NOW = new Date('2026-10-18T12:00:00Z').getTime()
  const claimsOf = () => verifyLiveAgentRunToken(h.clientArgs[0].runToken)!
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(NOW)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A tick that says one thing to the user, then stops. */
  const sayTurn = (output: { [key: string]: string | boolean }) => [
    ev.sessionStarted(),
    ev.turnStarted(),
    ev.stepStarted(0),
    ev.toolCall(0, 's1', 'say_to_user', { message: 'Ask about the budget.' }),
    ev.stepCompleted(0, 'tool-calls', { inputTokens: 9000, outputTokens: 40, costUsd: 0 }),
    ev.toolResult(0, 's1', 'say_to_user', output),
    ev.stepStarted(1),
    ev.stepCompleted(1, 'stop', { inputTokens: 9100, outputTokens: 5, costUsd: 0 }),
    ev.turnCompleted(),
    ev.sessionCompleted(),
  ]

  it('a tick turns the client age into a server-clock flush time (claim) and logs the queue wait', async () => {
    await post({ ...LIVE, window_age_ms: 7_000 })
    expect(claimsOf()).toMatchObject({ turnKind: 'tick', windowFlushedAt: NOW - 7_000 })
    expect(h.usage[0].metadata).toMatchObject({ queue_wait_ms: 7_000 })
  })

  it('only the server clock is compared: the old absolute field from a skewed client is ignored', async () => {
    // A Mac running 50 s slow would have sent a timestamp 50 s in the past;
    // the age it measures on its own clock is still the true 2 s.
    await post({ ...LIVE, window_flushed_at: NOW - 52_000, window_age_ms: 2_000 })
    expect(claimsOf().windowFlushedAt).toBe(NOW - 2_000)
  })

  it('no age → no claim, no queue_wait_ms (the guard falls back to the turn start)', async () => {
    await post(LIVE)
    expect(claimsOf().turnKind).toBe('tick')
    expect(claimsOf()).not.toHaveProperty('windowFlushedAt')
    expect(h.usage[0].metadata).not.toHaveProperty('queue_wait_ms')
  })

  it('garbage is ignored; an age past 10 min is clamped, a negative one is 0', async () => {
    await post({ ...LIVE, window_age_ms: 'a while' })
    expect(claimsOf()).not.toHaveProperty('windowFlushedAt')
    h.clientArgs = []
    await post({ ...LIVE, window_age_ms: 60 * 60_000 })
    expect(claimsOf().windowFlushedAt).toBe(NOW - 10 * 60_000)
    h.clientArgs = []
    await post({ ...LIVE, window_age_ms: -5_000 })
    expect(claimsOf().windowFlushedAt).toBe(NOW)
  })

  it('a batch carries its kind and never a flush time', async () => {
    await post({ capture_id: FIX.captureId, mode: 'batch', window_age_ms: 1_000 })
    expect(claimsOf()).toMatchObject({ turnKind: 'batch' })
    expect(claimsOf()).not.toHaveProperty('windowFlushedAt')
  })

  it('a delivered say_to_user logs time_to_first_say_ms and nudge_age_ms; the payload is unchanged', async () => {
    h.next = () => fakeTaskResponse(sayTurn({ delivered: true, id: 'n-1' }))
    const res = await post({ ...LIVE, window_age_ms: 3_000 })
    const json = (await res.json()) as Record<string, unknown>
    expect(json).not.toHaveProperty('stale_nudge_drops')
    expect(h.usage[0].metadata).toMatchObject({
      queue_wait_ms: 3_000,
      time_to_first_say_ms: 0,
      nudge_age_ms: 3_000,
      tool_ms: { say_to_user: { ms: 0, n: 1 } },
    })
  })

  it('coalesced windows: the guard claim and nudge_age_ms use the NEWEST age, queue_wait_ms the OLDEST', async () => {
    h.next = () => fakeTaskResponse(sayTurn({ delivered: true, id: 'n-1' }))
    await post({ ...LIVE, window_age_ms: 2_000, window_queued_age_ms: 50_000 })
    expect(claimsOf().windowFlushedAt).toBe(NOW - 2_000)
    expect(h.usage[0].metadata).toMatchObject({ queue_wait_ms: 50_000, nudge_age_ms: 2_000 })
  })

  it('window_queued_age_ms is clamped like the age and never reaches the token', async () => {
    await post({ ...LIVE, window_age_ms: 1_000, window_queued_age_ms: 60 * 60_000 })
    expect(h.usage[0].metadata).toMatchObject({ queue_wait_ms: 10 * 60_000 })
    const payload = Buffer.from(h.clientArgs[0].runToken.split('.')[0], 'base64url').toString('utf8')
    expect(payload).not.toContain('queued')
    expect(claimsOf().windowFlushedAt).toBe(NOW - 1_000)
  })

  it('a say_to_user the time guard dropped is counted (usage + payload), never as the first say', async () => {
    h.next = () => fakeTaskResponse(sayTurn({ dropped: 'stale', delivered: false, message: 'Not shown' }))
    const res = await post(LIVE)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.stale_nudge_drops).toBe(1)
    expect(h.usage[0].metadata).toMatchObject({ stale_nudge_drops: 1 })
    expect(h.usage[0].metadata).not.toHaveProperty('time_to_first_say_ms')
    expect(h.usage[0].metadata).not.toHaveProperty('nudge_age_ms')
  })

  it('a say_to_user a nudge.worth gate held is counted apart (held_nudge_drops; 0 and absent while shadow)', async () => {
    h.next = () => fakeTaskResponse(sayTurn({ dropped: 'held', delivered: false }))
    const res = await post(LIVE)
    const json = (await res.json()) as Record<string, unknown>
    expect(json.held_nudge_drops).toBe(1)
    expect(json).not.toHaveProperty('stale_nudge_drops')
    expect(h.usage[0].metadata).toMatchObject({ held_nudge_drops: 1 })
    expect(h.usage[0].metadata).not.toHaveProperty('time_to_first_say_ms')
  })
})

describe('recentTail: what was just said, signed for the tool route\'s shadow nudge.worth check', () => {
  const claimsOf = () => verifyLiveAgentRunToken(h.clientArgs[0].runToken)!

  it('a talking tick carries the window\'s newest 600 characters', async () => {
    await post({ ...LIVE, recent_chunks: ['Speaker 1: ship Friday', `${'x'.repeat(700)}   NEWEST`] })
    const tail = claimsOf().recentTail!
    expect(tail).toHaveLength(600)
    expect(tail.endsWith('x NEWEST')).toBe(true)
    h.clientArgs = []
    await post(LIVE)
    expect(claimsOf().recentTail).toBe('Speaker 1: ship Friday')
  })

  it('a notes tick and the batch carry none', async () => {
    await post({ ...LIVE, live_role: 'notes' })
    expect(claimsOf()).not.toHaveProperty('recentTail')
    h.clientArgs = []
    await post({ capture_id: FIX.captureId, mode: 'batch' })
    expect(claimsOf()).not.toHaveProperty('recentTail')
  })
})
