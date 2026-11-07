/**
 * Two concerns live in flow-functions.ts and are tested here:
 *
 * 1. The failed-run push moved onto the work ledger (the recorder's
 *    `work_failed`, src/lib/work/notify.ts) — the notifier that used to live
 *    here is gone; the dispatchers settle the fire's ledger row instead.
 *
 * 2. W-2 — the dormancy gate on scheduled fires (NORTH-STAR cost posture). Proves
 *    a scheduled loop in an inactive workspace SKIPS + LEDGERS (spends nothing),
 *    that a recent capture OR a recent action edit re-activates it, and that the
 *    activity-driven dispatchers (capture_processed) are NOT gated.
 *
 * flow-functions.ts pulls the whole dispatcher graph at import; we stub the heavy
 * edges so the module loads. createFunction is stubbed to CAPTURE each handler by
 * id so the schedule/capture_processed handlers can be driven directly with a
 * fake client + fake step. createNotification and runFlow are spied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ActionResult, FlowAction } from '@/lib/flows/types'
import { createStepMock } from '@/test/inngest-step-mock'

const h = vi.hoisted(() => ({
  createNotification: vi.fn(async () => {}),
  // Captured (config, handler) pairs, keyed by config.id — lets the tests invoke
  // the real dispatcher handler bodies without an Inngest runtime.
  handlers: new Map<string, (arg: unknown) => Promise<unknown>>(),
  // A benign runFlow result; overridable per test.
  runFlow: vi.fn(async () => ({ status: 'success' as const, action_results: [] as ActionResult[] })),
  // getServiceClient — a spy the dispatcher tests point at their activity-aware
  // fake. Defaults to an empty object (the notifier tests drive helpers directly
  // and pass their own client).
  getServiceClient: vi.fn(() => ({}) as unknown),
  reconcileSkip: vi.fn(),
  // The dispatched flow's trigger_type — settable per test so the dormancy
  // gate's schedule-only scoping (calendar_event is exempt) is assertable.
  flowTriggerType: { value: 'schedule' as string },
  // The status-change dispatcher's matched flows + loaded entity, settable per
  // test (the loop-guard cases).
  statusFlows: { value: [] as unknown[] },
  statusEntity: { value: null as unknown },
  // The PR dispatcher's matched flows, and the args it matched with.
  prFlows: { value: [] as unknown[] },
  prMatchArgs: [] as unknown[],
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    // createFunction(config, handler) — capture the handler by config.id so the
    // dispatcher bodies can be driven directly.
    createFunction: (config: { id: string }, handler: (arg: unknown) => Promise<unknown>) => {
      h.handlers.set(config.id, handler)
      return { id: config.id }
    },
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: h.getServiceClient }))
vi.mock('@/lib/flows/reconcile-decision', () => ({ decideReconcileSkip: h.reconcileSkip }))
vi.mock('@/lib/flows/runner', () => ({
  runFlow: (...args: unknown[]) => h.runFlow(...(args as [])),
  RESPONSE_BODY_PREVIEW_BYTES: 2000,
}))
const executorDeps: Array<{ deadlineMs?: number }> = []
vi.mock('@/lib/flows/run-skill', () => ({
  createRunSkillExecutor: (deps: { deadlineMs?: number }) => (executorDeps.push(deps), async () => ({})),
  flowRunDeadlineMs: (startedAt: number) => startedAt + 255_000,
}))
vi.mock('@/lib/flows/run-agent', () => ({ createRunAgentExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/archive-capture', () => ({ createArchiveCaptureExecutor: () => async () => ({}) }))
vi.mock('@/lib/flows/queries', () => ({
  findMatchingFlowsForStatusChange: async () => h.statusFlows.value,
  findMatchingFlowsForCaptureProcessed: async () => [flow],
  findMatchingFlowsForPrStatusChange: async (_s: unknown, args: unknown) => (h.prMatchArgs.push(args), h.prFlows.value),
  loadFlowForDispatch: async () => ({ ...flow, enabled: true, trigger_type: h.flowTriggerType.value }),
  loadRunnerEntityData: async () => h.statusEntity.value,
}))
vi.mock('@/lib/notifications', () => ({
  createNotification: h.createNotification,
}))

const {
  workspaceIsDormant,
  dormantSkipActionResults,
  DORMANCY_WINDOW_DAYS,
  FLOW_TRIGGER_MAX_DEPTH,
  normalizeStatusChangeOrigin,
  statusChangeSkipReason,
} = await import('../flow-functions')

// ── Fakes ─────────────────────────────────────────────────────────────────────

/**
 * Fake service client for the dormancy tests. `captures`/`actions` head-count
 * probes resolve to the configured counts; a `flow_run` insert is recorded so the
 * ledgered skip's shape is assertable.
 */
function makeActivitySupabase(opts: {
  captureCount?: number
  actionCount?: number
  captureError?: { message: string }
  actionError?: { message: string }
  /** The person's own chat turns in the window (role 'user'). */
  chatCount?: number
  chatError?: { message: string }
  /** Drafts the person reviewed or sent in the window. */
  draftCount?: number
  draftError?: { message: string }
  /** People who sent or dismissed a draft in the window (mail_review_activity, 343). */
  reviewCount?: number
  reviewError?: { message: string }
  /** When set, the flow_run insert fails — the gate must fail OPEN (run). */
  flowRunInsertError?: { message: string }
  /**
   * The `captures` row returned by maybeSingle — serves BOTH the
   * capture_processed visibility check and its load-capture title fetch.
   * `null` models a deleted capture (the visibility gate then fails closed).
   */
  captureRow?: { visibility?: string | null; title?: string | null } | null
  /** The workspace's autonomy is off (the kill switch, A5). */
  paused?: boolean
  /** A paused skip for this flow was already ledgered within the hour. */
  recentPausedSkip?: boolean
}) {
  const flowRunInserts: Array<Record<string, unknown>> = []
  // The dormancy COUNT probe (schedule handler) — distinct from the capture-title
  // fetch (capture_processed handler), which uses maybeSingle, not limit().
  const probed = { captures: false, actions: false, chat_messages: false, email_draft: false, mail_review_activity: false }

  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    // A head-count probe ends in `.limit()` and is awaited for { count, error };
    // resolve there. Every other terminal (`.update().eq().is()`, a bare await on
    // the chain) resolves to a benign { data:[], error:null } via `then`.
    Object.assign(b, {
      select: () => b,
      eq: () => b,
      in: () => b,
      gte: (col: string) => {
        if (col === 'last_review_at') b.reviewProbe = true
        return b
      },
      is: () => b,
      update: () => b,
      limit: async () => {
        if (table === 'captures') {
          probed.captures = true
          return { count: opts.captureCount ?? 0, error: opts.captureError ?? null }
        }
        if (table === 'actions') {
          probed.actions = true
          return { count: opts.actionCount ?? 0, error: opts.actionError ?? null }
        }
        if (table === 'chat_messages') {
          probed.chat_messages = true
          return { count: opts.chatCount ?? 0, error: opts.chatError ?? null }
        }
        if (table === 'email_draft') {
          probed.email_draft = true
          return { count: opts.draftCount ?? 0, error: opts.draftError ?? null }
        }
        if (table === 'mail_review_activity' && b.reviewProbe) {
          probed.mail_review_activity = true
          return { count: opts.reviewCount ?? 0, error: opts.reviewError ?? null }
        }
        if (table === 'flow_run') return { data: opts.recentPausedSkip ? [{ id: 'fr-earlier' }] : [], error: null }
        return { count: 0, error: null }
      },
      // capture_processed's visibility check + load-capture title fetch; the
      // kill switch's settings read on `workspace`.
      maybeSingle: async () =>
        table === 'workspace'
          ? { data: { settings: opts.paused ? { agent_autonomy: { mode: 'off' } } : {} }, error: null }
          : {
              data: opts.captureRow === undefined ? { visibility: 'workspace', title: null } : opts.captureRow,
              error: null,
            },
      insert: async (row: Record<string, unknown>) => {
        if (table === 'flow_run') {
          flowRunInserts.push(row)
          if (opts.flowRunInsertError) return { data: null, error: opts.flowRunInsertError }
        }
        return { data: null, error: null }
      },
      then: (resolve: (r: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    })
    return b
  }

  return {
    client: { from: (t: string) => builder(t) } as unknown as ReturnType<
      typeof import('@/lib/admin').getServiceClient
    >,
    flowRunInserts,
    probed,
  }
}

/**
 * Shared Inngest step mock: runs the callback inline (no memoization needed in
 * tests) and throws on any step.* call made from inside a step.run callback —
 * that nesting deadlocks in production. See src/test/inngest-step-mock.ts.
 */
const step = createStepMock()

const skillAction: FlowAction = {
  id: 'a1',
  type: 'run_skill',
  config: { skill_id: 's1', mode: 'act' } as unknown as FlowAction['config'],
  condition: null,
  parent_id: null,
  enabled: true,
  bearer_token_encrypted: null,
}

const flow = { id: 'flow-1', name: 'Corvanne Triage', created_by: 'user-1', actions: [skillAction] }


beforeEach(() => {
  h.createNotification.mockClear()
  h.runFlow.mockClear()
  h.runFlow.mockResolvedValue({ status: 'success', action_results: [] })
  h.getServiceClient.mockReset()
  h.getServiceClient.mockReturnValue({})
  h.reconcileSkip.mockReset().mockResolvedValue(null)
})

// ── Dormancy gate (W-2) ───────────────────────────────────────────────────────

describe('workspaceIsDormant', () => {
  it('is DORMANT when no capture, action edit, chat turn or reviewed draft is recent', async () => {
    const { client, probed } = makeActivitySupabase({ captureCount: 0, actionCount: 0 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(true)
    // Every signal was checked (each came back empty, so the next probe ran).
    expect(probed).toEqual({ captures: true, actions: true, chat_messages: true, email_draft: true, mail_review_activity: true })
  })

  it('a mail-only workspace the person works in is ACTIVE: their chat turns count', async () => {
    const { client, probed } = makeActivitySupabase({ captureCount: 0, actionCount: 0, chatCount: 1 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(false)
    expect(probed.email_draft).toBe(false)
  })

  it('a mail-only workspace the person works in is ACTIVE: a draft they reviewed or sent counts', async () => {
    const { client } = makeActivitySupabase({ captureCount: 0, actionCount: 0, chatCount: 0, draftCount: 1 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(false)
  })

  it('a mail-only workspace is ACTIVE when the person sent or dismissed a draft (the rows are deleted; a service-only row keeps when)', async () => {
    const { client } = makeActivitySupabase({ captureCount: 0, actionCount: 0, chatCount: 0, draftCount: 0, reviewCount: 1 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(false)
    // Before 343 the column is missing: fail open, never dormant on a read error.
    const pre343 = makeActivitySupabase({ captureCount: 0, actionCount: 0, chatCount: 0, draftCount: 0, reviewError: { message: 'relation "public.mail_review_activity" does not exist' } })
    expect(await workspaceIsDormant(pre343.client, 'ws-1')).toBe(false)
  })

  it('is ACTIVE on a recent capture — short-circuits before the action probe', async () => {
    const { client, probed } = makeActivitySupabase({ captureCount: 1, actionCount: 0 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(false)
    expect(probed.captures).toBe(true)
    // A recent capture alone re-activates; the action probe never runs.
    expect(probed.actions).toBe(false)
  })

  it('is ACTIVE on a recent action edit even with no recent capture', async () => {
    const { client, probed } = makeActivitySupabase({ captureCount: 0, actionCount: 1 })
    expect(await workspaceIsDormant(client, 'ws-1')).toBe(false)
    expect(probed).toMatchObject({ captures: true, actions: true })
  })

  it('fails OPEN (not dormant) on a read error so a real loop is never starved', async () => {
    const capErr = makeActivitySupabase({ captureError: { message: 'boom' } })
    expect(await workspaceIsDormant(capErr.client, 'ws-1')).toBe(false)
    const actErr = makeActivitySupabase({ captureCount: 0, actionError: { message: 'boom' } })
    expect(await workspaceIsDormant(actErr.client, 'ws-1')).toBe(false)
    const chatErr = makeActivitySupabase({ chatError: { message: 'boom' } })
    expect(await workspaceIsDormant(chatErr.client, 'ws-1')).toBe(false)
    const draftErr = makeActivitySupabase({ draftError: { message: 'boom' } })
    expect(await workspaceIsDormant(draftErr.client, 'ws-1')).toBe(false)
  })
})

describe('dormantSkipActionResults', () => {
  it('marks every action skipped, success, with the no-cost reason', () => {
    const results = dormantSkipActionResults([skillAction, { ...skillAction, id: 'a2' }])
    expect(results).toHaveLength(2)
    for (const r of results) {
      expect(r.skipped).toBe(true)
      expect(r.status).toBe('success')
      expect(r.disabled).toBe(false)
      expect(r.incomplete).toBe(false)
      expect(r.response_body_preview).toBe(`workspace inactive for ${DORMANCY_WINDOW_DAYS}d — skipped (no cost)`)
      expect(r.error_message).toBeNull()
    }
    expect(results.map((r) => r.action_id)).toEqual(['a1', 'a2'])
  })
})

describe('flowDispatchOnSchedule dormancy gate', () => {
  const runSchedule = () => {
    const handler = h.handlers.get('flow-dispatch-on-schedule')!
    return handler({
      event: { id: 'evt-1', data: { flow_id: 'flow-1', workspace_id: 'ws-1', scheduled_for: '2026-07-18T00:00:00Z' } },
      step,
    })
  }

  it('ledgers a Jev skip and avoids the agent, but runs when the skip cannot be recorded', async () => {
    h.reconcileSkip.mockResolvedValue({ reason: 'No commitments found', inferenceId: 'decision' })
    const fake = makeActivitySupabase({ captureCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)
    expect(await runSchedule()).toEqual({ dispatched: 0, skipped: 'no_commitments_to_reconcile' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts).toHaveLength(1)
    expect(fake.flowRunInserts[0].action_results).toEqual([expect.objectContaining({ skipped: true })])
    h.getServiceClient.mockReturnValue(makeActivitySupabase({ captureCount: 1, flowRunInsertError: { message: 'offline' } }).client)
    expect(await runSchedule()).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
  })

  it('DORMANT: skips the flow (no runFlow) and ledgers ONE skipped flow_run', async () => {
    const fake = makeActivitySupabase({ captureCount: 0, actionCount: 0 })
    h.getServiceClient.mockReturnValue(fake.client)

    const result = await runSchedule()

    expect(result).toEqual({ dispatched: 0, skipped: 'workspace_dormant' })
    // No LLM run happened.
    expect(h.runFlow).not.toHaveBeenCalled()
    // Exactly one flow_run row, shaped as a SKIP.
    expect(fake.flowRunInserts).toHaveLength(1)
    const row = fake.flowRunInserts[0]
    expect(row.flow_id).toBe('flow-1')
    expect(row.status).toBe('success') // enum has no 'skipped'
    expect(row.triggered_by_action_id).toBeNull()
    expect(row.response_body_preview).toBe(`workspace inactive for ${DORMANCY_WINDOW_DAYS}d — skipped (no cost)`)
    const actionResults = row.action_results as ActionResult[]
    expect(actionResults).toHaveLength(1)
    expect(actionResults[0]).toMatchObject({ action_id: 'a1', skipped: true, status: 'success' })
  })

  it('RECENT CAPTURE: passes the gate and runs the flow (no skip ledger)', async () => {
    const fake = makeActivitySupabase({ captureCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)

    const result = await runSchedule()

    expect(result).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
    // The only flow_run written is the real run's terminal row — not a dormancy skip.
    const dormantRows = fake.flowRunInserts.filter(
      (r) => r.response_body_preview === `workspace inactive for ${DORMANCY_WINDOW_DAYS}d — skipped (no cost)`,
    )
    expect(dormantRows).toHaveLength(0)
  })

  it("hands the run_skill executor this request's deadline (flowRunDeadlineMs from the handler start)", async () => {
    const fake = makeActivitySupabase({ captureCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)
    executorDeps.length = 0
    const before = Date.now()
    await runSchedule()
    const after = Date.now()
    expect(executorDeps).toHaveLength(1)
    expect(executorDeps[0].deadlineMs).toBeGreaterThanOrEqual(before + 255_000)
    expect(executorDeps[0].deadlineMs).toBeLessThanOrEqual(after + 255_000)
  })

  it('RECENT ACTION EDIT: passes the gate and runs the flow', async () => {
    const fake = makeActivitySupabase({ captureCount: 0, actionCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)

    const result = await runSchedule()

    expect(result).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
  })

  it('CALENDAR_EVENT fires are EXEMPT: a dormant workspace still gets its meeting-prep run', async () => {
    // calendar fires are activity-driven by construction (computeNextCalendarRun
    // requires a fresh calendar cache + a real occurrence) — the gate must not
    // starve them, and must not even probe.
    h.flowTriggerType.value = 'calendar_event'
    try {
      const fake = makeActivitySupabase({ captureCount: 0, actionCount: 0 })
      h.getServiceClient.mockReturnValue(fake.client)

      const result = await runSchedule()

      expect(result).toEqual({ dispatched: 1 })
      expect(h.runFlow).toHaveBeenCalledOnce()
      expect(fake.probed).toEqual({ captures: false, actions: false, chat_messages: false, email_draft: false, mail_review_activity: false })
    } finally {
      h.flowTriggerType.value = 'schedule'
    }
  })

  it('LEDGER INSERT FAILURE fails OPEN: an unrecordable skip runs instead (invariant 4)', async () => {
    const fake = makeActivitySupabase({
      captureCount: 0,
      actionCount: 0,
      flowRunInsertError: { message: 'transient' },
    })
    h.getServiceClient.mockReturnValue(fake.client)

    const result = await runSchedule()

    // The skip could not be ledgered, so the fire proceeds — absence is only
    // allowed when it's recorded.
    expect(result).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
  })
})

describe('flowDispatchOnCaptureProcessed is NOT dormancy-gated', () => {
  it('runs the flow even when the workspace is dormant (activity-driven by construction)', async () => {
    // A dormant workspace (both probes would be empty) — but capture_processed
    // fires anyway, because the capture IS the activity.
    const fake = makeActivitySupabase({ captureCount: 0, actionCount: 0 })
    h.getServiceClient.mockReturnValue(fake.client)

    const handler = h.handlers.get('flow-dispatch-on-capture-processed')!
    const result = await handler({
      event: { id: 'evt-2', data: { workspace_id: 'ws-1', capture_id: 'cap-1', processed_at: '2026-07-18T00:00:00Z' } },
      step,
    })

    expect(result).toEqual({ dispatched: 1 })
    // The flow ran …
    expect(h.runFlow).toHaveBeenCalledOnce()
    // … and the activity probes were never issued (the gate is schedule-only).
    expect(fake.probed).toEqual({ captures: false, actions: false, chat_messages: false, email_draft: false, mail_review_activity: false })
  })
})

// ── Private captures do not fire workspace automations ───────────────────────
//
// The emitter stamps flow_eligible, but the dispatcher re-checks the row
// itself: the flag is absent on emitters that predate it (the triage
// reconciler's re-fire) and a capture can be flipped to private between emit
// and dispatch. Both gates must skip BEFORE runFlow, because the dispatcher
// hands the run the capture's title out-of-band via extras — reaching the
// model prompt, the {{capture.title}} delivery template, and the run's
// provenance, none of which omitPrivateCaptures can intercept.
describe('flowDispatchOnCaptureProcessed skips private captures', () => {
  const fire = (data: Record<string, unknown>) =>
    h.handlers.get('flow-dispatch-on-capture-processed')!({
      event: {
        id: 'evt-3',
        data: { workspace_id: 'ws-1', capture_id: 'cap-1', processed_at: '2026-07-18T00:00:00Z', ...data },
      },
      step,
    })

  it('skips on flow_eligible:false without even reading the row', async () => {
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    expect(await fire({ flow_eligible: false })).toEqual({
      dispatched: 0,
      skipped: 'private_capture',
    })
    expect(h.runFlow).not.toHaveBeenCalled()
  })

  it('skips when the row is private even without the flag (reconciler re-fire)', async () => {
    const fake = makeActivitySupabase({ captureRow: { visibility: 'private', title: 'Interview — Acme CTO' } })
    h.getServiceClient.mockReturnValue(fake.client)

    expect(await fire({})).toEqual({ dispatched: 0, skipped: 'private_capture' })
    expect(h.runFlow).not.toHaveBeenCalled()
  })

  it('fails closed when the capture row is missing', async () => {
    const fake = makeActivitySupabase({ captureRow: null })
    h.getServiceClient.mockReturnValue(fake.client)

    expect(await fire({})).toEqual({ dispatched: 0, skipped: 'private_capture' })
    expect(h.runFlow).not.toHaveBeenCalled()
  })

  it('still dispatches a workspace-visible capture, passing its title as extras', async () => {
    const fake = makeActivitySupabase({ captureRow: { visibility: 'workspace', title: 'Team sync' } })
    h.getServiceClient.mockReturnValue(fake.client)

    expect(await fire({ flow_eligible: true })).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
    const opts = (h.runFlow.mock.calls[0] as unknown[])[4] as {
      extras?: { capture?: unknown }
    }
    expect(opts.extras?.capture).toEqual({ id: 'cap-1', title: 'Team sync' })
  })
})

// ── Loop guard on status-change fires (precondition A3) ──────────────────────

describe('statusChangeSkipReason / normalizeStatusChangeOrigin (pure)', () => {
  const optedIn = { trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2', fire_on_agent_changes: true } }
  const plain = { trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2' } }

  it("a person's change runs every flow", () => {
    expect(statusChangeSkipReason(plain, { actor: 'user', depth: 0 })).toBeNull()
    expect(statusChangeSkipReason(optedIn, { actor: 'user', depth: 0 })).toBeNull()
  })

  it("an agent's change is skipped unless the flow opted in", () => {
    expect(statusChangeSkipReason(plain, { actor: 'agent', depth: 1 })).toMatch(/agent.*loop guard/)
    expect(statusChangeSkipReason(optedIn, { actor: 'agent', depth: 1 })).toBeNull()
  })

  it("the pipeline's own applies (loop) and remote echoes (sync) run, subject to the depth cap", () => {
    expect(statusChangeSkipReason(plain, { actor: 'loop', depth: 1 })).toBeNull()
    expect(statusChangeSkipReason(plain, { actor: 'sync', depth: 0 })).toBeNull()
    expect(statusChangeSkipReason(optedIn, { actor: 'loop', depth: FLOW_TRIGGER_MAX_DEPTH })).toMatch(/depth.*cap.*loop guard/)
    expect(statusChangeSkipReason(optedIn, { actor: 'agent', depth: 2 }, 5)).toBeNull()
    expect(statusChangeSkipReason(optedIn, { actor: 'agent', depth: 5 }, 5)).toMatch(/cap \(5\)/)
  })

  it('the default cap is 2: a person → a run → a flow it triggers → nothing further', () => {
    expect(FLOW_TRIGGER_MAX_DEPTH).toBe(2)
  })

  it('normalizes a missing or malformed origin to a person at depth 0', () => {
    expect(normalizeStatusChangeOrigin(undefined)).toEqual({ actor: 'user', depth: 0 })
    expect(normalizeStatusChangeOrigin({ actor: 'robot', depth: -3 })).toEqual({ actor: 'user', depth: 0, run_id: null })
    expect(normalizeStatusChangeOrigin({ actor: 'agent', depth: 1, run_id: 'r' })).toEqual({ actor: 'agent', depth: 1, run_id: 'r' })
  })
})

describe('flowDispatchOnStatusChange loop guard', () => {
  const statusEvent = (origin?: unknown) => ({
    id: 'evt-status-1',
    data: {
      entity_type: 'action',
      entity_id: 'act-1',
      workspace_id: 'ws-1',
      team_id: 'team-1',
      from_status_id: 's1',
      to_status_id: 's2',
      actor_user_id: 'user-1',
      fired_at: '2026-09-25T00:00:00.000Z',
      ...(origin === undefined ? {} : { origin }),
    },
  })
  const plainFlow = { ...flow, trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2' } }
  const optedInFlow = {
    ...flow,
    id: 'flow-optin',
    trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2', fire_on_agent_changes: true },
  }
  const handler = () => h.handlers.get('flow-dispatch-on-entity-status-change')!

  beforeEach(() => {
    executorDeps.length = 0
    h.statusFlows.value = [plainFlow]
    h.statusEntity.value = { id: 'act-1', title: 'Fix the thing', status_id: 's2' }
  })

  it("a person's change (or a pre-guard event with no origin) runs the flow; its runs write at depth 1", async () => {
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    const res = (await handler()({ event: statusEvent(), step })) as { dispatched: number; skipped: number }

    expect(res).toEqual({ dispatched: 1, skipped: 0 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
    expect((executorDeps[0] as { originDepth?: number }).originDepth).toBe(1)
    expect(fake.flowRunInserts.some((r) => (r.action_results as unknown[]).length === 0)).toBe(true)
  })

  it("an agent's change SKIPS a flow that did not opt in, and ledgers the skip", async () => {
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    const res = (await handler()({ event: statusEvent({ actor: 'agent', depth: 1, run_id: 'run-9' }), step })) as {
      dispatched: number
      skipped: number
    }

    expect(res).toEqual({ dispatched: 0, skipped: 1 })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts).toHaveLength(1)
    const row = fake.flowRunInserts[0]
    expect(row.triggered_by_action_id).toBe('act-1')
    expect(String(row.response_body_preview)).toMatch(/agent.*loop guard/)
    const results = row.action_results as Array<{ skipped: boolean; status: string }>
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ skipped: true, status: 'success' })
  })

  it("an agent's change runs a flow that opted in, one hop deeper", async () => {
    h.statusFlows.value = [optedInFlow]
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    const res = (await handler()({ event: statusEvent({ actor: 'agent', depth: 1 }), step })) as { dispatched: number; skipped: number }

    expect(res).toEqual({ dispatched: 1, skipped: 0 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
    expect((executorDeps[0] as { originDepth?: number }).originDepth).toBe(2)
  })

  it('the depth cap refuses even an opted-in flow once the chain is long enough', async () => {
    h.statusFlows.value = [optedInFlow]
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    const res = (await handler()({ event: statusEvent({ actor: 'agent', depth: FLOW_TRIGGER_MAX_DEPTH }), step })) as {
      dispatched: number
      skipped: number
    }

    expect(res).toEqual({ dispatched: 0, skipped: 1 })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(String(fake.flowRunInserts[0].response_body_preview)).toMatch(/depth .* cap/)
  })

  it('a mixed match: the opted-in flow runs, the plain one is skipped — per flow, not per event', async () => {
    h.statusFlows.value = [plainFlow, optedInFlow]
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)

    const res = (await handler()({ event: statusEvent({ actor: 'agent', depth: 1 }), step })) as { dispatched: number; skipped: number }

    expect(res).toEqual({ dispatched: 1, skipped: 1 })
    expect(h.runFlow).toHaveBeenCalledTimes(1)
  })
})

// ── The kill switch (A5 slice 5): autonomy off runs no loop ──────────────────

describe('the kill switch on every flow dispatcher', () => {
  const PAUSED = 'Agent work is switched off for this workspace (autonomy off)'

  it('schedule: a paused workspace runs nothing and ledgers the skip (before the dormancy probe)', async () => {
    const fake = makeActivitySupabase({ paused: true, captureCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await h.handlers.get('flow-dispatch-on-schedule')!({
      event: { id: 'evt-p1', data: { flow_id: 'flow-1', workspace_id: 'ws-1', scheduled_for: '2026-10-14T00:00:00Z' } },
      step,
    })
    expect(res).toEqual({ dispatched: 0, skipped: 'agent_paused' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.probed.captures).toBe(false)
    expect(fake.flowRunInserts).toHaveLength(1)
    expect(fake.flowRunInserts[0]).toMatchObject({ flow_id: 'flow-1', status: 'success', response_body_preview: PAUSED })
    expect(fake.flowRunInserts[0].action_results).toEqual([expect.objectContaining({ action_id: 'a1', skipped: true })])
  })

  it('capture processed: a paused workspace runs no loop, one skip row per matched flow', async () => {
    const fake = makeActivitySupabase({ paused: true })
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await h.handlers.get('flow-dispatch-on-capture-processed')!({
      event: { id: 'evt-p2', data: { workspace_id: 'ws-1', capture_id: 'cap-1', processed_at: '2026-10-14T00:00:00Z' } },
      step,
    })
    expect(res).toEqual({ dispatched: 0, skipped: 'agent_paused' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts.map((r) => r.response_body_preview)).toEqual([PAUSED])
  })

  it('status change: a paused workspace runs no loop, the skip keeps its triggering action', async () => {
    h.statusFlows.value = [{ ...flow, trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2' } }]
    h.statusEntity.value = { id: 'act-1', title: 'Fix', status_id: 's2' }
    const fake = makeActivitySupabase({ paused: true })
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await h.handlers.get('flow-dispatch-on-entity-status-change')!({
      event: {
        id: 'evt-p3',
        data: { entity_type: 'action', entity_id: 'act-1', workspace_id: 'ws-1', team_id: 't', from_status_id: 's1', to_status_id: 's2', actor_user_id: 'user-1', fired_at: '2026-10-14T00:00:00Z' },
      },
      step,
    })
    expect(res).toEqual({ dispatched: 0, skipped: 'agent_paused' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts).toEqual([expect.objectContaining({ triggered_by_action_id: 'act-1', response_body_preview: PAUSED })])
  })

  it('autonomy on (propose) runs as before', async () => {
    const fake = makeActivitySupabase({ captureCount: 1 })
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await h.handlers.get('flow-dispatch-on-schedule')!({
      event: { id: 'evt-p4', data: { flow_id: 'flow-1', workspace_id: 'ws-1', scheduled_for: '2026-10-14T00:00:00Z' } },
      step,
    })
    expect(res).toEqual({ dispatched: 1 })
    expect(h.runFlow).toHaveBeenCalledOnce()
  })
})

describe('the kill switch caps its skip rows', () => {
  it('a flow with a paused skip in the last hour gets no second row (status-change bursts stay quiet)', async () => {
    h.statusFlows.value = [{ ...flow, trigger_config: { entity_type: 'action', from_status_id: null, to_status_id: 's2' } }]
    h.statusEntity.value = { id: 'act-1', title: 'Fix', status_id: 's2' }
    const fake = makeActivitySupabase({ paused: true, recentPausedSkip: true })
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await h.handlers.get('flow-dispatch-on-entity-status-change')!({
      event: {
        id: 'evt-p5',
        data: { entity_type: 'action', entity_id: 'act-1', workspace_id: 'ws-1', team_id: 't', from_status_id: 's1', to_status_id: 's2', actor_user_id: 'user-1', fired_at: '2026-10-14T00:00:00Z' },
      },
      step,
    })
    expect(res).toEqual({ dispatched: 0, skipped: 'agent_paused' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts).toHaveLength(0)
  })
})

describe('flowDispatchOnPrStatusChange (F1: pr_status_changed wired)', () => {
  const prEvent = (data: Record<string, unknown> = {}) => ({
    id: 'evt-pr-1',
    data: { workspace_id: 'ws-1', action_id: 'act-1', repo_full_name: 'acme/web', pr_number: 7, pr_state: 'merged', fired_at: '2026-10-19T00:00:00.000Z', ...data },
  })
  const handler = () => h.handlers.get('flow-dispatch-on-pr-status-change')!
  const prFlow = { ...flow, id: 'flow-pr', trigger_config: { kind: 'pr_status_changed', repo_full_name: 'acme/web', to_state: 'merged' } }

  beforeEach(() => {
    executorDeps.length = 0
    h.prMatchArgs.length = 0
    h.prFlows.value = [prFlow]
    h.statusEntity.value = { kind: 'action', id: 'act-1', title: 'Ship it', status_id: 's2', workspace_id: 'ws-1' }
  })

  it('runs the matching loops against the linked action, the PR state as to_status_id, as the owner', async () => {
    const fake = makeActivitySupabase({})
    h.getServiceClient.mockReturnValue(fake.client)
    const res = await handler()({ event: prEvent(), step })
    expect(res).toMatchObject({ dispatched: 1 })
    expect(h.prMatchArgs).toEqual([{ workspaceId: 'ws-1', repoFullName: 'acme/web', prState: 'merged' }])
    const [, entity, trigger] = h.runFlow.mock.calls[0] as unknown as [unknown, { id: string }, { type: string; entity_type: string; to_status_id: string }]
    expect(entity.id).toBe('act-1')
    expect(trigger).toMatchObject({ type: 'pr_status_changed', entity_type: 'action', to_status_id: 'merged' })
    expect(fake.flowRunInserts).toEqual([expect.objectContaining({ flow_id: 'flow-pr', triggered_by_action_id: 'act-1' })])
    expect((executorDeps[0] as { runAsUserId?: string }).runAsUserId).toBe('user-1')
  })

  it('no matching loop: nothing runs', async () => {
    h.prFlows.value = []
    h.getServiceClient.mockReturnValue(makeActivitySupabase({}).client)
    expect(await handler()({ event: prEvent(), step })).toEqual({ dispatched: 0 })
    expect(h.runFlow).not.toHaveBeenCalled()
  })

  it("an action in another workspace (moved since the link) fires nothing", async () => {
    h.statusEntity.value = { kind: 'action', id: 'act-1', title: 'Ship it', status_id: 's2', workspace_id: 'ws-other' }
    h.getServiceClient.mockReturnValue(makeActivitySupabase({}).client)
    expect(await handler()({ event: prEvent(), step })).toEqual({ dispatched: 0, error: 'entity_not_found' })
    expect(h.runFlow).not.toHaveBeenCalled()
  })

  it('the kill switch: a paused workspace runs nothing and ledgers the skip', async () => {
    const fake = makeActivitySupabase({ paused: true })
    h.getServiceClient.mockReturnValue(fake.client)
    expect(await handler()({ event: prEvent(), step })).toEqual({ dispatched: 0, skipped: 'agent_paused' })
    expect(h.runFlow).not.toHaveBeenCalled()
    expect(fake.flowRunInserts).toEqual([expect.objectContaining({ triggered_by_action_id: 'act-1' })])
  })
})
