import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

/**
 * Tests for src/lib/tasks/asana-webhook.ts — the convergent registration
 * lifecycle. Invariants locked in:
 *  - A fresh destination OPENS the handshake window, then CREATES and persists
 *    the gid. The secret is NOT written here (the receiver's handshake CAS owns
 *    it) and registered_at is stamped alongside the gid.
 *  - An alive registration that matches the configured project AND our receiver
 *    path is a pure no-op — one cheap GET, nothing else.
 *  - Dead / missing / wrong-project / wrong-target ⇒ CREATE-BEFORE-DELETE: the
 *    old gid+secret stay live and verifying until the replacement is registered
 *    AND persisted, and only then is the old webhook deleted. Deleting first
 *    would drop coverage for the width of the re-registration, and Asana
 *    deliveries are at-most-once — anything lost in that gap is lost for good.
 *  - A failure to PERSIST the new gid rolls the Asana-side create back, rather
 *    than leaking a webhook nothing can verify or tear down.
 *  - Clearing the destination tears the registration down.
 *  - A localhost/http target is a LOGGED no-op, never a create attempt: Asana
 *    can't reach it, so retrying every cron tick forever is the only alternative.
 *  - A create failure leaves the columns as they were so the next tick retries.
 */

const hoisted = vi.hoisted(() => ({
  createWebhook: vi.fn(),
  getWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
  getValidTokenForAccount: vi.fn(),
  loadAsanaWebhookAuth: vi.fn(),
  saveAsanaWebhookRegistration: vi.fn(),
  clearAsanaWebhookRegistration: vi.fn(),
  openAsanaWebhookPending: vi.fn(),
  listAsanaWebhookGidsForAccount: vi.fn(),
}))

class FakeUnauthorized extends Error {
  constructor() {
    super('401')
    this.name = 'AsanaUnauthorizedError'
  }
}

vi.mock('@/lib/integrations/asana-api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    createWebhook: hoisted.createWebhook,
    getWebhook: hoisted.getWebhook,
    deleteWebhook: hoisted.deleteWebhook,
    AsanaUnauthorizedError: FakeUnauthorized,
  }
})
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoisted.getValidTokenForAccount,
}))
vi.mock('@/lib/tasks/asana-config', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>
  return {
    ...actual,
    loadAsanaWebhookAuth: hoisted.loadAsanaWebhookAuth,
    saveAsanaWebhookRegistration: hoisted.saveAsanaWebhookRegistration,
    clearAsanaWebhookRegistration: hoisted.clearAsanaWebhookRegistration,
    openAsanaWebhookPending: hoisted.openAsanaWebhookPending,
    listAsanaWebhookGidsForAccount: hoisted.listAsanaWebhookGidsForAccount,
  }
})

const { ensureAsanaWebhook, isReachableTarget, asanaWebhookPath, tearDownAsanaWebhooksForAccount } =
  await import('@/lib/tasks/asana-webhook')

/** Relative order of two mocks' calls, by vitest's global invocation counter. */
function calledBefore(first: { mock: { invocationCallOrder: number[] } }, second: {
  mock: { invocationCallOrder: number[] }
}): boolean {
  const a = first.mock.invocationCallOrder[0]
  const b = second.mock.invocationCallOrder[0]
  return typeof a === 'number' && typeof b === 'number' && a < b
}

const SYNC_STATE_ID = 'tss-1'
const TARGET = `https://dial8.ai/api/webhooks/asana/${SYNC_STATE_ID}`

const STATE = {
  id: SYNC_STATE_ID,
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  userId: 'u-1',
  webhookGid: null as string | null,
  webhookSecret: null as string | null,
  projectGid: 'proj-1' as string | null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', 'https://dial8.ai')
  vi.stubEnv('ASANA_ALLOW_INSECURE_WEBHOOK_TARGET', '')
  hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...STATE })
  hoisted.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoisted.createWebhook.mockResolvedValue({ gid: 'wh-new', active: true })
  hoisted.deleteWebhook.mockResolvedValue(undefined)
  hoisted.saveAsanaWebhookRegistration.mockResolvedValue({ error: null })
  hoisted.clearAsanaWebhookRegistration.mockResolvedValue({ error: null })
  hoisted.openAsanaWebhookPending.mockResolvedValue({ error: null })
  hoisted.listAsanaWebhookGidsForAccount.mockResolvedValue([])
})

afterEach(() => {
  vi.unstubAllEnvs()
})

// ---- Target reachability ---------------------------------------------------

describe('isReachableTarget', () => {
  it('accepts a public https origin (including tunnels)', () => {
    expect(isReachableTarget('https://dial8.ai/api/webhooks/asana/x')).toBe(true)
    expect(isReachableTarget('https://abc123.ngrok.app/api/webhooks/asana/x')).toBe(true)
  })

  it('rejects localhost and plain http — Asana calls from its own infra', () => {
    expect(isReachableTarget('http://localhost:3000/api/webhooks/asana/x')).toBe(false)
    expect(isReachableTarget('https://localhost:3000/api/webhooks/asana/x')).toBe(false)
    expect(isReachableTarget('https://127.0.0.1/api/webhooks/asana/x')).toBe(false)
    expect(isReachableTarget('http://dial8.ai/api/webhooks/asana/x')).toBe(false)
    expect(isReachableTarget('not a url')).toBe(false)
  })

  it('honours the explicit escape hatch', () => {
    vi.stubEnv('ASANA_ALLOW_INSECURE_WEBHOOK_TARGET', 'true')
    expect(isReachableTarget('http://localhost:3000/x')).toBe(true)
  })
})

// ---- Create ----------------------------------------------------------------

describe('ensureAsanaWebhook — fresh registration', () => {
  it('creates the webhook and persists ONLY the gid (the secret is the receiver\'s)', async () => {
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'created', webhookGid: 'wh-new' })
    expect(hoisted.createWebhook).toHaveBeenCalledWith('tok', {
      resource: 'proj-1',
      target: TARGET,
      filters: [{ resource_type: 'task', action: 'changed', fields: ['completed'] }],
    })
    expect(hoisted.saveAsanaWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID, 'wh-new')
    expect(hoisted.getWebhook).not.toHaveBeenCalled()
  })

  it('OPENS the handshake window before creating — the receiver has nothing to claim otherwise', async () => {
    await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(hoisted.openAsanaWebhookPending).toHaveBeenCalledWith(SYNC_STATE_ID)
    expect(calledBefore(hoisted.openAsanaWebhookPending, hoisted.createWebhook)).toBe(true)
  })

  it('does NOT open a window for an unreachable target (nothing will handshake)', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(hoisted.openAsanaWebhookPending).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('ROLLS BACK the Asana create when the gid cannot be persisted', async () => {
    // Registered on Asana's side but unrecorded here: nothing would ever verify
    // its deliveries (the receiver requires a gid) or tear it down. Undo it and
    // let the next cron tick retry from a clean state.
    hoisted.saveAsanaWebhookRegistration.mockResolvedValue({ error: 'db down' })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-new')
    warn.mockRestore()
  })

  it('targets the one receiver path shape', () => {
    expect(asanaWebhookPath(SYNC_STATE_ID)).toBe(`/api/webhooks/asana/${SYNC_STATE_ID}`)
  })

  it('leaves the columns null when the create fails (the cron retries)', async () => {
    hoisted.createWebhook.mockRejectedValue(new Error('project archived'))
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.saveAsanaWebhookRegistration).not.toHaveBeenCalled()
  })

  it('reports create_failed when Asana returns no gid', async () => {
    hoisted.createWebhook.mockResolvedValue({})
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.saveAsanaWebhookRegistration).not.toHaveBeenCalled()
  })

  it('reports unauthorized (not a throw) when the token is rejected on create', async () => {
    hoisted.createWebhook.mockRejectedValue(new FakeUnauthorized())
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'unauthorized' })
  })

  it('is a LOGGED no-op against a localhost app URL', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', 'http://localhost:3000')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'insecure_target' })
    expect(hoisted.createWebhook).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

// ---- Health check ----------------------------------------------------------

describe('ensureAsanaWebhook — existing registration', () => {
  const alive = {
    gid: 'wh-1',
    active: true,
    resource: { gid: 'proj-1', resource_type: 'project' },
    target: TARGET,
  }

  beforeEach(() => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...STATE, webhookGid: 'wh-1' })
  })

  it('no-ops when the registration is alive, on-project and on-target', async () => {
    hoisted.getWebhook.mockResolvedValue(alive)
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'healthy', webhookGid: 'wh-1' })
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
    expect(hoisted.createWebhook).not.toHaveBeenCalled()
    expect(hoisted.clearAsanaWebhookRegistration).not.toHaveBeenCalled()
  })

  it('re-creates when Asana no longer has the webhook (404 → null)', async () => {
    hoisted.getWebhook.mockResolvedValue(null)
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookGid: 'wh-new' })
    expect(hoisted.createWebhook).toHaveBeenCalled()
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
    // The columns are NEVER nulled on a re-point: the old secret has to stay
    // valid until the new handshake swaps it, or deliveries arriving mid-swap
    // have no key to verify against.
    expect(hoisted.clearAsanaWebhookRegistration).not.toHaveBeenCalled()
  })

  it('REGRESSION: re-registration is CREATE → SAVE → DELETE-OLD, in that order', async () => {
    // Delete-first drops coverage for the entire width of the re-registration,
    // and Asana delivery is at-most-once: every completion toggled in that gap
    // is lost with no way to notice. Keeping the old gid+secret live until the
    // replacement is registered AND persisted is the whole point of the order.
    hoisted.getWebhook.mockResolvedValue({ ...alive, resource: { gid: 'proj-OLD' } })

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookGid: 'wh-new' })
    expect(calledBefore(hoisted.openAsanaWebhookPending, hoisted.createWebhook)).toBe(true)
    expect(calledBefore(hoisted.createWebhook, hoisted.saveAsanaWebhookRegistration)).toBe(true)
    expect(calledBefore(hoisted.saveAsanaWebhookRegistration, hoisted.deleteWebhook)).toBe(true)
    // …and the ONLY delete is the old registration, issued last.
    expect(hoisted.deleteWebhook).toHaveBeenCalledTimes(1)
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
  })

  it('keeps the OLD registration when the replacement create fails', async () => {
    // Nothing was torn down, so the workspace is still covered by the (stale but
    // live) webhook until a later tick manages to replace it.
    hoisted.getWebhook.mockResolvedValue(null)
    hoisted.createWebhook.mockRejectedValue(new Error('project archived'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'create_failed' })
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
    expect(hoisted.clearAsanaWebhookRegistration).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('REGRESSION: a failed delete-old leaves the NEW registration intact', async () => {
    // The crash-between case. The replacement is already live and persisted, so
    // a failure tidying up the old one must not be reported as create_failed —
    // that would send the next tick round to replace a perfectly good webhook.
    // (The orphan is inert anyway: its secret was swapped, so its deliveries
    // 401 and Asana deletes it after 24h.)
    hoisted.getWebhook.mockResolvedValue(null)
    hoisted.deleteWebhook.mockRejectedValue(new Error('asana 500'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated', webhookGid: 'wh-new' })
    expect(hoisted.saveAsanaWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID, 'wh-new')
    warn.mockRestore()
  })

  it('re-creates when the registration is INACTIVE', async () => {
    hoisted.getWebhook.mockResolvedValue({ ...alive, active: false })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'recreated' })
  })

  it('re-points when the destination moved to a DIFFERENT project', async () => {
    hoisted.getWebhook.mockResolvedValue({ ...alive, resource: { gid: 'proj-OLD' } })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'recreated' })
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
    expect(hoisted.createWebhook).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ resource: 'proj-1' }),
    )
  })

  it('re-points when the target no longer matches our receiver path', async () => {
    // e.g. the app moved domains, or the registration was made for another
    // sync state id.
    hoisted.getWebhook.mockResolvedValue({
      ...alive,
      target: 'https://old.example.com/api/webhooks/asana/tss-OTHER',
    })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'recreated' })
  })

  it('accepts a target on a different host as long as the path matches', async () => {
    // A preview/tunnel domain still delivers to the right sync state.
    hoisted.getWebhook.mockResolvedValue({
      ...alive,
      target: `https://preview.dial8.ai${asanaWebhookPath(SYNC_STATE_ID)}`,
    })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'healthy' })
  })

  it('reports unauthorized when the liveness GET is rejected', async () => {
    hoisted.getWebhook.mockRejectedValue(new FakeUnauthorized())
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'unauthorized' })
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
  })

  it('propagates a transient liveness failure', async () => {
    hoisted.getWebhook.mockRejectedValue(new Error('gateway'))
    await expect(ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })).rejects.toThrow('gateway')
  })
})

// ---- Teardown + gates ------------------------------------------------------

describe('ensureAsanaWebhook — teardown and gates', () => {
  it('tears the registration down when the destination is cleared', async () => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({
      ...STATE,
      webhookGid: 'wh-1',
      projectGid: null,
    })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })

    expect(result).toMatchObject({ status: 'torn_down' })
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
    expect(hoisted.clearAsanaWebhookRegistration).toHaveBeenCalledWith(SYNC_STATE_ID)
    expect(hoisted.createWebhook).not.toHaveBeenCalled()
  })

  it('no-ops for an unconfigured, unregistered state', async () => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...STATE, projectGid: null })
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_project' })
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
  })

  it('no-ops for a missing sync state', async () => {
    hoisted.loadAsanaWebhookAuth.mockResolvedValue(null)
    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_sync_state' })
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
  })

  it('leaves an existing registration ALONE when no token can be minted', async () => {
    // Tearing down on a token blip would lose deliveries a reconnect keeps.
    hoisted.loadAsanaWebhookAuth.mockResolvedValue({ ...STATE, webhookGid: 'wh-1' })
    hoisted.getValidTokenForAccount.mockResolvedValue(null)

    const result = await ensureAsanaWebhook({ syncStateId: SYNC_STATE_ID })
    expect(result).toMatchObject({ status: 'no_token' })
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
    expect(hoisted.clearAsanaWebhookRegistration).not.toHaveBeenCalled()
  })
})

// ---- Disconnect teardown ---------------------------------------------------

describe('tearDownAsanaWebhooksForAccount', () => {
  it('deletes every registered webhook for the account', async () => {
    hoisted.listAsanaWebhookGidsForAccount.mockResolvedValue(['wh-1', 'wh-2'])

    await tearDownAsanaWebhooksForAccount('acct-1')

    expect(hoisted.listAsanaWebhookGidsForAccount).toHaveBeenCalledWith('acct-1')
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-1')
    expect(hoisted.deleteWebhook).toHaveBeenCalledWith('tok', 'wh-2')
  })

  it('does not mint a token when nothing is registered', async () => {
    hoisted.listAsanaWebhookGidsForAccount.mockResolvedValue([])
    await tearDownAsanaWebhooksForAccount('acct-1')
    expect(hoisted.getValidTokenForAccount).not.toHaveBeenCalled()
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
  })

  it('gives up quietly when the account has no usable token', async () => {
    hoisted.listAsanaWebhookGidsForAccount.mockResolvedValue(['wh-1'])
    hoisted.getValidTokenForAccount.mockResolvedValue(null)
    await expect(tearDownAsanaWebhooksForAccount('acct-1')).resolves.toBeUndefined()
    expect(hoisted.deleteWebhook).not.toHaveBeenCalled()
  })

  it('NEVER throws — a disconnect must not fail on a tidy-up', async () => {
    hoisted.listAsanaWebhookGidsForAccount.mockRejectedValue(new Error('db down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await expect(tearDownAsanaWebhooksForAccount('acct-1')).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
