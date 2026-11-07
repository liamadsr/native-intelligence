import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/asana-echo-status.ts via the createFunction-capture
 * pattern (canonical: hubspot-push-contact.test.ts).
 *
 * Invariants locked in:
 *  - it rides the SHARED `flow/entity.status_changed` trigger (a second
 *    consumer beside flowDispatchOnStatusChange) with snake_case concurrency
 *    keys that match the event payload.
 *  - non-action entities and actions with no Asana links no-op BEFORE any
 *    lookup — the echo is free for workspaces that don't use Asana.
 *  - a completed-category status writes completed:true and moves the task when
 *    the bucket is mapped.
 *  - already-in-sync + no section mapped → NO Asana write at all.
 *  - 401 → last_push_error { code:'unauthorized' }, no throw.
 *  - 404 → last_push_error { code:'task_deleted' }, no throw.
 *  - anything else throws so Inngest retries.
 *  - marker LIFETIMES: a stored 'task_deleted' is terminal (zero Asana I/O
 *    forever), a stored 'unauthorized' is retried — including past the
 *    already_synced fast path, which would otherwise leave it stamped for good.
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: config.id }
    },
  },
}))

let dbFake: unknown = { from: vi.fn() }
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake }))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadAsanaSyncState: vi.fn() }))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadAsanaSyncState: hoistedConfig.loadAsanaSyncState }
})

const hoistedApi = vi.hoisted(() => ({
  updateTaskCompleted: vi.fn(),
  addTaskToSection: vi.fn(),
}))
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
  updateTaskCompleted: hoistedApi.updateTaskCompleted,
  addTaskToSection: hoistedApi.addTaskToSection,
  AsanaUnauthorizedError: FakeUnauthorized,
  AsanaApiError: FakeApiError,
}))

await import('@/lib/inngest/asana-echo-status')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — a vi.fn per method plus the nesting tripwire (step
 * tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = {
  data: {
    entity_type: 'action',
    entity_id: 'act-1',
    workspace_id: 'ws-1',
    team_id: 'team-1',
    from_status_id: 'st-todo',
    to_status_id: 'st-done',
    actor_user_id: 'u-1',
    fired_at: '2026-07-25T00:00:00.000Z',
  },
}

interface DbRows {
  links?: Array<Record<string, unknown>>
  category?: string | null
}

/**
 * Table-aware fake. `action_external_task` reads terminate at the awaited
 * filter chain (no .maybeSingle()); `workflow_state` reads terminate at
 * .maybeSingle(). Updates record their patch for assertion.
 */
function makeDb(rows: DbRows) {
  const updates: Array<{ id: string | null; patch: Record<string, unknown> }> = []
  const selects: Array<{ table: string; columns: string }> = []

  function builder(table: string) {
    let patch: Record<string, unknown> | null = null
    let targetId: string | null = null

    const api: Record<string, unknown> = {
      select: (columns?: string) => {
        selects.push({ table, columns: columns ?? '' })
        return api
      },
      eq: (col: string, value: string) => {
        if (patch && col === 'id') targetId = value
        return api
      },
      update: (p: Record<string, unknown>) => {
        patch = p
        return api
      },
      maybeSingle: async () => ({
        data: table === 'workflow_state' ? { category: rows.category ?? 'completed' } : null,
        error: null,
      }),
      // Awaited terminal: either the link list read, or an update chain.
      then: (resolve: (v: unknown) => unknown) => {
        if (patch) {
          updates.push({ id: targetId, patch })
          return Promise.resolve({ data: null, error: null }).then(resolve)
        }
        return Promise.resolve({ data: rows.links ?? [], error: null }).then(resolve)
      },
    }
    return api
  }

  return { client: { from: (table: string) => builder(table) } as never, updates, selects }
}

const OPEN_LINK = {
  id: 'link-1',
  external_id: 'task-1',
  completed: false,
  last_push_error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadAsanaSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { project_gid: 'proj-1' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.updateTaskCompleted.mockResolvedValue({ gid: 'task-1', completed: true })
  hoistedApi.addTaskToSection.mockResolvedValue(undefined)
})

// ---- Registration ----------------------------------------------------------

describe('asana-echo-status — registration', () => {
  it('registers as a SECOND consumer of the shared status-changed trigger', () => {
    expect(hoisted.config.id).toBe('asana-echo-status')
    expect(hoisted.config.triggers).toEqual([{ event: 'flow/entity.status_changed' }])
    expect(hoisted.config.retries).toBe(3)
  })

  it('keys concurrency on the event payload\'s SNAKE_CASE fields', () => {
    // camelCase keys would silently resolve to undefined and collapse every
    // workspace into one queue.
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspace_id' },
      { limit: 1, key: 'event.data.entity_id' },
    ])
  })
})

// ---- No-op gates -----------------------------------------------------------

describe('asana-echo-status — no-op gates', () => {
  it('no-ops for a non-action entity without touching the database', async () => {
    dbFake = makeDb({}).client
    const out = await hoisted.handler({
      event: { data: { ...EVENT.data, entity_type: 'project' } },
      step: makeStep(),
    })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_an_action' })
    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedConfig.loadAsanaSyncState).not.toHaveBeenCalled()
  })

  it('no-ops when the action has no Asana links (the common case)', async () => {
    dbFake = makeDb({ links: [] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links' })
    // Crucially: no destination lookup, no token mint.
    expect(hoistedConfig.loadAsanaSyncState).not.toHaveBeenCalled()
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('no-ops when the Asana account was disconnected but links survive', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue(null)
    dbFake = makeDb({ links: [OPEN_LINK] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_asana_account' })
    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
  })

  it('no-ops when no valid token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    dbFake = makeDb({ links: [OPEN_LINK] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_asana_account' })
  })
})

// ---- Writes ----------------------------------------------------------------

describe('asana-echo-status — writes', () => {
  it('completes the Asana task when the action moves to a completed status', async () => {
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', true)
    expect(hoistedApi.addTaskToSection).not.toHaveBeenCalled()
    expect(out).toMatchObject({ status: 'ok', bucket: 'done', completed: true })

    const write = db.updates.find((u) => u.id === 'link-1')
    expect(write?.patch).toMatchObject({ completed: true, last_push_error: null })
    expect(write?.patch.last_synced_at).toBeTruthy()
  })

  it('completes the task for a CANCELED action too (Asana has no cancel)', async () => {
    dbFake = makeDb({ links: [OPEN_LINK], category: 'canceled' }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', true)
    expect(out).toMatchObject({ bucket: 'canceled', completed: true })
  })

  it('re-opens the task when a completed action moves back to started', async () => {
    dbFake = makeDb({
      links: [{ ...OPEN_LINK, completed: true }],
      category: 'started',
    }).client
    await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', false)
  })

  it('moves the task into the mapped section for the new bucket', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: {
        project_gid: 'proj-1',
        section_map: { not_started: 's-todo', in_progress: 's-doing', done: 's-done', canceled: null },
      },
    })
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', true)
    expect(hoistedApi.addTaskToSection).toHaveBeenCalledWith('tok', 's-done', 'task-1')
  })

  it('skips ALL writes when already in sync and no section is mapped', async () => {
    const db = makeDb({ links: [{ ...OPEN_LINK, completed: true }], category: 'completed' })
    dbFake = db.client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedApi.addTaskToSection).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
  })

  it('still moves the section when completion already matches', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { project_gid: 'proj-1', section_map: { done: 's-done' } },
    })
    dbFake = makeDb({ links: [{ ...OPEN_LINK, completed: true }], category: 'completed' }).client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedApi.addTaskToSection).toHaveBeenCalledWith('tok', 's-done', 'task-1')
  })

  it('treats an unknown status category as not_started (task stays open)', async () => {
    dbFake = makeDb({ links: [{ ...OPEN_LINK, completed: true }], category: 'triage' }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', false)
    expect(out).toMatchObject({ bucket: 'not_started', completed: false })
  })
})

// ---- Permanent-failure markers --------------------------------------------

describe('asana-echo-status — permanent-failure markers', () => {
  it('marks unauthorized and no-ops on a 401 (never throws)', async () => {
    hoistedApi.updateTaskCompleted.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'unauthorized' }],
    })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
      at: string
    }
    expect(marker.code).toBe('unauthorized')
    expect(marker.at).toBeTruthy()
  })

  it('marks task_deleted and skips on a 404', async () => {
    hoistedApi.updateTaskCompleted.mockRejectedValue(new FakeApiError(404, 'Not a recognized ID'))
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'task_deleted' }],
    })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
    }
    expect(marker.code).toBe('task_deleted')
  })

  it('rethrows a transient failure so Inngest retries', async () => {
    hoistedApi.updateTaskCompleted.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await expect(hoisted.handler({ event: EVENT, step: makeStep() })).rejects.toThrow('unavailable')
  })

  it('keeps going through the remaining links after one is marked', async () => {
    hoistedApi.updateTaskCompleted
      .mockRejectedValueOnce(new FakeApiError(404, 'gone'))
      .mockResolvedValueOnce({ gid: 'task-2', completed: true })

    const db = makeDb({
      links: [
        OPEN_LINK,
        { id: 'link-2', external_id: 'task-2', completed: false, last_push_error: null },
      ],
      category: 'completed',
    })
    dbFake = db.client

    const out = (await hoisted.handler({ event: EVENT, step: makeStep() })) as {
      results: Array<{ linkId: string; outcome: string }>
    }
    expect(out.results).toEqual([
      { linkId: 'link-1', outcome: 'task_deleted' },
      { linkId: 'link-2', outcome: 'synced' },
    ])
  })
})

// ---- Stored markers: how the NEXT run treats them --------------------------

/**
 * The marker is only half the mechanism — what matters is what the next status
 * change does with it. 'task_deleted' must be terminal (no Asana call, ever)
 * and 'unauthorized' must be retried, or a single 401 during a token blip
 * permanently freezes an otherwise healthy link.
 */
describe('asana-echo-status — stored markers on a LATER run', () => {
  it('reads last_push_error alongside the link (it cannot be honoured unselected)', async () => {
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    const linkSelect = db.selects.find((s) => s.table === 'action_external_task')
    expect(linkSelect?.columns).toContain('last_push_error')
  })

  it('task_deleted is TERMINAL — zero Asana I/O and no re-marking', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, last_push_error: { code: 'task_deleted', at: 'yesterday' } }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedApi.addTaskToSection).not.toHaveBeenCalled()
    expect(db.updates).toHaveLength(0)
    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'marked_failed' }],
    })
  })

  it('unauthorized is RETRIED — a reconnect between runs fixes it', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, last_push_error: { code: 'unauthorized', at: 'yesterday' } }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.updateTaskCompleted).toHaveBeenCalledWith('tok', 'task-1', true)
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: true,
      last_push_error: null,
    })
  })

  it('the already_synced fast path does NOT swallow a stale unauthorized marker', async () => {
    // Completion already matches and no section is mapped, so there is nothing
    // to send Asana — but the marker is stale and NOTHING else ever clears it.
    // Before the fix this returned 'already_synced' and left the link showing
    // as broken forever.
    const db = makeDb({
      links: [
        {
          ...OPEN_LINK,
          completed: true,
          last_push_error: { code: 'unauthorized', at: 'yesterday' },
        },
      ],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
    const write = db.updates.find((u) => u.id === 'link-1')
    expect(write?.patch).toMatchObject({ completed: true, last_push_error: null })
  })

  it('still fast-paths an in-sync link with NO marker (no write at all)', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, completed: true }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(db.updates).toHaveLength(0)
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })

  it('ignores a malformed marker rather than wedging the link', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, completed: true, last_push_error: 'task_deleted' }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })
})
