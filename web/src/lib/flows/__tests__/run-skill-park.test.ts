/**
 * Bots v3 Phase 4 — a loop's skill run parks its session for the follow-up chat.
 *
 * Drives the real executor → runSpecViaEve → runViaEve → delivery flow with the
 * I/O boundary mocked (as run-skill-salvage.test.ts does), and pins:
 *   - a run whose ledger row names its teammate runs as a PARKING session
 *     (conversation mode), and only a run nobody fronts (or with no row) keeps
 *     its task session;
 *   - parking on finish: after delivery, the handle lands in
 *     tracked_job_session ({ sessionId, streamIndex, settleStreamIndex } + the
 *     run facts) and the row learns `source.run_chat`;
 *   - verdict cards are still applied EXACTLY ONCE, and before the park;
 *   - every other outcome (a failed turn, a prompt for input, the wall, the
 *     step cap, a salvage) cancels the session and parks nothing;
 *   - a park that can't be stored never fails the delivered run.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { HandleMessageStreamEvent } from 'eve/client'
import type { RunVerdict } from '../verdict-apply'
import type { FlowAction } from '../types'

type Payload = { onEvent?: (ev: HandleMessageStreamEvent) => void; signal: AbortSignal; outputSchema?: unknown }

const h = vi.hoisted(() => ({
  retireTaskSession: vi.fn(async () => true),
  createTaskSession: vi.fn(),
  createParkingRunSession: vi.fn(),
  cancelTaskSession: vi.fn(async () => true),
  applyVerdict: vi.fn(),
  logUsage: vi.fn(async () => {}),
  createNotification: vi.fn(async () => {}),
  outputContract: 'verdict' as 'verdict' | 'prose',
  /** Every write, in order: `insert:<table>` / `upsert:<table>`. */
  writes: [] as string[],
  upserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  upsertError: null as null | { message: string },
  /** The handle a previous run on the row kept (tracked_job_session.session_state). */
  priorSession: null as null | Record<string, unknown>,
}))

vi.mock('eve/client', async (importOriginal) => ({ ...(await importOriginal<typeof import('eve/client')>()), Client: vi.fn(() => ({})) }))
vi.mock('@/lib/eve/task-session', () => ({
  createTaskSession: h.createTaskSession,
  createParkingRunSession: h.createParkingRunSession,
  cancelTaskSession: h.cancelTaskSession,
  retireTaskSession: h.retireTaskSession,
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => {
    const chain = (table: string) => {
      const c: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'or', 'limit', 'gte', 'is', 'update', 'contains', 'in', 'order', 'not']) {
        c[m] = () => c
      }
      c.insert = () => {
        h.writes.push(`insert:${table}`)
        return c
      }
      c.upsert = async (row: Record<string, unknown>) => {
        h.writes.push(`upsert:${table}`)
        h.upserts.push({ table, row })
        return { error: h.upsertError }
      }
      c.maybeSingle = async () => {
        if (table === 'recipe') {
          return {
            data: {
              id: 'skill-1',
              name: 'Proposal Triage',
              system_prompt: 'triage the queue',
              updated_at: null,
              agent_config: { output_contract: h.outputContract },
            },
            error: null,
          }
        }
        if (table === 'member') return { data: { id: 'm1' }, error: null }
        if (table === 'tracked_job_session') {
          return { data: h.priorSession ? { session_state: h.priorSession } : null, error: null }
        }
        return { data: null, error: null }
      }
      c.single = async () => (table === 'documents' || table === 'document' ? { data: { id: 'doc-1' }, error: null } : { data: null, error: null })
      return c
    }
    return {
      from: (t: string) => chain(t),
      rpc: async () => ({ data: [{ allowed: true }], error: null }),
    }
  },
}))

vi.mock('@/lib/ai/system-prompt', () => ({ buildSystemPrompt: async () => 'base system prompt' }))
vi.mock('@/lib/ai/auth', () => ({ logUsage: h.logUsage }))
vi.mock('../context-pack', () => ({ buildContextPack: async () => '' }))
vi.mock('../verdict-apply', () => ({
  applyVerdict: h.applyVerdict,
  resolveTrust: () => ({
    auto_apply: false,
    min_confidence: 0.85,
    allow_external: false,
    max_cards_per_run: 3,
    outreach_draft_cards: true,
  }),
}))
vi.mock('@/lib/notifications', () => ({ createNotification: h.createNotification }))

const { createRunSkillExecutor } = await import('../run-skill')
const { PARKED_ON_INPUT_REASON } = await import('../run-skill-eve')
const { SKILL_RUN_SESSION_TABLE } = await import('../skill-run-session')

const VERDICT: RunVerdict = {
  decisions: [{ proposal_id: 'p1', verdict: 'accept', reason: 'r', confidence: 0.9, is_mine_explicit: true }],
  needs_user: [],
  summary: 'Triaged 1 item.',
}

const action: FlowAction = {
  id: 'a1',
  type: 'run_skill',
  config: { skill_id: 'skill-1', mode: 'act' } as unknown as FlowAction['config'],
  condition: null,
  parent_id: null,
  enabled: true,
  bearer_token_encrypted: null,
}

const ctx = {
  entity: null,
  trigger: {
    type: 'capture_processed' as const,
    entity_type: null,
    from_status_id: null,
    to_status_id: null,
    fired_at: '2026-10-02T00:00:00.000Z',
  },
  appBaseUrl: 'https://dial8.ai',
  capture: null,
}

const ev = (type: string, data: Record<string, unknown> = {}): HandleMessageStreamEvent =>
  ({ type, data: { sequence: 0, stepIndex: 0, turnId: 't', ...data } }) as unknown as HandleMessageStreamEvent
const step = (input: number, output: number) =>
  ev('step.completed', { finishReason: 'stop', usage: { inputTokens: input, outputTokens: output } })
const committed = (v: RunVerdict) => ev('result.completed', { result: v })
const said = (text: string) => ev('message.completed', { finishReason: 'stop', message: text })

/** A ledger handle: its row, its teammate, and every method a recorder has. */
function workHandle(over: { id?: string | null; inert?: boolean; aiTeamMemberId?: string | null } = {}) {
  const base = { id: 'job-1', inert: false, aiTeamMemberId: 'tm-1', kind: 'flow_run', workspaceId: 'ws-1', memberId: 'm1', ...over }
  const calls: Array<[string, unknown[]]> = []
  return {
    calls,
    handle: new Proxy(base as Record<string, unknown>, {
      get(target, prop: string) {
        if (prop in target) return target[prop]
        return (...args: unknown[]) => {
          calls.push([prop, args])
          if (prop === 'link') h.writes.push('link')
          return Promise.resolve()
        }
      },
    }),
  }
}

/** The parking session: streams `events` through the tap, then resolves `final` (or throws `error`). */
function parkingSession(
  events: HandleMessageStreamEvent[],
  outcome: { final: { status: string; data?: unknown; message?: string; inputRequests?: unknown[] } } | { error: Error },
  state = { sessionId: 'sess-park', streamIndex: 7 },
) {
  h.createParkingRunSession.mockImplementation(async (_client: unknown, payload: Payload) => ({
    session: { state },
    response: {
      sessionId: 'sess-park',
      result: async () => {
        for (const e of events) payload.onEvent?.(e)
        if ('error' in outcome) throw outcome.error
        return { inputRequests: [], message: '', ...outcome.final, events, sessionId: 'sess-park' }
      },
    },
  }))
}

function taskSession(events: HandleMessageStreamEvent[], final: { status: string; data?: unknown; message?: string }) {
  h.createTaskSession.mockImplementation(async (_client: unknown, payload: Payload) => ({
    sessionId: 'sess-task',
    result: async () => {
      for (const e of events) payload.onEvent?.(e)
      return { inputRequests: [], message: '', ...final, events, sessionId: 'sess-task' }
    },
  }))
}

const run = (work: unknown) =>
  createRunSkillExecutor({ workspaceId: 'ws-1', runAsUserId: 'user-1', flowId: 'flow-1', fireId: 'evt-1', work: work as never })(action, ctx)

beforeEach(() => {
  process.env.RUN_SKILL_INTERNAL_SECRET = 'test-internal-secret-abcdefghij'
  h.createTaskSession.mockReset()
  h.createParkingRunSession.mockReset()
  h.cancelTaskSession.mockClear()
  h.applyVerdict.mockReset()
  h.logUsage.mockClear()
  h.createNotification.mockClear()
  h.outputContract = 'verdict'
  h.writes = []
  h.upserts = []
  h.upsertError = null
  h.priorSession = null
  h.applyVerdict.mockImplementation(async (v: RunVerdict) => {
    h.writes.push('applyVerdict')
    return {
      summary: v.summary,
      entries: [],
      cards_surfaced: 1,
      cards_deduped: 0,
      cards_failed: 0,
      cards_overflow: 0,
      revoked_count: 0,
      submitted: v,
    }
  })
})
afterEach(() => {
  delete process.env.RUN_SKILL_INTERNAL_SECRET
})

describe('parking on finish', () => {
  it('a verdict run its bot fronts parks: cards applied once, then the handle and the flag', async () => {
    parkingSession([step(50, 20), committed(VERDICT)], { final: { status: 'waiting', data: VERDICT } })
    const { handle, calls } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('success')
    // Conversation mode, with the verdict schema on this first turn only.
    expect(h.createParkingRunSession).toHaveBeenCalledOnce()
    expect(h.createTaskSession).not.toHaveBeenCalled()
    expect(h.createParkingRunSession.mock.calls[0][1].outputSchema).toBeDefined()
    // Exactly once, and before the park.
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(h.writes.indexOf('applyVerdict')).toBeLessThan(h.writes.indexOf(`upsert:${SKILL_RUN_SESSION_TABLE}`))
    // The handle: the eve cursor, frozen at the park, and the run's facts.
    expect(h.upserts).toHaveLength(1)
    expect(h.upserts[0].table).toBe(SKILL_RUN_SESSION_TABLE)
    expect(h.upserts[0].row).toMatchObject({
      tracked_job_id: 'job-1',
      workspace_id: 'ws-1',
      session_state: { sessionId: 'sess-park', streamIndex: 7, settleStreamIndex: 7 },
      run_facts: { skillId: 'skill-1', mode: 'act', hasCapture: false, outputContract: 'verdict', runAsUserId: 'user-1' },
    })
    // The row learns only the flag.
    expect(calls).toContainEqual(['link', [{ source: { run_chat: true } }]])
    // A parked session is left alone.
    expect(h.cancelTaskSession).not.toHaveBeenCalled()
  })

  it('a prose run its bot fronts delivers its document, then parks', async () => {
    h.outputContract = 'prose'
    parkingSession([step(30, 40), said('This week in brief.')], { final: { status: 'waiting', message: 'This week in brief.' } })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.error_message ?? null).toBeNull()
    expect(result.status).toBe('success')
    expect(h.createParkingRunSession.mock.calls[0][1].outputSchema).toBeUndefined()
    expect(h.upserts[0].row).toMatchObject({ run_facts: { outputContract: 'prose' } })
  })

  it('a run nobody fronts keeps its TASK session and parks nothing', async () => {
    taskSession([step(50, 20), committed(VERDICT)], { status: 'completed', data: VERDICT })
    const { handle } = workHandle({ aiTeamMemberId: null })

    const result = await run(handle)

    expect(result.status).toBe('success')
    expect(h.createTaskSession).toHaveBeenCalledOnce()
    expect(h.createParkingRunSession).not.toHaveBeenCalled()
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(h.upserts).toHaveLength(0)
  })

  it('a run with no ledger row (an inert handle, a test fire) keeps its TASK session', async () => {
    taskSession([step(50, 20), committed(VERDICT)], { status: 'completed', data: VERDICT })
    const { handle } = workHandle({ id: null, inert: true })

    await run(handle)
    expect(h.createParkingRunSession).not.toHaveBeenCalled()
    expect(h.upserts).toHaveLength(0)
  })

  it('a handle that cannot be stored never fails the delivered run', async () => {
    parkingSession([step(50, 20), committed(VERDICT)], { final: { status: 'waiting', data: VERDICT } })
    h.upsertError = { message: 'relation "tracked_job_session" does not exist' }
    const { handle, calls } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('success')
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(calls.some(([m]) => m === 'link')).toBe(false)
    // Its handle is lost, so its session is stopped rather than left parked.
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
  })

  it('a parked session with no readable cursor is stopped, and nothing is kept', async () => {
    parkingSession([step(50, 20), committed(VERDICT)], { final: { status: 'waiting', data: VERDICT } }, { sessionId: 'sess-park', streamIndex: 0 })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('success')
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })

  it('a delivery that throws stops the parked session, and nothing is kept', async () => {
    parkingSession([step(50, 20), committed(VERDICT)], { final: { status: 'waiting', data: VERDICT } })
    h.applyVerdict.mockImplementation(async () => {
      throw new Error('apply walk exploded')
    })
    const { handle } = workHandle()

    await run(handle).catch(() => null)

    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })

  it('a later run on the same row replaces the handle and stops the session it replaced', async () => {
    h.priorSession = { sessionId: 'sess-older', streamIndex: 4, settleStreamIndex: 4 }
    parkingSession([step(50, 20), committed(VERDICT)], { final: { status: 'waiting', data: VERDICT } })
    const { handle } = workHandle()

    await run(handle)

    expect(h.upserts[0].row).toMatchObject({ session_state: { sessionId: 'sess-park' } })
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-older')
    expect(h.cancelTaskSession).not.toHaveBeenCalledWith(expect.anything(), 'sess-park')
  })
})

describe('every other outcome cancels the session and parks nothing', () => {
  it('a turn that failed (conversation mode parks after turn.failed) fails the run', async () => {
    parkingSession([ev('turn.failed', { message: 'provider exploded' })], { final: { status: 'waiting' } })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('failed')
    expect(result.error_message).toBe('eve session failed: provider exploded')
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.applyVerdict).not.toHaveBeenCalled()
    expect(h.upserts).toHaveLength(0)
  })

  it('a prompt for input (HITL / session limit) fails the run instead of waiting forever', async () => {
    parkingSession([step(10, 5)], { final: { status: 'waiting', inputRequests: [{ requestId: 'r1' }] } })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('failed')
    expect(result.error_message).toContain(PARKED_ON_INPUT_REASON)
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })

  it('a verdict committed before the turn failed is salvaged once, and the session is not kept', async () => {
    parkingSession([step(50, 20), committed(VERDICT), ev('turn.failed', { message: 'late failure' })], {
      final: { status: 'waiting', data: VERDICT },
    })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('success')
    expect(h.applyVerdict).toHaveBeenCalledOnce()
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })

  it('the wall cancels the session: a timeout, nothing parked', async () => {
    parkingSession([step(10, 5)], { error: new Error('The operation was aborted due to timeout') })
    const { handle } = workHandle()

    const result = await run(handle)

    expect(result.status).toBe('failed')
    expect(result.error_message).toContain('timed out')
    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })

  it('the step cap cancels the session and delivers what exists, unparked', async () => {
    h.outputContract = 'prose'
    const steps: HandleMessageStreamEvent[] = []
    for (let i = 0; i < 13; i++) steps.push(ev('step.started', { stepIndex: i }), said(`step ${i}`), step(1, 1))
    parkingSession(steps, { final: { status: 'waiting', message: 'step 12' } })
    const { handle } = workHandle()

    await run(handle)

    expect(h.cancelTaskSession).toHaveBeenCalledWith(expect.anything(), 'sess-park')
    expect(h.upserts).toHaveLength(0)
  })
})
