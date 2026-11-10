import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/linear-echo-status.ts via the createFunction-capture
 * pattern (canonical: hubspot-push-contact.test.ts).
 *
 * Far smaller than the Jira sibling's suite, and the reason is structural rather
 * than a gap in coverage: Jira has no settable status field, so its echo has to
 * discover a transition graph, pick between three tiers and satisfy a resolution
 * screen. Linear's `issueUpdate(input: { stateId })` is a DIRECT WRITE — the
 * destination's derived state map already names the target, so there is nothing
 * to select and no ambiguity to resolve.
 *
 * Invariants locked in:
 *  - it rides the SHARED `flow/entity.status_changed` trigger (a FOURTH consumer,
 *    beside flowDispatchOnStatusChange, asanaEchoStatus and jiraEchoStatus) with
 *    snake_case concurrency keys that match the event payload.
 *  - non-action entities and actions with no Linear links no-op BEFORE any
 *    lookup.
 *  - THE CURRENT STATE IS READ FIRST — the loop breaker. A change the read-back
 *    just imported must not be echoed straight back out at the customer's issue.
 *    The comparison is at BUCKET resolution, so an issue a human parked on a
 *    second in-progress state is left where they put it.
 *  - a bucket the destination's map cannot express declines with
 *    `no_target_state`. It NEVER falls back to the nearest closed state: landing
 *    a canceled action on "Done" would tell the customer's team it shipped.
 *  - a STALE state id (someone deleted the state in Linear) is repaired by ONE
 *    re-derivation from the team's current states, using the SAME pure function
 *    the settings route uses.
 *  - marker LIFETIMES: every Linear marker is RETRYABLE, and all of them are
 *    cleared by the next success.
 *  - the house rule: no step.* is ever called from inside a step.run callback.
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

let dbFake: AsanaRemoteFake = createAsanaRemoteFake()
vi.mock('@/lib/admin', () => ({ getServiceClient: () => dbFake.client }))

const hoistedToken = vi.hoisted(() => ({ getValidTokenForAccount: vi.fn() }))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

const hoistedConfig = vi.hoisted(() => ({ loadLinearSyncState: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoistedConfig.loadLinearSyncState }
})

const hoistedApi = vi.hoisted(() => ({
  getIssue: vi.fn(),
  updateIssueState: vi.fn(),
  listTeamStates: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly status = 401
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly graphQLErrors: unknown[] = []
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'LinearApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    updateIssueState: hoistedApi.updateIssueState,
    listTeamStates: hoistedApi.listTeamStates,
    LinearUnauthorizedError: FakeUnauthorized,
    LinearApiError: FakeApiError,
  }
})

await import('@/lib/inngest/linear-echo-status')

// ---- Helpers ---------------------------------------------------------------

function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = (overrides: Record<string, unknown> = {}) => ({
  data: {
    entity_type: 'action',
    entity_id: 'act-1',
    workspace_id: 'ws-1',
    to_status_id: 'st-done',
    ...overrides,
  },
})

const LINK = {
  id: 'link-1',
  action_id: 'act-1',
  external_id: 'iss-1',
  completed: false,
  workspace_id: 'ws-1',
  external_state_label: 'Todo',
  last_push_error: null,
  created_at: '2026-07-01T00:00:00.000Z',
}

/** The saved, derived bucket→state map for the destination team. */
const STATE_MAP = {
  not_started: { id: 'ls-todo', name: 'Todo' },
  in_progress: { id: 'ls-doing', name: 'In Progress' },
  done: { id: 'ls-done', name: 'Done' },
  canceled: { id: 'ls-cancel', name: 'Canceled' },
}

function issue(name: string, type: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'iss-1',
    identifier: 'ENG-1',
    url: 'https://linear.app/acme/issue/ENG-1',
    trashed: false,
    archivedAt: null,
    state: { id: `ls-${type}`, name, type },
    ...extra,
  }
}

/**
 * The fake models `workflow_state` lookups by team; the echo only reads the
 * event's own `to_status_id` row for its category, so the bucket comes from
 * here. `category` is the Native Intelligence column, folded by bucketForCategory.
 */
function db(options: {
  links?: Array<Record<string, unknown>>
  category?: string
}): AsanaRemoteFake {
  dbFake = createAsanaRemoteFake({
    links: (options.links ?? [{ ...LINK }]) as never,
    // A single workflow_state row keyed by the event's to_status_id.
    actions: [],
    states: {},
  })
  // The echo's bucket read is `workflow_state.select('category').eq('id', …)`,
  // which the shared fake serves from its states table; patch it directly so
  // each test can name the target bucket in one place.
  const original = dbFake.client.from.bind(dbFake.client) as (t: string) => unknown
  ;(dbFake.client as unknown as { from: (t: string) => unknown }).from = (table: string) => {
    if (table === 'workflow_state') {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { category: options.category ?? 'completed' } }),
      }
      return chain
    }
    return original(table)
  }
  return dbFake
}

beforeEach(() => {
  vi.resetAllMocks()
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    config: { team_id: 'team-1', organization_id: 'org-1', state_map: STATE_MAP },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
  hoistedApi.updateIssueState.mockResolvedValue(issue('Done', 'completed'))
  hoistedApi.listTeamStates.mockResolvedValue([])
  db({})
})

// ---- Registration ----------------------------------------------------------

describe('linear-echo-status — registration', () => {
  it('rides the shared status-changed event', () => {
    expect(hoisted.config.id).toBe('linear-echo-status')
    expect(hoisted.config.triggers).toEqual([{ event: 'flow/entity.status_changed' }])
    expect(hoisted.config.retries).toBe(3)
  })

  it('keys concurrency on the payload’s OWN snake_case field names', () => {
    // A camelCase key would silently resolve to undefined and degrade the two
    // constraints into one global queue.
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspace_id' },
      { limit: 1, key: 'event.data.entity_id' },
    ])
  })
})

// ---- Gates -----------------------------------------------------------------

describe('linear-echo-status — gates', () => {
  it('ignores non-action entities without touching the database', async () => {
    const out = await hoisted.handler({
      event: EVENT({ entity_type: 'project' }),
      step: makeStep(),
    })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_an_action' })
    expect(hoistedConfig.loadLinearSyncState).not.toHaveBeenCalled()
  })

  it('no-ops an action with no Linear links, before any destination lookup', async () => {
    db({ links: [] })
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links' })
    expect(hoistedConfig.loadLinearSyncState).not.toHaveBeenCalled()
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('no-ops when the Linear account was disconnected', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_linear_account' })
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('no-ops when the token can no longer be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    const out = await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_linear_account' })
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('scopes the link read to this action, workspace and provider', async () => {
    const fake = db({})
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(fake.linkQueries[0].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'action_id', val: 'act-1' },
        { op: 'eq', col: 'workspace_id', val: 'ws-1' },
        { op: 'eq', col: 'provider', val: 'linear' },
      ]),
    )
  })
})

// ---- The loop breaker ------------------------------------------------------

describe('linear-echo-status — the current state is read FIRST', () => {
  it('reads the issue before writing anything', async () => {
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'iss-1')
    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-done')
  })

  it('writes NOTHING when the issue already satisfies the bucket', async () => {
    // THE loop breaker: the read-back moved the Native Intelligence action, which emitted the
    // status change that woke this function. Echoing it back out would overwrite
    // the change the user made in Linear seconds earlier.
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed'))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'already_synced' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
  })

  it('compares at BUCKET resolution, not state id', async () => {
    // The issue sits on a SECOND in-progress state ("In Review") that the map
    // doesn't name. It already satisfies `in_progress`, so rewriting it to the
    // mapped "In Progress" would be the echo overruling a human for no gain.
    db({ category: 'started' })
    hoistedApi.getIssue.mockResolvedValue({
      ...issue('In Review', 'started'),
      state: { id: 'ls-review', name: 'In Review', type: 'started' },
    })

    const out = (await hoisted.handler({
      event: EVENT({ to_status_id: 'st-doing' }),
      step: makeStep(),
    })) as { results: Array<{ outcome: string }> }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'already_synced' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
  })

  it('still refreshes the recorded state and clears the marker when already synced', async () => {
    // Nothing else retires a marker on this side, and the recorded provider
    // state is what stops the read-back from bouncing straight back here.
    const fake = db({
      links: [{ ...LINK, last_push_error: { code: 'unauthorized', at: 'x' } }],
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed'))

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(fake.markerUpdates[0].patch).toMatchObject({
      completed: true,
      external_state_label: 'Done',
      last_push_error: null,
    })
  })

  it('marks canceled AND done as completed on the link row', async () => {
    // Both close the issue; the difference between them lives in the Native Intelligence
    // action's state, which the read-back sets — not in this boolean.
    db({ category: 'canceled' })
    hoistedApi.getIssue.mockResolvedValue(issue('Canceled', 'canceled'))

    const fake = dbFake
    await hoisted.handler({ event: EVENT({ to_status_id: 'st-cancel' }), step: makeStep() })

    expect(fake.markerUpdates[0].patch).toMatchObject({ completed: true })
  })

  it('never "upgrades" a remotely CANCELED issue to Done', async () => {
    // The bounce-back guard. A Native Intelligence team with no canceled-category workflow
    // state makes the shared applyRemoteTaskState land a remote cancellation on
    // the team's DONE state instead — which emits a status change whose bucket
    // is 'done'. Strict bucket equality would read canceled ≠ done, conclude the
    // issue must move, and flip the customer's own cancellation to Done.
    hoistedApi.getIssue.mockResolvedValue(issue('Canceled', 'canceled'))

    const fake = db({})
    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'already_synced' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(fake.markerUpdates[0].patch).toMatchObject({
      completed: true,
      external_state_label: 'Canceled',
    })
  })

  it('never "upgrades" a DUPLICATE-closed issue to Done either', async () => {
    // Same fallback, and "Done" is even more wrong here: the work was closed as
    // a duplicate of something else, not shipped.
    hoistedApi.getIssue.mockResolvedValue(issue('Duplicate', 'duplicate'))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'already_synced' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
  })

  it('STILL writes an NI-side cancel out to a done-state issue', async () => {
    // The asymmetry is deliberate: only a remote terminal state satisfies a
    // done bucket. A user cancelling in Native Intelligence must still move a shipped issue to
    // Canceled in Linear, or the cancel would silently never reach them.
    db({ category: 'canceled' })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed'))

    const out = (await hoisted.handler({
      event: EVENT({ to_status_id: 'st-cancel' }),
      step: makeStep(),
    })) as { results: Array<{ outcome: string }> }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-cancel')
  })

  it('falls through to the write when the CURRENT state type is unknown', async () => {
    // The deliberate divergence from the read-back, pinned so an "alignment"
    // refactor cannot flip it silently: the read-back leaves an unknown type
    // alone (no signal), but here an unknown type satisfies no bucket and the
    // echo writes. That is loop-safe precisely BECAUSE the read-back skips
    // unknown types — such a state can never be a change we just imported.
    hoistedApi.getIssue.mockResolvedValue(issue('Paused', 'paused'))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-done')
  })
})

// ---- Writing ---------------------------------------------------------------

describe('linear-echo-status — writing', () => {
  it('writes the mapped state and records what it landed on', async () => {
    const fake = db({})
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockResolvedValue(issue('Done', 'completed'))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-done')
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
    expect(fake.markerUpdates[0].patch).toMatchObject({
      completed: true,
      external_state_label: 'Done',
      last_push_error: null,
    })
  })

  it('takes the landed state from the mutation’s own response — no second read', async () => {
    // Linear returns the issue's state inline on issueUpdate; Jira's transition
    // response carries no status, which is why the sibling has an extra read.
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockResolvedValue(issue('Shipped', 'completed'))

    const fake = dbFake
    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(1)
    expect(fake.markerUpdates[0].patch).toMatchObject({ external_state_label: 'Shipped' })
  })

  it('echoes every link on the action', async () => {
    db({
      links: [
        { ...LINK },
        { ...LINK, id: 'link-2', external_id: 'iss-2' },
      ],
    })

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: unknown[]
    }

    expect(out.results).toHaveLength(2)
    expect(hoistedApi.updateIssueState).toHaveBeenCalledTimes(2)
  })
})

// ---- no_target_state -------------------------------------------------------

describe('linear-echo-status — a bucket the team cannot express', () => {
  it('DECLINES with no_target_state rather than writing the nearest closed state', async () => {
    // A team with no canceled-type state is ordinary, not broken. Falling back
    // to "Done" would tell the customer's team that abandoned work shipped.
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: {
        team_id: 'team-1',
        state_map: { done: { id: 'ls-done', name: 'Done' } },
      },
    })
    db({ category: 'canceled' })
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    // The team genuinely has no canceled state, so the re-derivation finds none
    // either.
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-todo', name: 'Todo', type: 'unstarted', position: 0 },
      { id: 'ls-done', name: 'Done', type: 'completed', position: 1 },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = (await hoisted.handler({
      event: EVENT({ to_status_id: 'st-cancel' }),
      step: makeStep(),
    })) as { results: Array<{ outcome: string }> }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'no_target_state' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(dbFake.markerUpdates[0].patch).toMatchObject({
      last_push_error: expect.objectContaining({ code: 'no_target_state' }),
    })
    warn.mockRestore()
  })

  it('re-derives ONCE before declining, and uses the fresh map when it helps', async () => {
    // The saved map simply predates a state the team has since added.
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: { team_id: 'team-1', state_map: { done: { id: 'ls-done', name: 'Done' } } },
    })
    db({ category: 'canceled' })
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-new-cancel', name: "Won't Do", type: 'canceled', position: 3 },
    ])

    const out = (await hoisted.handler({
      event: EVENT({ to_status_id: 'st-cancel' }),
      step: makeStep(),
    })) as { results: Array<{ outcome: string }> }

    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-new-cancel')
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
  })

  it('re-derives at most ONCE per run, however many links decline', async () => {
    // A workspace whose whole map went stale costs one extra listTeamStates for
    // the batch, not one per link.
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: { team_id: 'team-1', state_map: {} },
    })
    db({
      category: 'canceled',
      links: [
        { ...LINK },
        { ...LINK, id: 'link-2', external_id: 'iss-2' },
        { ...LINK, id: 'link-3', external_id: 'iss-3' },
      ],
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.listTeamStates.mockResolvedValue([])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await hoisted.handler({ event: EVENT({ to_status_id: 'st-cancel' }), step: makeStep() })

    expect(hoistedApi.listTeamStates).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('declines without re-deriving when the destination has no team', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: {},
    })
    db({ category: 'canceled' })
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = (await hoisted.handler({
      event: EVENT({ to_status_id: 'st-cancel' }),
      step: makeStep(),
    })) as { results: Array<{ outcome: string }> }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'no_target_state' }])
    expect(hoistedApi.listTeamStates).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---- Stale state ids -------------------------------------------------------

describe('linear-echo-status — a stale state id', () => {
  it('re-derives and RETRIES once when issueUpdate rejects the saved id', async () => {
    // Someone deleted or replaced the state in Linear since the destination was
    // saved. The id we sent is the only thing that changed, so retrying the same
    // call with a fresh id is the whole fix.
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState
      .mockRejectedValueOnce(new FakeApiError(200, 'Entity not found: WorkflowState'))
      .mockResolvedValueOnce(issue('Complete', 'completed'))
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-fresh-done', name: 'Complete', type: 'completed', position: 5 },
    ])

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(hoistedApi.updateIssueState).toHaveBeenNthCalledWith(1, 'tok', 'iss-1', 'ls-done')
    expect(hoistedApi.updateIssueState).toHaveBeenNthCalledWith(2, 'tok', 'iss-1', 'ls-fresh-done')
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
  })

  it('marks update_failed when the re-derivation names the SAME id', async () => {
    // The state exists and Linear still refused it — re-sending it would only
    // earn the same rejection.
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockRejectedValue(new FakeApiError(200, 'nope'))
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-done', name: 'Done', type: 'completed', position: 1 },
    ])

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(hoistedApi.updateIssueState).toHaveBeenCalledTimes(1)
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'update_failed' }])
    expect(dbFake.markerUpdates[0].patch).toMatchObject({
      last_push_error: expect.objectContaining({ code: 'update_failed' }),
    })
  })

  it('a whole BATCH of stale links is repaired by ONE re-derivation', async () => {
    // The repair is per-RUN, not per-link: `stateMap` is replaced in place by
    // the first link that needs it, so every later link reads the fresh map at
    // step 2 and never re-enters the retry path. That is what keeps a workspace
    // whose entire map went stale at one extra `listTeamStates` for the batch
    // rather than one per link — and it is why the spent-re-derivation branch
    // returns the current map rather than null: nothing should be able to
    // decline against a fresh map that is already in hand.
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      // Present but STALE — deleted in Linear since the destination was saved.
      config: {
        team_id: 'team-1',
        state_map: { done: { id: 'ls-deleted', name: 'Done (old)' } },
      },
    })
    db({ links: [{ ...LINK }, { ...LINK, id: 'link-2', external_id: 'iss-2' }] })
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockImplementation(
      async (_t: string, _i: string, stateId: string) => {
        if (stateId === 'ls-deleted') throw new FakeApiError(200, 'Entity not found')
        return issue('Complete', 'completed')
      },
    )
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-fresh-done', name: 'Complete', type: 'completed', position: 1 },
    ])

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ linkId: string; outcome: string }>
    }

    // BOTH links land on the fresh id, and the team was read exactly once.
    expect(out.results).toEqual([
      { linkId: 'link-1', outcome: 'synced' },
      { linkId: 'link-2', outcome: 'synced' },
    ])
    expect(hoistedApi.listTeamStates).toHaveBeenCalledTimes(1)
    expect(hoistedApi.updateIssueState).toHaveBeenLastCalledWith('tok', 'iss-2', 'ls-fresh-done')
  })

  it('marks update_failed when the RETRY also fails', async () => {
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockRejectedValue(new FakeApiError(200, 'nope'))
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-other-done', name: 'Shipped', type: 'completed', position: 1 },
    ])

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(hoistedApi.updateIssueState).toHaveBeenCalledTimes(2)
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'update_failed' }])
  })

  it("writes against the ISSUE's team, not the configured one, after a team move", async () => {
    // Linear states are TEAM-SCOPED, and issues move between teams (that is why
    // getIssue asks for the team at all). Targeting the configured team's state
    // id for an issue that now lives elsewhere is rejected every time, and
    // re-deriving from that same configured team reproduces the identical id —
    // so the one repair mechanism could never repair the most ordinary cause of
    // rejection, and the Native Intelligence → Linear direction stayed dead for that link.
    hoistedApi.getIssue.mockResolvedValue(
      issue('Todo', 'unstarted', { team: { id: 'team-B', key: 'OPS' } }),
    )
    hoistedApi.listTeamStates.mockResolvedValue([
      { id: 'ls-B-done', name: 'Done', type: 'completed', position: 1 },
    ])

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    // Read the team the ISSUE is on — never the configured team-1.
    expect(hoistedApi.listTeamStates).toHaveBeenCalledWith('tok', 'team-B')
    // And get the FIRST write right, rather than relying on a reject-and-retry.
    expect(hoistedApi.updateIssueState).toHaveBeenCalledTimes(1)
    expect(hoistedApi.updateIssueState).toHaveBeenCalledWith('tok', 'iss-1', 'ls-B-done')
    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'synced' }])
  })

  it('does not let one team’s re-derivation poison another link’s team', async () => {
    // The repair is cached PER TEAM. A single shared `stateMap` slot would let
    // the first link's team-B map become the map every later link writes
    // against, silently sending team-B ids at team-A issues.
    db({
      links: [
        { ...LINK, id: 'link-1', external_id: 'iss-1' },
        { ...LINK, id: 'link-2', external_id: 'iss-2' },
      ],
    })
    hoistedApi.getIssue
      .mockResolvedValueOnce(issue('Todo', 'unstarted', { team: { id: 'team-B', key: 'OPS' } }))
      .mockResolvedValueOnce(issue('Todo', 'unstarted', { team: { id: 'team-1', key: 'ENG' } }))
    hoistedApi.listTeamStates.mockImplementation(async (_t: string, teamId: string) =>
      teamId === 'team-B'
        ? [{ id: 'ls-B-done', name: 'Done', type: 'completed', position: 1 }]
        : [{ id: 'ls-done', name: 'Done', type: 'completed', position: 1 }],
    )

    await hoisted.handler({ event: EVENT(), step: makeStep() })

    expect(hoistedApi.updateIssueState).toHaveBeenNthCalledWith(1, 'tok', 'iss-1', 'ls-B-done')
    // The saved map already names the configured team's id, so link-2 needs no
    // read at all — and must NOT inherit team-B's.
    expect(hoistedApi.updateIssueState).toHaveBeenNthCalledWith(2, 'tok', 'iss-2', 'ls-done')
  })
})

// ---- Failure markers -------------------------------------------------------

describe('linear-echo-status — failure markers', () => {
  it('marks task_missing when the issue reads as NULL', async () => {
    hoistedApi.getIssue.mockResolvedValue(null)

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'task_missing' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
    expect(dbFake.markerUpdates[0].patch).toMatchObject({
      last_push_error: expect.objectContaining({ code: 'task_missing' }),
    })
  })

  it('marks task_missing when the issue is TRASHED', async () => {
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed', { trashed: true }))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ outcome: string }>
    }

    expect(out.results).toEqual([{ linkId: 'link-1', outcome: 'task_missing' }])
    expect(hoistedApi.updateIssueState).not.toHaveBeenCalled()
  })

  it('marks unauthorized on a rejected token and continues the batch', async () => {
    db({ links: [{ ...LINK }, { ...LINK, id: 'link-2', external_id: 'iss-2' }] })
    hoistedApi.getIssue
      .mockRejectedValueOnce(new FakeUnauthorized())
      .mockResolvedValue(issue('Todo', 'unstarted'))

    const out = (await hoisted.handler({ event: EVENT(), step: makeStep() })) as {
      results: Array<{ linkId: string; outcome: string }>
    }

    expect(out.results).toEqual([
      { linkId: 'link-1', outcome: 'unauthorized' },
      { linkId: 'link-2', outcome: 'synced' },
    ])
  })

  it('re-throws a transient failure so Inngest retries the step', async () => {
    hoistedApi.getIssue.mockRejectedValue(new Error('ECONNRESET'))

    await expect(
      hoisted.handler({ event: EVENT(), step: makeStep() }),
    ).rejects.toThrow('ECONNRESET')
  })

  it('re-throws a transient failure from the WRITE too', async () => {
    hoistedApi.getIssue.mockResolvedValue(issue('Todo', 'unstarted'))
    hoistedApi.updateIssueState.mockRejectedValue(new FakeApiError(503, 'gateway'))

    await expect(
      hoisted.handler({ event: EVENT(), step: makeStep() }),
    ).rejects.toThrow('gateway')
  })
})
