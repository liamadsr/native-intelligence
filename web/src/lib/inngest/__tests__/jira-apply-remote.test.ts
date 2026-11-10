import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createAsanaRemoteFake, type AsanaRemoteFake } from '@/test/asana-remote-fake'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/jira-apply-remote.ts — the Jira→Native Intelligence webhook fast
 * path — and, through it, the shared apply helper both providers run.
 *
 * Invariants locked in:
 *  - THE RE-FETCH IS THE SECURITY BOUNDARY. The delivery names an issue and
 *    nothing else; the status that gets applied always comes from an
 *    authenticated GET, never from the (unsigned, forgeable) payload. An id
 *    nothing is linked to costs zero Jira calls.
 *  - It routes ITSELF: with one global receiver URL a delivery carries no
 *    workspace, so links are resolved by (provider, external_id) and ONE issue
 *    id may fan out to several workspaces, each with its own site and token.
 *  - statusCategory `done` — the stable, non-localizable enum — is the fold to
 *    the shared boolean; the status NAME goes to external_state_label, and only
 *    when it changed.
 *  - 404 → the RETRYABLE task_missing marker, and the batch continues. That is
 *    also how a `jira:issue_deleted` delivery resolves, with no special casing —
 *    and it is deliberately not terminal, because Jira answers 404 for "you may
 *    not browse this" too. A later successful read RETIRES the marker.
 *  - every issue is re-read against the site the LINK records, not against
 *    whatever the workspace's destination config points at today.
 *  - A 401 skips THAT WORKSPACE only — unlike Asana, one run can span tenants.
 *  - The CAS is the idempotency guard and the echo-loop breaker.
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

const hoistedConfig = vi.hoisted(() => ({ loadJiraSyncState: vi.fn() }))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoistedConfig.loadJiraSyncState }
})

const hoistedApi = vi.hoisted(() => ({ getIssue: vi.fn() }))
class FakeUnauthorized extends Error {
  readonly code = 'JIRA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string> = {}
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'JiraApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getIssue: hoistedApi.getIssue,
    JiraUnauthorizedError: FakeUnauthorized,
    JiraApiError: FakeApiError,
  }
})

await import('@/lib/inngest/jira-apply-remote')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — a vi.fn per method PLUS the house-rule tripwire:
 * calling step.sendEvent (or a nested step.run) while a step.run callback is on
 * the stack throws. In production that combination deadlocks silently.
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = (issueIds: string[]) => ({ data: { issueIds } })

const LINK = {
  id: 'link-1',
  action_id: 'act-1',
  external_id: '10001',
  /** The site the issue lives on — issue ids are per-site (migration 216). */
  external_scope: 'cafe0001',
  completed: false,
  workspace_id: 'ws-1',
  external_state_label: 'To Do',
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

/** A Jira issue payload as `GET /issue?fields=status` returns it. */
function issue(name: string, category: string) {
  return { id: '10001', fields: { status: { id: 's1', name, statusCategory: { key: category } } } }
}

const DONE_ISSUE = issue('Done', 'done')
const OPEN_ISSUE = issue('In Progress', 'indeterminate')

function setDb(options: Parameters<typeof createAsanaRemoteFake>[0]) {
  dbFake = createAsanaRemoteFake(options)
  return dbFake
}

beforeEach(() => {
  // resetAllMocks, NOT clearAllMocks: `clear` wipes call history but leaves
  // queued `mockResolvedValueOnce` / `mockRejectedValueOnce` values in place
  // (this file queues four of them, all on getIssue), so a test that failed
  // before consuming its queued value leaked it into the NEXT one.
  //
  // MEASURED, not assumed: injecting a single failure into "a 401 in one
  // workspace does NOT stop the other" AFTER its queue is seeded reports THREE
  // failures under `clear` — the leaked 401 and the leaked DONE_ISSUE surface
  // as an inexplicable marker in two later tests that queued neither — and
  // exactly ONE under `reset`. That cascade is the shape of the 1-in-8 flake
  // the round-2 audit saw here.
  //
  // Every mock this file uses is re-seeded immediately below, which is what
  // makes the stronger reset safe: `reset` drops implementations too.
  vi.resetAllMocks()
  hoisted.send.mockResolvedValue({ ids: ['e'] })
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-sync',
    config: { cloud_id: 'cafe0001', project_id: '10000', issue_type_id: '1' },
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

describe('jira-apply-remote — registration', () => {
  it('registers with the documented id, trigger and retries', () => {
    expect(hoisted.config.id).toBe('jira-apply-remote-change')
    expect(hoisted.config.triggers).toEqual([{ event: 'tasks/jira-remote-change' }])
    expect(hoisted.config.retries).toBe(3)
  })

  it('caps concurrency WITHOUT a key — the event carries no workspace', () => {
    // Inngest evaluates a concurrency key against the EVENT, and a Jira delivery
    // names an issue and nothing else (one global receiver URL). A flat ceiling
    // is the honest expression of that; a key would silently be undefined.
    expect(hoisted.config.concurrency).toEqual([{ limit: 5 }])
  })

  /**
   * REGRESSION (review finding: "forged webhook delivery amplifies into
   * unbounded authenticated Jira calls across every tenant"). This function's
   * trigger is raised by an unauthenticated public endpoint, so its arrival RATE
   * is attacker-controlled. Concurrency caps how many runs execute at once, not
   * how many start — only a throttle does that, and without one a POST loop
   * turns into sustained authenticated Jira traffic charged against every
   * tenant's share of the app-wide Atlassian quota.
   */
  it('THROTTLES globally — the trigger is reachable by anyone with an HTTP client', () => {
    expect(hoisted.config.throttle).toEqual({ limit: 30, period: '1m' })
  })
})

// ---- Gates -----------------------------------------------------------------

describe('jira-apply-remote — gates', () => {
  it('skips an empty id list without a lookup', async () => {
    const out = await hoisted.handler({ event: EVENT([]), step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_issue_ids' })
    expect(hoistedConfig.loadJiraSyncState).not.toHaveBeenCalled()
  })

  it('skips an UNLINKED issue without resolving a destination or calling Jira', async () => {
    // Also the forged-delivery case: naming an issue Native Intelligence has no link to buys
    // an attacker exactly one indexed SELECT.
    setDb({ links: [] })
    const out = await hoisted.handler({ event: EVENT(['99999']), step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links', issues: 1 })
    expect(hoistedConfig.loadJiraSyncState).not.toHaveBeenCalled()
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('scopes the link lookup to the jira provider and the delivered ids', async () => {
    // NOT to a workspace: the delivery doesn't name one, so (provider,
    // external_id) is the router. Missing the provider filter would let an
    // Asana gid that happens to equal a Jira issue id cross providers.
    const db = setDb({ links: [LINK], actions: [], states: STATES })
    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.linkQueries[0].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', col: 'provider', val: 'jira' },
        { op: 'in', col: 'external_id', val: ['10001'] },
      ]),
    )
  })

  it('skips a workspace whose Jira account is gone (links outlive it)', async () => {
    setDb({ links: [LINK], states: STATES })
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      skipped: Array<{ workspaceId: string; reason: string }>
    }

    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'no_sync_state' }])
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('skips a workspace whose config lost its site — nothing can be addressed', async () => {
    setDb({ links: [LINK], states: STATES })
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-sync',
      config: {},
    })

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      skipped: Array<{ reason: string }>
    }
    expect(out.skipped[0]).toMatchObject({ reason: 'no_sync_state' })
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })

  it('skips cleanly when no token can be minted', async () => {
    setDb({ links: [LINK], states: STATES })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      skipped: Array<{ reason: string }>
    }
    expect(out.skipped[0]).toMatchObject({ reason: 'no_token' })
    expect(hoistedApi.getIssue).not.toHaveBeenCalled()
  })
})

// ---- The authenticated re-fetch --------------------------------------------

describe('jira-apply-remote — the re-fetch is the trust boundary', () => {
  it('reads the status from Jira, addressed to the workspace’s own site', async () => {
    setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '10001', 'status')
  })

  it('folds statusCategory `done` — not the status NAME — to completed', async () => {
    // Names are per-workflow and localized ("Erledigt"); the category enum is
    // the only stable signal, which is why the fold keys off it.
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Erledigt', 'done'))

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string; fromStatusId?: string; toStatusId?: string }>
    }

    expect(db.casUpdates[0].patch).toMatchObject({ completed: true })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-done' } }])
    expect(out.applied[0]).toMatchObject({
      outcome: 'completed',
      fromStatusId: 'st-doing',
      toStatusId: 'st-done',
    })
    expect(hoisted.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'flow/entity.status_changed',
        data: expect.objectContaining({
          entity_id: 'act-1',
          workspace_id: 'ws-1',
          actor_user_id: 'u-sync',
        }),
      }),
    )
  })

  /**
   * REGRESSION (review finding 17 / round-1 audit): the read-back used to fold
   * every non-done status onto "not completed" and reopen into the team's
   * DEFAULT state, so a Jira user's "In Progress" became Todo in Native Intelligence — and the
   * echo then dragged the issue back to To Do to match. The status the two sides
   * compare has to be the same one; see jira-loop-termination for the full trace.
   */
  it('reopens into the team’s STARTED state when Jira says `indeterminate`', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(OPEN_ISSUE)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string; toStatusId?: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'reverted', toStatusId: 'st-doing' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-doing' } }])
  })

  it('reopens into the team’s DEFAULT state when Jira says `new`', async () => {
    // The other half of the same rule: a genuine "back to the backlog" reopen
    // must still land where a brand-new action lands.
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('To Do', 'new'))

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-todo' } }])
  })

  /**
   * REGRESSION (round-1 audit, echo group issue 2): Jira has no canceled
   * CATEGORY — "Won't Do" is done-category — so a cancellation folded onto
   * `completed` and the user's abandoned work was recorded in Native Intelligence as finished,
   * then echoed back to Jira as a plain "Done" with a Done resolution.
   */
  it('lands a cancel-named done status in the team’s CANCELED state', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue("Won't Do", 'done'))

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string; toStatusId?: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'canceled', toStatusId: 'st-cancel' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-cancel' } }])
    // The link still records completion: `completed` is the PROVIDER's state,
    // and Jira genuinely reports a done-category status.
    expect(db.casUpdates[0].patch).toMatchObject({ completed: true })
  })

  it('falls back to COMPLETED for a team with no canceled column', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: { 'team-1': { completed: 'st-done', default: 'st-todo' } },
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Rejected', 'done'))

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'completed' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-done' } }])
  })

  /**
   * REGRESSION (round-2 audit, echo issue 2). The canceled-less fallback above
   * is truthful — "abandoned" really did finish — so it lands on completed. The
   * started-less REOPEN has no such landing: is_default is an unstarted state,
   * which the echo would then export to Jira as a transition back to "To Do",
   * overwriting the human who just moved the issue. So it writes nothing to the
   * action, and the two systems visibly disagree instead.
   */
  it('DECLINES a reopen for a team with no started column, and says so', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      // A Todo→Done board: no `started` column at all.
      states: { 'team-1': { completed: 'st-done', default: 'st-todo' } },
    })
    hoistedApi.getIssue.mockResolvedValue(OPEN_ISSUE)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string; toStatusId?: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'no_target_state' })
    // Zero destructive writes in EITHER system: the action keeps the state its
    // owner put it in, and nothing wakes the echo.
    expect(db.statusUpdates).toHaveLength(0)
    expect(hoisted.send).not.toHaveBeenCalled()
    // The two honest writes still happen — the link records the provider state
    // (so a re-delivery is a no-op) and the label shows the divergence.
    expect(db.casUpdates[0].patch).toMatchObject({ completed: false })
    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_state_label: 'In Progress' } },
    ])
  })

  /**
   * REGRESSION (round-2 audit, echo issue 3). `canceled_protected` is Asana's
   * carve-out, and it exists because Asana's un-complete is AMBIGUOUS. A Jira
   * caller hands the helper the issue's real statusCategory, so there is nothing
   * to guess — refusing the reopen used to strand the action in Cancelled
   * forever, with every reconcile sweep refusing it again.
   */
  it('REOPENS a canceled action when Jira says the issue is in progress', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: "Won't Do" }],
      actions: [{ id: 'act-1', status_id: 'st-cancel', team_id: 'team-1', category: 'canceled' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(OPEN_ISSUE)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string; toStatusId?: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'reverted', toStatusId: 'st-doing' })
    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-doing' } }])
    expect(db.casUpdates[0].patch).toMatchObject({ completed: false })
  })

  it('reopens a canceled action to the DEFAULT state when Jira says `new`', async () => {
    // Same rule, other category: `new` is not "in progress", so it lands where a
    // brand-new action lands rather than in the started column.
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: "Won't Do" }],
      actions: [{ id: 'act-1', status_id: 'st-cancel', team_id: 'team-1', category: 'canceled' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('To Do', 'new'))

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.statusUpdates).toEqual([{ actionId: 'act-1', patch: { status_id: 'st-todo' } }])
  })

  it('records the status NAME on the link — the half the boolean can’t carry', async () => {
    const db = setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('Erledigt', 'done'))

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_state_label: 'Erledigt' } },
    ])
  })

  it('does NOT rewrite an unchanged label (a sweep over quiet issues stays read-only)', async () => {
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-done', team_id: 'team-1', category: 'completed' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.linkUpdates).toHaveLength(0)
    expect(db.casUpdates).toHaveLength(0)
  })

  it('refreshes the label even when the completion outcome writes nothing', async () => {
    // A move WITHIN a category ("In Progress" → "In Review", both
    // `indeterminate`): the CAS matches nothing and the action is rightly left
    // alone, but the name the user sees beside the link did change.
    const db = setDb({
      links: [{ ...LINK, completed: false, external_state_label: 'In Progress' }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(issue('In Review', 'indeterminate'))

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ outcome: string }>
    }

    expect(out.applied[0]).toMatchObject({ outcome: 'unchanged' })
    expect(db.casUpdates).toHaveLength(0)
    expect(db.statusUpdates).toHaveLength(0)
    expect(db.linkUpdates).toEqual([
      { linkId: 'link-1', patch: { external_state_label: 'In Review' } },
    ])
  })
})

// ---- Fan-out across workspaces ---------------------------------------------

describe('jira-apply-remote — one issue, several workspaces', () => {
  it('resolves a destination and token PER WORKSPACE', async () => {
    // Two Native Intelligence workspaces link an issue with the SAME id — which is the
    // ordinary case rather than an exotic one, since Jira ids are per-site
    // sequences that every site starts at 10000. The global receiver can't tell
    // them apart, so this function must: its own account, its own token, and
    // its own site, read off each link.
    const db = setDb({
      links: [
        LINK,
        {
          ...LINK,
          id: 'link-2',
          action_id: 'act-2',
          workspace_id: 'ws-2',
          external_scope: 'cafe0002',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
      actions: [
        { id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
        { id: 'act-2', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
      ],
      states: STATES,
    })
    hoistedConfig.loadJiraSyncState
      .mockResolvedValueOnce({
        id: 'tss-1',
        accountId: 'acct-1',
        userId: 'u-one',
        config: { cloud_id: 'cafe0001' },
      })
      .mockResolvedValueOnce({
        id: 'tss-2',
        accountId: 'acct-2',
        userId: 'u-two',
        config: { cloud_id: 'cafe0002' },
      })

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(hoistedConfig.loadJiraSyncState).toHaveBeenCalledWith('ws-1')
    expect(hoistedConfig.loadJiraSyncState).toHaveBeenCalledWith('ws-2')
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '10001', 'status')
    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0002', '10001', 'status')
    expect(db.statusUpdates).toHaveLength(2)
  })

  it('a 401 in one workspace does NOT stop the other', async () => {
    // The Asana sibling aborts the whole run on a 401 because one invocation is
    // one workspace by construction. Here it isn't, so the blast radius is one
    // tenant.
    const db = setDb({
      links: [
        LINK,
        {
          ...LINK,
          id: 'link-2',
          action_id: 'act-2',
          workspace_id: 'ws-2',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
      actions: [
        { id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
        { id: 'act-2', status_id: 'st-doing', team_id: 'team-1', category: 'started' },
      ],
      states: STATES,
    })
    hoistedApi.getIssue
      .mockRejectedValueOnce(new FakeUnauthorized())
      .mockResolvedValueOnce(DONE_ISSUE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      status: string
      applied: Array<{ linkId: string }>
      skipped: Array<{ workspaceId: string; reason: string }>
    }

    expect(out.status).toBe('ok')
    expect(out.skipped).toEqual([{ workspaceId: 'ws-1', reason: 'unauthorized' }])
    expect(out.applied.map((r) => r.linkId)).toEqual(['link-2'])
    expect(db.statusUpdates).toEqual([{ actionId: 'act-2', patch: { status_id: 'st-done' } }])
    warn.mockRestore()
  })
})

// ---- Issue read failures ---------------------------------------------------

describe('jira-apply-remote — issue read failures', () => {
  it('404 stamps the RETRYABLE task_missing marker and continues the batch', async () => {
    // Also the `jira:issue_deleted` path: the re-fetch 404s, which is why the
    // receiver needs no special casing for that event.
    const db = setDb({
      links: [
        LINK,
        {
          ...LINK,
          id: 'link-2',
          action_id: 'act-2',
          external_id: '10002',
          created_at: '2026-07-02T00:00:00.000Z',
        },
      ],
      actions: [{ id: 'act-2', status_id: 'st-todo', team_id: 'team-1', category: 'unstarted' }],
      states: STATES,
    })
    hoistedApi.getIssue
      .mockRejectedValueOnce(new FakeApiError(404, 'Issue does not exist'))
      .mockResolvedValueOnce(DONE_ISSUE)

    const out = (await hoisted.handler({
      event: EVENT(['10001', '10002']),
      step: makeStep(),
    })) as { applied: Array<{ linkId: string; outcome: string }> }

    expect(db.markerUpdates).toHaveLength(1)
    expect((db.markerUpdates[0].patch.last_push_error as { code: string }).code).toBe(
      'task_missing',
    )
    expect(out.applied).toEqual([
      { linkId: 'link-1', outcome: 'task_missing' },
      expect.objectContaining({ linkId: 'link-2', outcome: 'completed' }),
    ])
  })

  /**
   * REGRESSION (review finding: "404 is treated as the TERMINAL task_deleted
   * marker, but Jira 404s on permission-denied reads too"). Atlassian answers
   * 404 for "the issue does not exist" AND for "you cannot browse it", and
   * deliberately does not distinguish them — so an hour of tightened permissions
   * used to write an irreversible marker onto every open link in a workspace.
   * Recovery has to be automatic, which means the marker has to be cleared on
   * the first successful read.
   */
  it('RETIRES a stale task_missing marker once the issue reads again', async () => {
    const db = setDb({
      links: [{ ...LINK, last_push_error: { code: 'task_missing', at: 'yesterday' } }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    hoistedApi.getIssue.mockResolvedValue(DONE_ISSUE)

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
      applied: Array<{ linkId: string; outcome: string }>
    }

    expect(db.markerUpdates).toEqual([
      { linkId: 'link-1', patch: { last_push_error: null } },
    ])
    expect(out.applied).toEqual([expect.objectContaining({ outcome: 'completed' })])
  })

  it('writes NO marker at all when there was none to retire', async () => {
    // A quiet sweep over healthy links must stay read-only on the marker column.
    const db = setDb({ links: [LINK], states: STATES })
    hoistedApi.getIssue.mockResolvedValue(issue('To Do', 'new'))

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.markerUpdates).toHaveLength(0)
  })

  /**
   * REGRESSION (review finding: "links carry no site identity, so re-pointing
   * cloud_id makes read-back apply unrelated issues' status to Native Intelligence actions").
   * Issue id 10001 exists on essentially every Jira site; after a destination
   * switch the config's cloudId resolves a DIFFERENT, real issue on the new
   * tenant, and a `done` category there silently completes an action nobody
   * touched.
   */
  it('re-reads against the site the LINK records, not the current destination', async () => {
    setDb({
      links: [{ ...LINK, external_scope: 'cafe0002' }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    // The workspace has since re-pointed its destination at another site.
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { cloud_id: 'cafe0001' },
    })

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0002', '10001', 'status')
    expect(hoistedApi.getIssue).not.toHaveBeenCalledWith('tok', 'cafe0001', '10001', 'status')
  })

  it('falls back to the configured site for a link written before 216', async () => {
    setDb({
      links: [{ ...LINK, external_scope: null }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '10001', 'status')
  })

  it('rethrows a transient failure so Inngest retries', async () => {
    setDb({ links: [LINK], states: STATES })
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    await expect(
      hoisted.handler({ event: EVENT(['10001']), step: makeStep() }),
    ).rejects.toThrow('unavailable')
  })
})

// ---- Idempotency / loop breaking -------------------------------------------

describe('jira-apply-remote — the CAS short-circuit', () => {
  it('does NOTHING when the link already records the remote state', async () => {
    // Re-delivery (Jira may deliver more than once), an overlapping reconcile,
    // or the echo's own transition coming back.
    const db = setDb({
      links: [{ ...LINK, completed: true, external_state_label: 'Done' }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })

    const out = (await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })) as {
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
    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })
    await hoisted.handler({ event: EVENT(['10001']), step: makeStep() })

    expect(db.casUpdates).toHaveLength(1)
    expect(db.statusUpdates).toHaveLength(1)
  })

  it('propagates a real DB error rather than reading it as "already applied"', async () => {
    setDb({ links: [LINK], states: STATES, linkUpdateError: { message: 'db down' } })
    await expect(
      hoisted.handler({ event: EVENT(['10001']), step: makeStep() }),
    ).rejects.toBeTruthy()
  })
})

// ---- Bounding + self-chaining ----------------------------------------------

describe('jira-apply-remote — bounded runs', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => `issue-${i}`)

  it('caps a run at 25 ids and SELF-CHAINS the remainder from the top level', async () => {
    setDb({ links: [], states: STATES })
    const out = await hoisted.handler({ event: EVENT(many(30)), step: makeStep() })
    expect(out).toMatchObject({ reason: 'no_links', issues: 25 })

    setDb({
      links: [{ ...LINK, external_id: 'issue-0' }],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    const step = makeStep()
    const chained = await hoisted.handler({ event: EVENT(many(30)), step })

    expect(chained).toMatchObject({ status: 'continued', remaining: 5 })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/jira-remote-change',
      data: { issueIds: many(30).slice(25) },
    })
  })

  it('chains even when a workspace was skipped — the rest may be healthy', async () => {
    setDb({ links: [{ ...LINK, external_id: 'issue-0' }], states: STATES })
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)

    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(many(30)), step })

    expect(out).toMatchObject({ status: 'continued', remaining: 5 })
    expect(step.sendEvent).toHaveBeenCalled()
  })

  it('does NOT chain when everything fitted in one run', async () => {
    setDb({
      links: [LINK],
      actions: [{ id: 'act-1', status_id: 'st-doing', team_id: 'team-1', category: 'started' }],
      states: STATES,
    })
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT(['10001']), step })
    expect(out).toMatchObject({ status: 'ok' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  /**
   * REGRESSION (review finding 5 / round-1 audit, webhook-security issues 1-3:
   * "forged webhook delivery amplifies into unbounded authenticated Jira calls
   * across every tenant"). The 25-id cap bounds IDS; the COST is links. Jira
   * issue ids are per-site sequences that every site starts at 10000, so one id
   * routinely matches links in many workspaces, and each link is one
   * authenticated GET issued sequentially inside a single step.run against
   * `maxDuration = 300` — retried three times, re-issuing every GET.
   *
   * So the run is bounded by LINKS, and the ids it could not afford are
   * self-chained exactly like the ids past the 25-cap.
   */
  /** n issue ids, matching the `external_id`s linksAcross mints. */
  const manyIds = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`)

  const linksAcross = (workspaces: number, idCount: number) =>
    Array.from({ length: workspaces }, (_, w) =>
      Array.from({ length: idCount }, (_, i) => ({
        ...LINK,
        id: `link-${w}-${i}`,
        action_id: `act-${w}-${i}`,
        external_id: `id-${i}`,
        workspace_id: `ws-${w}`,
        created_at: `2026-07-01T00:00:${String(i).padStart(2, '0')}.000Z`,
      })),
    ).flat()

  it('bounds a run by LINKS, not ids, and self-chains the ids it deferred', async () => {
    // 25 ids, each linked in 3 workspaces = 75 authenticated reads if unbounded.
    setDb({ links: linksAcross(3, 25), states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(manyIds(25)), step })

    // 16 ids × 3 links = 48; a 17th would be 51, past the 50 cap.
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(48)
    expect(out).toMatchObject({ status: 'continued', remaining: 9 })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/jira-remote-change',
      // In the ORIGINAL order — the chain is a continuation, not a reshuffle.
      data: { issueIds: manyIds(25).slice(16) },
    })
  })

  it('processes an id whose link count alone exceeds the cap, rather than stalling', async () => {
    // The termination guarantee: every run consumes at least one whole id, so
    // the chain is strictly shorter each hop and cannot cycle forever.
    setDb({ links: linksAcross(60, 2), states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(['id-0', 'id-1']), step })

    // id-0 alone is 60 links — over the cap, and taken whole anyway.
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(60)
    expect(out).toMatchObject({ status: 'continued', remaining: 1 })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/jira-remote-change',
      data: { issueIds: ['id-1'] },
    })
  })

  it('does NOT chain an id nothing links to — there is no work to resume', async () => {
    setDb({ links: linksAcross(3, 1), states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(['id-0', 'id-99']), step })

    expect(out).toMatchObject({ status: 'ok' })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('DRAINS and HALTS: every link is read exactly once across the chain', async () => {
    const db = setDb({ links: linksAcross(3, 25), states: STATES })
    // 30 delivered ids: 5 past the id cap AND more links than one run affords.
    let pending = manyIds(30)
    let runs = 0

    while (pending.length > 0) {
      runs++
      expect(runs, 'the self-chain must terminate').toBeLessThan(10)
      const step = makeStep()
      const out = (await hoisted.handler({ event: EVENT(pending), step })) as {
        status: string
      }
      if (out.status !== 'continued') break
      const [, payload] = step.sendEvent.mock.calls[0] as unknown as [
        string,
        { data: { issueIds: string[] } },
      ]
      pending = payload.data.issueIds
    }

    // Every one of the 75 links was read, once, and nothing is left queued.
    expect(hoistedApi.getIssue).toHaveBeenCalledTimes(db.links.length)
    const read = hoistedApi.getIssue.mock.calls.map((c) => c[2])
    expect(new Set(read).size).toBe(25) // 25 distinct ids, 3 workspaces each
  })

  /**
   * REGRESSION (round-2 audit, webhook note 4): the `no_links` early return sits
   * BEFORE the chain, so an event whose first 25 ids are all unlinked used to
   * drop its tail silently. Unreachable from the receiver today — it caps a
   * delivery at 25 ids and the self-chain never emits more — which is exactly
   * why it needs a test: nothing else would notice if a future caller raised
   * `tasks/jira-remote-change` with a longer list.
   */
  it('CHAINS the tail even when every id in this run is unlinked', async () => {
    setDb({ links: [], states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(many(30)), step })

    expect(out).toMatchObject({ status: 'continued', reason: 'no_links', remaining: 5 })
    expect(step.sendEvent).toHaveBeenCalledWith('continue-remote-change', {
      name: 'tasks/jira-remote-change',
      data: { issueIds: many(30).slice(25) },
    })
  })

  it('does NOT chain when the unlinked ids are all there were', async () => {
    setDb({ links: [], states: STATES })
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT(many(10)), step })

    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links', issues: 10 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })

  it('dedupes ids before counting them against the cap', async () => {
    setDb({ links: [], states: STATES })
    const step = makeStep()
    const out = await hoisted.handler({
      event: EVENT(['10001', '10001', '10001']),
      step,
    })
    expect(out).toMatchObject({ issues: 1 })
    expect(step.sendEvent).not.toHaveBeenCalled()
  })
})
