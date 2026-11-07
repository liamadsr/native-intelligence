/**
 * The reaper: a live row past its deadline fails with "no report back", unless
 * it mirrors an agent_run that is itself still live — then it is extended one
 * window and left to that run's own settle watcher. A row it fails sends the
 * failure notice a recorder failure does (notify.ts notifyWorkFailed).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase } from './fake-supabase'

const hoisted = vi.hoisted(() => ({ createNotification: vi.fn(async (_params: Record<string, unknown>) => {}) }))
vi.mock('@/lib/notifications', () => ({ createNotification: hoisted.createNotification }))
import { NO_REPORT_BACK, REAPER_NOTICES_PER_MEMBER, reapStaleWork } from '../reaper'

beforeEach(() => hoisted.createNotification.mockClear())

const MIN = 60 * 1000

function row(over: Record<string, unknown>) {
  return {
    id: String(over.id),
    kind: 'flow_run',
    status: 'running',
    agent_run_id: null,
    deadline_at: new Date(Date.now() - 5 * MIN).toISOString(),
    last_beat_at: new Date(Date.now() - 30 * MIN).toISOString(),
    ...over,
  }
}

describe('reapStaleWork', () => {
  it('fails queued/running rows past their deadline and leaves the rest alone', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      row({ id: 'stale-running' }),
      row({ id: 'stale-queued', status: 'queued' }),
      row({ id: 'fresh', deadline_at: new Date(Date.now() + 10 * MIN).toISOString() }),
      row({ id: 'parked', status: 'needs_input', deadline_at: null }),
      row({ id: 'settled', status: 'done', deadline_at: null }),
    ])
    const out = await reapStaleWork(fake as never)
    expect(out).toEqual({ failed: 2, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 })
    const byId = Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id, r]))
    expect(byId['stale-running'].status).toBe('failed')
    expect(byId['stale-running'].error_message).toBe(NO_REPORT_BACK)
    expect(byId['stale-running'].deadline_at).toBeNull()
    expect(byId['stale-queued'].status).toBe('failed')
    expect(byId['fresh'].status).toBe('running')
    expect(byId['parked'].status).toBe('needs_input')
    expect(byId['settled'].status).toBe('done')
  })

  it('extends a row whose agent run is still live instead of failing it', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      row({ id: 'alive', kind: 'work_run', agent_run_id: 'ar-live' }),
      row({ id: 'dead', kind: 'work_run', agent_run_id: 'ar-done' }),
      row({ id: 'gone', kind: 'work_run', agent_run_id: 'ar-missing' }),
    ])
    fake.seed('agent_run', [
      { id: 'ar-live', status: 'running' },
      { id: 'ar-done', status: 'completed' },
    ])
    const out = await reapStaleWork(fake as never)
    expect(out).toEqual({ failed: 2, extended: 1, expired: 0, questionsReconciled: 0, questionsExpired: 0 })
    const byId = Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id, r]))
    expect(byId['alive'].status).toBe('running')
    expect(Date.parse(byId['alive'].deadline_at as string)).toBeGreaterThan(Date.now())
    expect(byId['dead'].status).toBe('failed')
    expect(byId['gone'].status).toBe('failed')
  })

  it('closes a review nobody acted on for the TTL as expired, and leaves fresher ones waiting', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [
      row({
        id: 'stale-review',
        status: 'needs_review',
        deadline_at: null,
        finished_at: new Date(Date.now() - 20 * DAY).toISOString(),
        needs: { kind: 'review', verb: 'review' },
        progress: { done: 2, total: 2 },
      }),
      row({
        id: 'fresh-review',
        status: 'needs_review',
        deadline_at: null,
        finished_at: new Date(Date.now() - 3 * DAY).toISOString(),
        needs: { kind: 'review', verb: 'review' },
      }),
    ])
    const out = await reapStaleWork(fake as never)
    expect(out).toEqual({ failed: 0, extended: 0, expired: 1, questionsReconciled: 0, questionsExpired: 0 })
    const byId = Object.fromEntries(fake.rows('tracked_job').map((r) => [r.id, r]))
    expect(byId['stale-review']).toMatchObject({
      status: 'done',
      needs: null,
      progress: { done: 2, total: 2, review: 'expired' },
    })
    expect(byId['stale-review'].reviewed_at).toEqual(expect.any(String))
    expect(byId['fresh-review'].status).toBe('needs_review')
    // A shorter TTL sweeps the fresher one too.
    expect((await reapStaleWork(fake as never, { reviewTtlDays: 1 })).expired).toBe(1)
  })

  it('is a no-op on an empty scan', async () => {
    const fake = makeFakeSupabase()
    expect(await reapStaleWork(fake as never)).toEqual({ failed: 0, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 })
  })
})

// A row the reaper fails says so, the way a recorder failure does: the same
// notifyWorkFailed (quiet respected, one per (workspace, kind, teammate) per
// day, the owner's `work_failed` setting applied by createNotification), with
// the bot keys, so it lands in its bot's Notices and lights its dot.
describe('reapStaleWork: the failure notice', () => {
  const NOW = '2026-10-08T12:00:00.000Z'
  const stale = (over: Record<string, unknown>) =>
    row({
      workspace_id: 'w1',
      member_id: 'm1',
      title: 'Importing from HubSpot',
      source: {},
      ai_team_member_id: null,
      deadline_at: '2026-10-08T11:00:00.000Z',
      ...over,
    })
  const sent = () => hoisted.createNotification.mock.calls.map(([params]) => params as Record<string, unknown>)

  function world() {
    const fake = makeFakeSupabase()
    fake.seed('ai_team_member', [
      { id: 'tm-assistant', workspace_id: 'w1', system_key: 'assistant', is_system: true, name: 'Assistant' },
      { id: 'writer', workspace_id: 'w1', system_key: null, is_system: false, name: 'Writer' },
    ])
    return fake
  }

  it('sends its owner the work_failed notice, from its bot, grouped per (workspace, kind, teammate) per day', async () => {
    const fake = world()
    fake.seed('tracked_job', [stale({ id: 'writer-run', kind: 'work_run', title: 'Q3 plan', ai_team_member_id: 'writer' })])
    expect(await reapStaleWork(fake as never, { nowIso: NOW })).toEqual({ failed: 1, extended: 0, expired: 0, questionsReconciled: 0, questionsExpired: 0 })
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({
      workspaceId: 'w1',
      recipientId: 'm1',
      type: 'work_failed',
      title: 'Writer',
      targetType: 'work_item',
      targetId: 'writer-run',
      groupKey: 'work_failed:w1:work_run:writer:2026-10-08',
      metadata: { kind: 'work_run', teammate_id: 'writer', teammate_name: 'Writer', work_item_id: 'writer-run' },
    })
  })

  it('a row with no teammate (an import, an older run) fails as its workspace’s Assistant', async () => {
    const fake = world()
    fake.seed('tracked_job', [stale({ id: 'import', kind: 'crm_import' })])
    await reapStaleWork(fake as never, { nowIso: NOW })
    expect(sent()[0]).toMatchObject({
      type: 'work_failed',
      title: 'Assistant',
      groupKey: 'work_failed:w1:crm_import:tm-assistant:2026-10-08',
      metadata: { kind: 'crm_import', teammate_id: 'tm-assistant', work_item_id: 'import' },
    })
  })

  it('a sequence send’s notice stays plain (no bot), a quiet row sends none, and an extended row nothing', async () => {
    const fake = world()
    fake.seed('tracked_job', [
      stale({ id: 'send', kind: 'sequence_enrolment', title: 'Intro sequence' }),
      stale({ id: 'quiet', kind: 'flow_run', source: { quiet: true }, ai_team_member_id: 'writer' }),
      stale({ id: 'alive', kind: 'work_run', agent_run_id: 'ar-live', ai_team_member_id: 'writer' }),
    ])
    fake.seed('agent_run', [{ id: 'ar-live', status: 'running' }])
    expect(await reapStaleWork(fake as never, { nowIso: NOW })).toEqual({ failed: 2, extended: 1, expired: 0, questionsReconciled: 0, questionsExpired: 0 })
    expect(sent()).toHaveLength(1)
    expect(sent()[0]).toMatchObject({ targetId: 'send', groupKey: 'work_failed:w1:sequence_enrolment:2026-10-08', metadata: { kind: 'sequence_enrolment' } })
    expect(sent()[0].metadata).not.toHaveProperty('teammate_id')
  })

  it('two of one bot’s same kind failing the same day: one notice (the day’s group already has one)', async () => {
    const fake = world()
    fake.seed('tracked_job', [stale({ id: 'a', kind: 'email_import' }), stale({ id: 'b', kind: 'email_import' })])
    hoisted.createNotification.mockImplementation(async (params: Record<string, unknown>) => {
      fake.seed('notification', [{ id: `n-${String(params.targetId)}`, recipient_id: params.recipientId, type: params.type, group_key: params.groupKey }])
    })
    try {
      expect(await reapStaleWork(fake as never, { nowIso: NOW })).toMatchObject({ failed: 2 })
      expect(sent()).toHaveLength(1)
    } finally {
      hoisted.createNotification.mockImplementation(async () => {})
    }
  })
})

describe('reapStaleWork: a safety net, not a stream', () => {
  const NOW = '2026-10-08T12:00:00.000Z'
  const stale = (over: Record<string, unknown>) =>
    row({ workspace_id: 'w1', member_id: 'm1', title: 'Run', source: {}, ai_team_member_id: null, deadline_at: '2026-10-08T11:00:00.000Z', ...over })
  const sentTo = (member: string) => hoisted.createNotification.mock.calls.filter(([p]) => (p as Record<string, unknown>).recipientId === member).length

  it(`sends one member at most ${REAPER_NOTICES_PER_MEMBER} notices a tick; the rest still fail, silently; another member gets theirs`, async () => {
    const fake = makeFakeSupabase()
    // Six kinds (so no day's group folds them), all failing in one tick, for m1; one for m2.
    const kinds = ['flow_run', 'work_run', 'coding_run', 'prospecting', 'eval', 'crm_import']
    fake.seed('tracked_job', [
      ...kinds.map((kind, i) => stale({ id: `m1-${i}`, kind })),
      stale({ id: 'm2-0', member_id: 'm2', kind: 'flow_run' }),
    ])
    expect(await reapStaleWork(fake as never, { nowIso: NOW })).toMatchObject({ failed: 7 })
    expect(fake.rows('tracked_job').every((r) => r.status === 'failed')).toBe(true)
    expect(sentTo('m1')).toBe(REAPER_NOTICES_PER_MEMBER)
    expect(sentTo('m2')).toBe(1)
  })

  it('a row whose fail the reaper loses (someone else settled it first) sends nothing', async () => {
    const fake = makeFakeSupabase()
    fake.seed('tracked_job', [stale({ id: 'raced', kind: 'work_run' })])
    // Between the scan and the update, the row settles elsewhere: the CAS update matches nothing.
    const from = fake.from.bind(fake)
    fake.from = ((table: string) => {
      const q = from(table) as unknown as Record<string, (...args: unknown[]) => unknown>
      if (table !== 'tracked_job') return q
      const update = q.update.bind(q)
      q.update = (patch: unknown) => {
        const done = fake.rows('tracked_job').find((r) => r.id === 'raced')
        if (done && (patch as Record<string, unknown>).status === 'failed') done.status = 'done'
        return update(patch)
      }
      return q
    }) as typeof fake.from
    expect(await reapStaleWork(fake as never, { nowIso: NOW })).toMatchObject({ failed: 0 })
    expect(fake.rows('tracked_job')[0].status).toBe('done')
    expect(hoisted.createNotification).not.toHaveBeenCalled()
  })
})
