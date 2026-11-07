/**
 * Questions nobody can answer any more (stale-questions.ts), as the reaper
 * puts them right:
 *   - a waiting row whose run is gone (deleted with its action: agent_run_id
 *     set null, or a run id that no longer reads) is canceled; one whose run
 *     failed or was canceled takes that; one whose run finished becomes what
 *     the mirror's finish would have made it (a work run's result waits on
 *     review with its deliverables; a coding run with no PR ends done); one
 *     whose run is going again goes back to running, with a deadline. No
 *     failure notice; its unread notices read. The run is read again right
 *     before each write (one answered or re-parked since the scan wins);
 *   - a live question (its run still parked on it) is left alone, and so is a
 *     row still inside the grace (a mirror write may be in flight), and a
 *     kind no run records;
 *   - a live question unanswered for WORK_INPUT_TTL_DAYS is given up: its run
 *     canceled first, the way Stop does (a CAS to `canceling`, then
 *     `agent/run.cancel`), and the row only if that won; answered in the
 *     meantime, the row is left;
 *   - rows with no run are read first, and the rest by pages, so a crowd of
 *     live questions never hides them;
 *   - the stale-run reaper sends a running row whose run re-parked back to
 *     waiting on its question;
 *   - it rides the reaper (reapStaleWork counts it).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({
  createNotification: vi.fn(async (_params: Record<string, unknown>) => {}),
  send: vi.fn(async (_e: unknown) => ({ ids: ['evt'] })),
}))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: hoisted.send } }))

import { WORK_INPUT_TTL_DAYS } from '../types'
import {
  QUESTION_RECONCILE_GRACE_MS,
  QUESTION_RUN_GONE,
  QUESTION_TTL_REASON,
  questionRunState,
  reconcileStaleQuestions,
  stopWaitingOnQuestion,
} from '../stale-questions'
import { reapStaleWork } from '../reaper'
import { resetAgentRunMirrorCaches } from '../agent-run-mirror'

const NOW = '2026-10-08T12:00:00.000Z'
const MIN = 60_000
const DAY = 24 * 60 * MIN
const ago = (ms: number) => new Date(Date.parse(NOW) - ms).toISOString()

beforeEach(() => {
  hoisted.createNotification.mockClear()
  hoisted.send.mockClear()
  resetAgentRunMirrorCaches()
})

function question(over: Record<string, unknown>) {
  return {
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    status: 'needs_input',
    agent_run_id: null,
    needs: { kind: 'input', questions: [{ question: 'Which deadline?' }] },
    current_step: 'Waiting on your answer',
    last_beat_at: ago(2 * 60 * MIN),
    deadline_at: null,
    ...over,
  }
}

function world() {
  const fake = makeFakeSupabase()
  fake.seed('tracked_job', [
    question({ id: 'gone' }),
    question({ id: 'missing', agent_run_id: 'ar-deleted' }),
    question({ id: 'finished', agent_run_id: 'ar-completed' }),
    question({ id: 'pr', kind: 'coding_run', agent_run_id: 'ar-pr' }),
    question({ id: 'broke', agent_run_id: 'ar-failed' }),
    question({ id: 'stopped', agent_run_id: 'ar-canceled' }),
    question({ id: 'resumed', agent_run_id: 'ar-running' }),
    question({ id: 'live', agent_run_id: 'ar-waiting' }),
    question({ id: 'elsewhere', agent_run_id: 'ar-other-ws' }),
    question({ id: 'fresh', last_beat_at: ago(2 * MIN) }),
    question({ id: 'not-a-run', kind: 'flow_run' }),
  ])
  fake.seed('agent_run', [
    { id: 'ar-completed', workspace_id: 'w1', status: 'completed', result_summary: 'Drafted the recap', deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }] },
    { id: 'ar-pr', workspace_id: 'w1', status: 'pr_open' },
    { id: 'ar-failed', workspace_id: 'w1', status: 'failed' },
    { id: 'ar-canceled', workspace_id: 'w1', status: 'canceled' },
    { id: 'ar-running', workspace_id: 'w1', status: 'running' },
    { id: 'ar-waiting', workspace_id: 'w1', status: 'needs_input' },
    { id: 'ar-other-ws', workspace_id: 'w2', status: 'needs_input' },
  ])
  fake.seed('notification', [
    { id: 'n-gone', recipient_id: 'm1', target_type: 'work_item', target_id: 'gone', is_read: false, read_at: null },
    { id: 'n-live', recipient_id: 'm1', target_type: 'work_item', target_id: 'live', is_read: false, read_at: null },
  ])
  return fake
}

const byId = (fake: ReturnType<typeof makeFakeSupabase>) => Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id as string, r]))

describe('questionRunState', () => {
  it('reads the run: parked is a live question; none is gone; live otherwise is moved; settled takes its outcome', () => {
    expect(questionRunState(null)).toEqual({ state: 'gone' })
    expect(questionRunState({ status: 'needs_input' })).toEqual({ state: 'waiting' })
    for (const status of ['queued', 'running', 'canceling']) expect(questionRunState({ status })).toEqual({ state: 'moved' })
    expect(questionRunState({ status: 'completed' })).toEqual({ state: 'settled', to: 'done' })
    expect(questionRunState({ status: 'pr_open' })).toEqual({ state: 'settled', to: 'done' })
    expect(questionRunState({ status: 'failed' })).toEqual({ state: 'settled', to: 'failed' })
    expect(questionRunState({ status: 'canceled' })).toEqual({ state: 'settled', to: 'canceled' })
  })
})

describe('reconcileStaleQuestions', () => {
  it('puts right every row whose run is gone or moved on, quietly, and leaves a live question, a fresh row and a non-run kind alone', async () => {
    const fake = world()
    const out = await reconcileStaleQuestions(fake as never, { nowIso: NOW })
    expect(out).toEqual({ reconciled: 8, expired: 0 })
    const rows = byId(fake)
    expect(rows.gone).toMatchObject({ status: 'canceled', needs: null, current_step: null, error_message: QUESTION_RUN_GONE, finished_at: NOW })
    expect(rows.missing).toMatchObject({ status: 'canceled', error_message: QUESTION_RUN_GONE })
    // A run in another workspace is not this row's run: gone.
    expect(rows.elsewhere).toMatchObject({ status: 'canceled', error_message: QUESTION_RUN_GONE })
    // Finished: what the mirror's finish makes it, a work run's result waiting on review with its deliverables.
    expect(rows.finished).toMatchObject({
      status: 'needs_review',
      needs: { kind: 'review', verb: 'review' },
      result_summary: 'Drafted the recap',
      deliverables: [{ type: 'document', id: 'doc-1', label: 'Q3 recap' }],
    })
    // A coding run's PR with no URL: nothing to review, it ends.
    expect(rows.pr.status).toBe('done')
    expect(rows.broke.status).toBe('failed')
    expect(rows.stopped.status).toBe('canceled')
    expect(rows.resumed).toMatchObject({ status: 'running', needs: null })
    expect(Date.parse(rows.resumed.deadline_at as string)).toBeGreaterThan(Date.parse(NOW))
    // Left alone.
    expect(rows.live.status).toBe('needs_input')
    expect(rows.fresh.status).toBe('needs_input')
    expect(rows['not-a-run'].status).toBe('needs_input')
    // No failure notice: only the finished run's review says it needs you, as its own finish would have.
    expect(hoisted.createNotification.mock.calls.map(([p]) => [p.type, p.targetId])).toEqual([['work_needs_you', 'finished']])
    expect(fake.rows('notification').find((n) => n.id === 'n-gone')?.is_read).toBe(true)
    expect(fake.rows('notification').find((n) => n.id === 'n-live')?.is_read).toBe(false)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('a fresh row is reconciled once it has sat past the grace', async () => {
    const fake = world()
    await reconcileStaleQuestions(fake as never, { nowIso: new Date(Date.parse(NOW) + QUESTION_RECONCILE_GRACE_MS).toISOString() })
    expect(byId(fake).fresh.status).toBe('canceled')
  })

  it(`a live question unanswered for ${WORK_INPUT_TTL_DAYS} days is given up: the row canceled, its run canceled the way Stop does`, async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      question({ id: 'old', agent_run_id: 'ar-old', last_beat_at: ago(WORK_INPUT_TTL_DAYS * DAY + MIN) }),
      question({ id: 'young', agent_run_id: 'ar-young', last_beat_at: ago((WORK_INPUT_TTL_DAYS - 1) * DAY) }),
    ])
    fake.seed('agent_run', [
      { id: 'ar-old', workspace_id: 'w1', status: 'needs_input' },
      { id: 'ar-young', workspace_id: 'w1', status: 'needs_input' },
    ])
    expect(await reconcileStaleQuestions(fake as never, { nowIso: NOW })).toEqual({ reconciled: 0, expired: 1 })
    expect(byId(fake).old).toMatchObject({ status: 'canceled', error_message: QUESTION_TTL_REASON })
    expect(byId(fake).young.status).toBe('needs_input')
    const runs = Object.fromEntries(fake.rows('agent_run').map((r) => [r.id as string, r]))
    expect(runs['ar-old'].status).toBe('canceling')
    expect(runs['ar-young'].status).toBe('needs_input')
    expect(hoisted.send).toHaveBeenCalledTimes(1)
    expect(hoisted.send.mock.calls[0][0]).toEqual({
      name: 'agent/run.cancel',
      data: { agent_run_id: 'ar-old', workspace_id: 'w1', reason: QUESTION_TTL_REASON },
    })
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })

  it('a failed run read leaves that row as it is (it says nothing about the run)', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [question({ id: 'finished', agent_run_id: 'ar-completed' })])
    fake.seed('agent_run', [{ id: 'ar-completed', workspace_id: 'w1', status: 'completed' }])
    const realFrom = fake.from.bind(fake)
    const failing = { select: () => failing, eq: () => failing, maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }
    ;(fake as unknown as { from: (t: string) => unknown }).from = (table: string) => (table === 'agent_run' ? failing : realFrom(table))
    expect(await reconcileStaleQuestions(fake as never, { nowIso: NOW })).toEqual({ reconciled: 0, expired: 0 })
    expect(byId(fake).finished.status).toBe('needs_input')
  })

  it('reads the run again right before acting: one answered after the tick began is read as it is now', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      question({ id: 'orphan', last_beat_at: ago(DAY) }),
      question({ id: 'q', agent_run_id: 'ar-1', last_beat_at: ago(WORK_INPUT_TTL_DAYS * DAY + MIN) }),
    ])
    fake.seed('agent_run', [{ id: 'ar-1', workspace_id: 'w1', status: 'needs_input' }])
    // The person answers while the tick closes the orphan: respond-to-run moves the run to queued.
    const realFrom = fake.from.bind(fake)
    ;(fake as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const api = realFrom(table) as { update: (p: Record<string, unknown>) => unknown }
      if (table !== 'tracked_job') return api
      const realUpdate = api.update.bind(api)
      api.update = (patch: Record<string, unknown>) => {
        if (patch.status === 'canceled') fake.rows('agent_run')[0].status = 'queued'
        return realUpdate(patch)
      }
      return api
    }
    const out = await reconcileStaleQuestions(fake as never, { nowIso: NOW })
    // Not given up as unanswered: the answer won, and the row follows the run (going again).
    expect(out).toEqual({ reconciled: 2, expired: 0 })
    expect(byId(fake).q.status).toBe('running')
    expect(fake.rows('agent_run')[0].status).toBe('queued')
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('the TTL cancels the run first: if that CAS loses (answered at that moment), the row is left waiting, never canceled as unanswered', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [question({ id: 'q', agent_run_id: 'ar-1', last_beat_at: ago(WORK_INPUT_TTL_DAYS * DAY + MIN) })])
    fake.seed('agent_run', [{ id: 'ar-1', workspace_id: 'w1', status: 'needs_input' }])
    const realFrom = fake.from.bind(fake)
    ;(fake as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      const api = realFrom(table) as { update: (p: Record<string, unknown>) => unknown }
      if (table !== 'agent_run') return api
      const realUpdate = api.update.bind(api)
      // The answer lands just as the cancel is written: respond-to-run's CAS got there first.
      api.update = (patch: Record<string, unknown>) => {
        if (patch.status === 'canceling') fake.rows('agent_run')[0].status = 'queued'
        return realUpdate(patch)
      }
      return api
    }
    expect(await reconcileStaleQuestions(fake as never, { nowIso: NOW })).toEqual({ reconciled: 0, expired: 0 })
    expect(byId(fake).q.status).toBe('needs_input')
    expect(fake.rows('agent_run')[0].status).toBe('queued')
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('rows sharing a beat across a page’s edge are none of them skipped (a (beat, id) cursor)', async () => {
    const fake = makeFakeSupabase()
    const beat = ago(DAY)
    // 205 rows all stamped with one time (a reaper tick's re-parks), their runs settled: every one is reached.
    const tied = Array.from({ length: 205 }, (_, i) => question({ id: `t-${String(i).padStart(3, '0')}`, agent_run_id: `ar-${i}`, last_beat_at: beat }))
    fake.seed('tracked_job', tied)
    fake.seed('agent_run', tied.map((r) => ({ id: r.agent_run_id, workspace_id: 'w1', status: 'failed' })))
    const out = await reconcileStaleQuestions(fake as never, { nowIso: NOW })
    expect(out.reconciled).toBe(205)
    expect(fake.rows('tracked_job').every((r) => r.status === 'failed')).toBe(true)
  })

  it('live questions sharing a beat across a page’s edge don’t hide the row after them', async () => {
    const fake = makeFakeSupabase()
    const beat = ago(DAY)
    const live = Array.from({ length: 210 }, (_, i) => question({ id: `l-${String(i).padStart(3, '0')}`, agent_run_id: `ar-${i}`, last_beat_at: beat }))
    fake.seed('tracked_job', [...live, question({ id: 'z-after', agent_run_id: 'ar-done', last_beat_at: beat }), question({ id: 'later', agent_run_id: 'ar-done-2', last_beat_at: ago(DAY - MIN) })])
    fake.seed('agent_run', [
      ...live.map((r) => ({ id: r.agent_run_id, workspace_id: 'w1', status: 'needs_input' })),
      { id: 'ar-done', workspace_id: 'w1', status: 'canceled' },
      { id: 'ar-done-2', workspace_id: 'w1', status: 'canceled' },
    ])
    expect(await reconcileStaleQuestions(fake as never, { nowIso: NOW })).toEqual({ reconciled: 2, expired: 0 })
    expect(byId(fake)['z-after'].status).toBe('canceled')
    expect(byId(fake).later.status).toBe('canceled')
  })

  it('rows with no run are put right even behind a crowd of live questions, and live questions past the first page are still read', async () => {
    const fake = makeFakeSupabase()
    const live = Array.from({ length: 450 }, (_, i) =>
      question({ id: `live-${i}`, agent_run_id: `ar-${i}`, last_beat_at: ago(DAY + (450 - i) * MIN) }),
    )
    fake.seed('tracked_job', [...live, question({ id: 'orphan', last_beat_at: ago(30 * MIN) }), question({ id: 'late-finished', agent_run_id: 'ar-done', last_beat_at: ago(20 * MIN) })])
    fake.seed('agent_run', [
      ...live.map((r) => ({ id: r.agent_run_id, workspace_id: 'w1', status: 'needs_input' })),
      { id: 'ar-done', workspace_id: 'w1', status: 'failed' },
    ])
    const out = await reconcileStaleQuestions(fake as never, { nowIso: NOW })
    expect(out).toEqual({ reconciled: 2, expired: 0 })
    expect(byId(fake).orphan.status).toBe('canceled')
    expect(byId(fake)['late-finished'].status).toBe('failed')
  })

  it('rides the reaper: reapStaleWork counts what it put right', async () => {
    const fake = world()
    const out = await reapStaleWork(fake as never, { nowIso: NOW })
    expect(out).toMatchObject({ questionsReconciled: 8, questionsExpired: 0 })
  })

  it('the re-park reads the run again first: a question answered since the batch read is never asked again', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      { id: 'answered', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', status: 'running', agent_run_id: 'ar-1', deadline_at: ago(MIN), last_beat_at: ago(30 * MIN), opened_at: ago(60 * MIN) },
    ])
    fake.seed('agent_run', [{ id: 'ar-1', workspace_id: 'w1', status: 'needs_input', pending_input: { requestId: 'r', questions: [{ question: 'Which tone?' }] } }])
    // The person answers right after the batch read (respond-to-run: needs_input → queued).
    const realFrom = fake.from.bind(fake)
    let runReads = 0
    ;(fake as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table === 'agent_run' && ++runReads === 2) fake.rows('agent_run')[0].status = 'queued'
      return realFrom(table)
    }
    const out = await reapStaleWork(fake as never, { nowIso: NOW })
    expect(out).toMatchObject({ questionsReconciled: 0, extended: 1, failed: 0 })
    expect(byId(fake).answered).toMatchObject({ status: 'running', opened_at: ago(60 * MIN) })
  })

  it('the stale-run reaper sends a running row whose run re-parked on a question back to waiting on it, not extended forever', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      { id: 'reparked', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', status: 'running', agent_run_id: 'ar-asking', deadline_at: ago(MIN), last_beat_at: ago(30 * MIN), opened_at: ago(60 * MIN) },
      { id: 'delegating', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', status: 'running', agent_run_id: 'ar-deleg', deadline_at: ago(MIN), last_beat_at: ago(30 * MIN) },
    ])
    fake.seed('agent_run', [
      { id: 'ar-asking', workspace_id: 'w1', status: 'needs_input', pending_input: { requestId: 'r', questions: [{ question: 'Which tone?' }] } },
      { id: 'ar-deleg', workspace_id: 'w1', status: 'needs_input', pending_input: { kind: 'delegation', askedAt: ago(MIN), children: [] } },
    ])
    const out = await reapStaleWork(fake as never, { nowIso: NOW })
    expect(out).toMatchObject({ questionsReconciled: 1, extended: 1, failed: 0 })
    expect(byId(fake).reparked).toMatchObject({
      status: 'needs_input',
      needs: { kind: 'input', questions: [{ question: 'Which tone?' }] },
      deadline_at: null,
      opened_at: null,
    })
    // A delegation park is the run waiting on a teammate, not you: extended as before.
    expect(byId(fake).delegating.status).toBe('running')
  })
})

describe('stopWaitingOnQuestion', () => {
  it('gone: canceled; live: refused and untouched; not waiting: nothing', async () => {
    const fake = world()
    const rows = byId(fake)
    expect(await stopWaitingOnQuestion(fake as never, rows.gone as never, { nowIso: NOW })).toEqual({ outcome: 'stopped', status: 'canceled' })
    expect(await stopWaitingOnQuestion(fake as never, rows.live as never, { nowIso: NOW })).toEqual({ outcome: 'live' })
    expect(byId(fake).live.status).toBe('needs_input')
    expect(await stopWaitingOnQuestion(fake as never, { ...(rows.gone as object), status: 'canceled' } as never)).toEqual({ outcome: 'not_waiting', status: 'canceled' })
    // A fresh row whose run is gone: the person may stop waiting at once (no grace for them).
    expect(await stopWaitingOnQuestion(fake as never, rows.fresh as never, { nowIso: NOW })).toEqual({ outcome: 'stopped', status: 'canceled' })
  })
})
