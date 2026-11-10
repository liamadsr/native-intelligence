import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/jira-echo-status.ts via the createFunction-capture
 * pattern (canonical: hubspot-push-contact.test.ts).
 *
 * The transition SELECTION is the heart of this file and is tested as a pure
 * function as well as through the handler, because it is the one piece with no
 * safe default: picking the wrong transition moves a customer's real issue into
 * a wrong status and fires their notifications and automations.
 *
 * Invariants locked in:
 *  - it rides the SHARED `flow/entity.status_changed` trigger (a THIRD consumer,
 *    beside flowDispatchOnStatusChange and asanaEchoStatus) with snake_case
 *    concurrency keys that match the event payload.
 *  - non-action entities and actions with no Jira links no-op BEFORE any lookup.
 *  - selection order: explicit status mapping → canceled-by-name (unmapped only)
 *    → statusCategory. No multi-hop.
 *  - the resolution field is set ONLY when the transition's screen carries it,
 *    preferring "Won't Do"/"Done" and falling back to the first allowed value
 *    when required.
 *  - 409 Conflict is RETRIED (Atlassian's documented concurrent-transition
 *    behaviour); 4xx → 'transition_failed'; 401 → 'unauthorized'; 404 →
 *    'task_missing'; 5xx throws so Inngest retries.
 *  - THE CURRENT STATUS IS READ FIRST, before any transition is selected: a
 *    workflow with no self-loop offers no transition to the status the issue is
 *    already in, so choosing "any transition in the right category" moves an
 *    issue that was already correct. That check is also what stops a
 *    Jira-originated change round-tripping back out, and what makes an Inngest
 *    replay of the per-link loop a no-op.
 *  - marker LIFETIMES: every Jira marker is RETRYABLE, including 'task_missing'
 *    (404 means "gone OR not browsable", and Atlassian will not say which), and
 *    all of them are cleared by the next success.
 *  - the issue is addressed against the site the LINK records, not against
 *    whatever the destination config points at today.
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

const hoistedConfig = vi.hoisted(() => ({ loadJiraSyncState: vi.fn() }))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return { ...actual, loadJiraSyncState: hoistedConfig.loadJiraSyncState }
})

const hoistedApi = vi.hoisted(() => ({
  getTransitions: vi.fn(),
  transitionIssue: vi.fn(),
  getIssue: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'JIRA_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  readonly fieldErrors: Record<string, string>
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'JiraApiError'
    this.status = status
    this.fieldErrors = {}
  }
}
vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    getTransitions: hoistedApi.getTransitions,
    transitionIssue: hoistedApi.transitionIssue,
    getIssue: hoistedApi.getIssue,
    JiraUnauthorizedError: FakeUnauthorized,
    JiraApiError: FakeApiError,
  }
})

const { selectTransition, resolutionForTransition, statusSatisfiesBucket } = await import(
  '@/lib/inngest/jira-echo-status'
)

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

/** Transitions of a plain three-status workflow. */
const T_TODO = { id: '11', name: 'To Do', to: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } }
const T_DOING = {
  id: '21',
  name: 'Start',
  to: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } },
}
const T_DONE = { id: '31', name: 'Done', to: { id: '3', name: 'Done', statusCategory: { key: 'done' } } }
const T_WONT_DO = {
  id: '41',
  name: "Won't Do",
  to: { id: '4', name: "Won't Do", statusCategory: { key: 'done' } },
}

interface DbRows {
  links?: Array<Record<string, unknown>>
  category?: string | null
}

/**
 * Table-aware fake. `action_external_task` reads terminate at the awaited filter
 * chain (no .maybeSingle()); `workflow_state` reads terminate at .maybeSingle().
 * Updates record their patch for assertion.
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
  external_id: '99001',
  // The site the issue lives on (migration 216) — the same one the destination
  // config points at, which is the ordinary case.
  external_scope: 'cafe0001',
  completed: false,
  external_state_label: 'To Do',
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedConfig.loadJiraSyncState.mockResolvedValue({
    id: 'tss-1',
    accountId: 'acct-1',
    userId: 'u-1',
    config: { cloud_id: 'cafe0001', project_id: '10000', issue_type_id: '10001' },
  })
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.getTransitions.mockResolvedValue([T_TODO, T_DOING, T_DONE])
  hoistedApi.transitionIssue.mockResolvedValue(undefined)
  hoistedApi.getIssue.mockResolvedValue({
    id: '99001',
    fields: { status: { id: '1', name: 'To Do', statusCategory: { key: 'new' } } },
  })
})

// ---- selectTransition (pure) -----------------------------------------------

describe('selectTransition — tier (a): explicit status mapping wins', () => {
  it('picks the transition landing on the mapped status id', () => {
    const picked = selectTransition([T_TODO, T_DOING, T_DONE], 'done', { done: '2' })
    // Deliberately the "In Progress" status: an explicit mapping outranks the
    // category, because the user said so.
    expect(picked?.id).toBe('21')
  })

  it('falls through to the category when the mapped status is unreachable', () => {
    const picked = selectTransition([T_TODO, T_DONE], 'done', { done: '999' })
    expect(picked?.id).toBe('31')
  })
})

describe('selectTransition — tier (b): canceled by NAME, unmapped only', () => {
  it("prefers a Won't Do transition over a plain Done one for canceled", () => {
    const picked = selectTransition([T_DONE, T_WONT_DO], 'canceled', null)
    expect(picked?.id).toBe('41')
  })

  it('falls back to the done category when no cancel-ish name exists', () => {
    // Landing a canceled action on Done is the right approximation; the
    // resolution field usually carries the nuance.
    const picked = selectTransition([T_TODO, T_DONE], 'canceled', null)
    expect(picked?.id).toBe('31')
  })

  it('does NOT apply the name heuristic when canceled IS mapped', () => {
    // An explicit mapping is a decision; the heuristic is a guess.
    const picked = selectTransition([T_DONE, T_WONT_DO], 'canceled', { canceled: '3' })
    expect(picked?.id).toBe('31')
  })

  /**
   * REGRESSION (review finding: "an action marked Done can be transitioned into
   * a Won't Do / Cancelled status"). This test used to assert the OPPOSITE —
   * that the first done-CATEGORY transition wins and "the name is irrelevant" —
   * which pinned the bug in place. Transition order comes from the workflow
   * definition and is arbitrary, so a workspace whose "Won't Do" happens to be
   * listed first had every completed action presented in Jira as abandoned.
   */
  it('SKIPS a cancel-named landing status for the done bucket', () => {
    const picked = selectTransition([T_WONT_DO, T_DONE], 'done', null)
    expect(picked?.id).toBe('31')
    expect(picked?.to?.name).toBe('Done')
  })

  it('still lets an EXPLICIT done mapping land on a cancel-named status', () => {
    // A mapping is a decision somebody made; the exclusion above only governs
    // the guess we make in its absence.
    expect(selectTransition([T_DONE, T_WONT_DO], 'done', { done: '4' })?.id).toBe('41')
  })

  it('reports no candidate when the only done-category transition is a cancellation', () => {
    // Better an honest `no_transition` (which self-heals) than silently
    // cancelling completed work.
    expect(selectTransition([T_TODO, T_WONT_DO], 'done', null)).toBeNull()
  })

  /**
   * REGRESSION (review finding: "an unreachable explicit canceled mapping falls
   * straight to Done, skipping the cancel-name heuristic"). The tier-(b) guard
   * was keyed on whether a mapping EXISTS rather than on whether tier (a)
   * actually matched, so a canceled status id that no offered transition
   * reaches — a condition hid it, or it went stale after a project move — fell
   * through to the category tier and marked the issue plain Done, with a
   * "Won't Do" transition sitting right there.
   */
  it('falls back to the cancel NAME when a mapped canceled status is unreachable', () => {
    const picked = selectTransition([T_DONE, T_WONT_DO], 'canceled', { canceled: '10004' })
    expect(picked?.id).toBe('41')
  })
})

describe('selectTransition — tier (c): statusCategory', () => {
  const table: Array<[string, string]> = [
    ['not_started', '11'],
    ['in_progress', '21'],
    ['done', '31'],
  ]
  for (const [bucket, id] of table) {
    it(`maps '${bucket}' onto its statusCategory transition`, () => {
      expect(
        selectTransition([T_TODO, T_DOING, T_DONE], bucket as never, null)?.id,
      ).toBe(id)
    })
  }

  it('returns null when nothing in the list reaches the bucket', () => {
    expect(selectTransition([T_TODO], 'done', null)).toBeNull()
  })

  it('returns null for an empty transition list', () => {
    expect(selectTransition([], 'done', null)).toBeNull()
  })
})

describe('selectTransition — hygiene', () => {
  it('skips transitions explicitly flagged isAvailable:false', () => {
    const blocked = { ...T_DONE, isAvailable: false }
    expect(selectTransition([blocked], 'done', null)).toBeNull()
  })

  it('keeps transitions with isAvailable absent (the normal response shape)', () => {
    expect(selectTransition([T_DONE], 'done', null)?.id).toBe('31')
  })

  it('skips a malformed transition with no id', () => {
    expect(selectTransition([{ id: '', to: T_DONE.to } as never], 'done', null)).toBeNull()
  })

  it('does NOT multi-hop — an indirect path is no path', () => {
    // Only To Do is offered while the target is done: v1 refuses to walk there
    // through a visible intermediate status change in the customer's Jira.
    expect(selectTransition([T_TODO], 'done', { done: '3' })).toBeNull()
  })
})

// ---- resolutionForTransition (pure) ----------------------------------------

describe('resolutionForTransition', () => {
  function withResolution(
    allowedValues: Array<{ id?: string; name?: string }>,
    required = false,
  ) {
    return { ...T_DONE, fields: { resolution: { required, allowedValues } } }
  }

  it('sends NOTHING when the transition screen has no resolution field', () => {
    // Setting an off-screen field is a guaranteed 400 that would turn a working
    // transition into a failure.
    expect(resolutionForTransition(T_DONE, 'done')).toBeNull()
  })

  it("prefers Won't Do for canceled", () => {
    expect(
      resolutionForTransition(withResolution([{ name: 'Done' }, { name: "Won't Do" }]), 'canceled'),
    ).toEqual({ name: "Won't Do" })
  })

  it('prefers Done for done', () => {
    expect(
      resolutionForTransition(withResolution([{ name: 'Done' }, { name: "Won't Do" }]), 'done'),
    ).toEqual({ name: 'Done' })
  })

  it("matches case-insensitively but sends the SITE'S OWN spelling back", () => {
    // allowedValues is what the instance will accept; our casing is not.
    expect(
      resolutionForTransition(withResolution([{ name: "WON'T DO" }]), 'canceled'),
    ).toEqual({ name: "WON'T DO" })
  })

  it('omits an OPTIONAL resolution it cannot match', () => {
    expect(
      resolutionForTransition(withResolution([{ name: 'Fixed' }, { name: 'Duplicate' }]), 'done'),
    ).toBeNull()
  })

  it('falls back to the first allowed value when the field is REQUIRED', () => {
    // A slightly wrong resolution beats a transition that cannot fire at all.
    expect(
      resolutionForTransition(withResolution([{ name: 'Fixed' }, { name: 'Duplicate' }], true), 'done'),
    ).toEqual({ name: 'Fixed' })
  })

  it('falls back to an id when the first allowed value has no name', () => {
    expect(resolutionForTransition(withResolution([{ id: '10000' }], true), 'done')).toEqual({
      id: '10000',
    })
  })

  it('omits when the field is required but offers no allowed values', () => {
    expect(resolutionForTransition(withResolution([], true), 'done')).toBeNull()
  })

  it('omits for the open buckets, which have no meaningful resolution', () => {
    expect(
      resolutionForTransition(withResolution([{ name: 'Done' }]), 'in_progress'),
    ).toBeNull()
    expect(resolutionForTransition(withResolution([{ name: 'Done' }]), 'not_started')).toBeNull()
  })
})

// ---- Registration ----------------------------------------------------------

describe('jira-echo-status — registration', () => {
  it('registers as ANOTHER consumer of the shared status-changed trigger', () => {
    expect(hoisted.config.id).toBe('jira-echo-status')
    expect(hoisted.config.triggers).toEqual([{ event: 'flow/entity.status_changed' }])
    expect(hoisted.config.retries).toBe(3)
  })

  it("keys concurrency on the event payload's SNAKE_CASE fields", () => {
    // camelCase keys would silently resolve to undefined and collapse every
    // workspace into one queue.
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspace_id' },
      { limit: 1, key: 'event.data.entity_id' },
    ])
  })
})

// ---- No-op gates -----------------------------------------------------------

describe('jira-echo-status — no-op gates', () => {
  it('no-ops for a non-action entity without touching the database', async () => {
    dbFake = makeDb({}).client
    const out = await hoisted.handler({
      event: { data: { ...EVENT.data, entity_type: 'project' } },
      step: makeStep(),
    })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_an_action' })
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
    expect(hoistedConfig.loadJiraSyncState).not.toHaveBeenCalled()
  })

  it('no-ops when the action has no Jira links (the common case)', async () => {
    dbFake = makeDb({ links: [] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_links' })
    // Crucially: no destination lookup, no token mint.
    expect(hoistedConfig.loadJiraSyncState).not.toHaveBeenCalled()
    expect(hoistedToken.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('no-ops when the Jira account was disconnected but links survive', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue(null)
    dbFake = makeDb({ links: [OPEN_LINK] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_jira_account' })
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
  })

  it('no-ops when the destination has no cloud_id — the call is unaddressable', async () => {
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { project_id: '10000' },
    })
    dbFake = makeDb({ links: [OPEN_LINK] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_jira_account' })
  })

  it('no-ops when no valid token can be minted', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    dbFake = makeDb({ links: [OPEN_LINK] }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_jira_account' })
  })
})

// ---- Writes ----------------------------------------------------------------

describe('jira-echo-status — transitions', () => {
  it('transitions the issue to the done-category status and records the landing state', async () => {
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getTransitions).toHaveBeenCalledWith('tok', 'cafe0001', '99001')
    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', {
      transition: { id: '31' },
    })
    expect(out).toMatchObject({ status: 'ok', bucket: 'done' })

    const write = db.updates.find((u) => u.id === 'link-1')
    expect(write?.patch).toMatchObject({
      completed: true,
      external_state_label: 'Done',
      last_push_error: null,
    })
    expect(write?.patch.last_synced_at).toBeTruthy()
  })

  it('re-opens the issue when a completed action moves back to started', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, completed: true, external_state_label: 'Done' }],
      category: 'started',
    })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', {
      transition: { id: '21' },
    })
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: false,
      external_state_label: 'In Progress',
    })
  })

  it('sends the resolution when the chosen transition screen carries it', async () => {
    hoistedApi.getTransitions.mockResolvedValue([
      { ...T_DONE, fields: { resolution: { required: true, allowedValues: [{ name: 'Done' }] } } },
    ])
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', {
      transition: { id: '31' },
      fields: { resolution: { name: 'Done' } },
    })
  })

  it("sends Won't Do for a canceled action when the screen offers it", async () => {
    hoistedApi.getTransitions.mockResolvedValue([
      {
        ...T_DONE,
        fields: { resolution: { required: true, allowedValues: [{ name: 'Done' }, { name: "Won't Do" }] } },
      },
    ])
    dbFake = makeDb({ links: [OPEN_LINK], category: 'canceled' }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ bucket: 'canceled' })
    expect(hoistedApi.transitionIssue.mock.calls[0][3]).toEqual({
      transition: { id: '31' },
      fields: { resolution: { name: "Won't Do" } },
    })
  })

  it('marks a canceled action completed:true — the done CATEGORY is what counts', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_WONT_DO])
    const db = makeDb({ links: [OPEN_LINK], category: 'canceled' })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: true,
      external_state_label: "Won't Do",
    })
  })

  it('treats an unknown status category as not_started', async () => {
    // The issue has to be somewhere OTHER than a `new` status, or the
    // already-satisfied pre-check (correctly) short-circuits before any move.
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    const db = makeDb({ links: [OPEN_LINK], category: 'triage' })
    dbFake = db.client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', {
      transition: { id: '11' },
    })
    expect(out).toMatchObject({ bucket: 'not_started' })
  })

  it('keeps going through the remaining links after one fails', async () => {
    hoistedApi.transitionIssue
      .mockRejectedValueOnce(new FakeApiError(404, 'gone'))
      .mockResolvedValueOnce(undefined)

    const db = makeDb({
      links: [
        OPEN_LINK,
        {
          id: 'link-2',
          external_id: '99002',
          external_scope: 'cafe0001',
          completed: false,
          external_state_label: null,
        },
      ],
      category: 'completed',
    })
    dbFake = db.client

    const out = (await hoisted.handler({ event: EVENT, step: makeStep() })) as {
      results: Array<{ linkId: string; outcome: string }>
    }
    expect(out.results).toEqual([
      { linkId: 'link-1', outcome: 'task_missing' },
      { linkId: 'link-2', outcome: 'synced' },
    ])
  })
})

// ---- statusSatisfiesBucket (pure) ------------------------------------------

/**
 * The gate the whole echo now hangs off. It decides "leave the customer's issue
 * exactly where it is" vs "transition it", and both errors are expensive: too
 * lax and a Native Intelligence column move stops mirroring, too strict and the echo bounces a
 * status a human just set.
 */
describe('statusSatisfiesBucket', () => {
  const done = { id: '3', name: 'Done', categoryKey: 'done' }
  const wontDo = { id: '4', name: "Won't Do", categoryKey: 'done' }
  const doing = { id: '2', name: 'In Progress', categoryKey: 'indeterminate' }
  const todo = { id: '1', name: 'To Do', categoryKey: 'new' }

  it('matches the MAPPED status id and nothing else', () => {
    expect(statusSatisfiesBucket(done, 'done', { done: '3' })).toBe(true)
    // Right category, wrong status: the user named one, so only that one counts.
    expect(statusSatisfiesBucket(wontDo, 'done', { done: '3' })).toBe(false)
  })

  it('falls back to the statusCategory when unmapped', () => {
    expect(statusSatisfiesBucket(doing, 'in_progress', null)).toBe(true)
    expect(statusSatisfiesBucket(todo, 'not_started', null)).toBe(true)
    expect(statusSatisfiesBucket(todo, 'done', null)).toBe(false)
  })

  /**
   * REGRESSION (round-1 audit, echo group issues 3+4). This check briefly ALSO
   * enforced the cancel-name rule — `done` rejected "Won't Do", `canceled`
   * rejected a plain "Done" — and both directions caused harm:
   *
   *  - a Native Intelligence Done-column move against an issue a user had parked on "Won't Do"
   *    stopped reporting `already_synced` and started FIGHTING that cancellation
   *    (or stamping `no_transition` on a perfectly healthy link when nothing
   *    else in the done category was reachable);
   *  - and it broke the module header's idempotency promise, because
   *    selectTransition legitimately lands a `canceled` echo on a plain "Done"
   *    when the workflow offers no cancel-named status — a landing this check
   *    then rejected forever, so every Inngest replay re-entered selection.
   *
   * The rule is therefore SATISFACTION BY CATEGORY ONLY. The name heuristic is a
   * tie-breaker for CHOOSING where to move an issue, not a licence to move one
   * that is already in the right category — see selectTransition, which is the
   * only place it now lives.
   */
  it('accepts ANY done-category status for BOTH terminal buckets', () => {
    expect(statusSatisfiesBucket(done, 'done', null)).toBe(true)
    expect(statusSatisfiesBucket(wontDo, 'done', null)).toBe(true)
    expect(statusSatisfiesBucket(done, 'canceled', null)).toBe(true)
    expect(statusSatisfiesBucket(wontDo, 'canceled', null)).toBe(true)
  })

  it('still separates the terminal buckets from the open ones', () => {
    // The category is doing real work here: `canceled` is not satisfied by an
    // issue somebody is actively working on.
    expect(statusSatisfiesBucket(doing, 'canceled', null)).toBe(false)
    expect(statusSatisfiesBucket(todo, 'canceled', null)).toBe(false)
    expect(statusSatisfiesBucket(doing, 'done', null)).toBe(false)
  })

  it('an explicit mapping still overrides the category for canceled', () => {
    // A mapping is a decision somebody made: only that status counts, whatever
    // its name or category.
    expect(statusSatisfiesBucket(wontDo, 'canceled', { canceled: '4' })).toBe(true)
    expect(statusSatisfiesBucket(done, 'canceled', { canceled: '4' })).toBe(false)
  })
})

// ---- The already-satisfied pre-check ---------------------------------------

/**
 * REGRESSION (review findings: "echo transitions without checking the issue's
 * current status", "echo fires a category-fallback transition even when the
 * issue already sits on the explicitly mapped status", "echo bounces a Jira
 * reopen back to To Do").
 *
 * The echo used to call selectTransition unconditionally and only ask for the
 * current status in the `!transition` branch. Jira workflows offer no self-loop,
 * so an issue ALREADY in the right status matches nothing in tier (a) and fell
 * into tier (c) — which then moved it to a different status in the same
 * category. Every scenario below produced a real, visible status change (with
 * notifications and automation triggers) in a customer's Jira, seconds after a
 * human had put the issue where they wanted it.
 */
describe('jira-echo-status — the issue is already where the bucket wants it', () => {
  it('does NOT transition a Done issue to "Won\u2019t Do" for a done-bucket echo', async () => {
    // The exact production shape: a user drags the issue to Done in Jira → the
    // read-back completes the Native Intelligence action → that emits status_changed → this
    // echo wakes with bucket=done. From Done the workflow offers Won't Do and a
    // reopen, so tier (c) used to pick Won't Do.
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    hoistedApi.getTransitions.mockResolvedValue([T_WONT_DO, T_TODO])
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
    // The link still records the provider state, which is what stops the
    // read-back coming back around.
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: true,
      external_state_label: 'Done',
      last_push_error: null,
    })
  })

  it('does not even ASK for transitions when the current status already satisfies', async () => {
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
  })

  it('honours an EXPLICIT mapping the issue already sits on', async () => {
    // in_progress is mapped to status 2; the action moves between two `started`
    // columns. Tier (a) finds nothing (no self-loop) and tier (c) used to pick
    // In Review — a status nobody selected and the opposite of the mapping.
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      config: { cloud_id: 'cafe0001', status_map: { in_progress: '2' } },
    })
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    hoistedApi.getTransitions.mockResolvedValue([
      { id: '51', name: 'Review', to: { id: '5', name: 'In Review', statusCategory: { key: 'indeterminate' } } },
    ])
    dbFake = makeDb({ links: [OPEN_LINK], category: 'started' }).client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })

  /**
   * The pre-check is a guard, not a mute button: an issue that genuinely
   * disagrees with the bucket still moves.
   *
   * The shape below is a real disagreement — a Native Intelligence action sitting in an
   * unstarted column while its issue is In Progress. It is NOT the shape a Jira
   * REOPEN produces any more: the read-back now lands an `indeterminate` reopen
   * in the team's started state, so the echo it wakes agrees with the issue and
   * fires nothing (jira-loop-termination BRAKE 3 owns that trace end to end).
   */
  it('still moves an issue that genuinely disagrees with the bucket', async () => {
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    hoistedApi.getTransitions.mockResolvedValue([T_TODO, T_DONE])
    dbFake = makeDb({ links: [{ ...OPEN_LINK, completed: true }], category: 'unstarted' }).client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', {
      transition: { id: '11' },
    })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
  })

  /**
   * REGRESSION (round-1 audit, echo group issue 3). A user parks an issue on
   * "Won't Do" in Jira and then moves the Native Intelligence action to a Done column. With
   * the name rule inside this check the echo refused to accept the issue's
   * status, went looking for a transition, and either dragged the issue out of
   * the cancellation the user had just chosen or — with nothing else in the done
   * category reachable — stamped `no_transition` on a healthy link.
   *
   * With N2 landing a Jira cancellation in a Native Intelligence CANCELED state this pairing
   * is rare, but "rare" is not "impossible": the user can still drag the action
   * to Done by hand. The correct answer is to leave the issue alone.
   */
  it('leaves an issue parked on "Won’t Do" alone for a DONE echo', async () => {
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '4', name: "Won't Do", statusCategory: { key: 'done' } } },
    })
    // Nothing else in the done category is reachable — the shape that used to
    // mark the link broken.
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(hoistedApi.getTransitions).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
    // Emphatically NOT a `no_transition` marker on a link that is fine.
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: true,
      external_state_label: "Won't Do",
      last_push_error: null,
    })
  })

  /**
   * REGRESSION (round-1 audit, echo group issue 4 — the idempotency hole).
   * selectTransition legitimately lands a `canceled` echo on a plain "Done" when
   * the workflow offers no cancel-named status (tier c). While this check also
   * enforced the name rule it then REJECTED that landing forever, so every
   * Inngest replay of the single `echo-issues` step re-entered selection and
   * either fired a second transition or marked the link broken.
   */
  it('is IDEMPOTENT for a CANCELED echo that had to settle for plain "Done"', async () => {
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    // No cancel-named status exists, so tier (c) lands on Done.
    hoistedApi.getTransitions.mockResolvedValue([T_TODO, T_DONE])
    dbFake = makeDb({ links: [OPEN_LINK], category: 'canceled' }).client

    const first = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(first).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(1)

    // The replay sees the issue where the first run left it: plain "Done".
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    const replay = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(1)
    expect(replay).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })

  /**
   * REGRESSION (review finding: the single `echo-issues` step is replayed whole
   * by Inngest's `retries: 3`, so links that already succeeded were transitioned
   * AGAIN — to a different same-category status the second time round).
   */
  it('is IDEMPOTENT under a replay: the second run transitions nothing', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO, T_DOING, T_DONE])
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(1)

    // The replay sees the issue where the first run left it.
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(1)
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })
})

// ---- The site a link lives on ----------------------------------------------

/**
 * REGRESSION (review finding: "links carry no site identity, so re-pointing
 * cloud_id makes the sync apply unrelated issues"). Jira issue ids are per-site
 * sequences that every site starts at 10000, so `external_id` alone does not
 * identify an issue — the pair (external_scope, external_id) does.
 */
describe('jira-echo-status — addresses the LINK\u2019s site', () => {
  it('uses external_scope over the destination config\u2019s current cloud_id', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, external_scope: 'cafe0002' }],
      category: 'completed',
    })
    dbFake = db.client

    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0002', '99001', 'status')
    expect(hoistedApi.getTransitions).toHaveBeenCalledWith('tok', 'cafe0002', '99001')
    expect(hoistedApi.transitionIssue).toHaveBeenCalledWith(
      'tok',
      'cafe0002',
      '99001',
      expect.anything(),
    )
  })

  it('falls back to the configured site for a link written before 216', async () => {
    dbFake = makeDb({
      links: [{ ...OPEN_LINK, external_scope: null }],
      category: 'completed',
    }).client

    await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'status')
  })
})

// ---- The no-candidate fork -------------------------------------------------

/**
 * With the current status already ruled out by the pre-check above, "no
 * candidate" now means exactly one thing: unreachable. These tests hold that
 * line — including the shapes that USED to be ambiguous.
 */
describe('jira-echo-status — no candidate transition', () => {
  it('reads the CURRENT status and reports already_synced when it satisfies the bucket', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO]) // nothing reaches done
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalledWith('tok', 'cafe0001', '99001', 'status')
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
    // It still refreshes the recorded state and clears any stale marker.
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      completed: true,
      external_state_label: 'Done',
      last_push_error: null,
    })
  })

  it('honours the EXPLICIT mapping when deciding "already there"', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '3', name: 'Done', statusCategory: { key: 'done' } } },
    })
    hoistedConfig.loadJiraSyncState.mockResolvedValue({
      id: 'tss-1',
      accountId: 'acct-1',
      userId: 'u-1',
      // done is mapped to a DIFFERENT status than the one the issue sits in.
      config: { cloud_id: 'cafe0001', status_map: { done: '9' } },
    })
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'no_transition' }] })
  })

  it('recognises a canceled-by-name status as satisfying the canceled bucket', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '4', name: "Won't Do", statusCategory: { key: 'done' } } },
    })
    dbFake = makeDb({ links: [OPEN_LINK], category: 'canceled' }).client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'already_synced' }] })
  })

  it('stamps no_transition when the target is genuinely unreachable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    hoistedApi.getIssue.mockResolvedValue({
      id: '99001',
      fields: { status: { id: '2', name: 'In Progress', statusCategory: { key: 'indeterminate' } } },
    })
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'no_transition' }] })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
      at: string
    }
    expect(marker.code).toBe('no_transition')
    expect(marker.at).toBeTruthy()
    expect(warn).toHaveBeenCalled()
  })

  it('marks task_missing — NOT a terminal marker — when the status read 404s', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(404, 'gone'))
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'task_missing' }] })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
    }
    expect(marker.code).toBe('task_missing')
  })

  it('rethrows a transient failure on the status probe', async () => {
    hoistedApi.getTransitions.mockResolvedValue([T_TODO])
    hoistedApi.getIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await expect(hoisted.handler({ event: EVENT, step: makeStep() })).rejects.toThrow('unavailable')
  })
})

// ---- 409 + failure markers -------------------------------------------------

describe('jira-echo-status — 409 concurrent transition', () => {
  it('RETRIES a 409 and succeeds on a later attempt', async () => {
    // Atlassian changed concurrent transitions from an inconsistent 400 to a
    // 409 specifically so integrators would retry. A webhook-driven write racing
    // a human in the Jira UI is an ordinary collision.
    hoistedApi.transitionIssue
      .mockRejectedValueOnce(new FakeApiError(409, 'conflict'))
      .mockResolvedValueOnce(undefined)
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(2)
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
  })

  it('gives up after three attempts and marks transition_failed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.transitionIssue.mockRejectedValue(new FakeApiError(409, 'conflict'))
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.transitionIssue).toHaveBeenCalledTimes(3)
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'transition_failed' }] })
  })
})

describe('jira-echo-status — permanent-failure markers', () => {
  it('marks unauthorized and no-ops on a 401 (never throws)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.transitionIssue.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'unauthorized' }] })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
    }
    expect(marker.code).toBe('unauthorized')
  })

  it('marks unauthorized when the TRANSITIONS READ 401s (before any write)', async () => {
    hoistedApi.getTransitions.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'unauthorized' }] })
    expect(hoistedApi.transitionIssue).not.toHaveBeenCalled()
  })

  it('marks task_missing on a 404 from the transitions read', async () => {
    hoistedApi.getTransitions.mockRejectedValue(new FakeApiError(404, 'no issue'))
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'task_missing' }] })
  })

  it('marks transition_failed on a 400 — a validator or an off-screen field', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoistedApi.transitionIssue.mockRejectedValue(
      new FakeApiError(400, "Field 'resolution' cannot be set."),
    )
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'transition_failed' }] })
    const marker = db.updates.find((u) => u.id === 'link-1')?.patch.last_push_error as {
      code: string
    }
    expect(marker.code).toBe('transition_failed')
  })

  it('rethrows a transient 5xx so Inngest retries the whole step', async () => {
    hoistedApi.transitionIssue.mockRejectedValue(new FakeApiError(503, 'unavailable'))
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await expect(hoisted.handler({ event: EVENT, step: makeStep() })).rejects.toThrow('unavailable')
  })

  it('rethrows a transient failure on the transitions read', async () => {
    hoistedApi.getTransitions.mockRejectedValue(new FakeApiError(500, 'boom'))
    dbFake = makeDb({ links: [OPEN_LINK], category: 'completed' }).client

    await expect(hoisted.handler({ event: EVENT, step: makeStep() })).rejects.toThrow('boom')
  })
})

// ---- Stored markers: how the NEXT run treats them --------------------------

describe('jira-echo-status — stored markers on a LATER run', () => {
  it('reads the LINK\u2019s site alongside it (an issue id alone addresses nothing)', async () => {
    const db = makeDb({ links: [OPEN_LINK], category: 'completed' })
    dbFake = db.client
    await hoisted.handler({ event: EVENT, step: makeStep() })

    const linkSelect = db.selects.find((s) => s.table === 'action_external_task')
    expect(linkSelect?.columns).toContain('external_scope')
    expect(linkSelect?.columns).toContain('external_state_label')
  })

  /**
   * REGRESSION (review finding: "Jira 404 means gone OR forbidden, but is
   * stamped as the terminal task_deleted marker"). A marked link used to skip
   * ALL Jira I/O forever, clearable only by an unlink — so one hour of tightened
   * project permissions killed the echo permanently for every link in the
   * workspace, and the only repair was unlinking and re-pushing each action,
   * which mints duplicate issues.
   */
  it('a stored task_missing marker is RETRIED, not skipped', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, last_push_error: { code: 'task_missing', at: 'yesterday' } }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(hoistedApi.getIssue).toHaveBeenCalled()
    expect(hoistedApi.transitionIssue).toHaveBeenCalled()
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
    // …and the stale marker is retired by the success.
    expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
      last_push_error: null,
    })
  })

  const retryable = ['unauthorized', 'no_transition', 'transition_failed', 'task_missing']
  for (const code of retryable) {
    it(`${code} is RETRIED and CLEARED by the next success`, async () => {
      const db = makeDb({
        links: [{ ...OPEN_LINK, last_push_error: { code, at: 'yesterday' } }],
        category: 'completed',
      })
      dbFake = db.client

      const out = await hoisted.handler({ event: EVENT, step: makeStep() })

      expect(hoistedApi.transitionIssue).toHaveBeenCalled()
      expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
      expect(db.updates.find((u) => u.id === 'link-1')?.patch).toMatchObject({
        completed: true,
        last_push_error: null,
      })
    })
  }

  it('ignores a malformed marker rather than wedging the link', async () => {
    const db = makeDb({
      links: [{ ...OPEN_LINK, last_push_error: 'task_missing' }],
      category: 'completed',
    })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ results: [{ linkId: 'link-1', outcome: 'synced' }] })
  })
})
