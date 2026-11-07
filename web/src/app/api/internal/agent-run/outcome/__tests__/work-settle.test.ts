/**
 * Route tests for the WORK-RUN settle branch of POST /api/internal/agent-run/
 * outcome (Loops v3 work proposals — docs/loop-engine/WORK-PROPOSALS-DESIGN.md).
 *
 * The work-agent's finish_work posts { result:'work_completed', summary,
 * deliverables }. This route is the SINGLE writer of a work run's terminal state.
 * Load-bearing invariants:
 *   1. COMPLETION: agent_run → completed + finished_at + result_summary (clamped)
 *      + validated deliverables; tracked action → REVIEW (a review-named or
 *      started state, never Done) + agent_run_status='idle'; a work_run_ready notification for the triggering
 *      user (target_type='agent_run').
 *   2. DELIVERABLE VALIDATION: malformed entries dropped (never fail the settle).
 *   3. IDEMPOTENCY: a second finish_work on an already-completed run → 200
 *      alreadySettled; a canceling/canceled row → 409 RUN_CANCELED (no
 *      resurrection); a failed row → 409 OUTCOME_CONFLICT.
 *   4. GUARDS: 401 without secret/token; 400 on empty summary; 400 on wrong kind.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const SECRET = 'test-agent-run-secret-work-000000'

// ── Stateful multi-row table store ──────────────────────────────────────────
const store = {
  agent_run: null as Record<string, unknown> | null,
  actions: null as Record<string, unknown> | null,
  workflow_state: [] as Record<string, unknown>[],
  attention_item: null as Record<string, unknown> | null,
  member: null as Record<string, unknown> | null,
  // The run's work-ledger row (the mirror settles it and sends the push).
  tracked_job: null as Record<string, unknown> | null,
}

const notifications: Array<Record<string, unknown>> = []
const writes: { table: string; patch: Record<string, unknown> }[] = []

/**
 * Simulate a concurrent writer winning the SELECT→UPDATE gap: when the completed
 * settle CAS (`update({status:'completed'}).eq('status', <observed>)`) is issued,
 * flip the store row to `winnerStatus` FIRST so the CAS filter misses (0 rows), then
 * the route's re-read observes `winnerStatus`. Cleared per test.
 */
let raceWinnerStatus: string | null = null

function makeClient() {
  function chain(table: string): Record<string, unknown> {
    const filters: Array<(r: Record<string, unknown>) => boolean> = []
    let pendingUpdate: Record<string, unknown> | null = null
    const c: Record<string, unknown> = {}
    c.select = () => c
    c.order = () => c
    c.limit = () => c
    c.eq = (k: string, v: unknown) => {
      filters.push((r) => r[k] === v)
      return c
    }
    c.in = (k: string, vs: unknown[]) => {
      filters.push((r) => vs.includes(r[k]))
      return c
    }
    c.update = (patch: Record<string, unknown>) => {
      // Race injection: right before the completed CAS lands, a concurrent winner
      // flipped the row's status, so the CAS `status = <observed>` predicate misses.
      if (
        raceWinnerStatus &&
        table === 'agent_run' &&
        patch.status === 'completed' &&
        store.agent_run
      ) {
        store.agent_run.status = raceWinnerStatus
        raceWinnerStatus = null // one-shot
      }
      pendingUpdate = patch
      writes.push({ table, patch })
      return c
    }
    const currentRows = (): Record<string, unknown>[] => {
      const val = (store as Record<string, unknown>)[table]
      if (Array.isArray(val)) return val
      return val ? [val as Record<string, unknown>] : []
    }
    const resolve = () => {
      const rows = currentRows().filter((r) => filters.every((f) => f(r)))
      if (pendingUpdate) {
        // CAS: mutate only matching rows; return the first (null when none).
        if (rows.length === 0) return Promise.resolve({ data: null, error: null })
        for (const row of rows) Object.assign(row, pendingUpdate)
        return Promise.resolve({ data: [{ id: rows[0].id }], error: null })
      }
      return Promise.resolve({ data: rows[0] ?? null, error: null })
    }
    c.maybeSingle = () => resolve()
    c.single = () => resolve()
    // `.update().eq()...select()` (array return, CAS-guard) resolves via then.
    // A plain read of a many-row table (the team's workflow states) answers
    // with the matching rows, as PostgREST does.
    c.then = (r: (v: unknown) => unknown) =>
      (!pendingUpdate && Array.isArray((store as Record<string, unknown>)[table])
        ? Promise.resolve({ data: currentRows().filter((row) => filters.every((f) => f(row))), error: null })
        : resolve()
      ).then(r)
    return c
  }
  return { from: (t: string) => chain(t) }
}

vi.mock('@/lib/admin', () => ({ getServiceClient: () => makeClient() }))
const sendMock = vi.hoisted(() => vi.fn(async (_p: unknown) => undefined))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: sendMock } }))
vi.mock('@/lib/notifications', () => ({
  createNotification: async (params: Record<string, unknown>) => {
    notifications.push(params)
  },
}))

import { POST } from '@/app/api/internal/agent-run/outcome/route'
import {
  mintAgentRunToken,
  AGENT_RUN_SECRET_HEADER,
  AGENT_RUN_TOKEN_HEADER,
} from '@/lib/agent-run/agent-run-token'

const CLAIMS = { agentRunId: 'run-1', workspaceId: 'ws-1', userId: 'user-1' }

function req(opts: { secret?: string | null; token?: string | null; body?: unknown }) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (opts.secret != null) headers[AGENT_RUN_SECRET_HEADER] = opts.secret
  if (opts.token != null) headers[AGENT_RUN_TOKEN_HEADER] = opts.token
  return new Request('http://localhost/api/internal/agent-run/outcome', {
    method: 'POST',
    headers,
    body: JSON.stringify(opts.body ?? {}),
  })
}

function seedRunning(overrides: Record<string, unknown> = {}) {
  store.agent_run = {
    id: 'run-1',
    workspace_id: 'ws-1',
    status: 'running',
    kind: 'workspace',
    action_id: 'act-1',
    attention_item_id: 'wc1',
    triggered_by: 'user-1',
    ...overrides,
  }
  store.actions = { id: 'act-1', workspace_id: 'ws-1', title: 'Draft a follow-up to Randy', team_id: 'team-1', status_id: 'ws-todo', agent_run_status: 'working' }
  store.workflow_state = [
    { id: 'ws-todo', team_id: 'team-1', name: 'Todo', category: 'unstarted', sort_order: 0 },
    { id: 'ws-doing', team_id: 'team-1', name: 'In Progress', category: 'started', sort_order: 1 },
    { id: 'ws-done', team_id: 'team-1', name: 'Done', category: 'completed', sort_order: 2 },
  ]
  store.attention_item = { id: 'wc1', title: 'Draft a follow-up email to Randy' }
  store.member = { id: 'mem-1', user_id: 'user-1', workspace_id: 'ws-1' }
  store.tracked_job = {
    id: 'job-1',
    workspace_id: 'ws-1',
    member_id: 'mem-1',
    kind: 'work_run',
    title: 'Draft a follow-up email to Randy',
    status: 'running',
    agent_run_id: 'run-1',
    progress: {},
    source: {},
  }
}

beforeEach(() => {
  process.env.AGENT_RUN_INTERNAL_SECRET = SECRET
  store.agent_run = null
  store.actions = null
  store.workflow_state = []
  store.attention_item = null
  store.member = null
  store.tracked_job = null
  notifications.length = 0
  writes.length = 0
  raceWinnerStatus = null
  sendMock.mockClear()
})

function token() {
  return mintAgentRunToken(CLAIMS)
}

describe('work-run settle — auth + validation', () => {
  it('401s without secret', async () => {
    const res = await POST(req({ token: token(), body: { result: 'work_completed', summary: 'x' } }))
    expect(res.status).toBe(401)
  })

  it('401s without a valid token', async () => {
    const res = await POST(req({ secret: SECRET, body: { result: 'work_completed', summary: 'x' } }))
    expect(res.status).toBe(401)
  })

  it('400s on an empty summary', async () => {
    seedRunning()
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: '   ', deliverables: [] } }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('INVALID_SUMMARY')
  })

  it('400s when the run is not a workspace run', async () => {
    seedRunning({ kind: 'coding' })
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'did it', deliverables: [] } }))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('WRONG_KIND')
  })
})

describe('work-run settle — completion', () => {
  it('completes the run, moves the action to REVIEW (never Done), and notifies', async () => {
    seedRunning()
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: {
          result: 'work_completed',
          summary: 'Drafted the follow-up email to Randy about GA access.',
          deliverables: [{ type: 'email_draft', id: 'draft-9', label: 'Follow-up to Randy' }],
        },
      }),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.alreadySettled).toBe(false)

    // agent_run settled.
    expect(store.agent_run!.status).toBe('completed')
    expect(store.agent_run!.finished_at).toBeTruthy()
    expect(store.agent_run!.result_summary).toContain('Randy')
    expect((store.agent_run!.deliverables as unknown[]).length).toBe(1)

    // Tracked action → review, not Done (decision 9): it never left Todo, so
    // it moves to the team's first started state, and its run status is idle.
    // The person's Reviewed marks it Done.
    expect(store.actions!.status_id).toBe('ws-doing')
    expect(store.actions!.status_id).not.toBe('ws-done')
    expect(store.actions!.agent_run_status).toBe('idle')

    // The work-ledger row settled into Needs you with the draft to review …
    expect(store.tracked_job).toMatchObject({
      status: 'needs_review',
      deliverables: [{ type: 'email_draft', id: 'draft-9', label: 'Follow-up to Randy' }],
      needs: { kind: 'review', verb: 'review' },
    })
    // … and that transition is the ONE "ready to review" push, targeting the item.
    expect(notifications.length).toBe(1)
    const n = notifications[0]
    expect(n.type).toBe('work_needs_you')
    expect(n.targetType).toBe('work_item')
    expect(n.targetId).toBe('job-1')
    expect(n.recipientId).toBe('mem-1')
    expect(n.title).toBe('Draft a follow-up email to Randy — ready to review')
    expect(n.body).toContain('Review 1 draft')
  })

  it('drops malformed deliverables but still completes', async () => {
    seedRunning()
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: {
          result: 'work_completed',
          summary: 'Did the work.',
          deliverables: [
            { type: 'document', id: 'doc-1', label: 'Spec' }, // valid
            { type: 'not_a_type', id: 'x', label: 'y' }, // bad type
            { type: 'action', id: '', label: 'missing id' }, // empty id
            { type: 'entity', id: 'con-3', label: 'Randy', entity_type: 'contact' }, // valid entity
          ],
        },
      }),
    )
    expect(res.status).toBe(200)
    const kept = store.agent_run!.deliverables as Array<Record<string, unknown>>
    expect(kept.length).toBe(2)
    expect(kept.map((d) => d.id)).toEqual(['doc-1', 'con-3'])
    expect(kept[1].entity_type).toBe('contact')
  })

  it('a run with no deliverables still waits on review — the summary is the deliverable', async () => {
    seedRunning({ attention_item_id: null })
    store.attention_item = null
    // The push is titled by the ledger row (named at dispatch after the card,
    // else the tracked action), not re-derived at settle.
    store.tracked_job!.title = 'Draft a follow-up to Randy'
    await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'done', deliverables: [] } }))
    expect(store.tracked_job).toMatchObject({ status: 'needs_review', deliverables: [] })
    expect(notifications[0].title).toBe('Draft a follow-up to Randy — ready to review')
    expect(notifications[0].body).toBe('Review the result · done')
  })
})

describe('work-run settle — delegation (row 13)', () => {
  const finish = (deliverables: unknown[]) =>
    POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'Did the research.', deliverables } }))

  it('checks the deliverables against what the run was asked for, and never fails it for a shortfall', async () => {
    seedRunning({ expects: [{ type: 'document', min: 1 }] })
    const res = await finish([{ type: 'email_draft', id: 'draft-9', label: 'A draft' }])
    expect(res.status).toBe(200)
    expect(store.agent_run!.status).toBe('completed')
    expect(store.tracked_job).toMatchObject({ status: 'needs_review' })
    expect((store.tracked_job!.progress as { expects_unmet?: string[] }).expects_unmet).toHaveLength(1)
  })

  it('records nothing when what was asked for was produced, or nothing was asked', async () => {
    seedRunning({ expects: [{ type: 'document', min: 1 }] })
    await finish([{ type: 'document', id: 'doc-1', label: 'The research' }])
    expect((store.tracked_job!.progress as { expects_unmet?: unknown }).expects_unmet).toBeUndefined()
    seedRunning()
    await finish([])
    expect((store.tracked_job!.progress as { expects_unmet?: unknown }).expects_unmet).toBeUndefined()
  })

  it('a delegated child tells its parent it settled; a run with no parent tells no one', async () => {
    seedRunning({ parent_run_id: 'run-parent', action_id: null, attention_item_id: null })
    await finish([{ type: 'document', id: 'doc-1', label: 'The research' }])
    expect(sendMock).toHaveBeenCalledWith({
      id: 'child-settled:run-1',
      name: 'work/run.child_settled',
      data: { agent_run_id: 'run-parent', child_run_id: 'run-1', workspace_id: 'ws-1' },
    })
    sendMock.mockClear()
    seedRunning()
    await finish([])
    expect(sendMock).not.toHaveBeenCalled()
  })

  it("row 15: a run done as a teammate asks for that teammate's memory summary", async () => {
    seedRunning({ ai_team_member_id: 'tm-quill' })
    await finish([{ type: 'document', id: 'doc-1', label: 'The note' }])
    expect(sendMock).toHaveBeenCalledWith({
      id: 'agent-memory:run-1',
      name: 'agent-memory/summarize',
      data: { agent_run_id: 'run-1', workspace_id: 'ws-1', ai_team_member_id: 'tm-quill' },
    })
  })
})

describe('work-run settle — idempotency', () => {
  it('a second finish on an already-completed run → 200 alreadySettled', async () => {
    seedRunning({ status: 'completed' })
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'again', deliverables: [] } }))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.alreadySettled).toBe(true)
    // No new notification on the replay.
    expect(notifications.length).toBe(0)
  })

  it('a canceling row → 409 RUN_CANCELED (no resurrection)', async () => {
    seedRunning({ status: 'canceling' })
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'late', deliverables: [] } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_CANCELED')
    expect(store.agent_run!.status).toBe('canceling') // untouched
  })

  it('a failed row → 409 OUTCOME_CONFLICT', async () => {
    seedRunning({ status: 'failed' })
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'x', deliverables: [] } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('OUTCOME_CONFLICT')
  })
})

describe('work-run settle — interactive guards (Loops v3 Phase 3)', () => {
  it('a needs_input row → 409 RUN_NEEDS_INPUT (a stray finish_work never clobbers the open question)', async () => {
    seedRunning({
      status: 'needs_input',
      pending_input: { requestId: 'req-1', approveOptionId: 'approve', denyOptionId: 'deny', questions: [], askedAt: 'x' },
    })
    const res = await POST(req({ secret: SECRET, token: token(), body: { result: 'work_completed', summary: 'clobber attempt', deliverables: [{ type: 'document', id: 'd', label: 'x' }] } }))
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_NEEDS_INPUT')
    // The parked row is UNTOUCHED — status, pending_input, and result_summary all intact.
    expect(store.agent_run!.status).toBe('needs_input')
    expect(store.agent_run!.pending_input).toBeDefined()
    expect(store.agent_run!.result_summary).toBeUndefined()
    expect(store.agent_run!.deliverables).toBeUndefined()
    // No write at all (the guard returns before any update).
    expect(writes.length).toBe(0)
  })

  it('CAS-loss re-read: a cancel that wins the SELECT→UPDATE gap → 409 RUN_CANCELED (not a false success)', async () => {
    seedRunning() // SELECT reads 'running'; the CAS then loses to a concurrent cancel.
    raceWinnerStatus = 'canceling'
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: { result: 'work_completed', summary: 'raced by a cancel', deliverables: [] },
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_CANCELED')
    // No notification — the outcome was NOT recorded.
    expect(notifications.length).toBe(0)
  })

  it('CAS-loss re-read: a needs_input park that wins the gap → 409 RUN_NEEDS_INPUT', async () => {
    seedRunning()
    raceWinnerStatus = 'needs_input'
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: { result: 'work_completed', summary: 'raced by a park', deliverables: [] },
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('RUN_NEEDS_INPUT')
    expect(notifications.length).toBe(0)
  })

  it('CAS-loss re-read: a concurrent completed-settle → 200 alreadySettled (genuine idempotent replay)', async () => {
    seedRunning()
    raceWinnerStatus = 'completed' // another completed-settle won the gap.
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: { result: 'work_completed', summary: 'raced by a twin settle', deliverables: [] },
      }),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.alreadySettled).toBe(true)
    // The concurrent winner owns the notification; this replay files none.
    expect(notifications.length).toBe(0)
  })

  it('CAS-loss re-read: an unclassifiable winner (failed) → 409 OUTCOME_CONFLICT', async () => {
    seedRunning()
    raceWinnerStatus = 'failed'
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: { result: 'work_completed', summary: 'raced by a failure', deliverables: [] },
      }),
    )
    expect(res.status).toBe(409)
    expect((await res.json()).code).toBe('OUTCOME_CONFLICT')
  })

  it('a second finish_work on a completed run never rewrites result_summary / deliverables', async () => {
    seedRunning({
      status: 'completed',
      result_summary: 'The original summary — must survive.',
      deliverables: [{ type: 'document', id: 'orig-doc', label: 'Original' }],
    })
    const res = await POST(
      req({
        secret: SECRET,
        token: token(),
        body: {
          result: 'work_completed',
          summary: 'A DIFFERENT summary from a follow-up turn that should NOT win.',
          deliverables: [{ type: 'email_draft', id: 'new-draft', label: 'Should not appear' }],
        },
      }),
    )
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.alreadySettled).toBe(true)
    // The first settle's summary + deliverables are preserved verbatim.
    expect(store.agent_run!.result_summary).toBe('The original summary — must survive.')
    expect((store.agent_run!.deliverables as Array<Record<string, unknown>>)[0].id).toBe('orig-doc')
    // Idempotent no-op — no write, no notification.
    expect(writes.length).toBe(0)
    expect(notifications.length).toBe(0)
  })
})
