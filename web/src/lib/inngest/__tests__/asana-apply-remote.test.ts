import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/asana-apply-remote.ts and, through it, the shared
 * src/lib/tasks/apply-remote-task-state.ts (the reconcile sweep runs the same
 * helper, so these lock the rules for BOTH paths).
 *
 * Invariants locked in:
 *  - HOUSE RULE: no step.* is ever called from inside a step.run callback. The
 *    shared step mock (src/test/inngest-step-mock.ts) FAILS the test if that
 *    happens, which is the whole reason the self-chain sendEvent lives at the
 *    top level.
 *  - Unlinked gids are skipped without any Asana call.
 *  - 404 → terminal task_deleted marker, and the batch continues.
 *  - The link CAS is the idempotency guard AND the echo-loop breaker: a second
 *    delivery of the same state matches 0 rows and touches nothing.
 *  - completed=true on an active action → status write + emitStatusChange with
 *    the right from/to; an already-completed or CANCELED action gets no write.
 *  - completed=false only re-opens a COMPLETED action — never a canceled one
 *    (Asana can't express cancel) and never a started/backlog one (no downgrade).
 *  - …and for the canceled case the LINK ROW is left alone too: the action is
 *    loaded before the CAS precisely so nothing is committed for a state we
 *    then refuse to act on.
 *  - >25 gids self-chains the remainder.
 *  - A 401 aborts the whole run cleanly (no throw, no chain).
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
  send: vi.fn(async () => ({ ids: ['e'] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
    // emitStatusChange fires through the plain client (never step.sendEvent).
    send: hoisted.send,
  },
}))

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaWebhookAuth: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaWebhookAuth: hoistedConfig.loadAsanaWebhookAuth }
})

const hoistedApi = vi.hoisted(() => ({ getTask: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly code = 'ASANA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'AsanaApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/asana-api', () => ({
  getTask: hoistedApi.getTask,
  AsanaUnauthorizedError: FakeUnauthorized,
  AsanaApiError: FakeApiError,
}))

await import('@/lib/inngest/asana-apply-remote')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — a vi.fn per method PLUS the house-rule tripwire:
 * calling step.sendEvent (or a nested step.run) while a step.run callback is on
 * the stack throws. In production that combination deadlocks silently, so it
 * must fail loudly here.
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = (taskGids: string[]) => ({
  data: { syncStateId: 'tss-1', workspaceId: 'ws-1', taskGids },
})

const LINK = {
  id: 'link-1',
  action_id: 'act-1',
  external_id: 'task-1',
  completed: false,
  created_at: '2026-07-01T00:00:00.000Z',
}

const STATES = { 'team-1': { completed: 'st-done', default: 'st-todo', unstarted: 'st-queued' } }

function setDb(options: Parameters<typeof createAsanaRemoteFake>[0]) {
  dbFake = createAsanaRemoteFake(options)
  return dbFake
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadAsanaWebhookAuth.mockResolvedValue({
    id: 'tss-1',
    workspaceId: 'ws-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    webhookGid: 'wh-1',
    webhookSecret: 'shh',
    projectGid: 'proj-1',
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getTask.mockResolvedValue({ gid: 'task-1', completed: true })
  setDb({})
})

// ---- Registration ----------------------------------------------------------

describe('asana-apply-remote — registration', () => {
  it('registers with the documented id, trigger, retries and concurrency key', () => {
    expect(hoisted.config.id).toBe('asana-apply-remote-change')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/asana-remote-change' }])
    expect(hoisted.config.retries).toBe(3)
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspaceId' },
    ])
  })
})

// ---- Gates -----------------------------------------------------------------

describe('asana-apply-remote — gates', () => {
  it('skips an empty gid list without a lookup', async () => {
    const out = await hoisted.handler({ event: EVENT([]), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_task_gids' })
    expect(hoistedConfig.loadAsanaWebhookAuth).not.toHaveBeenCalled()
  })

  it('skips when the sync state is gone', async () => {
    hoistedConfig.loadAsanaWebhookAuth.mockResolvedValue(null)
    const out = await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_sync_state' })
    expect(hoistedApi.getTask).not.toHaveBeenCalled()
  })

  it('skips an UNLINKED gid without minting a token or calling Asana', async () => {
    // A task created directly in Asana, or one whose link was deleted.
    setDb({ links: [] })
    const out = await hoisted.handler({ event: EVENT(['task-unknown']), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links' })
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoistedApi.getTask).not.toHaveBeenCalled()
  })

  it('skips cleanly when no token can be minted (disconnected account)', async () => {
    setDb({ links: [LINK] })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const out = await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_token' })
    expect(hoistedApi.getTask).not.toHaveBeenCalled()
  })

  it('scopes the link lookup to the workspace AND the asana provider', async () => {
    const db = setDb({ links: [LINK], actions: [], states: STATES })
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    const query = db.linkQueries[0]
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'workspace_id', val: 'ws-1' },
        { op: 'eq', col: 'provider', val: 'asana' },
        { op: 'in', col: 'external_id', val: ['task-1'] },
      ]),
    )
  })
})

// ---- Task read failures ----------------------------------------------------

describe('asana-apply-remote — task read failures', () => {
  it('404 stamps the terminal task_deleted marker and continues the batch', async () => {
    const db = setDb({
      links: [
        LINK,
        {
          id: 'link-2',
          action_id: 'act-2',
          external_id: 'task-2',
          completed: false,
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
      actions: [{ id: 'act-2', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })
    hoistedApi.getTask
      .mockRejectedValueOnce(new FakeApiError(404, 'Not a recognized ID'))
      .mockResolvedValueOnce({ gid: 'task-2', completed: true })

    const out = (await hoisted.handler({
      event: EVENT(['task-1', 'task-2']),
      step: makeStep(),
    })) as { applied: Array<{ linkId: string; outcome: string }> }

    expect(db.markerUpdates).toHaveLength(1)
    expect(db.markerUpdates[0].linkId).toBe('link-1')
    expect(
      (db.markerUpdates[0].patch.last_push_error as { code: string }).code,
    ).toBe('task_deleted')
    // The second link still got processed.
    expect(out.applied).toEqual([
      { linkId: 'link-1', outcome: 'task_deleted' },
      expect.objectContaining({ linkId: 'link-2', outcome: 'completed' }),
    ])
    expect(db.statusUpdates).toHaveLength(1)
  })

  it('401 ABORTS the whole run cleanly — no throw, no status writes, no chain', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })
    hoistedApi.getTask.mockRejectedValue(new FakeUnauthorized())

    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(['task-1']), step })

    expect(out).toMatchObject({ status: 'aborted', reason: 'unauthorized' })
    expect(db.statusUpdates).toHaveLength(0)
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('rethrows a transient failure so Inngest retries', async () => {
    setDb({ links: [LINK], states: STATES })
    hoistedApi.getTask.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    await expect(
      hoisted.handler({ event: EVENT(['task-1']), step: makeStep() }),
    ).rejects.toThrow('unavailable')
  })
})

// ---- Completion (remote → Dial8) -------------------------------------------

describe('asana-apply-remote — task completed in Asana', () => {
  it('moves an active action to the team completed state and emits the change', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue({ gid: 'task-1', completed: true })

    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string; fromStatusId?: string; toStatusId?: string }>
    }

    expect(db.casUpdates[0].patch).toMatchObject({ completed: true })
    expect(db.statusUpdates).toEqual([
      { actionId: 'act-1', patch: { status_id: 'st-done' } },
    ])
    expect(out.applied[0]).toMatchObject({
      outcome: 'completed',
      fromStatusId: 'st-doing',
      toStatusId: 'st-done',
    })

    // emitStatusChange rides the shared flow event, credited to the sync
    // state's user and carrying the pre-update status as `from`.
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'flow/entity.status_changed',
        data: expect.objectContaining({
          entity_type: 'action',
          entity_id: 'act-1',
          workspace_id: 'ws-1',
          team_id: 'team-1',
          from_status_id: 'st-doing',
          to_status_id: 'st-done',
          actor_user_id: 'u-sync',
        }),
      }),
    )
  })

  it('updates the LINK only when the action is already completed', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(db.casUpdates).toHaveLength(1)
    expect(db.statusUpdates).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
    expect(out.applied[0]).toMatchObject({ outcome: 'link_only' })
  })

  it('never resurrects a CANCELED action', async () => {
    // The echo pushes canceled actions as completed:true too, so an observed
    // completion is most likely our own write coming back.
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-cancel', team_id: 'team-1', category: 'canceled' }],
      states: STATES,
    })
    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }
    expect(db.statusUpdates).toHaveLength(0)
    expect(out.applied[0]).toMatchObject({ outcome: 'link_only' })
  })

  it('records link-only when the team has no completed state at all', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: { 'team-1': {} },
    })
    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }
    expect(db.statusUpdates).toHaveLength(0)
    expect(out.applied[0]).toMatchObject({ outcome: 'no_target_state' })
  })

  it('handles the array-shaped embedded workflow_state PostgREST can return', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
      embedAsArray: true,
    })
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-done' } }])
  })

  it('reports action_missing when the link outlived its action', async () => {
    const db = setDb({ links: [LINK], actions: [], states: STATES })
    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }
    expect(out.applied[0]).toMatchObject({ outcome: 'action_missing' })
    expect(db.statusUpdates).toHaveLength(0)
  })
})

// ---- Idempotency / loop breaking -------------------------------------------

describe('asana-apply-remote — the CAS short-circuit', () => {
  it('does NOTHING when the link already records the remote state', async () => {
    // Re-delivery, an overlapping reconcile sweep, or the echo's own write
    // arriving back: the CAS matches 0 rows and the action is never touched.
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue({ gid: 'task-1', completed: true })

    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'unchanged' })
    expect(db.casUpdates).toHaveLength(0)
    expect(db.statusUpdates).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('is idempotent across a REPEATED delivery of the same event', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    // Second delivery: the fake's link row now carries completed:true.
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })

    expect(db.casUpdates).toHaveLength(1)
    expect(db.statusUpdates).toHaveLength(1)
  })

  it('propagates a real DB error rather than reading it as "already applied"', async () => {
    setDb({ links: [LINK], states: STATES, linkUpdateError: { message: 'db down' } })
    await expect(
      hoisted.handler({ event: EVENT(['task-1']), step: makeStep() }),
    ).rejects.toBeTruthy()
  })
})

// ---- Re-opening (remote completed=false) -----------------------------------

describe('asana-apply-remote — task re-opened in Asana', () => {
  const OPEN_TASK = { gid: 'task-1', completed: false }

  it('reverts a COMPLETED action to the team default state and emits', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)

    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-todo' } }])
    expect(out.applied[0]).toMatchObject({ outcome: 'reverted' })
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ from_status_id: 'st-done', to_status_id: 'st-todo' }),
      }),
    )
  })

  it('falls back to the lowest-sorted unstarted state when no default exists', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: { 'team-1': { completed: 'st-done', unstarted: 'st-queued' } },
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-queued' } }])
  })

  it('NEVER un-cancels a canceled action (Asana cannot express cancel)', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-cancel', team_id: 'team-1', category: 'canceled' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)

    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }
    expect(db.statusUpdates).toHaveLength(0)
    expect(out.applied[0]).toMatchObject({ outcome: 'canceled_protected' })
  })

  it('REGRESSION: un-completing a CANCELED action strands nothing — the link row is untouched', async () => {
    // The CAS used to run BEFORE the canceled check, so this delivery committed
    // completed:true→false on a link whose action we then deliberately refuse to
    // touch. The link was left permanently disagreeing with what the echo pushes
    // for a canceled action (completed:true), and nothing was scheduled to
    // repair it: the echo only rewrites on the NEXT status change, which a
    // canceled action may never have. Loading the action first is the fix.
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-cancel', team_id: 'team-1', category: 'canceled' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)

    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'canceled_protected' })
    // Nothing written at all — not the action, and NOT the link row.
    expect(db.casUpdates).toHaveLength(0)
    expect(db.statusUpdates).toHaveLength(0)
    expect(db.links[0].completed).toBe(true)
    expect(hoisted.send).not.toHaveBeenCalled()
  })

  it('still applies the CAS for every other re-open case', async () => {
    // The reorder must not have turned the CAS off generally — a started action
    // is still left alone, but its link row converges to the remote state.
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)

    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })

    expect(db.casUpdates).toHaveLength(1)
    expect(db.links[0].completed).toBe(false)
    expect(db.statusUpdates).toHaveLength(0)
  })

  it('never DOWNGRADES a started action', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)
    const out = (await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }
    expect(db.statusUpdates).toHaveLength(0)
    expect(out.applied[0]).toMatchObject({ outcome: 'link_only' })
  })

  it('never downgrades a backlog action either', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-ice', team_id: 'team-1', category: 'backlog' }],
      states: STATES,
    })
    hoistedApi.getTask.mockResolvedValue(OPEN_TASK)
    await hoisted.handler({ event: EVENT(['task-1']), step: makeStep() })
    expect(db.statusUpdates).toHaveLength(0)
  })
})

// ---- Bounding + self-chaining ----------------------------------------------

describe('asana-apply-remote — bounded runs', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `task-${i}`)

  it('caps a run at 25 gids and SELF-CHAINS the remainder from the top level', async () => {
    setDb({ links: [], states: STATES })
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(many(30)), step })

    // The link lookup only ever saw the first 25.
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links', gids: 25 })
    void step

    // With links present, the remainder is chained.
    setDb({
      links: [{ ...LINK, external_id: 'task-0' }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    const step2 = makeStep()
    const chained = await hoisted.handler({ event: EVENT(many(30)), step: step2 })

    expect(chained).toMatchObject({ status: 'continued', remaining: 5 })
    expect(step2.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/asana-remote-change',
      data: { syncStateId: 'tss-1', workspaceId: 'ws-1', taskGids: many(30).slice(25) },
    })
  })

  it('does NOT chain when everything fitted in one run', async () => {
    setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(['task-1']), step })
    expect(out).toMatchObject({ status: 'ok' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('dedupes gids before counting them against the cap', async () => {
    setDb({ links: [], states: STATES })
    const step = makeStep()
    const out = await hoisted.handler({
      event: EVENT(['task-1', 'task-1', 'task-1']),
      step,
    })
    expect(out).toMatchObject({ gids: 1 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
