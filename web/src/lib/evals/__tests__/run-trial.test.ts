import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { filterArgs, makeFakeSupabase, type Captured, type FakeResult } from './fake-supabase'
import type { EvalCaseRow } from '../types'

const hoisted = vi.hoisted(() => ({
  cloneTrialCapture: vi.fn(async () => ({ captureId: 'clone-1', transcriptLength: 0 })),
  decideAutoApply: vi.fn((): 'stage' | 'apply' => 'stage'),
  fetchWorkspaceSettings: vi.fn(async () => ({})),
  resolveTrustPolicy: vi.fn(() => ({ enabled: true })),
  broadcastChannel: vi.fn(),
}))

vi.mock('../clone-trial-capture', () => ({ cloneTrialCapture: hoisted.cloneTrialCapture }))
vi.mock('@/lib/proposed-changes/auto-apply-gate', () => ({ decideAutoApply: hoisted.decideAutoApply }))
vi.mock('@/lib/proposed-changes/trust-policy', () => ({
  resolveTrustPolicyFromSettings: hoisted.resolveTrustPolicy,
}))
vi.mock('@/lib/workspace-settings', () => ({ fetchWorkspaceSettings: hoisted.fetchWorkspaceSettings }))
vi.mock('@/lib/supabase/service', () => ({ getServiceClient: () => ({}) }))

const { LiveAgentHttpError, collectNudges, mintRunToken, revokeRunToken, runBatchTrial, runLiveInstantTrial } =
  await import('../run-trial')
// Imported AFTER run-trial so the mocks above are in place for its import graph.
// The gate tests assert the produced trace actually FAILS the grader, not just
// that a field is missing — a shape assertion alone would not prove the canary
// fires.
const { gradeGateRecorded } = await import('../graders/deterministic')

const WS = 'ws-1'
const USER = 'user-1'

const CASE: EvalCaseRow = {
  id: 'case-1',
  suite_id: 'suite-1',
  workspace_id: WS,
  name: 'Discovery call',
  capture_id: 'template-1',
  capture_is_eval: true,
  script: [{ t_ms: 0, speaker: 'Dana', stream: 'system', text: 'Can you send the questionnaire?' }],
  chunks: [
    { index: 0, t_ms_start: 0, t_ms_end: 5000, segment_indices: [0], text: '[Dana]: chunk one' },
    { index: 1, t_ms_start: 9000, t_ms_end: 14000, segment_indices: [1], text: '[Liam]: chunk two' },
  ],
  expected: {},
  modes: ['batch', 'live'],
  polarity: 'positive',
  seeded_from_capture_id: null,
  visibility: 'workspace',
  created_by: null,
  sort_order: 0,
  created_at: '2026-09-08T00:00:00Z',
  updated_at: '2026-09-08T00:00:00Z',
}

/**
 * A fake with the tables both drivers read back from.
 *
 * `extraction_pass` is the route's OWN record of which proposals its auto-apply
 * block decided on, and `readBackCapture` stamps a `gate` only on the ids it
 * finds there. By default every proposal in `opts.proposals` is gated — the
 * normal case. Pass `gatedIds: []` to simulate the block never running, which is
 * exactly what `gate_recorded` exists to catch.
 */
function fixture(
  opts: {
    proposals?: Array<{ id: string } & Record<string, unknown>>
    usage?: unknown[]
    appendStatus?: string
    gatedIds?: string[]
  } = {},
) {
  const gated = opts.gatedIds ?? (opts.proposals ?? []).map((p) => p.id)
  return makeFakeSupabase((q: Captured): FakeResult => {
    if (q.table === 'captures') return { data: { ai_summary: 'a summary', title: 'a title' } }
    if (q.table === 'extraction_pass') {
      return {
        data: gated.length
          ? [
              {
                ledger: {
                  entries: gated.map((id) => ({
                    proposal_id: id,
                    decision: 'accept',
                    outcome: 'carded',
                    reason: 'gate staged — pending review',
                  })),
                },
              },
            ]
          : [],
      }
    }
    if (q.table === 'proposed_change') return { data: opts.proposals ?? [] }
    if (q.table === 'ai_usage_logs') return { data: opts.usage ?? [] }
    if (q.table === 'chat_conversations') return { data: null }
    if (q.table === 'chat_messages') return { data: [] }
    if (q.table === 'device_token') return { data: { id: 'token-row-1' } }
    return { data: null }
  })
}

/** The channel + rpc surface the live driver needs, layered onto a fake. */
function withRealtime(
  client: ReturnType<typeof fixture>['client'],
  // 'applied' is what append_capture_transcript actually returns on success
  // (migration 192). This default was 'ok' — a status the RPC has never
  // returned — which is precisely how the driver's matching bug survived: the
  // mock and the driver agreed with each other, and neither agreed with the DB.
  appendStatus = 'applied',
  seededLength = 0,
) {
  const c = client as unknown as Record<string, unknown>
  c.channel = () => ({
    on() {
      return this
    },
    subscribe(cb: (s: string) => void) {
      cb('SUBSCRIBED')
      return this
    },
  })
  c.removeChannel = async () => {}
  // Honest about the compare-and-swap: a base length that is not the server's
  // own is what the real RPC refuses, and a live clone now starts NON-empty.
  let length = seededLength
  c.rpc = async (
    _name: string,
    params: { p_append: string; p_base_length: number },
  ) => {
    if (params.p_base_length !== length) {
      return { data: [{ status: 'conflict', server_length: length }], error: null }
    }
    length += params.p_append.length
    return { data: [{ status: appendStatus, server_length: length }], error: null }
  }
  return client
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** A fetch double whose recorded calls are TYPED, so a test can read the url
 *  and the init back without casting through `unknown`. */
function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const mock = vi.fn((url: string, init: RequestInit) => Promise.resolve(handler(url, init)))
  vi.stubGlobal('fetch', mock)
  return mock
}

beforeEach(() => {
  vi.restoreAllMocks()
  hoisted.cloneTrialCapture.mockClear()
  hoisted.decideAutoApply.mockReturnValue('stage')
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.test')
})

describe('the run token', () => {
  it('pins the workspace and a TTL, so a leaked log is worthless tomorrow', async () => {
    const { client, queries } = fixture()
    const token = await mintRunToken(client, { userId: USER, workspaceId: WS, runId: 'run-abcdef12' })
    expect(token.token).toMatch(/^nid_/)
    expect(token.tokenId).toBe('token-row-1')

    const payload = queries.find((q) => q.table === 'device_token')!.payload as {
      user_id: string
      active_workspace_id: string
      expires_at: string
      token_hash: string
    }
    expect(payload.user_id).toBe(USER)
    // Pinned, not left to the "oldest workspace" fallback.
    expect(payload.active_workspace_id).toBe(WS)
    expect(new Date(payload.expires_at).getTime()).toBeGreaterThan(Date.now())
    // Only the hash is stored — never the plaintext.
    expect(payload.token_hash).not.toContain(token.token)
  })

  it('deletes the row on revoke and swallows a failure — the TTL is the backstop', async () => {
    const { client, queries } = makeFakeSupabase((): FakeResult => ({ error: { message: 'gone' } }))
    await expect(revokeRunToken(client, 'token-row-1')).resolves.toBeUndefined()
    expect(queries.find((q) => q.table === 'device_token')!.op).toBe('delete')
  })
})

describe('runBatchTrial', () => {
  it('posts as a real client: bearer token, workspace header, mode batch, no auto-archive', async () => {
    const fetchMock = stubFetch(() =>
      jsonResponse({ ok: true, tool_calls: 1, tool_call_details: [{ tool: 'write_summary', args: {} }], steps_used: 4, finish_reason: 'stop', duration_ms: 3000 }),
    )

    const { client } = fixture()
    await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: 'recipe-1',
      token: 'nid_secret',
    })

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://dial8.test/api/ai/live-agent')
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer nid_secret')
    expect(headers['x-workspace-id']).toBe(WS)
    const body = JSON.parse(init.body as string)
    expect(body).toMatchObject({ capture_id: 'clone-1', mode: 'batch', stream: false, allow_auto_archive: false })
  })

  it('clones with mode batch — the transcript is populated for a one-shot run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture()
    await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(hoisted.cloneTrialCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'batch', runStarterUserId: USER }),
    )
  })

  /**
   * DEFECT 2a — batch built its ONE flush record with `chunk_text: ''`, because
   * the route reads the transcript off the capture server-side rather than
   * through a flush. The judges reconstruct their transcript from exactly that
   * field, so on DEV judge_summary and judge_proposal_quality both returned
   * `unknown` saying no transcript was provided. The trace must be honest about
   * what the agent saw.
   */
  it('records the transcript the route processed on the batch flush', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture()
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    const [flush] = out.trace.flushes
    expect(flush.chunk_text).toBe('[Dana]: Can you send the questionnaire?')
    // `chars` counts the same text, not a separately derived length.
    expect(flush.chars).toBe(flush.chunk_text.length)
  })

  it('treats a SKIPPED response as errored, never as a scored zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true, skipped: 'empty_transcript' })))
    const { client } = fixture()
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.errorCode).toBe('empty_transcript')
    expect(out.trace.flushes).toEqual([])
  })

  it('rethrows a 429 so the LANE can call it a usage wall rather than a trial failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('over limit', { status: 429 })))
    const { client } = fixture()
    await expect(
      runBatchTrial(client, { caseRow: CASE, workspaceId: WS, runStarterUserId: USER, recipeId: null, token: 't' }),
    ).rejects.toBeInstanceOf(LiveAgentHttpError)
  })

  it('records summary_source from the TOOL CALL, not from captures.ai_summary', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, tool_call_details: [{ tool: 'propose_change', args: {} }] })),
    )
    const { client } = fixture()
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    // The capture read returns 'a summary', but no summary tool was called.
    expect(out.trace.summary_final).toBe('a summary')
    expect(out.trace.summary_source).toBe('none')
  })

  it('splits tool calls into commitments and reads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        jsonResponse({
          ok: true,
          tool_call_details: [
            // The tool's INPUT schema — what the route records as `args`. The
            // `{text, subject}` shape is the eval short-circuit's RETURN value
            // and never reaches the trace; a fixture using it would ratify a
            // reader that always produced an empty commitment.
            {
              tool: 'record_commitment',
              args: {
                person_name: 'Dana',
                commitment: 'Dana will review',
                trigger_quote: 'I will review it tonight',
                confidence: 0.8,
              },
            },
            { tool: 'list_projects', args: { limit: 5 } },
            { tool: 'propose_change', args: {} },
          ],
        }),
      ),
    )
    const { client } = fixture()
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.commitments).toEqual([
      {
        text: 'Dana will review',
        subject: 'Dana',
        trigger_quote: 'I will review it tonight',
        confidence: 0.8,
      },
    ])
    // propose_change is a write, so only list_projects is a read.
    expect(out.trace.reads.map((r) => r.tool)).toEqual(['list_projects'])
  })
})

describe('the counterfactual on every proposal', () => {
  it('re-runs the gate in ACT mode — report mode records no counterfactual of its own', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    hoisted.decideAutoApply.mockReturnValue('apply')

    const { client } = fixture({
      proposals: [
        {
          id: 'p1',
          entity_type: 'action',
          change_type: 'create',
          title: 't',
          display_text: 'd',
          confidence: 0.91,
          status: 'pending',
          assignee_name: 'Liam',
          extra: { is_explicitly_stated: true },
        },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })

    expect(out.trace.proposals_final[0].gate).toEqual({ decision: 'stage', would_have_applied: true })
    expect(hoisted.decideAutoApply).toHaveBeenCalledWith(
      expect.objectContaining({ confidence: 0.91 }),
      expect.anything(),
      expect.objectContaining({ mode: 'act', authority: 'extraction', isExplicitlyStated: true }),
    )
  })

  it('reports would_have_applied false when the gate would still have staged', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    hoisted.decideAutoApply.mockReturnValue('stage')
    const { client } = fixture({
      proposals: [
        { id: 'p1', entity_type: 'action', change_type: 'create', title: null, display_text: 'd', confidence: 0.3, status: 'pending', assignee_name: null, extra: null },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.proposals_final[0].gate?.would_have_applied).toBe(false)
  })

  it('leaves gate UNDEFINED when the route recorded no pass — the isolation canary', async () => {
    // The failure this exists to catch: the route's auto-apply block is guarded
    // on `!aborted && currentMemberId && trustPolicy.enabled`, so a null member
    // or a disabled policy skips it entirely. No pass is flushed, the
    // counterfactual — the highest-value thing a trial measures — is absent, and
    // every other check still passes. Stamping `gate` unconditionally here would
    // make `gate_recorded` vacuously true, which is the exact defect it replaced.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      proposals: [
        { id: 'p1', entity_type: 'action', change_type: 'create', title: null, display_text: 'd', confidence: 0.9, status: 'pending', assignee_name: null, extra: null },
      ],
      gatedIds: [],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })

    expect(out.trace.proposals_final[0].gate).toBeUndefined()
    // And the grader must actually FAIL on that trace, not merely score lower.
    const graded = gradeGateRecorded(out.trace)
    expect(graded.outcome).toBe('fail')
    expect(graded.severity).toBe('gate')
  })

  it('gates only the proposals the route recorded, not every row it reads back', async () => {
    // A partial pass (one proposal decided, another arriving after the loop)
    // must show up as a partial gate, not be papered over.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      proposals: [
        { id: 'p1', entity_type: 'action', change_type: 'create', title: null, display_text: 'd', confidence: 0.9, status: 'pending', assignee_name: null, extra: null },
        { id: 'p2', entity_type: 'action', change_type: 'create', title: null, display_text: 'd', confidence: 0.9, status: 'pending', assignee_name: null, extra: null },
      ],
      gatedIds: ['p1'],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })

    expect(out.trace.proposals_final[0].gate).toBeDefined()
    expect(out.trace.proposals_final[1].gate).toBeUndefined()
    expect(gradeGateRecorded(out.trace).outcome).toBe('fail')
  })

  it('scopes the pass read to this trial capture AND workspace', async () => {
    // The clients here are service-role; a read without both fences would let
    // another workspace's pass rows vouch for this trial's proposals.
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const built = fixture({ proposals: [] })
    await runBatchTrial(built.client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    const pass = built.queries.find((q) => q.table === 'extraction_pass')
    expect(pass).toBeDefined()
    expect(filterArgs(pass!, 'eq')).toContainEqual(['workspace_id', WS])
    expect(filterArgs(pass!, 'eq')).toContainEqual(['capture_id', 'clone-1'])
  })
})

describe('usage mirroring', () => {
  it('reads the REAL cost out of metadata, since skipBilling forces cost_usd to zero', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      usage: [
        { input_tokens: 4000, output_tokens: 300, model: 'deepseek-v4-flash', metadata: { eval: true, realCostUsd: 0.0119 } },
        { input_tokens: 4200, output_tokens: 280, model: 'deepseek-v4-flash', metadata: { eval: true, realCostUsd: 0.0121 } },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
      targetModel: 'fallback',
    })
    expect(out.trace.usage).toEqual({ tokens_in: 8200, tokens_out: 580, cost_usd: 0.024, model: 'deepseek-v4-flash' })
  })

  it('ignores rows without the eval stamp, so a concurrent REAL meeting cannot contaminate the trial', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      usage: [
        { input_tokens: 999999, output_tokens: 999999, model: 'other', metadata: null },
        { input_tokens: 100, output_tokens: 10, model: 'deepseek-v4-flash', metadata: { eval: true, realCostUsd: 0.001 } },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.usage.tokens_in).toBe(100)
  })

  /**
   * DEFECT — `ai_usage_logs` has no workspace_id, the lane's concurrency key is
   * the workspace, and the run token's identity is a plain user id. So one user
   * with runs in two workspaces had each trial summing the other's rows, and the
   * inflated total is what `max_cost_usd` and the monthly cap then read.
   */
  it('ignores an eval row stamped with a DIFFERENT capture — a concurrent eval run in another workspace', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      usage: [
        // Another workspace's trial, same user, same window, same eval stamp.
        { input_tokens: 999999, output_tokens: 999999, model: 'other', metadata: { eval: true, realCostUsd: 9.99, captureId: 'someone-elses-clone' } },
        { input_tokens: 100, output_tokens: 10, model: 'deepseek-v4-flash', metadata: { eval: true, realCostUsd: 0.001, captureId: 'clone-1' } },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.usage.tokens_in).toBe(100)
    expect(out.trace.usage.cost_usd).toBeCloseTo(0.001, 8)
  })

  it('still counts a row the route has not stamped with a capture yet — narrowing must never drop real spend', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture({
      usage: [
        { input_tokens: 100, output_tokens: 10, model: 'deepseek-v4-flash', metadata: { eval: true, realCostUsd: 0.001 } },
      ],
    })
    const out = await runBatchTrial(client, {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.usage.tokens_in).toBe(100)
  })
})

describe('runLiveInstantTrial', () => {
  it('posts once per frozen chunk with a rolling 3-chunk window', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, tool_calls: 0, tool_call_details: [] }))
    const { client } = fixture()
    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).recent_chunks).toEqual([
      '[Dana]: chunk one',
    ])
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).recent_chunks).toEqual([
      '[Dana]: chunk one',
      '[Liam]: chunk two',
    ])
    expect(out.trace.flushes).toHaveLength(2)
    expect(out.trace.mode).toBe('live')
  })

  it('sends each window with window_age_ms 0 (it goes at once), recording the send time as started_at_ms', async () => {
    const before = Date.now()
    const fetchMock = stubFetch(() => jsonResponse({ ok: true, tool_calls: 0, tool_call_details: [] }))
    const { client } = fixture()
    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    const bodies = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body as string))
    expect(bodies.map((b) => b.window_age_ms)).toEqual([0, 0])
    for (const b of bodies) expect(b).not.toHaveProperty('window_flushed_at')
    for (const f of out.trace.flushes) expect(f.started_at_ms).toBeGreaterThanOrEqual(before)
  })

  it('carries the route’s stale_nudge_drops onto the flush, and does not wait for a broadcast that never comes', async () => {
    stubFetch(() =>
      jsonResponse({ ok: true, tool_calls: 1, tool_call_details: [{ tool: 'say_to_user', args: { message: 'late' } }], stale_nudge_drops: 1 }),
    )
    const { client } = fixture()
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.flushes.map((f) => f.stale_nudge_drops)).toEqual([1, 1])
    // No NUDGE_TAIL_GRACE_MS wait: every say_to_user call is accounted for.
    const { NUDGE_TAIL_GRACE_MS } = await import('../run-trial')
    expect(timeouts.mock.calls.some(([, ms]) => ms === NUDGE_TAIL_GRACE_MS)).toBe(false)
    timeouts.mockRestore()
  })

  it('clones with mode live so the transcript starts EMPTY and accumulates', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture()
    await runLiveInstantTrial(withRealtime(client), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(hoisted.cloneTrialCapture).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ mode: 'live' }),
    )
  })

  /**
   * DEFECT — a live clone is no longer blank: it carries the self speaker's
   * label line so `positionEvidenceHolds` is true on flush 1 and the self
   * binding is not revoked. The append RPC compare-and-swaps on the SERVER's
   * length, so a driver that still assumed zero would fail every append and the
   * trial would error at chunk 0 with `transcript_conflict`.
   */
  it('starts the append chain at the clone\'s SEEDED length, not zero', async () => {
    const SEED = '[local_1]\n'
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    hoisted.cloneTrialCapture.mockResolvedValue({
      captureId: 'clone-1',
      transcriptLength: SEED.length,
    } as never)
    const { client } = fixture()
    const out = await runLiveInstantTrial(withRealtime(client, 'applied', SEED.length), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    // Every chunk appended cleanly — no `transcript_conflict` from a stale base.
    expect(out.errorCode).toBeUndefined()
    expect(out.trace.flushes).toHaveLength(2)
  })

  it('records steps_used and finish_reason per flush, for the step-ceiling grader', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse({ ok: true, steps_used: 20, finish_reason: 'tool-calls' })),
    )
    const { client } = fixture()
    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.trace.flushes[0]).toMatchObject({ steps_used: 20, finish_reason: 'tool-calls' })
  })

  it('stops with a terminal error when the append RPC returns locked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = fixture()
    const out = await runLiveInstantTrial(withRealtime(client, 'locked'), {
      caseRow: CASE,
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.errorCode).toBe('transcript_locked')
    // The flush that produced it is still recorded — a partial trace is useful.
    expect(out.trace.flushes).toHaveLength(1)
  })

  it('errors the trial when the agent asked a question the case cannot answer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    const { client } = makeFakeSupabase((q: Captured): FakeResult => {
      if (q.table === 'chat_conversations') return { data: { id: 'conv-1' } }
      if (q.table === 'chat_messages') {
        return {
          data: [
            {
              id: 'm1',
              ui_message: {
                parts: [
                  {
                    type: 'tool-ask_user',
                    state: 'input-available',
                    toolCallId: 'tc1',
                    input: { questions: [{ question: 'Which project is this for?' }] },
                  },
                ],
              },
            },
          ],
        }
      }
      if (q.table === 'captures') return { data: { ai_summary: null, title: null } }
      return { data: [] }
    })
    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: { ...CASE, expected: {} },
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.errorCode).toBe('unanswered_question')
  })

  it('answers a pending question from expected.answers and keeps going', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ ok: true })))
    let answered = false
    const { client, queries } = makeFakeSupabase((q: Captured): FakeResult => {
      if (q.table === 'chat_conversations') return { data: { id: 'conv-1' } }
      if (q.table === 'chat_messages') {
        if (q.op === 'update') {
          answered = true
          return { data: null }
        }
        return {
          data: answered
            ? []
            : [
                {
                  id: 'm1',
                  ui_message: {
                    parts: [
                      {
                        type: 'tool-ask_user',
                        state: 'input-available',
                        toolCallId: 'tc1',
                        input: { questions: [{ question: 'Which project is this for?' }] },
                      },
                    ],
                  },
                },
              ],
        }
      }
      if (q.table === 'captures') return { data: { ai_summary: null, title: null } }
      return { data: [] }
    })

    const out = await runLiveInstantTrial(withRealtime(client), {
      caseRow: { ...CASE, expected: { answers: { which_project: 'The Northwind renewal' } } },
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(out.errorCode).toBeUndefined()
    expect(out.trace.flushes).toHaveLength(2)

    // Only the targeted part is flipped — the mutation the answer route makes.
    const update = queries.find((q) => q.table === 'chat_messages' && q.op === 'update')!
    const parts = (update.payload as { ui_message: { parts: Array<{ state: string; output: unknown }> } })
      .ui_message.parts
    expect(parts[0].state).toBe('output-available')
    expect(parts[0].output).toEqual({ answers: ['The Northwind renewal'] })
  })
})

// ── The append contract, pinned to the database ────────────────────────────
//
// Every live-replay trial in the workspace errored on its first chunk with
// `transcript_applied` because the driver treated 'ok' as the success status.
// `append_capture_transcript` has never returned 'ok' — migration 192 returns
// 'applied' — so the replay aborted before a single flush was graded, and the
// three live runs recorded between 2026-09-08 and 2026-09-11 produced no
// checks at all. Batch trials never append, which is why the smoke suites
// stayed green throughout and the breakage was invisible.
//
// The behavioral tests above cannot catch a recurrence on their own: they mock
// the RPC, so a driver and a fixture that share the same wrong literal agree
// with each other forever. These assertions read the migration and the
// production consumer instead — the two places that define the real contract.
describe('append_capture_transcript success status', () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), 'utf8')

  it("the RPC's success status is 'applied', and never 'ok'", () => {
    const migration = read('supabase/migrations/192_transcript_append_rpc.sql')
    expect(migration).toMatch(/status 'applied'/)
    expect(migration, "the RPC does not define an 'ok' status").not.toMatch(/'ok'::text/)
  })

  it('the eval driver matches the status the RPC actually returns', () => {
    const driver = read('src/lib/evals/run-trial.ts')
    expect(driver).toMatch(/appendRow\?\.status === 'applied'/)
    expect(driver, "'ok' is not a status this RPC returns").not.toMatch(
      /appendRow\?\.status === 'ok'/,
    )
  })

  it('agrees with the production transcript-append route', () => {
    // The route that real meetings go through switches on the same literal.
    // These two consumers disagreeing is the bug; asserting they agree is the
    // cheapest durable guard against it happening again.
    const route = read('src/app/api/account/captures/[id]/transcript-append/route.ts')
    expect(route).toMatch(/case 'applied':/)
  })
})

/**
 * Directives injected mid-replay (live-agent messaging L5). The driver writes
 * each one through the chat's `@notes` writer, as the run starter, at the point
 * the case names, then runs the record turn the client runs when a directive
 * arrives with nothing buffered (L3). The order of those writes against the
 * route calls is the whole behaviour, so the fixture records one timeline.
 */
describe('directives injected mid-replay (L5)', () => {
  type Status = { status: string; consumed_session: string | null }
  function directiveFixture(opts: { statuses?: Record<string, Status>; insertError?: string; readError?: string } = {}) {
    let n = 0
    const timeline: string[] = []
    const inserted: Array<Record<string, unknown>> = []
    const fake = makeFakeSupabase((q: Captured): FakeResult => {
      if (q.table === 'live_directive') {
        if (q.op === 'insert') {
          if (opts.insertError) return { data: null, error: { message: opts.insertError } }
          const payload = q.payload as Record<string, unknown>
          const id = `dir-${++n}`
          inserted.push({ id, ...payload })
          timeline.push(`write:${payload.text}`)
          return { data: { id, status: 'pending', ...payload } }
        }
        const idIn = filterArgs(q, 'in')[0]
        if (idIn) {
          if (opts.readError) return { data: null, error: { message: opts.readError } }
          const ids = idIn[1] as string[]
          return {
            data: ids.map((id) => ({
              id,
              status: opts.statuses?.[id]?.status ?? 'pending',
              consumed_session: opts.statuses?.[id]?.consumed_session ?? null,
            })),
          }
        }
        return { count: 0 } // the writer's per-author pending cap
      }
      if (q.table === 'captures') return { data: { ai_summary: 'a summary', title: 'a title' } }
      if (q.table === 'extraction_pass') return { data: [] }
      if (q.table === 'proposed_change') return { data: [] }
      if (q.table === 'ai_usage_logs') return { data: [] }
      return { data: null }
    })
    return { ...fake, timeline, inserted }
  }

  /** The route double: records each call on the same timeline. */
  function routeDouble(
    timeline: string[],
    answer: (body: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true, tool_calls: 0 }),
  ) {
    return stubFetch((_url, init) => {
      const body = JSON.parse(init.body as string) as Record<string, unknown>
      timeline.push(
        body.mode === 'batch'
          ? 'post:batch'
          : `post:${body.record_only ? 'record' : 'window'}${body.live_role ? `:${body.live_role}` : ''}`,
      )
      return jsonResponse(answer(body))
    })
  }

  const withDirectives = (directives: NonNullable<EvalCaseRow['expected']['directives']>): EvalCaseRow => ({
    ...CASE,
    expected: { directives },
  })
  const BUDGET = { key: 'budget', text: 'Dana owns the budget', must_contain: ['Dana'] }
  const run = (client: SupabaseLike, caseRow: EvalCaseRow) =>
    runLiveInstantTrial(withRealtime(client), { caseRow, workspaceId: WS, runStarterUserId: USER, recipeId: null, token: 't' })
  type SupabaseLike = ReturnType<typeof fixture>['client']

  it('after chunk 0: written after that flush, then ONE record-only turn over the windows already sent', async () => {
    const fx = directiveFixture({ statuses: { 'dir-1': { status: 'consumed', consumed_session: 'sess-9' } } })
    const fetchMock = routeDouble(fx.timeline)
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 0 }]))

    expect(fx.timeline).toEqual(['post:window', 'write:Dana owns the budget', 'post:record', 'post:window'])
    expect(fx.inserted[0]).toMatchObject({
      capture_id: 'clone-1',
      workspace_id: WS,
      created_by: USER,
      source: 'user',
      text: 'Dana owns the budget',
    })
    const recordBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(recordBody).toMatchObject({ capture_id: 'clone-1', mode: 'live', record_only: true, stream: false })
    // A record turn has no new window, so no flush time; its send time is still recorded.
    expect(recordBody).not.toHaveProperty('window_age_ms')
    expect(typeof out.trace.flushes[1].started_at_ms).toBe('number')
    expect(recordBody.recent_chunks).toEqual(['[Dana]: chunk one'])
    expect(recordBody.live_role).toBeUndefined()

    expect(out.trace.flushes.map((f) => [f.index, f.record_only ?? false])).toEqual([
      [0, false],
      [0, true],
      [1, false],
    ])
    expect(out.trace.flushes[1]).toMatchObject({ chunk_text: '', chars: 0, t_ms: 5000, directive_keys: ['budget'] })
    expect(out.trace.directives).toEqual([
      { key: 'budget', id: 'dir-1', text: 'Dana owns the budget', after_chunk: 0, status: 'consumed', consumed_session: 'sess-9' },
    ])
    expect(out.errorCode).toBeUndefined()
  })

  it('no after_chunk: written before the first chunk, so the first window carries it (no record turn)', async () => {
    const fx = directiveFixture()
    routeDouble(fx.timeline)
    const out = await run(fx.client, withDirectives([BUDGET]))
    expect(fx.timeline).toEqual(['write:Dana owns the budget', 'post:window', 'post:window'])
    expect(out.trace.directives?.[0]).toMatchObject({ after_chunk: null, status: 'pending' })
  })

  it('an after_chunk past the end lands after the last chunk', async () => {
    const fx = directiveFixture()
    routeDouble(fx.timeline)
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 9 }]))
    expect(fx.timeline).toEqual(['post:window', 'post:window', 'write:Dana owns the budget', 'post:record'])
    expect(out.trace.directives?.[0].after_chunk).toBe(1)
  })

  it('a paired recipe: the record turn goes to the note-taker', async () => {
    const fx = directiveFixture()
    routeDouble(fx.timeline, () => ({ ok: true, pair_notes: true }))
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 0 }]))
    expect(fx.timeline).toEqual(['post:window', 'write:Dana owns the budget', 'post:record:notes', 'post:window'])
    expect(out.trace.flushes[1]).toMatchObject({ record_only: true, live_role: 'notes' })
  })

  it('not yet paired: the copilot record turn skips and says pair, and the note-taker records it', async () => {
    const fx = directiveFixture()
    routeDouble(fx.timeline, (body) =>
      body.record_only && !body.live_role
        ? { ok: true, skipped: 'no_directives', tool_calls: 0, pair_notes: true }
        : { ok: true, tool_calls: 1, tool_call_details: [{ tool: 'update_summary' }] },
    )
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 0 }]))
    expect(fx.timeline).toEqual([
      'post:window',
      'write:Dana owns the budget',
      'post:record',
      'post:record:notes',
      'post:window',
    ])
    // One record flush: the turn that ran, not the skip.
    const records = out.trace.flushes.filter((f) => f.record_only)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ live_role: 'notes', response: { tool_calls: 1 } })
  })

  it('a directive that cannot be written errors the trial: no record turn and no later window', async () => {
    const fx = directiveFixture({ insertError: 'permission denied' })
    routeDouble(fx.timeline)
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 0 }]))
    expect(fx.timeline).toEqual(['post:window'])
    expect(out.errorCode).toBe('directive_not_injected')
    expect(out.errorMessage).toContain('budget')
    expect(out.trace.flushes).toHaveLength(1)
  })

  it('a case without directives never touches live_directive and carries no directives in its trace', async () => {
    const fx = directiveFixture()
    routeDouble(fx.timeline)
    const out = await run(fx.client, CASE)
    expect(fx.queries.some((q) => q.table === 'live_directive')).toBe(false)
    expect(out.trace.directives).toBeUndefined()
    expect(fx.timeline).toEqual(['post:window', 'post:window'])
  })

  it('a failed read-back leaves the status unknown (null), never a guessed pending', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fx = directiveFixture({ readError: 'timeout' })
    routeDouble(fx.timeline)
    const out = await run(fx.client, withDirectives([{ ...BUDGET, after_chunk: 0 }]))
    expect(out.trace.directives?.[0]).toMatchObject({ key: 'budget', id: 'dir-1', status: null, consumed_session: null })
    expect(warn).toHaveBeenCalledWith('[evals] directive read-back failed:', 'timeout')
    warn.mockRestore()
  })

  it('batch: every directive is written before the one pass, whatever its after_chunk', async () => {
    const fx = directiveFixture({ statuses: { 'dir-2': { status: 'consumed', consumed_session: 'sess-b' } } })
    routeDouble(fx.timeline)
    const out = await runBatchTrial(fx.client, {
      caseRow: withDirectives([BUDGET, { key: 'friday', text: 'Ship Friday', after_chunk: 1, must_contain: ['Friday'] }]),
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(fx.timeline).toEqual(['write:Dana owns the budget', 'write:Ship Friday', 'post:batch'])
    expect(out.trace.directives?.map((d) => [d.key, d.after_chunk, d.status])).toEqual([
      ['budget', null, 'pending'],
      ['friday', null, 'consumed'],
    ])
  })

  it('batch: a directive that cannot be written errors the trial before the pass runs', async () => {
    const fx = directiveFixture({ insertError: 'nope' })
    routeDouble(fx.timeline)
    const out = await runBatchTrial(fx.client, {
      caseRow: withDirectives([BUDGET]),
      workspaceId: WS,
      runStarterUserId: USER,
      recipeId: null,
      token: 't',
    })
    expect(fx.timeline).toEqual([])
    expect(out.errorCode).toBe('directive_not_injected')
  })
})

describe('runLiveInstantTrial — the last nudge is not lost', () => {
  /** A realtime fake whose channel keeps the broadcast handler, so a test can
   *  deliver a nudge whenever it likes. */
  function withBroadcast(client: ReturnType<typeof fixture>['client']) {
    withRealtime(client)
    let handler: ((m: { payload: unknown }) => void) | null = null
    ;(client as unknown as Record<string, unknown>).channel = () => ({
      on(_type: string, _filter: unknown, cb: (m: { payload: unknown }) => void) {
        handler = cb
        return this
      },
      subscribe(cb: (s: string) => void) {
        cb('SUBSCRIBED')
        return this
      },
    })
    return { client, deliver: (message: string) => handler?.({ payload: { id: `n-${message}`, kind: 'insight', message, ts: 1 } }) }
  }

  it('waits for a broadcast still in flight after the LAST flush and puts it on that flush', async () => {
    const { client } = fixture()
    const { deliver } = withBroadcast(client)
    let call = 0
    stubFetch(() => {
      call += 1
      if (call === 2) {
        // The broadcast for the last flush lands after its response returned:
        // after the flush drained, during the tail wait.
        setTimeout(() => deliver('the late one'), 20)
        return jsonResponse({ ok: true, tool_calls: 1, tool_call_details: [{ tool: 'say_to_user', args: { message: 'the late one' } }] })
      }
      return jsonResponse({ ok: true, tool_calls: 0, tool_call_details: [] })
    })
    const out = await runLiveInstantTrial(client, { caseRow: CASE, workspaceId: WS, runStarterUserId: USER, recipeId: null, token: 't' })
    expect(out.trace.flushes).toHaveLength(2)
    expect(out.trace.flushes[1].nudges.map((n) => n.message)).toEqual(['the late one'])
  })

  it('does not wait at all when every say_to_user call already has its nudge', async () => {
    const { client } = fixture()
    withBroadcast(client)
    stubFetch(() => jsonResponse({ ok: true, tool_calls: 0, tool_call_details: [] }))
    const timeouts = vi.spyOn(globalThis, 'setTimeout')
    await runLiveInstantTrial(client, { caseRow: CASE, workspaceId: WS, runStarterUserId: USER, recipeId: null, token: 't' })
    const { NUDGE_TAIL_GRACE_MS } = await import('../run-trial')
    expect(timeouts.mock.calls.some(([, ms]) => ms === NUDGE_TAIL_GRACE_MS)).toBe(false)
  })
})

describe('collectNudges — the nudge as say_to_user broadcasts it', () => {
  it('keeps the broadcast id as is: the same id as the nudge’s chat row (ui_message_id)', async () => {
    let handler: ((m: { payload: unknown }) => void) | null = null
    let channelName = ''
    const service = {
      channel: (name: string) => {
        channelName = name
        return {
          on(_type: string, _filter: unknown, cb: (m: { payload: unknown }) => void) {
            handler = cb
            return this
          },
          subscribe(cb: (s: string) => void) {
            cb('SUBSCRIBED')
            return this
          },
        }
      },
      removeChannel: async () => {},
    }
    const collector = await collectNudges(service as never, 'cap-1')
    expect(channelName).toBe('agent-nudge:cap-1')
    // The payload say_to_user broadcasts (lib/live-agent/tools.ts): a plain
    // uuid, no prefix, which is also the row's ui_message.id.
    const id = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'
    handler!({ payload: { id, message: 'Ask about the budget.', kind: 'reminder', captureId: 'cap-1', ts: 42 } })
    expect(collector.drain()).toEqual([{ id, kind: 'reminder', message: 'Ask about the budget.', ts: 42 }])
    expect(collector.drain()).toEqual([])
    await collector.close()
  })
})
