import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for src/lib/tasks/jira-webhook.ts — the convergent registration
 * lifecycle. Invariants locked in:
 *  - A fresh destination CREATES with the exact registration body read-back
 *    depends on (`project = <id>` JQL, both issue events, a status field
 *    filter) and persists the id + the clock.
 *  - PARTIAL SUCCESS is read: a per-entry `errors` array is a failure even
 *    though the HTTP call returned 200.
 *  - A live, on-project, on-target registration is a no-op — UNTIL it ages past
 *    the 7-day mark, when it is REFRESHED rather than re-created. Atlassian
 *    expires a webhook 30 days after its last refresh regardless of health, so
 *    this is the one convergence rule with no Asana analogue.
 *  - Gone / wrong-project / wrong-target / wrong-events ⇒ CREATE-BEFORE-DELETE:
 *    the old id keeps delivering until the replacement is registered AND
 *    persisted, and only then is it deleted.
 *  - A failure to PERSIST the new id rolls the Jira-side create back, rather
 *    than leaking a registration nothing can refresh, tear down, or even see —
 *    and which holds one of the five slots Atlassian allows.
 *  - Clearing the destination tears the registration down.
 *  - A localhost/http target is a LOGGED no-op, never a create attempt.
 *  - A create failure leaves the columns as they were so the next tick retries.
 *  - Teardown deletes per-SITE: an id alone cannot be deleted anywhere.
 */

const hoisted = vi.hoisted(() => ({
  registerWebhooks: vi.fn(),
  listWebhooks: vi.fn(),
  refreshWebhooks: vi.fn(),
  deleteWebhooks: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  loadJiraWebhookState: vi.fn(),
  saveJiraWebhookRegistration: vi.fn(),
  clearJiraWebhookRegistration: vi.fn(),
  listJiraWebhookRegistrationsForAccount: vi.fn(),
}))

class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'JiraUnauthorizedError'
  }
}

vi.mock('@/lib/integrations/jira-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    registerWebhooks: hoisted.registerWebhooks,
    listWebhooks: hoisted.listWebhooks,
    refreshWebhooks: hoisted.refreshWebhooks,
    deleteWebhooks: hoisted.deleteWebhooks,
    JiraUnauthorizedError: FakeUnauthorized,
  }
})
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))
vi.mock('@/lib/tasks/jira-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadJiraWebhookState: hoisted.loadJiraWebhookState,
    saveJiraWebhookRegistration: hoisted.saveJiraWebhookRegistration,
    clearJiraWebhookRegistration: hoisted.clearJiraWebhookRegistration,
    listJiraWebhookRegistrationsForAccount: hoisted.listJiraWebhookRegistrationsForAccount,
  }
})

const {
  ensureJiraWebhook,
  isReachableTarget,
  jiraWebhookPath,
  jiraWebhookJql,
  retireJiraWebhook,
  tearDownJiraWebhooksForAccount,
  WEBHOOK_REFRESH_AFTER_MS,
} = await import('@/lib/tasks/jira-webhook')

/** Relative order of two mocks' calls, by vitest's global invocation counter. */
function calledBefore(
  first: { mock: { invocationCallOrder: number[] } },
  second: { mock: { invocationCallOrder: number[] } },
): boolean {
  const a = first.mock.invocationCallOrder[0]
  const b = second.mock.invocationCallOrder[0]
  return typeof a === 'number' && typeof b === 'number' && a < b
}

const SYNC_STATE_ID = 'tss-1'
const CLOUD = 'cafe0001'
const TARGET = 'https://nativeintelligence.dev/api/webhooks/jira'

/** Just-registered — well inside the refresh window. */
const FRESH = new Date(Date.now() - 60 * 60 * 1000).toISOString()
/** Older than the 7-day cadence. */
const STALE_CLOCK = new Date(Date.now() - WEBHOOK_REFRESH_AFTER_MS - 60_000).toISOString()

const STATE = {
  id: SYNC_STATE_ID,
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  userId: 'u-1',
  webhookId: null as string | null,
  webhookRegisteredAt: null as string | null,
  cloudId: CLOUD as string | null,
  projectId: '10000' as string | null,
}

/** A live registration exactly as we would register it today. */
const LIVE = {
  id: 5000,
  url: TARGET,
  events: ['jira:issue_updated', 'jira:issue_deleted'],
  jqlFilter: 'project = 10000',
  fieldIdsFilter: ['status'],
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://nativeintelligence.dev')
  vi.stubEnv('JIRA_ALLOW_INSECURE_WEBHOOK_TARGET', '')
  hoisted.loadJiraWebhookState.mockResolvedValue({ ...STATE })
  hoisted.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoisted.registerWebhooks.mockResolvedValue([{ createdWebhookId: 6000 }])
  hoisted.listWebhooks.mockResolvedValue({ webhooks: [], isLast: true, nextStartAt: null })
  hoisted.refreshWebhooks.mockResolvedValue({ expirationDate: Date.now() + 30 * 86400_000 })
  hoisted.deleteWebhooks.mockResolvedValue(undefined)
  hoisted.saveJiraWebhookRegistration.mockResolvedValue({ error: null })
  hoisted.clearJiraWebhookRegistration.mockResolvedValue({ error: null })
  hoisted.listJiraWebhookRegistrationsForAccount.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---- Target reachability ---------------------------------------------------

describe('isReachableTarget', () => {
  it('accepts a public https origin (including tunnels)', () => {
    expect(isReachableTarget('https://nativeintelligence.dev/api/webhooks/jira')).toBe(true)
    expect(isReachableTarget('https://abc123.ngrok.app/api/webhooks/jira')).toBe(true)
  })

  it('rejects localhost and plain http — Jira calls from its own infra', () => {
    expect(isReachableTarget('http://localhost:3000/api/webhooks/jira')).toBe(false)
    expect(isReachableTarget('https://localhost:3000/api/webhooks/jira')).toBe(false)
    expect(isReachableTarget('https://127.0.0.1/api/webhooks/jira')).toBe(false)
    expect(isReachableTarget('http://nativeintelligence.dev/api/webhooks/jira')).toBe(false)
    expect(isReachableTarget('not a url')).toBe(false)
  })

  it('honours the explicit escape hatch', () => {
    vi.stubEnv('JIRA_ALLOW_INSECURE_WEBHOOK_TARGET', 'true')
    expect(isReachableTarget('http://localhost:3000/x')).toBe(true)
  })
})

describe('the delivery target', () => {
  it('is ONE global path — Atlassian allows a single URL per app', () => {
    // Deliberately no sync-state segment: the registration schema says "only a
    // single URL per app is allowed to be registered", so a per-tenant receiver
    // path is not expressible and the read-back routes by issue id instead.
    expect(jiraWebhookPath()).toBe('/api/webhooks/jira')
  })

  it('filters on the project ID, not its key (an admin can rename a key)', () => {
    expect(jiraWebhookJql('10000')).toBe('project = 10000')
  })

  /**
   * REGRESSION (review finding: "project_id is stored unvalidated and
   * interpolated straight into the webhook's JQL filter"). There is no escaping
   * available here — the value goes into a query Atlassian parses — and
   * `project = 10000 OR assignee != null` is INSIDE the restricted subset
   * webhooks accept, so it registers cleanly and then turns a whole Jira site
   * into a firehose at the global receiver. `isHealthy` compares the stored
   * filter for equality, so it would read as healthy forever.
   */
  it('REFUSES to build a filter from a non-numeric project id', () => {
    expect(() => jiraWebhookJql('10000 OR assignee != null')).toThrow(
      /Invalid Jira projectId/,
    )
    expect(() => jiraWebhookJql('')).toThrow()
  })
})

describe('ensureJiraWebhook — a stored project id that is not an Atlassian id', () => {
  it('refuses to register rather than widening the filter', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      projectId: '10000 OR assignee != null',
    })

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toEqual({ status: 'invalid_project' })
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

/**
 * REGRESSION (review finding: "changing the Jira site … webhook left on the old
 * site"). `DELETE /webhook` is addressed to a SITE, so a registration is only
 * reachable through the cloudId it was created on. Once the destination has
 * moved, ensureJiraWebhook's own cleanup would fire the delete at the NEW
 * tenant, where the id means nothing — leaving the old site delivering, and
 * holding one of its five slots, for up to 30 days.
 */
describe('retireJiraWebhook — deleting on a site we no longer point at', () => {
  it('deletes against the site it is GIVEN, not the current config', async () => {
    // The stored config has already moved on to CLOUD.
    const result = await retireJiraWebhook({
      syncStateId: SYNC_STATE_ID,
      webhookId: '5000',
      cloudId: 'cafe0002',
    })

    expect(result).toEqual({ status: 'retired' })
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', 'cafe0002', [5000])
  })

  it('is a no-op without a usable id or site', async () => {
    expect(
      await retireJiraWebhook({ syncStateId: SYNC_STATE_ID, webhookId: 'abc', cloudId: 'cafe0002' }),
    ).toEqual({ status: 'skipped' })
    expect(
      await retireJiraWebhook({ syncStateId: SYNC_STATE_ID, webhookId: '5000', cloudId: '' }),
    ).toEqual({ status: 'skipped' })
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('NEVER throws — a tidy-up must not fail the settings change that caused it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hoisted.getValidTokenForAccount.mockRejectedValue(new Error('token service down'))

    expect(
      await retireJiraWebhook({
        syncStateId: SYNC_STATE_ID,
        webhookId: '5000',
        cloudId: 'cafe0002',
      }),
    ).toEqual({ status: 'skipped' })
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---- Create ----------------------------------------------------------------

describe('ensureJiraWebhook — fresh registration', () => {
  it('registers with the body read-back depends on, and persists the id', async () => {
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'created', webhookId: '6000' })
    expect(hoisted.registerWebhooks).toHaveBeenCalledWith('tok', CLOUD, {
      url: TARGET,
      webhooks: [
        {
          events: ['jira:issue_updated', 'jira:issue_deleted'],
          jqlFilter: 'project = 10000',
          fieldIdsFilter: ['status'],
        },
      ],
    })
    // Stored as TEXT (the column is shared with Asana's string gids).
    expect(hoisted.saveJiraWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID, '6000')
  })

  it('does not list anything when there is no stored registration', async () => {
    await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(hoisted.listWebhooks).not.toHaveBeenCalled()
  })

  it('reads PARTIAL FAILURE out of a 200 response', async () => {
    // The documented shape: one result per requested webhook, each carrying
    // either an id or its own errors. A 200 says nothing about either.
    hoisted.registerWebhooks.mockResolvedValue([
      { errors: ['The clause myClause is unsupported'] },
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.saveJiraWebhookRegistration).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports create_failed when the result carries no id at all', async () => {
    hoisted.registerWebhooks.mockResolvedValue([{}])
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.saveJiraWebhookRegistration).not.toHaveBeenCalled()
  })

  it('ROLLS BACK the Jira create when the id cannot be persisted', async () => {
    // Registered on Atlassian's side but unrecorded here: nothing would ever
    // refresh it (so it dies in 30 days), nothing could tear it down, and it
    // holds one of five slots meanwhile.
    hoisted.saveJiraWebhookRegistration.mockResolvedValue({ error: 'db down' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', CLOUD, [6000])
    warn.mockRestore()
  })

  it('leaves the columns alone when the create throws (the cron retries)', async () => {
    hoisted.registerWebhooks.mockRejectedValue(new Error('project archived'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.saveJiraWebhookRegistration).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports unauthorized (not a throw) when the token is rejected on create', async () => {
    hoisted.registerWebhooks.mockRejectedValue(new FakeUnauthorized())
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'unauthorized' })
  })

  it('is a LOGGED no-op against a localhost app URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'insecure_target' })
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---- Health check + expiry -------------------------------------------------

describe('ensureJiraWebhook — existing registration', () => {
  beforeEach(() => {
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      webhookRegisteredAt: FRESH,
    })
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [LIVE],
      isLast: true,
      nextStartAt: null,
    })
  })

  it('no-ops when the registration is live, on-project, on-target and fresh', async () => {
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'healthy', webhookId: '5000' })
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    expect(hoisted.refreshWebhooks).not.toHaveBeenCalled()
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('REFRESHES a healthy registration once it ages past the cadence', async () => {
    // The rule with no Asana analogue: a Jira webhook expires 30 days after its
    // last create/refresh no matter how healthy it is, and goes silent with
    // nothing surfacing. Re-registering instead would churn the id and burn a
    // slot for no reason.
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      webhookRegisteredAt: STALE_CLOCK,
    })

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'refreshed', webhookId: '5000' })
    expect(hoisted.refreshWebhooks).toHaveBeenCalledWith('tok', CLOUD, [5000])
    // Same id, new clock — nothing re-registered, nothing deleted.
    expect(hoisted.saveJiraWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID, '5000')
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('refreshes a registration whose clock was never stamped', async () => {
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      webhookRegisteredAt: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'refreshed' })
  })

  it('reports HEALTHY when a due refresh fails — ~23 days of slack remain', async () => {
    // Re-registering on a transient refresh failure would burn a cap slot to
    // solve a problem that isn't urgent for three more weeks.
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      webhookRegisteredAt: STALE_CLOCK,
    })
    hoisted.refreshWebhooks.mockRejectedValue(new Error('jira 500'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'healthy', webhookId: '5000' })
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('reports unauthorized when the refresh is rejected', async () => {
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      webhookRegisteredAt: STALE_CLOCK,
    })
    hoisted.refreshWebhooks.mockRejectedValue(new FakeUnauthorized())
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'unauthorized' })
  })

  it('re-creates when Jira no longer lists the registration', async () => {
    hoisted.listWebhooks.mockResolvedValue({ webhooks: [], isLast: true, nextStartAt: null })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookId: '6000' })
    expect(hoisted.registerWebhooks).toHaveBeenCalled()
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', CLOUD, [5000])
    // The columns are NEVER nulled on a re-point — the old registration keeps
    // delivering until the replacement is persisted.
    expect(hoisted.clearJiraWebhookRegistration).not.toHaveBeenCalled()
  })

  it('walks pages of GET /webhook looking for the stored id', async () => {
    hoisted.listWebhooks
      .mockResolvedValueOnce({
        webhooks: [{ ...LIVE, id: 4999 }],
        isLast: false,
        nextStartAt: 1,
      })
      .mockResolvedValueOnce({ webhooks: [LIVE], isLast: true, nextStartAt: null })

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'healthy' })
    expect(hoisted.listWebhooks).toHaveBeenNthCalledWith(2, 'tok', CLOUD, { startAt: 1 })
  })

  it('REGRESSION: re-registration is CREATE → SAVE → DELETE-OLD, in that order', async () => {
    // Delete-first drops coverage for the width of the swap, and a change made
    // in that gap is never re-sent — a 3LO app cannot even query Atlassian for
    // what it missed (`GET /webhook/failed` is Connect-only).
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, jqlFilter: 'project = 99999' }],
      isLast: true,
      nextStartAt: null,
    })

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookId: '6000' })
    expect(calledBefore(hoisted.registerWebhooks, hoisted.saveJiraWebhookRegistration)).toBe(true)
    expect(calledBefore(hoisted.saveJiraWebhookRegistration, hoisted.deleteWebhooks)).toBe(true)
    // …and the ONLY delete is the old registration, issued last.
    expect(hoisted.deleteWebhooks).toHaveBeenCalledTimes(1)
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', CLOUD, [5000])
  })

  it('keeps the OLD registration when the replacement create fails', async () => {
    hoisted.listWebhooks.mockResolvedValue({ webhooks: [], isLast: true, nextStartAt: null })
    hoisted.registerWebhooks.mockRejectedValue(new Error('project archived'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
    expect(hoisted.clearJiraWebhookRegistration).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('REGRESSION: a failed delete-old leaves the NEW registration intact', async () => {
    // The replacement is already live and persisted, so a failure tidying up
    // must not report create_failed — that would send the next tick round to
    // replace a perfectly good webhook.
    hoisted.listWebhooks.mockResolvedValue({ webhooks: [], isLast: true, nextStartAt: null })
    hoisted.deleteWebhooks.mockRejectedValue(new Error('jira 500'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookId: '6000' })
    expect(hoisted.saveJiraWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID, '6000')
    warn.mockRestore()
  })

  it('re-points when the destination moved to a DIFFERENT project', async () => {
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, jqlFilter: 'project = 99999' }],
      isLast: true,
      nextStartAt: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated' })
    expect(hoisted.registerWebhooks).toHaveBeenCalledWith(
      'tok',
      CLOUD,
      expect.objectContaining({
        webhooks: [expect.objectContaining({ jqlFilter: 'project = 10000' })],
      }),
    )
  })

  it('re-points when the url no longer matches our receiver path', async () => {
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, url: 'https://old.example.com/api/webhooks/asana/x' }],
      isLast: true,
      nextStartAt: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'recreated' })
  })

  /**
   * REGRESSION (review finding: "webhook health check compares only the URL
   * suffix, so a changed app origin is never detected"). This test used to
   * assert the OPPOSITE — that a different host is fine "as long as the path
   * matches" — which is only true when the path identifies the destination. It
   * does for Asana (the path embeds a unique syncStateId); for Jira the path is
   * a global constant, so every stale origin satisfies a suffix test. The result
   * was a registration reported `healthy` in every log line, refreshed every 7
   * days so it never even expired, delivering to a domain we no longer run.
   */
  it('RE-REGISTERS a url on a different host — the origin is part of the target', async () => {
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, url: 'https://preview.nativeintelligence.dev/api/webhooks/jira' }],
      isLast: true,
      nextStartAt: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated' })
    expect(hoisted.registerWebhooks).toHaveBeenCalledWith(
      'tok',
      CLOUD,
      expect.objectContaining({ url: TARGET }),
    )
    // Create-before-delete still holds for this case.
    expect(calledBefore(hoisted.registerWebhooks, hoisted.deleteWebhooks)).toBe(true)
  })

  it('is healthy only for the EXACT url we would register today', async () => {
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, url: `${TARGET}/` }],
      isLast: true,
      nextStartAt: null,
    })
    expect(await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })).toMatchObject({
      status: 'recreated',
    })
  })

  it('re-registers a subscription that lost the DELETED event', async () => {
    // An older registration (or a hand-edited one) that only watches updates
    // would silently never notice a deleted issue.
    hoisted.listWebhooks.mockResolvedValue({
      webhooks: [{ ...LIVE, events: ['jira:issue_updated'] }],
      isLast: true,
      nextStartAt: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'recreated' })
  })

  it('reports unauthorized when the liveness LIST is rejected', async () => {
    hoisted.listWebhooks.mockRejectedValue(new FakeUnauthorized())
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'unauthorized' })
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('propagates a transient liveness failure', async () => {
    hoisted.listWebhooks.mockRejectedValue(new Error('gateway'))
    await expect(ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })).rejects.toThrow('gateway')
  })
})

// ---- Teardown + gates ------------------------------------------------------

describe('ensureJiraWebhook — teardown and gates', () => {
  it('tears the registration down when the destination is cleared', async () => {
    hoisted.loadJiraWebhookState.mockResolvedValue({
      ...STATE,
      webhookId: '5000',
      projectId: null,
    })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'torn_down' })
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', CLOUD, [5000])
    expect(hoisted.clearJiraWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID)
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
  })

  it('no-ops for an unconfigured, unregistered state', async () => {
    hoisted.loadJiraWebhookState.mockResolvedValue({ ...STATE, projectId: null })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_project' })
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('never tries to register without a site — there is no URL to call', async () => {
    // Unlike Asana, the cloudId is part of the API ADDRESS: a project without a
    // site cannot be registered, listed or deleted.
    hoisted.loadJiraWebhookState.mockResolvedValue({ ...STATE, cloudId: null })
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_project' })
    expect(hoisted.registerWebhooks).not.toHaveBeenCalled()
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('no-ops for a missing sync state', async () => {
    hoisted.loadJiraWebhookState.mockResolvedValue(null)
    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_sync_state' })
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('leaves an existing registration ALONE when no token can be minted', async () => {
    // Tearing down on a token blip would lose deliveries a reconnect keeps.
    hoisted.loadJiraWebhookState.mockResolvedValue({ ...STATE, webhookId: '5000' })
    hoisted.getValidTokenForAccount.mockResolvedValue(null)

    const result = await ensureJiraWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_token' })
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
    expect(hoisted.clearJiraWebhookRegistration).not.toHaveBeenCalled()
  })
})

// ---- Disconnect teardown ---------------------------------------------------

describe('tearDownJiraWebhooksForAccount', () => {
  it('deletes each registration AGAINST ITS OWN SITE', async () => {
    // The delete is addressed to a site; an id alone cannot be deleted anywhere,
    // which is the one place Asana's flat gid list does not carry over.
    hoisted.listJiraWebhookRegistrationsForAccount.mockResolvedValue([
      { webhookId: '5000', cloudId: 'cafe000a' },
      { webhookId: '5001', cloudId: 'cafe000b' },
    ])

    await tearDownJiraWebhooksForAccount('acct-1')

    expect(hoisted.listJiraWebhookRegistrationsForAccount).toHaveBeenCalledWith('acct-1')
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', 'cafe000a', [5000])
    expect(hoisted.deleteWebhooks).toHaveBeenCalledWith('tok', 'cafe000b', [5001])
  })

  it('skips a registration whose site is unknown rather than guessing one', async () => {
    hoisted.listJiraWebhookRegistrationsForAccount.mockResolvedValue([
      { webhookId: '5000', cloudId: null },
    ])
    await tearDownJiraWebhooksForAccount('acct-1')
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('does not mint a token when nothing is registered', async () => {
    hoisted.listJiraWebhookRegistrationsForAccount.mockResolvedValue([])
    await tearDownJiraWebhooksForAccount('acct-1')
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('gives up quietly when the account has no usable token', async () => {
    hoisted.listJiraWebhookRegistrationsForAccount.mockResolvedValue([
      { webhookId: '5000', cloudId: CLOUD },
    ])
    hoisted.getValidTokenForAccount.mockResolvedValue(null)
    await expect(tearDownJiraWebhooksForAccount('acct-1')).resolves.toBeUndefined()
    expect(hoisted.deleteWebhooks).not.toHaveBeenCalled()
  })

  it('NEVER throws — a disconnect must not fail on a tidy-up', async () => {
    hoisted.listJiraWebhookRegistrationsForAccount.mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(tearDownJiraWebhooksForAccount('acct-1')).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
