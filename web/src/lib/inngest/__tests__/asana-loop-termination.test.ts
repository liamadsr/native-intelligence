import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * REGRESSION: the Asana↔Dial8 completion cycle must terminate in one hop.
 *
 * Dial8→Asana (asana-echo-status) and Asana→Dial8 (applyRemoteTaskState) form a
 * closed loop: a webhook moves the action, that fires
 * `flow/entity.status_changed`, which wakes the echo, which writes back to
 * Asana, which raises another webhook… Left unguarded this is an infinite
 * ping-pong that burns API budget and rewrites the user's task forever.
 *
 * The brake is `action_external_task.completed`: the read-back CAS records the
 * new provider state BEFORE emitting, so the echo it wakes finds the link
 * already in sync and takes its `already_synced` fast path — ZERO Asana writes.
 *
 * This test runs the REAL apply helper against a shared DB fake, then hands the
 * resulting link state to the REAL echo function and asserts no completion PUT
 * is issued. Anything that decouples the CAS from the emit (reordering them,
 * clearing `completed`, widening the echo's fast path) fails here.
 */

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  send: vi.fn(async () => ({ ids: ['e'] })),
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      return { id: config.id }
    },
    send: hoisted.send,
  },
}))

const db = createAsanaRemoteFake({
  links: [
    {
      id: 'link-1',
      action_id: 'act-1',
      external_id: 'task-1',
      completed: false,
      last_push_error: null,
    },
  ],
  actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
  states: { 'team-1': { completed: 'st-done', default: 'st-todo' } },
})

/**
 * The echo reads its links through `getServiceClient()` with a chain the apply
 * fake doesn't model (`select(...).eq().eq().eq()` awaited, plus
 * `workflow_state` by id). Layer just those two reads on top of the shared fake
 * so BOTH functions see the SAME mutable link row — which is the entire point.
 */
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      if (table === 'workflow_state') {
        // The echo resolves the TARGET status's category by id.
        return {
          select: () => ({
            eq: () => ({ maybeSingle: async () => ({ data: { category: 'completed' } }) }),
          }),
        }
      }
      if (table === 'action_external_task') {
        const api: Record<string, unknown> = {
          select: () => api,
          eq: () => api,
          update: (patch: Record<string, unknown>) => {
            echoLinkWrites.push(patch)
            return api
          },
          then: (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ data: db.links, error: null }).then(resolve),
        }
        return api
      }
      return db.client.from(table)
    },
  }),
}))

const echoLinkWrites: Array<Record<string, unknown>> = []

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
vi.mock('@/lib/integrations/asana-api', () => ({
  updateTaskCompleted: hoistedApi.updateTaskCompleted,
  addTaskToSection: hoistedApi.addTaskToSection,
  AsanaUnauthorizedError: class extends Error {},
  AsanaApiError: class extends Error {
    readonly status = 500
  },
}))

const { applyRemoteTaskState } = await import('@/lib/tasks/apply-remote-task-state')
await import('@/lib/inngest/asana-echo-status')

/**
 * Shared Inngest step mock — a vi.fn per method plus the nesting tripwire (step
 * tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

beforeEach(() => {
  hoistedApi.updateTaskCompleted.mockReset().mockResolvedValue({ gid: 'task-1', completed: true })
  hoistedApi.addTaskToSection.mockReset().mockResolvedValue(undefined)
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
})

describe('Asana ↔ Dial8 loop termination', () => {
  it('a webhook-applied completion produces ZERO Asana writes from the echo', async () => {
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      // No section map: nothing to move, so the echo has literally nothing to do.
      config: { project_gid: 'proj-1' },
    })

    // 1. Asana → Dial8: the task was completed remotely.
    const applied = await applyRemoteTaskState({
      supabase: db.client,
      workspaceId: 'ws-1',
      actorUserId: 'u-sync',
      link: { id: 'link-1', action_id: 'act-1', external_id: 'task-1', completed: false },
      remoteCompleted: true,
    })
    expect(applied.outcome).toBe('completed')
    // The CAS recorded the provider state BEFORE the emit — the brake.
    expect(db.links[0].completed).toBe(true)

    // 2. …which emitted flow/entity.status_changed. Feed that to the echo.
    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    expect(emitted[0].name).toBe('flow/entity.status_changed')

    const out = await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // 3. THE ASSERTION: the echo made no Asana call at all.
    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedApi.addTaskToSection).not.toHaveBeenCalled()
    expect(out).toMatchObject({
      status: 'ok',
      results: [{ linkId: 'link-1', outcome: 'already_synced' }],
    })
    // No link write either — nothing left to converge.
    expect(echoLinkWrites).toHaveLength(0)
  })

  it('with a section map the echo moves the task ONCE and never completes it', async () => {
    // The documented caveat: a mapped `done` section costs one idempotent
    // addTaskToSection. It cannot feed back — our webhook filter is
    // completed-only, so a section move raises no delivery.
    hoistedConfig.loadAsanaSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: { project_gid: 'proj-1', section_map: { done: 's-done' } },
    })

    const emitted = hoisted.send.mock.calls.at(-1) as unknown as [
      { name: string; data: Record<string, unknown> },
    ]
    await hoisted.handler({ event: { data: emitted[0].data }, step: makeStep() })

    // Still ZERO completion PUTs — the link already matches.
    expect(hoistedApi.updateTaskCompleted).not.toHaveBeenCalled()
    expect(hoistedApi.addTaskToSection).toHaveBeenCalledTimes(1)
    expect(hoistedApi.addTaskToSection).toHaveBeenCalledWith('tok', 's-done', 'task-1')
  })
})
