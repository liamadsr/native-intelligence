import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/hubspot-push-contact.ts via the createFunction-
 * capture pattern (canonical: capture-ingest.test.ts / hubspot-log-capture.test.ts).
 *
 * Invariants locked in:
 *  - flag off (or absent) → no-op, no search, no create, no local write.
 *  - SCOPE 'manual' (default): only source='manual' is eligible; every auto-
 *    extracted source no-ops ('not_manual').
 *  - SCOPE 'all': any source EXCEPT 'member' is eligible (auto-extracted sources
 *    now push); a 'member' contact still no-ops ('member_excluded').
 *  - contact otherwise ineligible → no-op: merged tombstone, already provider-
 *    linked, or no email.
 *  - no connected HubSpot account for the workspace → no-op.
 *  - no valid token → no-op (never throw-forever).
 *  - dedupe: an existing HubSpot contact for the email is CLAIMED (local row
 *    stamped source_provider='hubspot' + provider_contact_id) WITHOUT a create.
 *  - happy path: no existing → create → persist the returned HubSpot id, source
 *    stays 'manual'.
 *  - 409 (email exists race) → re-search once and claim.
 *  - 401 (token predates contacts.write) → no-op, NOT a throw/retry.
 *  - non-401 error → rethrow so Inngest retries.
 */

// ---- Hoisted capture of the inngest function ------------------------------

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
vi.mock('@/lib/admin', () => ({
  getServiceClient: () => dbFake,
}))

const hoistedToken = vi.hoisted(() => ({
  getValidTokenForAccount: vi.fn(),
}))
vi.mock('@/lib/oauth/token-manager', () => ({
  getValidTokenForAccount: hoistedToken.getValidTokenForAccount,
}))

// HubSpot API — search/create/archive stubs + real error classes so the
// 401 / 409 branches can be exercised via `instanceof` / `.status`.
const hoistedApi = vi.hoisted(() => ({
  searchContactByEmail: vi.fn(),
  createContact: vi.fn(),
  archiveContact: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'HUBSPOT_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'HubspotUnauthorizedError'
  }
}
class FakeApiError extends Error {
  readonly status: number
  constructor(status: number, message = 'boom') {
    super(message)
    this.name = 'HubspotApiError'
    this.status = status
  }
}
vi.mock('@/lib/integrations/hubspot-api', () => ({
  searchContactByEmail: hoistedApi.searchContactByEmail,
  createContact: hoistedApi.createContact,
  archiveContact: hoistedApi.archiveContact,
  HubspotUnauthorizedError: FakeUnauthorized,
  HubspotApiError: FakeApiError,
}))

vi.mock('@/lib/crm/hubspot-sync', () => ({
  HUBSPOT_SOURCE_PROVIDER: 'hubspot',
  HUBSPOT_PUSH_ERROR_KEY: 'hubspot_push_error',
}))

// Evaluate the module so createFunction runs and the handler is captured.
await import('@/lib/inngest/hubspot-push-contact')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — vi.fn per method plus the nesting tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = {
  data: { contactId: 'ct-1', workspaceId: 'ws-1' },
}

interface DbRows {
  workspaceSettings?: Record<string, unknown>
  contact?: Record<string, unknown> | null
  syncState?: Record<string, unknown> | null
  /**
   * Result of the CAS persist update's `.select('id')`. Default: one row back
   * (the compare-and-swap landed). `{ data: [] }` models a LOST claim race (the
   * `.is('source_provider', null)` guard matched nothing). `{ error }` models a
   * real DB failure that must rethrow.
   */
  persistResult?: { data?: Array<{ id: string }> | null; error?: { code?: string; message?: string } | null }
  /**
   * Result of the permanent-failure marker write (an update chain with NO
   * `.select()` terminal, awaited directly). Default: clean.
   */
  markerWriteResult?: { error?: { message: string } | null }
}

/**
 * Table-aware supabase fake. Each `.from(table)` returns a chainable builder.
 * Reads terminate at `.maybeSingle()`. The CAS persist write is a chain ending
 * in `.select('id')`, which — on an update chain — returns a real Promise that
 * resolves to `{ data, error }` (awaited directly by the handler). `.update()`
 * on the contact records the written patch so the persist step can be asserted.
 */
function makeDb(rows: DbRows) {
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = []

  function builder(table: string) {
    let isUpdate = false

    const resolveSingle = () => {
      if (table === 'workspace') return { settings: rows.workspaceSettings ?? {} }
      if (table === 'contact') return rows.contact ?? null
      if (table === 'crm_sync_state') return rows.syncState ?? null
      return null
    }

    const persist = rows.persistResult ?? { data: [{ id: 'ct-1' }], error: null }

    const api: Record<string, unknown> = {
      // On the update (CAS) chain, `.select('id')` is the awaited terminal and
      // must resolve { data, error }; on a read chain it stays chainable.
      select: () =>
        isUpdate
          ? Promise.resolve({ data: persist.data ?? [], error: persist.error ?? null })
          : api,
      eq: () => api,
      is: () => api,
      order: () => api,
      limit: () => api,
      update: (p: Record<string, unknown>) => {
        isUpdate = true
        writes.push({ table, patch: p })
        return api
      },
      maybeSingle: async () => ({ data: resolveSingle(), error: null }),
      // Terminal for an update chain with no `.select()` — the marker write.
      then: (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: null,
          error: rows.markerWriteResult?.error ?? null,
        }).then(resolve),
    }
    return api
  }

  return {
    client: { from: (table: string) => builder(table) } as never,
    writes,
  }
}

const HAPPY: DbRows = {
  workspaceSettings: { push_contacts_to_hubspot: true },
  contact: {
    id: 'ct-1',
    email: 'ada@example.com',
    first_name: 'Ada',
    last_name: 'Lovelace',
    phone: '+15551234567',
    job_title: 'Engineer',
    source: 'manual',
    source_provider: null,
    provider_contact_id: null,
    merged_into_contact_id: null,
  },
  syncState: { account_id: 'acct-1' },
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.searchContactByEmail.mockResolvedValue(null)
  hoistedApi.createContact.mockResolvedValue({ id: 'hs-new-1' })
  hoistedApi.archiveContact.mockResolvedValue(undefined)
})

// ---- Registration ----------------------------------------------------------

describe('hubspot-push-contact — registration', () => {
  it('registers with the right id, trigger, retries, idempotency, and keyed concurrency', () => {
    expect(hoisted.config.id).toBe('hubspot-push-contact')
    expect(hoisted.config.triggers).toEqual([
      { event: 'crm/hubspot-push-contact' },
    ])
    expect(hoisted.config.retries).toBe(3)
    expect(hoisted.config.idempotency).toBe('event.data.contactId')
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspaceId' },
      { limit: 1, key: 'event.data.contactId' },
    ])
  })
})

// ---- No-op gates -----------------------------------------------------------

describe('hubspot-push-contact — no-op gates', () => {
  it('no-ops when the opt-in flag is absent (default false)', async () => {
    dbFake = makeDb({ ...HAPPY, workspaceSettings: {} }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'flag_off' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops when the flag is explicitly false', async () => {
    dbFake = makeDb({ ...HAPPY, workspaceSettings: { push_contacts_to_hubspot: false } }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'flag_off' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops when the contact is missing', async () => {
    dbFake = makeDb({ ...HAPPY, contact: null }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'missing_contact' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('NEVER pushes an auto-extracted contact (source=email_sync)', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, source: 'email_sync' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('NEVER pushes an auto-extracted contact (source=calendar_sync)', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, source: 'calendar_sync' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('NEVER pushes an auto-extracted contact (source=capture_participant)', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, source: 'capture_participant' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops on a merge tombstone (merged_into_contact_id set)', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, merged_into_contact_id: 'ct-other' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'merged' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops on a HELD contact (metadata.hubspot_push_hold — created by an unattended run)', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, metadata: { hubspot_push_hold: { at: '2026-09-01T00:00:00.000Z', by: 'unattended' } } },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'held' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops when the contact is already provider-linked', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, source_provider: 'hubspot', provider_contact_id: 'hs-x' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'already_linked' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops when the contact has no email', async () => {
    dbFake = makeDb({
      ...HAPPY,
      contact: { ...HAPPY.contact, email: null },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_email' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it('no-ops when the workspace has no connected HubSpot account', async () => {
    dbFake = makeDb({ ...HAPPY, syncState: null }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_hubspot_account' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })
})

// ---- Scope gate (manual vs all) --------------------------------------------

describe('hubspot-push-contact — scope gate', () => {
  // Scope 'manual' is the default (absent scope key). The no-op-gates block
  // above already proves email_sync/calendar_sync/capture_participant no-op
  // under that default; here we prove the SAME with the scope explicitly set,
  // and prove scope 'all' flips the eligibility for exactly those sources.

  it("scope 'manual' (explicit): still refuses an auto-extracted contact", async () => {
    dbFake = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'manual' },
      contact: { ...HAPPY.contact, source: 'email_sync' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it("scope 'all': PUSHES an auto-extracted contact (source=email_sync)", async () => {
    const db = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'all' },
      contact: { ...HAPPY.contact, source: 'email_sync' },
    })
    dbFake = db.client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'created', contactId: 'ct-1', hubspotId: 'hs-new-1' })
    expect(hoistedApi.createContact).toHaveBeenCalledOnce()
    // source is never rewritten — it stays 'email_sync'.
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch.source).toBeUndefined()
    expect(write?.patch).toMatchObject({ source_provider: 'hubspot', provider_contact_id: 'hs-new-1' })
  })

  it("scope 'all': PUSHES a manual contact too (superset of manual)", async () => {
    dbFake = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'all' },
      contact: { ...HAPPY.contact, source: 'manual' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'created' })
    expect(hoistedApi.createContact).toHaveBeenCalledOnce()
  })

  it("scope 'all': STILL excludes a teammate self-contact (source=member)", async () => {
    dbFake = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'all' },
      contact: { ...HAPPY.contact, source: 'member' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'member_excluded' })
    expect(hoistedApi.searchContactByEmail).not.toHaveBeenCalled()
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it("scope 'manual': also refuses a teammate self-contact (source=member)", async () => {
    dbFake = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'manual' },
      contact: { ...HAPPY.contact, source: 'member' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    // Under manual scope, non-'manual' sources fail the source==='manual' gate.
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })

  it("an unrecognized scope value falls back to 'manual' (conservative)", async () => {
    dbFake = makeDb({
      ...HAPPY,
      workspaceSettings: { push_contacts_to_hubspot: true, push_contacts_scope: 'garbage' },
      contact: { ...HAPPY.contact, source: 'email_sync' },
    }).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'not_manual' })
  })

  it('no-ops when there is no valid token', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    dbFake = makeDb(HAPPY).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_token' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
  })
})

// ---- Dedupe (search claims without creating) -------------------------------

describe('hubspot-push-contact — dedupe by email', () => {
  it('claims an existing HubSpot contact (no create) and stamps the local row', async () => {
    hoistedApi.searchContactByEmail.mockResolvedValue({
      id: 'hs-existing-7',
      properties: { email: 'ada@example.com' },
    })
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'claimed', contactId: 'ct-1', hubspotId: 'hs-existing-7' })
    expect(hoistedApi.searchContactByEmail).toHaveBeenCalledWith('tok', 'ada@example.com')
    // No create — dedupe short-circuited it.
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
    // Local row claimed for HubSpot; source unchanged.
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch).toMatchObject({
      source_provider: 'hubspot',
      provider_contact_id: 'hs-existing-7',
    })
    expect(write?.patch.source).toBeUndefined()
  })
})

// ---- Happy path (create) ---------------------------------------------------

describe('hubspot-push-contact — create', () => {
  it('creates the contact and persists the returned HubSpot id, source stays manual', async () => {
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'created', contactId: 'ct-1', hubspotId: 'hs-new-1' })
    expect(hoistedApi.createContact).toHaveBeenCalledOnce()
    const [token, input] = hoistedApi.createContact.mock.calls[0]
    expect(token).toBe('tok')
    expect(input).toEqual({
      email: 'ada@example.com',
      firstname: 'Ada',
      lastname: 'Lovelace',
      phone: '+15551234567',
      jobtitle: 'Engineer',
    })
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch).toMatchObject({
      source_provider: 'hubspot',
      provider_contact_id: 'hs-new-1',
    })
    // source is never written — it remains 'manual'.
    expect(write?.patch.source).toBeUndefined()
  })
})

// ---- CAS persist: success + lost-race handling -----------------------------

describe('hubspot-push-contact — compare-and-swap persist', () => {
  it('CAS claim SUCCESS: create → guarded update lands (row returned) → created', async () => {
    // Default persistResult = one row back → the CAS matched (source_provider was
    // still null). Assert the write filtered on source_provider IS NULL is what
    // ran, and no orphan cleanup fired.
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'created', contactId: 'ct-1', hubspotId: 'hs-new-1' })
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch).toMatchObject({
      source_provider: 'hubspot',
      provider_contact_id: 'hs-new-1',
    })
    // No lost-race path → the just-created contact is NOT archived.
    expect(hoistedApi.archiveContact).not.toHaveBeenCalled()
  })

  it('LOST race after a CREATE: archives the orphan, does NOT clobber, returns lost_claim_race', async () => {
    // CAS returns zero rows (another writer set source_provider first). This run
    // had CREATED a new HubSpot object → it is now orphaned and must be archived.
    const db = makeDb({ ...HAPPY, persistResult: { data: [], error: null } })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({
      status: 'lost_claim_race',
      contactId: 'ct-1',
      hubspotId: 'hs-new-1',
    })
    // The created-but-orphaned HubSpot contact is archived with the run's token.
    expect(hoistedApi.archiveContact).toHaveBeenCalledOnce()
    expect(hoistedApi.archiveContact).toHaveBeenCalledWith('tok', 'hs-new-1')
    // The update was ATTEMPTED (CAS) but matched no row — the winner's claim on
    // the local row is never clobbered (the guard did its job).
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch).toMatchObject({
      source_provider: 'hubspot',
      provider_contact_id: 'hs-new-1',
    })
  })

  it('LOST race after a CLAIM (search hit): no archive — the existing object stays', async () => {
    // Search hit → action 'claimed' (no HubSpot object created by us). Losing the
    // CAS must NOT archive anything: the existing HubSpot contact is legitimate.
    hoistedApi.searchContactByEmail.mockResolvedValue({
      id: 'hs-existing-7',
      properties: { email: 'ada@example.com' },
    })
    const db = makeDb({ ...HAPPY, persistResult: { data: [], error: null } })
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({
      status: 'lost_claim_race',
      contactId: 'ct-1',
      hubspotId: 'hs-existing-7',
    })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
    // Nothing was created by us, so nothing is archived.
    expect(hoistedApi.archiveContact).not.toHaveBeenCalled()
  })

  it('rethrows a real DB error on the persist so Inngest retries (not a lost race)', async () => {
    const db = makeDb({
      ...HAPPY,
      persistResult: { data: null, error: { code: '08006', message: 'connection reset' } },
    })
    dbFake = db.client

    await expect(
      hoisted.handler({ event: EVENT, step: makeStep() }),
    ).rejects.toMatchObject({ message: 'connection reset' })
    // A DB failure is not a lost race — no orphan cleanup.
    expect(hoistedApi.archiveContact).not.toHaveBeenCalled()
  })
})

// ---- 409 create-race -------------------------------------------------------

describe('hubspot-push-contact — 409 create race', () => {
  it('re-searches once and claims the now-visible object on a 409', async () => {
    // First search: empty. Create: 409. Second search: the raced row.
    hoistedApi.searchContactByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'hs-raced-9', properties: {} })
    hoistedApi.createContact.mockRejectedValue(new FakeApiError(409, 'CONTACT_EXISTS'))
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'claimed', hubspotId: 'hs-raced-9' })
    expect(hoistedApi.searchContactByEmail).toHaveBeenCalledTimes(2)
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch).toMatchObject({ provider_contact_id: 'hs-raced-9' })
  })

  it('rethrows the 409 when the re-search is still empty (pathological)', async () => {
    hoistedApi.searchContactByEmail.mockResolvedValue(null) // both searches empty
    hoistedApi.createContact.mockRejectedValue(new FakeApiError(409, 'CONTACT_EXISTS'))
    dbFake = makeDb(HAPPY).client

    await expect(
      hoisted.handler({ event: EVENT, step: makeStep() }),
    ).rejects.toBeInstanceOf(FakeApiError)
  })
})

// ---- 401 + non-401 error handling ------------------------------------------

describe('hubspot-push-contact — error handling', () => {
  it('no-ops (does NOT throw) on 401 from the dedupe search', async () => {
    hoistedApi.searchContactByEmail.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'unauthorized' })
    expect(hoistedApi.createContact).not.toHaveBeenCalled()
    // Nothing was created/claimed, so the row is never provider-linked. (The
    // one write that DOES happen is the failure marker — see the marker block.)
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch.source_provider).toBeUndefined()
    expect(write?.patch.provider_contact_id).toBeUndefined()
  })

  it('no-ops (does NOT throw) on 401 from the create', async () => {
    hoistedApi.createContact.mockRejectedValue(new FakeUnauthorized())
    dbFake = makeDb(HAPPY).client
    const out = await hoisted.handler({ event: EVENT, step: makeStep() })
    expect(out).toMatchObject({ status: 'skipped', reason: 'unauthorized' })
  })

  it('rethrows a non-401 create error so Inngest retries', async () => {
    hoistedApi.createContact.mockRejectedValue(new Error('boom 500'))
    dbFake = makeDb(HAPPY).client
    await expect(
      hoisted.handler({ event: EVENT, step: makeStep() }),
    ).rejects.toThrow('boom 500')
  })
})

// ---- Permanent-failure marker (metadata.hubspot_push_error) ----------------

describe('hubspot-push-contact — permanent-failure marker', () => {
  // A 401'd contact keeps source_provider NULL, so the sweep's eligibility
  // query would re-emit it on every cron tick, forever. The marker is what
  // takes it out of the routine sweep until an explicit retry.

  const marked = (metadata: Record<string, unknown>): DbRows => ({
    ...HAPPY,
    contact: { ...HAPPY.contact, metadata },
  })

  it('persists { code: unauthorized, at } into contact.metadata on a 401', async () => {
    hoistedApi.createContact.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb(HAPPY)
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'skipped', reason: 'unauthorized' })
    const write = db.writes.find((w) => w.table === 'contact')
    const metadata = write?.patch.metadata as Record<string, unknown>
    expect(metadata.hubspot_push_error).toMatchObject({ code: 'unauthorized' })
    const at = (metadata.hubspot_push_error as { at: string }).at
    expect(new Date(at).toISOString()).toBe(at)
  })

  it('MERGES the marker — sibling metadata keys are never clobbered', async () => {
    hoistedApi.searchContactByEmail.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb(marked({ voice_profile_id: 'vp-1', imported_from: 'csv' }))
    dbFake = db.client

    await hoisted.handler({ event: EVENT, step: makeStep() })

    const write = db.writes.find((w) => w.table === 'contact')
    const metadata = write?.patch.metadata as Record<string, unknown>
    expect(metadata.voice_profile_id).toBe('vp-1')
    expect(metadata.imported_from).toBe('csv')
    expect(metadata.hubspot_push_error).toMatchObject({ code: 'unauthorized' })
  })

  it('re-stamps an existing marker (refreshed timestamp, still one key)', async () => {
    hoistedApi.searchContactByEmail.mockRejectedValue(new FakeUnauthorized())
    const db = makeDb(
      marked({ hubspot_push_error: { code: 'unauthorized', at: '2020-01-01T00:00:00.000Z' } }),
    )
    dbFake = db.client

    await hoisted.handler({ event: EVENT, step: makeStep() })

    const write = db.writes.find((w) => w.table === 'contact')
    const metadata = write?.patch.metadata as Record<string, unknown>
    const at = (metadata.hubspot_push_error as { at: string }).at
    expect(at).not.toBe('2020-01-01T00:00:00.000Z')
  })

  it('swallows a marker-write failure — the run still ends as a clean no-op', async () => {
    hoistedApi.searchContactByEmail.mockRejectedValue(new FakeUnauthorized())
    dbFake = makeDb({ ...HAPPY, markerWriteResult: { error: { message: 'db down' } } }).client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    // A marker-write failure must not turn the 401 no-op into a retrying run.
    expect(out).toMatchObject({ status: 'skipped', reason: 'unauthorized' })
  })

  it('CLEARS the marker on a successful create (keeping siblings)', async () => {
    const db = makeDb(
      marked({
        hubspot_push_error: { code: 'unauthorized', at: '2020-01-01T00:00:00.000Z' },
        voice_profile_id: 'vp-1',
      }),
    )
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'created' })
    const write = db.writes.find((w) => w.table === 'contact')
    const metadata = write?.patch.metadata as Record<string, unknown>
    expect(metadata).toEqual({ voice_profile_id: 'vp-1' })
    expect('hubspot_push_error' in metadata).toBe(false)
  })

  it('CLEARS the marker on a successful claim (search hit)', async () => {
    hoistedApi.searchContactByEmail.mockResolvedValue({
      id: 'hs-existing-7',
      properties: { email: 'ada@example.com' },
    })
    const db = makeDb(
      marked({ hubspot_push_error: { code: 'unauthorized', at: '2020-01-01T00:00:00.000Z' } }),
    )
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'claimed' })
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch.metadata).toEqual({})
  })

  it('does NOT write metadata at all when there is no marker to clear', async () => {
    // Avoid a gratuitous read-modify-write that could race another metadata
    // writer for a row that has nothing to clean up.
    const db = makeDb(marked({ voice_profile_id: 'vp-1' }))
    dbFake = db.client

    const out = await hoisted.handler({ event: EVENT, step: makeStep() })

    expect(out).toMatchObject({ status: 'created' })
    const write = db.writes.find((w) => w.table === 'contact')
    expect(write?.patch.metadata).toBeUndefined()
    expect(write?.patch).toMatchObject({
      source_provider: 'hubspot',
      provider_contact_id: 'hs-new-1',
    })
  })
})
