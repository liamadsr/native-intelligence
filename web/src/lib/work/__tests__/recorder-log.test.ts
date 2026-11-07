/**
 * The ledger's agent-log hook (A2b, src/lib/log/agent-log.ts): a new row and
 * every won move that matters write ONE line for the row's owner, in its own
 * workspace, after the write committed, off the caller's path; a lost CAS, a
 * retried start, a resume or a skip writes none. The review settle (both
 * doors), the reaper's fail, re-park and review expiry, and the stale-question
 * reconcile's closes log too, each with the row's facts for the log filter.
 * A quiet row, a delegated child, a housekeeping kind and the email-drafts
 * pass's start or empty finish write none (agent-log.ts workEventLogged).
 *
 * Against the stateful ledger fake, with the log module's writer mocked (its
 * filter and event mapping are the real ones): what is pinned is which event
 * each move hands the log, and how often.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({
  logWorkEvent: vi.fn(async (..._args: unknown[]) => true),
  memberUserId: vi.fn(async (..._args: unknown[]) => 'user-1' as string | null),
  pending: [] as Promise<unknown>[],
}))
vi.mock('@/lib/log/agent-log', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/log/agent-log')>()),
  logWorkEvent: hoisted.logWorkEvent,
  memberUserId: hoisted.memberUserId,
  deferLogWrite: (work: Promise<unknown>) => {
    hoisted.pending.push(work)
  },
}))
vi.mock('@/lib/notifications', () => ({ createNotification: vi.fn(async () => {}) }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn(async () => {}) } }))

import { attachWork, startWork } from '../recorder'
import { resolveWorkForDeliverable, settleReview } from '../resolve'
import { reapStaleWork } from '../reaper'
import { reconcileStaleQuestions } from '../stale-questions'
import type { WorkItem } from '../types'

const base = { workspaceId: 'w1', memberId: 'm1', kind: 'work_run', title: 'Reply drafts', area: 'mail' as const }

/** Let every deferred log write run, then return the events handed to the log, in order. */
async function logged(): Promise<Array<Record<string, unknown>>> {
  while (hoisted.pending.length) await hoisted.pending.shift()
  return hoisted.logWorkEvent.mock.calls.map(([, target, event]) => ({ ...(event as object), target }))
}

const types = async () => (await logged()).map((e) => e.type)

beforeEach(() => {
  hoisted.logWorkEvent.mockClear()
  hoisted.memberUserId.mockClear()
  hoisted.memberUserId.mockResolvedValue('user-1')
  hoisted.pending.length = 0
})

describe('startWork', () => {
  it('logs a new row as started, for its owner, in its own workspace', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, base)
    const events = await logged()
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'work_started',
      target: { workItemId: work.id, workspaceId: 'w1', memberId: 'm1', userId: 'user-1', title: 'Reply drafts', area: 'mail', kind: 'work_run', quiet: false, child: false },
    })
    expect(events[0].at).toBe(fake.rows('tracked_job')[0].last_beat_at)
    expect(hoisted.memberUserId).toHaveBeenCalledWith(fake, 'w1', 'm1')
  })

  it('logs a one-shot row by its outcome only, and a skipped one not at all', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, kind: 'flow_run', status: 'done', resultSummary: 'Sent the digest' })
    expect(await logged()).toMatchObject([{ type: 'work_done', summary: 'Sent the digest' }])
    hoisted.logWorkEvent.mockClear()
    await startWork(fake as never, { ...base, kind: 'sweep', status: 'skipped', skipReason: 'dormant' })
    expect(await types()).toEqual([])
  })

  it('logs nothing for housekeeping: a quiet row, a delegated child, a housekeeping kind', async () => {
    const fake = makeFakeSupabase()
    const quiet = await startWork(fake as never, { ...base, kind: 'sequence_enrolment', status: 'running', quiet: true })
    await quiet.finish({ summary: 'enrolled' })
    const child = await startWork(fake as never, { ...base, status: 'running', parentId: 'p1', rootId: 'p1', depth: 1 })
    await child.finish({ summary: 'researched' })
    for (const kind of ['crm_enrichment', 'triage_reconcile']) {
      const chore = await startWork(fake as never, { ...base, kind, status: 'running' })
      await chore.fail('boom')
    }
    await startWork(fake as never, { ...base, kind: 'extraction', status: 'done', resultSummary: '3 actions' })
    await startWork(fake as never, { ...base, kind: 'proposal_age_out', status: 'done', resultSummary: 'aged out 12' })
    expect(await types()).toEqual([])
    expect(hoisted.memberUserId).not.toHaveBeenCalled()
  })

  it('logs a muted row’s moves no more once it is muted', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, kind: 'flow_run', status: 'running' })
    await work.mute()
    await work.finish({ summary: 'done quietly' })
    expect(await types()).toEqual(['work_started'])
  })

  it('logs the email-drafts pass only for drafts made, or a failure', async () => {
    const fake = makeFakeSupabase()
    const drafts = { ...base, kind: 'email_drafts', status: 'running' as const }
    const empty = await startWork(fake as never, drafts)
    await empty.finish({ summary: 'Nothing needed a draft' })
    const made = await startWork(fake as never, drafts)
    await made.finish({ summary: '2 drafts ready to review', deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: Q3' }, { type: 'email_draft', id: 'd2', label: 'Re: pricing' }] })
    const broke = await startWork(fake as never, drafts)
    await broke.fail('Gmail token expired')
    expect(await logged()).toMatchObject([
      { type: 'work_done', summary: '2 drafts ready to review', delivered: 2 },
      { type: 'work_failed' },
    ])
  })

  it('writes no second line for a retried start (the same row comes back)', async () => {
    const fake = makeFakeSupabase()
    await startWork(fake as never, { ...base, runKey: 'evt-1', status: 'running' })
    await startWork(fake as never, { ...base, runKey: 'evt-1', status: 'running' })
    expect(await types()).toEqual(['work_started'])
  })
})

describe('transitions', () => {
  it('logs each won move once: a question, then a review with its summary', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.needInput([{ q: 'Which thread?' }])
    await work.needInput([{ q: 'Again?' }]) // lost CAS: already parked
    await work.resume()
    await work.finish({ summary: '3 drafts', review: { kind: 'review', verb: 'review' } })
    const events = await logged()
    expect(events.map((e) => e.type)).toEqual(['work_started', 'work_needs_input', 'work_needs_review'])
    expect(Number.isFinite(Date.parse(String(events[1].at)))).toBe(true)
    expect(events[2]).toMatchObject({ summary: '3 drafts' })
  })

  it('logs done, failed and canceled once each, and nothing for a lost CAS on a settled row', async () => {
    const fake = makeFakeSupabase()
    const a = await startWork(fake as never, { ...base, status: 'running' })
    await a.finish({ summary: 'ok' })
    await a.finish({ summary: 'twice' })
    await a.fail('late')
    const b = await startWork(fake as never, { ...base, status: 'running' })
    await b.fail('Model timed out')
    const c = await startWork(fake as never, { ...base, status: 'running' })
    await c.cancel()
    await c.cancel()
    expect(await types()).toEqual(['work_started', 'work_done', 'work_started', 'work_failed', 'work_started', 'work_canceled'])
  })

  it('logs nothing for a skip or a park on a child', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await work.step('Back at it')
    await work.waitOnChild({ workItemId: 'child-1', role: 'research', label: 'Researcher', count: 1 })
    hoisted.logWorkEvent.mockClear()
    hoisted.pending.length = 0
    const other = await startWork(fake as never, { ...base, status: 'running' })
    await other.skip('Workspace dormant')
    expect(await types()).toEqual(['work_started'])
  })

  it('logs nothing when another writer settled the row first', async () => {
    const fake = makeFakeSupabase()
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await logged()
    hoisted.logWorkEvent.mockClear()
    fake.rows('tracked_job')[0].status = 'done'
    await work.finish({ summary: 'mine' })
    await work.fail('mine')
    expect(await types()).toEqual([])
  })

  it('reads the owner once per handle, and writes nothing for a member without a user (retrying the read next time)', async () => {
    const fake = makeFakeSupabase()
    hoisted.memberUserId.mockResolvedValue(null)
    const work = await startWork(fake as never, { ...base, status: 'running' })
    await logged()
    expect(hoisted.logWorkEvent).not.toHaveBeenCalled()
    hoisted.memberUserId.mockResolvedValue('user-1')
    await work.needInput([])
    await work.resume()
    await work.finish({ summary: 'x' })
    expect(await types()).toEqual(['work_needs_input', 'work_done'])
    expect(hoisted.memberUserId).toHaveBeenCalledTimes(2)
  })

  it('a handle attached to an existing row logs its moves too', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      { id: 'j9', workspace_id: 'w1', member_id: 'm1', kind: 'agent_launch', title: 'Fix the build', status: 'running', progress: {}, source: {}, started_at: '2026-10-14T09:00:00.000Z', last_beat_at: null, area: null },
    ])
    const work = attachWork(fake as never, fake.rows('tracked_job')[0] as unknown as WorkItem)
    await work.fail('boom')
    expect(await logged()).toMatchObject([{ type: 'work_failed', target: { workItemId: 'j9', title: 'Fix the build' } }])
  })
})

describe('the review settle', () => {
  const waiting = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    source: {},
    parent_id: null,
    depth: 0,
    title: 'Reply drafts',
    area: 'mail',
    status: 'needs_review',
    needs: { kind: 'review', verb: 'review' },
    deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: Pricing' }],
    progress: {},
    reviewed_at: null,
    ...over,
  })

  it('logs a reviewed or dismissed item once, for its owner, and nothing for a lost settle', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [waiting('r1'), waiting('r2')])
    expect(await settleReview(fake as never, { id: 'r1', member_id: 'm1', progress: {} }, 'reviewed', { nowIso: '2026-10-14T12:00:00.000Z' })).toBe(true)
    expect(await settleReview(fake as never, { id: 'r1', member_id: 'm1', progress: {} }, 'reviewed')).toBe(false)
    await settleReview(fake as never, { id: 'r2', member_id: 'm1', progress: {} }, 'dismissed')
    const events = await logged()
    expect(events.map((e) => [e.type, e.outcome, (e.target as { workItemId: string }).workItemId])).toEqual([
      ['work_settled', 'reviewed', 'r1'],
      ['work_settled', 'dismissed', 'r2'],
    ])
    expect(events[0]).toMatchObject({
      at: '2026-10-14T12:00:00.000Z',
      target: { workspaceId: 'w1', memberId: 'm1', title: 'Reply drafts', area: 'mail', kind: 'work_run', quiet: false, child: false },
    })
  })

  it('logs an item completed on its deliverable’s own surface as resolved, and a partial resolve not at all', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [
      waiting('one'),
      waiting('two', { deliverables: [{ type: 'email_draft', id: 'd1', label: 'Re: Q3' }, { type: 'email_draft', id: 'd2', label: 'Re: pricing' }] }),
    ])
    await resolveWorkForDeliverable(fake as never, { type: 'email_draft', id: 'd1' })
    expect((await logged()).map((e) => [e.type, e.outcome, (e.target as { workItemId: string }).workItemId])).toEqual([
      ['work_settled', 'resolved', 'one'],
    ])
  })
})

describe('the reaper', () => {
  it('logs a row it fails, once, and nothing for a row it leaves', async () => {
    const fake = makeFakeSupabase()
    const past = new Date(Date.now() - 5 * 60_000).toISOString()
    fake.seed('tracked_job', [
      { id: 'stale', workspace_id: 'w1', member_id: 'm1', kind: 'flow_run', title: 'Nightly digest', status: 'running', agent_run_id: null, deadline_at: past, last_beat_at: past, source: {}, area: 'flows' },
      { id: 'fresh', workspace_id: 'w1', member_id: 'm1', kind: 'flow_run', title: 'Fresh', status: 'running', agent_run_id: null, deadline_at: new Date(Date.now() + 600_000).toISOString(), last_beat_at: past, source: {} },
    ])
    await reapStaleWork(fake as never)
    await reapStaleWork(fake as never)
    expect(await logged()).toMatchObject([
      {
        type: 'work_failed',
        target: { workItemId: 'stale', workspaceId: 'w1', memberId: 'm1', title: 'Nightly digest', area: 'flows', kind: 'flow_run', quiet: false, child: false },
      },
    ])
  })

  it('logs a review it expires as expired unreviewed, once, with the row’s facts', async () => {
    const fake = makeFakeSupabase({ project: true })
    const old = new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString()
    fake.seed('tracked_job', [
      { id: 'rv', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 'Pricing page draft', status: 'needs_review', finished_at: old, last_beat_at: old, progress: {}, source: { quiet: false }, parent_id: null, depth: 0, area: 'documents' },
    ])
    const nowIso = new Date().toISOString()
    await reapStaleWork(fake as never, { nowIso })
    await reapStaleWork(fake as never, { nowIso })
    expect(fake.rows('tracked_job')[0]).toMatchObject({ status: 'done', progress: { review: 'expired' } })
    expect(await logged()).toMatchObject([
      {
        type: 'work_settled',
        outcome: 'expired',
        at: nowIso,
        target: { workItemId: 'rv', title: 'Pricing page draft', area: 'documents', kind: 'work_run', quiet: false, child: false },
      },
    ])
  })

  it('logs a running row it re-parks on its run’s question as waiting on you', async () => {
    const fake = makeFakeSupabase()
    const past = new Date(Date.now() - 5 * 60_000).toISOString()
    fake.seed('tracked_job', [
      { id: 'rp', workspace_id: 'w1', member_id: 'm1', kind: 'work_run', title: 'Book the offsite', status: 'running', agent_run_id: 'run-1', deadline_at: past, last_beat_at: past, source: {}, area: null, parent_id: null, depth: 0 },
    ])
    fake.seed('agent_run', [{ id: 'run-1', workspace_id: 'w1', status: 'needs_input', pending_input: { questions: [{ q: 'Which venue?' }] } }])
    const nowIso = new Date().toISOString()
    await reapStaleWork(fake as never, { nowIso })
    expect(fake.rows('tracked_job')[0].status).toBe('needs_input')
    expect(await logged()).toMatchObject([{ type: 'work_needs_input', at: nowIso, target: { workItemId: 'rp', title: 'Book the offsite' } }])
  })
})

describe('the stale-question reconcile', () => {
  const asked = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    workspace_id: 'w1',
    member_id: 'm1',
    kind: 'work_run',
    title: `Question ${id}`,
    status: 'needs_input',
    agent_run_id: `run-${id}`,
    last_beat_at: new Date(Date.now() - 60 * 60_000).toISOString(),
    needs: { kind: 'input', questions: [] },
    source: {},
    parent_id: null,
    depth: 0,
    area: null,
    ...over,
  })

  it('logs the close it wins as the recorder would (canceled, failed), and nothing for a run going again', async () => {
    const fake = makeFakeSupabase({ project: true })
    fake.seed('tracked_job', [asked('gone', { agent_run_id: null }), asked('failed'), asked('moved')])
    fake.seed('agent_run', [
      { id: 'run-failed', workspace_id: 'w1', status: 'failed' },
      { id: 'run-moved', workspace_id: 'w1', status: 'running' },
    ])
    const nowIso = new Date().toISOString()
    const out = await reconcileStaleQuestions(fake as never, { nowIso })
    expect(out.reconciled).toBe(3)
    expect(Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id, r.status]))).toEqual({ gone: 'canceled', failed: 'failed', moved: 'running' })
    const events = await logged()
    expect(events.map((e) => [e.type, (e.target as { workItemId: string }).workItemId]).sort()).toEqual([
      ['work_canceled', 'gone'],
      ['work_failed', 'failed'],
    ])
    expect(events[0]).toMatchObject({ at: nowIso, target: { workspaceId: 'w1', memberId: 'm1', kind: 'work_run', quiet: false, child: false } })
    // A second pass finds nothing waiting: no second line.
    hoisted.logWorkEvent.mockClear()
    await reconcileStaleQuestions(fake as never, { nowIso })
    expect(await types()).toEqual([])
  })
})
