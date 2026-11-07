import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/linear-apply-remote.ts — the Linear→Dial8 webhook
 * fast path — and, through it, the shared apply helper all three providers run.
 *
 * Invariants locked in:
 *  - THE RE-FETCH IS THE CORRECTNESS BOUNDARY. The delivery names issue UUIDs
 *    and nothing else; everything applied comes from an authenticated
 *    `issue(id:)` read. This is what makes the UNVERIFIED shape of the webhook's
 *    `data.state` / `updatedFrom` structurally irrelevant. An id nothing is
 *    linked to costs zero Linear calls.
 *  - It routes ITSELF: Linear's webhooks are app-level (one URL for the whole
 *    app), so a delivery carries no workspace and links are resolved by
 *    (provider, external_id). ONE issue id may fan out to several workspaces.
 *  - `WorkflowState.type` — the stable 7-value enum — is the fold, never a
 *    status NAME. `duplicate` folds to CANCELED, not done.
 *  - null → the RETRYABLE task_missing marker; `trashed: true` → the SAME
 *    marker; but `archivedAt` set and NOT trashed is a real issue whose state
 *    applies normally (Linear auto-archives old completed issues).
 *  - an UNRECOGNIZED state type is NO SIGNAL: the action is left alone rather
 *    than defaulted open.
 *  - an organization mismatch skips the workspace (defence in depth behind the
 *    signature, not authentication).
 *  - A 401 skips THAT WORKSPACE only — one run can span tenants.
 *  - >25 ids self-chains the remainder, and the house rule holds: no step.* is
 *    ever called from inside a step.run callback (the shared step mock FAILS the
 *    test if it is).
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

const hoistedConfig = vi.hoisted(() => ({ loadLinearSyncState: vi.fn() }))
vi.mock('@/lib/tasks/linear-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadLinearSyncState: hoistedConfig.loadLinearSyncState }
})

const hoistedApi = vi.hoisted(() => ({ getIssue: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly status = 401
  constructor() {
    super('401')
    this.name = 'LinearUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/linear-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    LinearUnauthorizedError: FakeUnauthorized,
  }
})

await import('@/lib/inngest/linear-apply-remote')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — a vi.fn per method PLUS the house-rule tripwire:
 * calling step.sendEvent (or a nested step.run) while a step.run callback is on
 * the stack throws. In production that combination deadlocks silently.
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = (issueIds: string[], extra: Record<string, unknown> = {}) => ({
  data: { issueIds, ...extra },
})

const LINK = {
  id: 'link-1',
  action_id: 'act-1',
  external_id: 'iss-1',
  completed: false,
  workspace_id: 'ws-1',
  external_state_label: 'Todo',
  // What the push stored; the read-back refreshes it only when Linear rewrote
  // the issue's URL (a team move).
  external_url: 'https://linear.app/acme/issue/ENG-1',
  last_push_error: null,
  created_at: '2026-07-01T00:00:00.000Z',
}

const STATES = {
  'team-1': {
    completed: 'st-done',
    default: 'st-todo',
    unstarted: 'st-queued',
    started: 'st-doing',
    canceled: 'st-cancel',
  },
}

/** A Linear issue payload as `issue(id:)` returns it. */
function issue(
  name: string,
  type: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'iss-1',
    identifier: 'ENG-1',
    url: 'https://linear.app/acme/issue/ENG-1',
    trashed: false,
    archivedAt: null,
    state: { id: 'st-x', name, type },
    ...extra,
  }
}

const DONE_ISSUE = issue('Done', 'completed')
const OPEN_ISSUE = issue('In Progress', 'started')

function setDb(options: Parameters<typeof createAsanaRemoteFake>[0]) {
  dbFake = createAsanaRemoteFake(options)
  return dbFake
}

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: `clear` leaves queued
  // `mockResolvedValueOnce` values in place, so a test that failed before
  // consuming one leaks it into the next (the cascade the Jira sibling's
  // round-2 audit measured). Every mock is re-seeded immediately below, which
  // is what makes the stronger reset safe.
  vi.resetAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoistedConfig.loadLinearSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    config: { team_id: 'team-1', organization_id: 'org-1' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)
  setDb({})
})

// ---- Registration ----------------------------------------------------------

describe('linear-apply-remote — registration', () => {
  it('registers with the documented id, trigger and retries', () => {
    expect(hoisted.config.id).toBe('linear-apply-remote-change')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/linear-remote-change' }])
    expect(hoisted.config.retries).toBe(3)
  })

  it('caps concurrency WITHOUT a key — the event carries no workspace', () => {
    // Inngest evaluates a concurrency key against the EVENT, and an app-level
    // Linear delivery names an issue and an org, never a Dial8 workspace.
    expect(hoisted.config.concurrency).toEqual([{ limit: 5 }])
  })

  it('throttles globally — a bulk edit in Linear arrives as a burst', () => {
    expect(hoisted.config.throttle).toEqual({ limit: 30, period: '1m' })
  })
})

// ---- Gates -----------------------------------------------------------------

describe('linear-apply-remote — gates', () => {
  it('skips an empty id list without a lookup', async () => {
    const out = await hoisted.handler({ event: EVENT([]), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_issue_ids' })
    expect(hoistedConfig.loadLinearSyncState).not.toHaveBeenCalled()
  })

  it('skips an UNLINKED issue without resolving a destination or calling Linear', async () => {
    setDb({ links: [] })
    const out = await hoisted.handler({ event: EVENT(['iss-nope']), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links' })
    expect(hoistedConfig.loadLinearSyncState).not.toHaveBeenCalled()
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('skips a workspace whose Linear account was disconnected', async () => {
    setDb({ links: [{ ...LINK }] })
    hoistedConfig.loadLinearSyncState.mockResolvedValue(null)

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      skipped: Array<{ reason: string }>
    }

    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'no_sync_state' }])
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('skips a workspace whose token can no longer be minted', async () => {
    setDb({ links: [{ ...LINK }] })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      skipped: Array<{ reason: string }>
    }

    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'no_token' }])
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })
})

// ---- The organization sanity check -----------------------------------------

describe('linear-apply-remote — organization check', () => {
  it('SKIPS a workspace whose stored organization differs from the delivery', async () => {
    // Defence in depth behind the signature, not authentication: a delivery from
    // one Linear org reaching another org's links is impossible through the
    // normal path, so it is treated as one and nothing is read.
    setDb({ links: [{ ...LINK }], actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }], states: STATES })

    const out = (await hoisted.handler({
      event: EVENT(['iss-1'], { organizationId: 'org-SOMEONE-ELSE' }),
      step: makeStep(),
    })) as { skipped: Array<{ reason: string }> }

    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'organization_mismatch' }])
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('proceeds when the organizations MATCH', async () => {
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })

    await hoisted.handler({
      event: EVENT(['iss-1'], { organizationId: 'org-1' }),
      step: makeStep(),
    })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'iss-1')
  })

  it('proceeds when the DELIVERY carries no organization', async () => {
    // The receiver forwards the field only when the body had a usable one.
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalled()
  })

  it('proceeds when the CONFIG predates organization_id being stored', async () => {
    hoistedConfig.loadLinearSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: { team_id: 'team-1' },
    })
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })

    await hoisted.handler({
      event: EVENT(['iss-1'], { organizationId: 'org-1' }),
      step: makeStep(),
    })

    expect(hoistedApi.getIssue).toHaveBeenCalled()
  })
})

// ---- Applying a state ------------------------------------------------------

describe('linear-apply-remote — applying', () => {
  it('completes the action when the issue reaches a `completed`-type state', async () => {
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied).toMatchObject([{ linkId: 'link-1', outcome: 'completed' }])
    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-done' })
    expect(db.links[0].completed).toBe(true)
  })

  it('writes the state NAME to external_state_label — only when it changed', async () => {
    const db = setDb({
      links: [{ ...LINK, external_state_label: 'Todo' }],
      actions: [{ id: 'act-1', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_state_label: 'Done' } },
    ])
  })

  it('refreshes external_url when the issue moved team and its URL was rewritten', async () => {
    // Linear rewrites an issue's identifier — and therefore its canonical URL —
    // when it moves to another team, which is exactly the drift this re-fetch
    // exists to absorb. Keeping the retired URL leaves "Open in Linear"
    // pointing at an identifier that only works while Linear keeps redirecting.
    const db = setDb({
      links: [
        {
          ...LINK,
          external_state_label: 'Done',
          completed: true,
          external_url: 'https://linear.app/acme/issue/ENG-1',
        },
      ],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(
      issue('Done', 'completed', {
        identifier: 'OPS-45',
        url: 'https://linear.app/acme/issue/OPS-45',
      }),
    )

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_url: 'https://linear.app/acme/issue/OPS-45' } },
    ])
  })

  it('never NULLS a stored url when the re-fetch omits one', async () => {
    const db = setDb({
      links: [
        {
          ...LINK,
          external_state_label: 'Done',
          completed: true,
          external_url: 'https://linear.app/acme/issue/ENG-1',
        },
      ],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed', { url: null }))

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.linkUpdates).toEqual([])
  })

  it('does NOT write the label when the name is unchanged (sweep stays read-only)', async () => {
    const db = setDb({
      links: [{ ...LINK, external_state_label: 'Done', completed: true }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.linkUpdates).toEqual([])
  })

  it('folds `canceled` to a CANCELED landing, not a completion', async () => {
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Canceled', 'canceled'))

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-cancel' })
  })

  it('folds `duplicate` to CANCELED too — the seventh type is not "done"', async () => {
    // The value it is easiest to forget. An issue closed as a duplicate is
    // abandoned work, not shipped work; landing it on Done would tell the team
    // the action was delivered.
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Duplicate', 'duplicate'))

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-cancel' })
  })

  it('NEVER consults the state NAME — a done state named "Rejected" completes', async () => {
    // Jira needs isCanceledStatusName because it has no canceled category.
    // Linear has a real one, so the heuristic must never touch a Linear state:
    // a team whose completed state is literally named "Rejected" is read right.
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Rejected', 'completed'))

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-done' })
  })

  it('reopens INTO the started state when the issue moves back to `started`', async () => {
    // remoteHint.category === 'indeterminate' — the reopen lands in the team's
    // started state rather than its default.
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(OPEN_ISSUE)

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-doing' })
  })

  it('applies normally for an ARCHIVED but not trashed issue', async () => {
    // Linear auto-archives old completed issues. Treating archived as gone would
    // silently stop read-back for exactly the issues most likely to be done.
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(
      issue('Done', 'completed', { archivedAt: '2026-01-01T00:00:00.000Z', trashed: false }),
    )

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied).toMatchObject([{ linkId: 'link-1', outcome: 'completed' }])
    expect(dbFake.markerUpdates).toEqual([])
    expect(db.statusUpdates[0].patch).toMatchObject({ status_id: 'st-done' })
  })

  it('leaves the action ALONE for an unrecognized state type', async () => {
    // No signal. Defaulting an unknown type to "not started" would reopen work a
    // user just closed the moment Linear ships an eighth value.
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Paused', 'hibernating'))

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied).toEqual([{ linkId: 'link-1', outcome: 'unchanged' }])
    expect(db.statusUpdates).toEqual([])
    // …but the label still tracks what Linear says.
    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_state_label: 'Paused' } },
    ])
  })

  it('fans ONE issue id out to every workspace that links it', async () => {
    // Two Dial8 workspaces connected to the same Linear organization.
    const db = setDb({
      links: [
        { ...LINK },
        { ...LINK, id: 'link-2', action_id: 'act-2', workspace_id: 'ws-2' },
      ],
      actions: [
        { id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
        { id: 'act-2', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
      ],
      states: STATES,
    })

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ linkId: string }>
    }

    expect(out.applied.map((r) => r.linkId).sort()).toEqual(['link-1', 'link-2'])
    expect(db.statusUpdates).toHaveLength(2)
  })
})

// ---- task_missing ----------------------------------------------------------

describe('linear-apply-remote — the issue cannot be read', () => {
  it('marks task_missing on a NULL issue and continues the batch', async () => {
    // `issue(id:)` answers a bare null for deleted, invisible AND never-existed
    // alike — indistinguishable, so the marker is retryable rather than final.
    const db = setDb({
      links: [
        { ...LINK },
        { ...LINK, id: 'link-2', action_id: 'act-2', external_id: 'iss-2' },
      ],
      actions: [
        { id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
        { id: 'act-2', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
      ],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValueOnce(null).mockResolvedValueOnce(DONE_ISSUE)

    const out = (await hoisted.handler({
      event: EVENT(['iss-1', 'iss-2']),
      step: makeStep(),
    })) as { applied: Array<{ linkId: string; outcome: string }> }

    expect(out.applied).toMatchObject([
      { linkId: 'link-1', outcome: 'task_missing' },
      { linkId: 'link-2', outcome: 'completed' },
    ])
    expect(db.markerUpdates[0].patch).toMatchObject({
      last_push_error: expect.objectContaining({ code: 'task_missing' }),
    })
  })

  it('marks task_missing on a TRASHED issue — same code, no second vocabulary', async () => {
    // Linear's delete is a 30-day grace window, so trashed is "gone for now,
    // possibly back" — which is precisely what task_missing already means.
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Done', 'completed', { trashed: true }))

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied).toEqual([{ linkId: 'link-1', outcome: 'task_missing' }])
    // And crucially: the trashed issue's state was NOT applied.
    expect(db.statusUpdates).toEqual([])
  })

  it('RETIRES a stale marker once the issue reads again', async () => {
    const db = setDb({
      links: [
        {
          ...LINK,
          last_push_error: { code: 'task_missing', at: '2026-07-01T00:00:00.000Z' },
        },
      ],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.markerUpdates).toEqual([{ linkId: 'link-1', patch: { last_push_error: null } }])
  })

  it('does NOT write a marker-clear when there is no marker', async () => {
    const db = setDb({
      links: [{ ...LINK, last_push_error: null }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    expect(db.markerUpdates).toEqual([])
  })
})

// ---- Token failures --------------------------------------------------------

describe('linear-apply-remote — token failures', () => {
  it('a 401 in one workspace does NOT stop the other', async () => {
    setDb({
      links: [
        { ...LINK },
        { ...LINK, id: 'link-2', action_id: 'act-2', workspace_id: 'ws-2' },
      ],
      actions: [
        { id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
        { id: 'act-2', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
      ],
      states: STATES,
    })
    hoistedApi.getIssue
      .mockRejectedValueOnce(new FakeUnauthorized())
      .mockResolvedValue(DONE_ISSUE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })) as {
      applied: Array<{ linkId: string }>
      skipped: Array<{ reason: string }>
    }

    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'unauthorized' }])
    expect(out.applied.map((r) => r.linkId)).toEqual(['link-2'])
    warn.mockRestore()
  })

  it('re-throws a transient failure so Inngest retries the step', async () => {
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockRejectedValue(new Error('ECONNRESET'))

    await expect(
      hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() }),
    ).rejects.toThrow('ECONNRESET')
  })
})

// ---- Caps and the self-chain ----------------------------------------------

describe('linear-apply-remote — bounds', () => {
  it('processes 25 ids and CHAINS the remainder, in order', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `iss-${i}`)
    setDb({ links: [] })
    const step = makeStep()

    const out = (await hoisted.handler({ event: EVENT(ids), step })) as {
      status: string
      remaining: number
    }

    expect(out.status).toBe('continued')
    expect(out.remaining).toBe(5)
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/linear-remote-change',
      data: { issueIds: ids.slice(25) },
    })
  })

  it('carries the organization hint through the self-chain', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `iss-${i}`)
    setDb({ links: [] })
    const step = makeStep()

    await hoisted.handler({ event: EVENT(ids, { organizationId: 'org-1' }), step })

    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/linear-remote-change',
      data: { issueIds: ids.slice(25), organizationId: 'org-1' },
    })
  })

  it('defers whole IDS, never half an id, when the LINK cap bites', async () => {
    // One id with 60 links exceeds MAX_LINKS_PER_RUN on its own. It is still
    // processed WHOLE — splitting mid-id would re-load it from the start every
    // hop and never finish. That is the termination proof.
    const links = Array.from({ length: 60 }, (_, i) => ({
      ...LINK,
      id: `link-${i}`,
      action_id: `act-${i}`,
      workspace_id: `ws-${i}`,
    }))
    links.push({ ...LINK, id: 'link-late', action_id: 'act-late', external_id: 'iss-2', workspace_id: 'ws-late' })
    setDb({ links, states: STATES })
    const step = makeStep()

    const out = (await hoisted.handler({
      event: EVENT(['iss-1', 'iss-2']),
      step,
    })) as { status: string }

    expect(out.status).toBe('continued')
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/linear-remote-change',
      data: { issueIds: ['iss-2'] },
    })
    // The oversized id was processed in full this run: 60 reads, not 50.
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(60)
  })

  it('chains the tail even when NO id in this batch was linked', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `iss-${i}`)
    setDb({ links: [] })
    const step = makeStep()

    const out = (await hoisted.handler({ event: EVENT(ids), step })) as {
      status: string
      reason: string
    }

    expect(out).toMatchObject({ status: 'continued', reason: 'no_links' })
    expect(step.sendEvent).toHaveBeenCalled()
  })

  it('does NOT chain when everything fit', async () => {
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    const step = makeStep()

    const out = (await hoisted.handler({ event: EVENT(['iss-1']), step })) as { status: string }

    expect(out.status).toBe('ok')
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('dedupes repeated ids in one delivery', async () => {
    setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['iss-1', 'iss-1', 'iss-1']), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(1)
  })
})

// ---- House rule ------------------------------------------------------------

describe('linear-apply-remote — house rules', () => {
  it('never calls step.* from inside a step.run callback', async () => {
    // The shared mock throws NESTED_STEP_ERROR if it happens; in production the
    // same shape deadlocks silently and performs nothing.
    const ids = Array.from({ length: 30 }, (_, i) => `iss-${i}`)
    setDb({ links: [] })
    const step = makeStep()

    await expect(hoisted.handler({ event: EVENT(ids), step })).resolves.toMatchObject({
      status: 'continued',
    })
  })

  it('queries links by (provider, external_id) — the routing index', async () => {
    const db = setDb({
      links: [{ ...LINK }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['iss-1']), step: makeStep() })

    const query = db.linkQueries[0]
    expect(query.filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'provider', val: 'linear' },
        { op: 'in', col: 'external_id', val: ['iss-1'] },
      ]),
    )
  })
})
