/**
 * The work recorder's lifecycle contract (ACTIVITY-AND-REVIEW-DESIGN §3.2).
 *
 * Against a stateful fake that honors the CAS guards, so each transition is a
 * real state change and its idempotency is meaningful. Covers: start shapes
 * (queued / running / one-shot terminal), idempotent start on the (kind,
 * run_key) unique index, the queued → running flip on the first step, step
 * coalescing, the parked / resumed path, finish → done vs needs_review, the
 * terminal guards (a settled row is never overwritten), the inert handle, and
 * `opened_at` re-arming on every move into a waiting status (migration 295).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'
import { BEAT_COALESCE_MS, STEP_COALESCE_MS, attachWork, findWork, startWork, workFor } from '../recorder'
import { WORK_STEP_LOG_CAP, type WorkItem } from '../types'
import { USAGE_LIMIT_BODY } from '../notify'
import { markOpened, resolveWorkForDeliverable } from '../resolve'
import { countByOwner } from '../agent-work-lanes'

// The push is a side effect of status; the recorder is its only producer.
const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))

const base = { workspaceId: 'w1', memberId: 'm1', kind: 'email_drafts', title: 'Reply drafts' }

beforeEach(() => {
  hoisted.createNotification.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('startWork', () => {
  it('creates a queued row with no lifecycle stamps and a queued deadline', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    expect(work.inert).toBe(false)
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('queued')
    expect(row.started_at).toBeNull()
    expect(row.finished_at).toBeNull()
    expect(row.deadline_at).not.toBeNull()
    expect(row.actor).toBe('system')
    expect(row.deliverables).toEqual([])
  })

  it('creates a running row with started_at stamped', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, status: 'running', actor: 'loop' })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('running')
    expect(row.started_at).not.toBeNull()
    expect(row.actor).toBe('loop')
  })

  it('records a one-shot terminal row in a single write (the age-out sweep)', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, {
      ...base,
      kind: 'proposal_age_out',
      status: 'done',
      resultSummary: 'aged out 12 stale proposals',
      source: { workspace_id: 'w1', dismissed: 12 },
    })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('done')
    expect(row.started_at).not.toBeNull()
    expect(row.finished_at).not.toBeNull()
    expect(row.deadline_at).toBeNull()
    expect(row.result_summary).toBe('aged out 12 stale proposals')
  })

  it('is idempotent on (kind, run_key): a retry gets the SAME row back', async () => {
    const fake = makeFakeSupabase()
    const first = await startWork(fake as never, { ...base, runKey: 'evt-1', status: 'running' })
    await first.step('Reading the thread')
    const again = await startWork(fake as never, { ...base, runKey: 'evt-1', status: 'running' })
    expect(again.id).toBe(first.id)
    expect(fake.rows('tracked_job')).toHaveLength(1)
    // The re-attached handle carries the earlier steps forward.
    await again.finish({ summary: 'done' })
    const steps = (fake.rows('tracked_job')[0].progress as { steps: unknown[] }).steps
    expect(steps).toHaveLength(1)
  })

  it('returns an inert handle when the insert fails, and never throws', async () => {
    const broken = {
      from: () => ({
        insert: () => ({
          select: () => ({ maybeSingle: async () => ({ data: null, error: { message: 'boom' } }) }),
        }),
      }),
    }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const work = await startWork(broken as never, base)
    expect(work.inert).toBe(true)
    expect(work.id).toBeNull()
    await expect(work.step('x')).resolves.toBeUndefined()
    await expect(work.finish()).resolves.toBeUndefined()
    spy.mockRestore()
  })
})

describe('step', () => {
  it('flips queued → running on the first step, stamps started_at, writes the line and the log', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.step('Reading the thread from Dana', { total: 3, done: 0 })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('running')
    expect(row.started_at).not.toBeNull()
    expect(row.current_step).toBe('Reading the thread from Dana')
    const progress = row.progress as { steps: Array<{ text: string }>; total: number; done: number }
    expect(progress.total).toBe(3)
    expect(progress.steps.map((s) => s.text)).toEqual(['Reading the thread from Dana'])
  })

  it('coalesces a burst into one trailing write and keeps the latest text', async () => {
    vi.useFakeTimers()
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.step('one') // written immediately (first write)
    await work.step('two') // within the window → trails
    await work.step('three') // replaces the trailing text
    expect(fake.rows('tracked_job')[0].current_step).toBe('one')
    await vi.advanceTimersByTimeAsync(STEP_COALESCE_MS + 10)
    expect(fake.rows('tracked_job')[0].current_step).toBe('three')
    const steps = (fake.rows('tracked_job')[0].progress as { steps: Array<{ text: string }> }).steps
    expect(steps.map((s) => s.text)).toEqual(['one', 'three'])
  })

  it('flushes a trailing step on finish, so nothing is lost at the end', async () => {
    vi.useFakeTimers()
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.step('one')
    await work.step('two')
    await work.finish({ summary: 'Drafted 2 replies' })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('done')
    expect(row.current_step).toBeNull()
    const steps = (row.progress as { steps: Array<{ text: string }> }).steps
    expect(steps.map((s) => s.text)).toEqual(['one', 'two'])
  })

  it('caps the step log', async () => {
    vi.useFakeTimers()
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    for (let i = 0; i < WORK_STEP_LOG_CAP + 5; i += 1) {
      await work.step(`step ${i}`)
      await vi.advanceTimersByTimeAsync(STEP_COALESCE_MS + 1)
    }
    const steps = (fake.rows('tracked_job')[0].progress as { steps: Array<{ text: string }> }).steps
    expect(steps).toHaveLength(WORK_STEP_LOG_CAP)
    expect(steps[steps.length - 1].text).toBe(`step ${WORK_STEP_LOG_CAP + 4}`)
  })

  it('never resurrects a settled row', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.finish({ summary: 'x' })
    await work.step('late step')
    expect(fake.rows('tracked_job')[0].status).toBe('done')
    expect(fake.rows('tracked_job')[0].current_step).toBeNull()
  })
})

describe('beat', () => {
  it('keeps the row alive at most once per window — a log pump never costs an UPDATE per chunk', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-17T12:00:00Z'))
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    const row = () => fake.rows('tracked_job')[0]
    const atStart = row().last_beat_at

    // Inside the window of the row's own creation: skipped.
    await vi.advanceTimersByTimeAsync(1000)
    await work.beat()
    expect(row().last_beat_at).toBe(atStart)

    // Past it: written, with the running deadline re-armed.
    await vi.advanceTimersByTimeAsync(BEAT_COALESCE_MS)
    await work.beat()
    const afterBeat = row().last_beat_at
    expect(afterBeat).not.toBe(atStart)
    expect(Date.parse(row().deadline_at as string)).toBeGreaterThan(Date.parse(afterBeat as string))

    // A fresh handle over the same row (one request per beat, a new process each
    // time) seeds its clock from the row, so it throttles too.
    await vi.advanceTimersByTimeAsync(1000)
    const again = attachWork(fake as never, row() as unknown as WorkItem)
    await again.beat()
    expect(row().last_beat_at).toBe(afterBeat)
    await vi.advanceTimersByTimeAsync(BEAT_COALESCE_MS)
    await again.beat()
    expect(row().last_beat_at).not.toBe(afterBeat)

    // A step is never throttled by the beat window (it is the live signal).
    await vi.advanceTimersByTimeAsync(STEP_COALESCE_MS + 1)
    await again.step('Reading the thread')
    expect(row().current_step).toBe('Reading the thread')
  })
})

describe('needInput / resume', () => {
  it('parks the row with its questions and clears the deadline; resume re-arms it', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.needInput([{ question: 'Which tone?' }])
    let row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('needs_input')
    expect(row.needs).toEqual({ kind: 'input', questions: [{ question: 'Which tone?' }] })
    expect(row.deadline_at).toBeNull()
    expect(row.current_step).toBe('Waiting on your answer')

    // A stray step while parked does not un-park it — only resume() does.
    await work.step('sneaky')
    expect(fake.rows('tracked_job')[0].status).toBe('needs_input')

    await work.resume()
    row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('running')
    expect(row.needs).toBeNull()
    expect(row.deadline_at).not.toBeNull()
  })

  it('resume is a no-op unless the row is parked', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.resume()
    expect(fake.rows('tracked_job')[0].status).toBe('running')
    expect(fake.rows('tracked_job')[0].current_step).toBeNull()
  })
})

describe('waitOnChild (row 13)', () => {
  it('parks on the child it handed work to, with no deadline and no push; resume un-parks it', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    hoisted.createNotification.mockClear()
    await work.waitOnChild({ workItemId: 'child-work', role: 'researcher', label: 'Researcher', count: 1 })
    let row = fake.rows('tracked_job')[0]
    expect(row).toMatchObject({
      status: 'waiting_on_child',
      needs: { kind: 'child', work_item_id: 'child-work', role: 'researcher' },
      current_step: 'Waiting on Researcher',
      deadline_at: null,
    })
    expect(hoisted.createNotification).not.toHaveBeenCalled()

    await work.resume()
    row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('running')
    expect(row.needs).toBeNull()
    expect(row.deadline_at).not.toBeNull()
  })

  it('names the count when it waits on several', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.waitOnChild({ workItemId: 'c1', role: 'researcher', label: 'Researcher', count: 2 })
    expect(fake.rows('tracked_job')[0]).toMatchObject({
      current_step: 'Waiting on 2 teammates',
      needs: { kind: 'child', work_item_id: 'c1', role: 'researcher', count: 2 },
    })
  })

  it('a run waiting on a child can still be failed or canceled', async () => {
    const fake = makeFakeSupabase()
    const a = await startWork(fake as never, { ...base, status: 'running' })
    await a.waitOnChild({ workItemId: 'c1', role: 'researcher', label: 'Researcher', count: 1 })
    await a.cancel('stopped')
    expect(fake.rows('tracked_job')[0].status).toBe('canceled')
    const b = await startWork(fake as never, { ...base, kind: 'other', status: 'running' })
    await b.waitOnChild({ workItemId: 'c1', role: 'researcher', label: 'Researcher', count: 1 })
    await b.fail('boom')
    expect(fake.rows('tracked_job')[1].status).toBe('failed')
  })

  it('startWork writes the tree linkage it is given', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, parentId: 'p', rootId: 'r', depth: 2 })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ parent_id: 'p', root_id: 'r', depth: 2 })
  })
})

describe('finish / fail / skip / cancel', () => {
  it('finish → done with summary, deliverables and no needs', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.finish({
      summary: 'Drafted 2 replies',
      deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: Q3' }],
    })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('done')
    expect(row.result_summary).toBe('Drafted 2 replies')
    expect(row.deliverables).toEqual([{ type: 'email_draft', id: 'd1', label: 'Re: Q3' }])
    expect(row.needs).toBeNull()
    expect(row.finished_at).not.toBeNull()
    expect(row.deadline_at).toBeNull()
  })

  it('finish with review → needs_review carrying the verb', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.finish({
      summary: 'Drafted 2 replies',
      deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: Q3' }],
      review: { kind: 'review', verb: 'review' },
    })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('needs_review')
    expect(row.needs).toEqual({ kind: 'review', verb: 'review' })
  })

  it('finish from queued stamps started_at too (a one-step job)', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.finish()
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('done')
    expect(row.started_at).not.toBeNull()
  })

  it('fail records the message and is final: a later finish is ignored', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.fail('Model timed out after 120s')
    await work.finish({ summary: 'late' })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('failed')
    expect(row.error_message).toBe('Model timed out after 120s')
    expect(row.result_summary).toBeNull()
  })

  it('fail may leave needs_review (a review that can no longer happen)', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.finish({ review: { kind: 'review', verb: 'send' } })
    await work.fail('draft deleted')
    expect(fake.rows('tracked_job')[0].status).toBe('failed')
  })

  it('skip records the reason from queued or running only', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    await work.skip('Workspace dormant for 14 days')
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('skipped')
    expect(row.skip_reason).toBe('Workspace dormant for 14 days')
    await work.skip('again')
    expect(fake.rows('tracked_job')[0].skip_reason).toBe('Workspace dormant for 14 days')
  })

  it('cancel settles a parked row', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.needInput([])
    await work.cancel('Canceled by user')
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('canceled')
    expect(row.needs).toBeNull()
    expect(row.error_message).toBe('Canceled by user')
  })
})

describe('link / findWork / workFor', () => {
  it('link stamps back-references and merges source', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, source: { capture_id: 'c1' } })
    await work.link({ flowRunId: 'fr-1', source: { agent_run_id: 'ar-1' } })
    const row = fake.rows('tracked_job')[0]
    expect(row.flow_run_id).toBe('fr-1')
    expect(row.source).toEqual({ capture_id: 'c1', agent_run_id: 'ar-1' })
  })

  it('findWork resolves by run key, agent run and flow run', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, runKey: 'k1', agentRunId: 'ar-1', flowRunId: 'fr-1' })
    expect((await findWork(fake as never, { kind: base.kind, runKey: 'k1' }))?.run_key).toBe('k1')
    expect((await findWork(fake as never, { agentRunId: 'ar-1' }))?.agent_run_id).toBe('ar-1')
    expect((await findWork(fake as never, { flowRunId: 'fr-1' }))?.flow_run_id).toBe('fr-1')
    expect(await findWork(fake as never, { agentRunId: 'nope' })).toBeNull()
    expect(await findWork(fake as never, {})).toBeNull()
  })

  it('workFor attaches a live handle to a found row and an inert one otherwise', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, agentRunId: 'ar-1', status: 'running' })
    const found = await workFor(fake as never, { agentRunId: 'ar-1' })
    expect(found.inert).toBe(false)
    await found.finish({ summary: 'ok' })
    expect(fake.rows('tracked_job')[0].status).toBe('done')

    const missing = await workFor(fake as never, { agentRunId: 'ar-2' })
    expect(missing.inert).toBe(true)
  })

  it('attachWork carries the row status so a settled row stays settled', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, status: 'done', runKey: 'k1' })
    const row = fake.rows('tracked_job')[0] as unknown as WorkItem
    const work = attachWork(fake as never, row)
    await work.step('late')
    expect(fake.rows('tracked_job')[0].status).toBe('done')
  })
})

describe('notifications as a side effect of status', () => {
  const drafts = [
    { type: 'email_draft' as const, id: 'd1', label: 'Re: A' },
    { type: 'email_draft' as const, id: 'd2', label: 'Re: B' },
  ]

  it('needInput → work_needs_you with the first question, targeting the item; resume is silent', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.needInput([{ question: 'Which tone should the reply take?' }])
    expect(hoisted.createNotification).toHaveBeenCalledTimes(1)
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: 'w1',
        recipientId: 'm1',
        type: 'work_needs_you',
        targetType: 'work_item',
        targetId: work.id,
        title: 'Reply drafts — needs your answer',
        body: 'Which tone should the reply take?',
      }),
    )
    await work.resume()
    expect(hoisted.createNotification).toHaveBeenCalledTimes(1)
  })

  it('finish with a review → "ready to review" over the deliverables; a plain finish is silent', async () => {
    const fake = makeFakeSupabase()
    const plain = await startWork(fake as never, { ...base, status: 'running' })
    await plain.finish({ summary: 'Nothing needed a draft' })
    expect(hoisted.createNotification).not.toHaveBeenCalled()

    const review = await startWork(fake as never, { ...base, status: 'running' })
    await review.finish({
      summary: '2 drafts ready to review',
      deliverables: drafts,
      review: { kind: 'review', verb: 'review' },
    })
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'work_needs_you',
        targetId: review.id,
        title: 'Reply drafts — ready to review',
        body: 'Review 2 drafts · 2 drafts ready to review',
      }),
    )
  })

  it('fail → work_failed, at most once per (workspace, kind) per day; a usage limit reads as paused', async () => {
    const fake = makeFakeSupabase()
    const first = await startWork(fake as never, { ...base, status: 'running' })
    await first.fail('Model timed out')
    expect(hoisted.createNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'work_failed',
        targetType: 'work_item',
        targetId: first.id,
        title: "Reply drafts couldn't run",
        body: 'Model timed out',
        groupKey: expect.stringMatching(/^work_failed:w1:email_drafts:\d{4}-\d{2}-\d{2}$/),
      }),
    )
    // The day's group already has one (the row createNotification would have
    // inserted): a second failure of the same kind is folded into it.
    const { groupKey } = (hoisted.createNotification.mock.calls[0] as unknown as [{ groupKey: string }])[0]
    fake.seed('notification', [{ id: 'n1', recipient_id: 'm1', type: 'work_failed', group_key: groupKey }])
    const second = await startWork(fake as never, { ...base, status: 'running' })
    await second.fail('Again')
    expect(hoisted.createNotification).toHaveBeenCalledTimes(1)

    // Another kind is its own group, and a usage-limit block reads as paused.
    const other = await startWork(fake as never, { ...base, kind: 'flow_run', title: 'Weekly groom', status: 'running' })
    await other.fail('AI usage limit reached for this plan')
    expect(hoisted.createNotification).toHaveBeenLastCalledWith(
      expect.objectContaining({ type: 'work_failed', title: "Weekly groom couldn't run", body: USAGE_LIMIT_BODY }),
    )
  })

  it('quiet items, quiet finishes and a lost CAS send nothing; mute() survives re-attach', async () => {
    const fake = makeFakeSupabase()
    const muted = await startWork(fake as never, { ...base, status: 'running', quiet: true })
    await muted.needInput([{ question: 'q' }])
    await muted.resume()
    await muted.fail('x')
    const quietFinish = await startWork(fake as never, { ...base, status: 'running' })
    await quietFinish.finish({ deliverables: drafts, review: { kind: 'review', verb: 'check' }, quiet: true })
    expect(hoisted.createNotification).not.toHaveBeenCalled()
    expect(fake.rows('tracked_job')[1].status).toBe('needs_review')

    const later = await startWork(fake as never, { ...base, status: 'running', runKey: 'muted' })
    await later.mute()
    const again = await workFor(fake as never, { kind: base.kind, runKey: 'muted' })
    await again.fail('boom')
    expect(hoisted.createNotification).not.toHaveBeenCalled()

    const a = await startWork(fake as never, { ...base, status: 'running', runKey: 'cas' })
    const b = await workFor(fake as never, { kind: base.kind, runKey: 'cas' })
    await a.fail('first')
    hoisted.createNotification.mockClear()
    await b.fail('second')
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })
})

describe('opened_at: opened since it last started waiting on you (migration 295)', () => {
  const OPENED = '2026-09-30T09:00:00.000Z'
  const stamp = (fake: ReturnType<typeof makeFakeSupabase>, i = 0) => {
    fake.rows('tracked_job')[i].opened_at = OPENED
  }
  const MISSING = { data: null, error: { code: '42703', message: 'column tracked_job.opened_at does not exist' } }
  /** The fake as PostgREST answers on a database without migration 295: any
   *  tracked_job write naming opened_at fails (`throws`: the call itself throws). */
  function without295(fake: ReturnType<typeof makeFakeSupabase>, opts: { throws?: boolean } = {}) {
    return {
      ...fake,
      from: (table: string) => {
        const q = fake.from(table) as Record<string, (...args: unknown[]) => unknown>
        if (table !== 'tracked_job') return q
        const update = q.update
        let names = false
        q.update = (patch: unknown) => {
          names = !!patch && typeof patch === 'object' && 'opened_at' in patch
          update(patch)
          return q
        }
        for (const end of ['then', 'maybeSingle', 'single']) {
          const real = q[end]
          q[end] = (...args: unknown[]) => {
            if (!names) return real(...args)
            if (opts.throws) throw new Error('column tracked_job.opened_at does not exist')
            const answer = Promise.resolve(MISSING)
            return end === 'then'
              ? answer.then(args[0] as (v: unknown) => unknown, args[1] as (e: unknown) => unknown)
              : answer
          }
        }
        return q
      },
    }
  }

  it('needInput from running clears the stamp, right after the move', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    // The owner looked in while it ran (the panel stamps in any status).
    stamp(fake)
    await work.needInput([{ question: 'Which tone?' }])
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('needs_input')
    expect(row.opened_at).toBeNull()
  })

  it('finish with a review from running clears it; a plain finish keeps it', async () => {
    const fake = makeFakeSupabase()
    const reviewed = await startWork(fake as never, { ...base, status: 'running' })
    const plain = await startWork(fake as never, { ...base, status: 'running' })
    stamp(fake, 0)
    stamp(fake, 1)
    await reviewed.finish({ summary: 'Drafted it', review: { kind: 'review', verb: 'review' } })
    await plain.finish({ summary: 'Done' })
    const [r, p] = fake.rows('tracked_job')
    expect(r.status).toBe('needs_review')
    expect(r.opened_at).toBeNull()
    expect(p.status).toBe('done')
    expect(p.opened_at).toBe(OPENED)
  })

  it('needs_review → needs_review is no move: the stamp stays, and so it does through other writes on the row', async () => {
    const fake = makeFakeSupabase()
    const first = await startWork(fake as never, { ...base, status: 'running' })
    await first.finish({
      deliverables: [
        { type: 'email_draft', id: 'd1', label: 'Re: A' },
        { type: 'email_draft', id: 'd2', label: 'Re: B' },
      ],
      review: { kind: 'review', verb: 'review' },
    })
    stamp(fake)
    // A second settle over the waiting row (a retried mirror) loses its CAS…
    const again = attachWork(fake as never, fake.rows('tracked_job')[0] as unknown as WorkItem)
    await again.finish({ summary: 'again', review: { kind: 'review', verb: 'review' } })
    await again.needInput([{ question: 'late' }])
    // …one draft acted on in Mail stamps it resolved, still waiting on the other…
    await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd1' })
    // …and a back-link.
    await again.link({ source: { thread_ids: ['t1'] } })
    const row = fake.rows('tracked_job')[0]
    expect(row.status).toBe('needs_review')
    expect(row.opened_at).toBe(OPENED)
  })

  it('a run that asked, was opened, then resumed and came back with a draft calls for you again', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, kind: 'work_run', status: 'running', aiTeamMemberId: 'writer' })
    const id = work.id as string
    const held = () => fake.rows('tracked_job')[0] as unknown as WorkItem
    const writer = () => countByOwner([held()]).get('tm:writer')

    await work.needInput([{ question: 'Which tone?' }])
    expect(writer()).toEqual({ running: 0, needsYou: 1, beckoning: [id], asking: [id] })
    // The owner opens the question (the panel's PATCH → markOpened)…
    expect(await markOpened(fake as never, held())).toBe(true)
    expect(writer()).toEqual({ running: 0, needsYou: 1, beckoning: [] })
    // …answers, the run picks the work back up…
    await work.resume()
    // (Not waiting on you: the stamp is left as it is, and counts for nothing.)
    expect(held().opened_at).not.toBeNull()
    expect(writer()).toEqual({ running: 1, needsYou: 0, beckoning: [] })
    // …and settles with a draft: new again, so its bot jumps.
    await work.finish({ summary: 'Drafted the reply', review: { kind: 'review', verb: 'review' } })
    expect(held().status).toBe('needs_review')
    expect(held().opened_at).toBeNull()
    expect(writer()).toEqual({ running: 0, needsYou: 1, beckoning: [id] })
    // Opening the draft quiets it, and a second open moves nothing.
    expect(await markOpened(fake as never, held())).toBe(true)
    expect(await markOpened(fake as never, held())).toBe(false)
    expect(writer()).toEqual({ running: 0, needsYou: 1, beckoning: [] })
  })

  it('a question answered with no resume recorded (needs_input → needs_review) is a new ask too', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, kind: 'work_run', status: 'running', aiTeamMemberId: 'writer' })
    await work.needInput([{ question: 'Which tone?' }])
    expect(await markOpened(fake as never, fake.rows('tracked_job')[0] as unknown as WorkItem)).toBe(true)
    await work.finish({ summary: 'Drafted the reply', review: { kind: 'review', verb: 'review' } })
    const row = fake.rows('tracked_job')[0] as unknown as WorkItem
    expect(row.status).toBe('needs_review')
    expect(row.opened_at).toBeNull()
    expect(countByOwner([row]).get('tm:writer')?.beckoning).toEqual([work.id])
  })

  it('the move never depends on the column: without migration 295 the row still moves and pushes, the re-arm skipped with one line', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const throws of [false, true]) {
        hoisted.createNotification.mockClear()
        warn.mockClear()
        const fake = makeFakeSupabase()
        // Its Mail face, whom these rows' notices come from (they name no teammate, and an email
        // pass is Mail's: notify.ts withNoticeBot, migration 318).
        fake.seed('ai_team_member', [{ id: 'tm-mail', workspace_id: base.workspaceId, system_key: 'mail', name: 'Mail' }])
        const db = without295(fake, { throws })
        const asks = await startWork(db as never, { ...base, status: 'running' })
        const drafts = await startWork(db as never, { ...base, status: 'running' })
        await asks.needInput([{ question: 'Which tone?' }])
        await drafts.finish({
          summary: 'Drafted 1 reply',
          deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: A' }],
          review: { kind: 'review', verb: 'review' },
        })
        const [a, d] = fake.rows('tracked_job')
        expect(a.status).toBe('needs_input')
        expect(a.needs).toEqual({ kind: 'input', questions: [{ question: 'Which tone?' }] })
        expect(d.status).toBe('needs_review')
        expect(d.deliverables).toEqual([{ type: 'email_draft', id: 'd1', label: 'Re: A' }])
        // Both pushes went out.
        expect(hoisted.createNotification).toHaveBeenCalledTimes(2)
        expect(hoisted.createNotification).toHaveBeenCalledWith(expect.objectContaining({ type: 'work_needs_you' }))
        // One line per skipped re-arm, nothing logged as a failed move.
        expect(warn).toHaveBeenCalledTimes(2)
        expect(warn).toHaveBeenCalledWith('[work] opened_at re-arm skipped:', 'column tracked_job.opened_at does not exist')
        expect(error).not.toHaveBeenCalled()
        // Later moves still go through the handle.
        await asks.resume()
        expect(fake.rows('tracked_job')[0].status).toBe('running')
      }
    } finally {
      warn.mockRestore()
      error.mockRestore()
    }
  })
})
