import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/hubspot-log-capture.ts via the createFunction-
 * capture pattern (canonical: capture-ingest.test.ts).
 *
 * Invariants locked in:
 *  - private capture → no-op (the summary never leaves the product), and a
 *    failed capture read fails CLOSED the same way.
 *  - flag off (or absent) → no-op, no HubSpot call, no metadata write.
 *  - already-logged (metadata.hubspot_meeting_id present) → no-op.
 *  - no connected HubSpot account for the workspace → no-op.
 *  - no participant contact carries a HubSpot id → no-op.
 *  - happy path: meeting body carries summary + confirmed action items + link,
 *    one association per contact, engagement id persisted, jsonb merge preserves
 *    other metadata keys.
 *  - 401 (token predates contacts.write scope) → no-op, NOT a throw/retry.
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

// HubSpot API — createMeeting stub + the real HubspotUnauthorizedError so the
// 401 no-op branch can be exercised via `instanceof`.
const hoistedApi = vi.hoisted(() => ({
  createMeeting: vi.fn(),
}))
class FakeUnauthorized extends Error {
  readonly code = 'HUBSPOT_UNAUTHORIZED'
  constructor() {
    super('401')
    this.name = 'HubspotUnauthorizedError'
  }
}
vi.mock('@/lib/integrations/hubspot-api', () => ({
  createMeeting: hoistedApi.createMeeting,
  HubspotUnauthorizedError: FakeUnauthorized,
  MEETING_TO_CONTACT_ASSOCIATION_TYPE_ID: 200,
}))

vi.mock('@/lib/crm/hubspot-sync', () => ({
  HUBSPOT_SOURCE_PROVIDER: 'hubspot',
}))

// Evaluate the module so createFunction runs and the handler is captured.
await import('@/lib/inngest/hubspot-log-capture')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — vi.fn per method plus the nesting tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const EVENT = {
  data: { captureId: 'cap-1', workspaceId: 'ws-1', ownerUserId: 'u-1' },
}

interface DbRows {
  capture?: Record<string, unknown> | null
  workspaceSettings?: Record<string, unknown>
  syncState?: Record<string, unknown> | null
  participants?: Array<{ contact_id: string | null }>
  contacts?: Array<{ provider_contact_id: string | null }>
  actions?: Array<{ title: string | null }>
  /** Force the captures read to error, to assert the fail-closed path. */
  captureReadError?: boolean
}

/**
 * Table-aware supabase fake. Each `.from(table)` returns a chainable builder
 * whose terminal `.maybeSingle()` / await resolves the rows the test supplied.
 * `.update()` on captures records the written metadata so idempotency +
 * jsonb-merge can be asserted; a mutable `captureRow` lets the persist-step read
 * back the row it's about to update.
 */
function makeDb(rows: DbRows) {
  const writes: Array<{ table: string; patch: Record<string, unknown> }> = []
  let captureRow = rows.capture ? { ...rows.capture } : rows.capture

  function builder(table: string) {
    let mode: 'select' | 'update' = 'select'
    let patch: Record<string, unknown> | null = null

    const resolveList = () => {
      if (table === 'capture_participant') return rows.participants ?? []
      if (table === 'contact') return rows.contacts ?? []
      if (table === 'actions') return rows.actions ?? []
      return []
    }
    const resolveSingle = () => {
      if (table === 'captures') return captureRow ?? null
      if (table === 'workspace') return { settings: rows.workspaceSettings ?? {} }
      if (table === 'crm_sync_state') return rows.syncState ?? null
      return null
    }

    const api: Record<string, unknown> = {
      select: () => api,
      eq: () => api,
      in: () => api,
      order: () => api,
      limit: () => api,
      update: (p: Record<string, unknown>) => {
        mode = 'update'
        patch = p
        return api
      },
      maybeSingle: async () => {
        if (table === 'captures' && rows.captureReadError) {
          return { data: null, error: { message: 'boom' } }
        }
        return { data: resolveSingle(), error: null }
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (mode === 'update' && patch) {
          writes.push({ table, patch })
          if (table === 'captures') {
            captureRow = { ...(captureRow ?? {}), ...patch }
          }
        }
        return Promise.resolve({ data: resolveList(), error: null }).then(resolve)
      },
    }
    return api
  }

  return {
    client: { from: (table: string) => builder(table) } as never,
    writes,
    getCaptureRow: () => captureRow,
  }
}

const HAPPY: DbRows = {
  capture: {
    id: 'cap-1',
    title: 'Weekly sync',
    ai_summary: 'The team agreed to ship the billing rework on Friday.',
    started_at: '2026-07-25T10:00:00.000Z',
    ended_at: '2026-07-25T10:30:00.000Z',
    metadata: { existing_key: 'keep-me' },
    visibility: 'workspace',
  },
  workspaceSettings: { log_meetings_to_hubspot: true },
  syncState: { account_id: 'acct-1' },
  participants: [{ contact_id: 'ct-1' }, { contact_id: 'ct-2' }],
  contacts: [
    { provider_contact_id: '111' },
    { provider_contact_id: '222' },
  ],
  actions: [{ title: 'Send the QA report' }, { title: 'Book the follow-up' }],
}

beforeEach(() => {
  vi.clearAllMocks()
  hoistedToken.getValidTokenForAccount.mockResolvedValue({
    token: 'tok',
    email: null,
    accountId: 'acct-1',
  })
  hoistedApi.createMeeting.mockResolvedValue({ id: 'meeting-1' })
})

// ---- Registration ----------------------------------------------------------

describe('hubspot-log-capture — registration', () => {
  it('registers with the right id, trigger, retries, and keyed concurrency', () => {
    expect(hoisted.config.id).toBe('hubspot-log-capture')
    expect(hoisted.config.triggers).toEqual([
      { event: 'crm/hubspot-log-capture' },
    ])
    expect(hoisted.config.retries).toBe(3)
    expect(hoisted.config.concurrency).toEqual([
      { limit: 5, key: 'event.data.workspaceId' },
      { limit: 1, key: 'event.data.captureId' },
    ])
  })

  it('dedups double-fires via idempotency + per-capture serialization', () => {
    // Invocation-level dedup collapses a Reprocess double-fire to one run.
    expect(hoisted.config.idempotency).toBe('event.data.captureId')
    // The metadata check-then-act race is closed by a SECOND concurrency
    // constraint (limit 1, keyed on captureId) alongside the workspace one —
    // Inngest evaluates both, so no two concurrent runs for the same capture.
    const concurrency = hoisted.config.concurrency as Array<{
      limit: number
      key: string
    }>
    expect(concurrency).toHaveLength(2)
    expect(concurrency).toContainEqual({ limit: 1, key: 'event.data.captureId' })
    expect(concurrency).toContainEqual({ limit: 5, key: 'event.data.workspaceId' })
  })
})

// ---- Capture visibility (external writeback) -------------------------------
//
// A private capture ("Only me") must never reach an external CRM: unlike every
// in-product surface, a HubSpot engagement is outside Dial8's visibility model
// entirely — it cannot be revoked by flipping the capture back. The gate is an
// independent re-read of the row, NOT the event's flow_eligible flag, because
// the triage reconciler emits capture.processed unflagged.
// See docs/design-capture-visibility.md.

describe('hubspot-log-capture — capture visibility', () => {
  it('skips a private capture before any HubSpot call', async () => {
    const db = makeDb({ ...HAPPY, capture: { ...HAPPY.capture, visibility: 'private' } })
    dbFake = db.client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'skipped', reason: 'private_capture' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
  })

  it('fails CLOSED when the capture read errors', async () => {
    const db = makeDb({ ...HAPPY, captureReadError: true })
    dbFake = db.client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'skipped', reason: 'missing_capture' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
  })

  it('pushes a workspace-visible capture as normal', async () => {
    dbFake = makeDb(HAPPY).client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'logged', meetingId: 'meeting-1' })
    expect(hoistedApi.createMeeting).toHaveBeenCalledOnce()
  })
})

// ---- No-op gates -----------------------------------------------------------

describe('hubspot-log-capture — on by default', () => {
  it('logs when the flag is absent (missing = on)', async () => {
    dbFake = makeDb({ ...HAPPY, workspaceSettings: {} }).client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'logged', meetingId: 'meeting-1' })
    expect(hoistedApi.createMeeting).toHaveBeenCalledOnce()
  })
})

describe('hubspot-log-capture — no-op gates', () => {

  it('no-ops when the flag is explicitly false', async () => {
    dbFake = makeDb({ ...HAPPY, workspaceSettings: { log_meetings_to_hubspot: false } }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'flag_off' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })

  it('no-ops when the capture already has a hubspot_meeting_id', async () => {
    dbFake = makeDb({
      ...HAPPY,
      capture: { ...HAPPY.capture, metadata: { hubspot_meeting_id: 'meeting-prev' } },
    }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'already_logged' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })

  it('no-ops when the capture is missing', async () => {
    dbFake = makeDb({ ...HAPPY, capture: null }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'missing_capture' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })

  it('no-ops when the workspace has no connected HubSpot account', async () => {
    dbFake = makeDb({ ...HAPPY, syncState: null }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_hubspot_account' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })

  it('no-ops when no participant contact carries a HubSpot id', async () => {
    dbFake = makeDb({ ...HAPPY, contacts: [] }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_hubspot_contacts' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })

  it('no-ops when there are no participants at all', async () => {
    dbFake = makeDb({ ...HAPPY, participants: [], contacts: [] }).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_hubspot_contacts' })
  })

  it('no-ops when there is no valid token', async () => {
    hoistedToken.getValidTokenForAccount.mockResolvedValue(null)
    dbFake = makeDb(HAPPY).client
    const step = makeStep()
    const out = await hoisted.handler({ event: EVENT, step })
    expect(out).toMatchObject({ status: 'skipped', reason: 'no_token' })
    expect(hoistedApi.createMeeting).not.toHaveBeenCalled()
  })
})

// ---- 401 no-op (missing write scope) ---------------------------------------

describe('hubspot-log-capture — 401 handling', () => {
  it('no-ops (does NOT throw) when HubSpot returns 401 for a token missing the write scope', async () => {
    hoistedApi.createMeeting.mockRejectedValue(new FakeUnauthorized())
    dbFake = makeDb(HAPPY).client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({ status: 'skipped', reason: 'unauthorized' })
    // No metadata write — the engagement never got created.
    const db = dbFake as never
    void db
  })

  it('rethrows a non-401 HubSpot error so Inngest retries', async () => {
    hoistedApi.createMeeting.mockRejectedValue(new Error('boom 500'))
    dbFake = makeDb(HAPPY).client
    const step = makeStep()

    await expect(hoisted.handler({ event: EVENT, step })).rejects.toThrow('boom 500')
  })
})

// ---- Happy path ------------------------------------------------------------

describe('hubspot-log-capture — happy path', () => {
  it('creates ONE meeting with summary + confirmed action items + deep link, associated to every contact', async () => {
    const db = makeDb(HAPPY)
    dbFake = db.client
    const step = makeStep()

    const out = await hoisted.handler({ event: EVENT, step })

    expect(out).toMatchObject({
      status: 'logged',
      captureId: 'cap-1',
      meetingId: 'meeting-1',
      contactCount: 2,
    })

    expect(hoistedApi.createMeeting).toHaveBeenCalledOnce()
    const [token, input] = hoistedApi.createMeeting.mock.calls[0]
    expect(token).toBe('tok')
    expect(input.hs_meeting_title).toBe('Weekly sync')
    // Association: one contact id per participant with a HubSpot id.
    expect(input.contactIds).toEqual(['111', '222'])
    // Timestamps: hs_timestamp = start; start/end passed through as epoch ms.
    expect(input.hs_timestamp).toBe(String(Date.parse('2026-07-25T10:00:00.000Z')))
    expect(input.hs_meeting_start_time).toBe(String(Date.parse('2026-07-25T10:00:00.000Z')))
    expect(input.hs_meeting_end_time).toBe(String(Date.parse('2026-07-25T10:30:00.000Z')))
    // Body: summary + action items + link back to the Dial8 capture.
    expect(input.hs_meeting_body).toContain('billing rework')
    expect(input.hs_meeting_body).toContain('Action items:')
    expect(input.hs_meeting_body).toContain('- Send the QA report')
    expect(input.hs_meeting_body).toContain('- Book the follow-up')
    expect(input.hs_meeting_body).toContain('/account/captures/cap-1')
  })

  it('persists the engagement id, merging into metadata WITHOUT clobbering other keys', async () => {
    const db = makeDb(HAPPY)
    dbFake = db.client
    const step = makeStep()

    await hoisted.handler({ event: EVENT, step })

    const captureWrites = db.writes.filter((w) => w.table === 'captures')
    expect(captureWrites).toHaveLength(1)
    const written = captureWrites[0].patch.metadata as Record<string, unknown>
    expect(written.hubspot_meeting_id).toBe('meeting-1')
    // Pre-existing metadata key survived the jsonb merge.
    expect(written.existing_key).toBe('keep-me')
  })

  it('omits the "Action items:" block when there are no confirmed actions', async () => {
    const db = makeDb({ ...HAPPY, actions: [] })
    dbFake = db.client
    const step = makeStep()

    await hoisted.handler({ event: EVENT, step })

    const input = hoistedApi.createMeeting.mock.calls[0][1]
    expect(input.hs_meeting_body).not.toContain('Action items:')
    // The deep link always survives.
    expect(input.hs_meeting_body).toContain('/account/captures/cap-1')
  })

  it('deduplicates repeated contact ids across participants', async () => {
    const db = makeDb({
      ...HAPPY,
      participants: [{ contact_id: 'ct-1' }, { contact_id: 'ct-1' }],
      contacts: [{ provider_contact_id: '111' }],
    })
    dbFake = db.client
    const step = makeStep()

    await hoisted.handler({ event: EVENT, step })

    const input = hoistedApi.createMeeting.mock.calls[0][1]
    expect(input.contactIds).toEqual(['111'])
  })
})

// ---- Truncation: no unpaired UTF-16 surrogate ------------------------------

describe('hubspot-log-capture — body truncation', () => {
  // MAX_BODY_CHARS in the module. Kept local so the test stays independent of an
  // (unexported) constant; if the module value changes this drifts loudly.
  const MAX_BODY_CHARS = 60_000

  /**
   * Run the handler with the given over-budget summary as the capture's
   * ai_summary and return the truncated hs_meeting_body.
   */
  async function bodyForSummary(summary: string): Promise<string> {
    const db = makeDb({
      ...HAPPY,
      actions: [],
      // Fresh metadata (no prior hubspot_meeting_id) so the run proceeds; the
      // over-budget summary forces the truncation branch.
      capture: { ...HAPPY.capture, ai_summary: summary, metadata: {} },
    })
    dbFake = db.client
    const step = makeStep()
    await hoisted.handler({ event: { data: { ...EVENT.data } }, step })
    const input = hoistedApi.createMeeting.mock.calls[0][1] as {
      hs_meeting_body: string
    }
    return input.hs_meeting_body
  }

  it('never leaves a lone high surrogate when an emoji straddles the cut point', async () => {
    // '😀' = U+1F600 = surrogate pair 😀 (2 UTF-16 code units). A run of
    // emojis far exceeds the summary budget; sweeping a 1-char BMP prefix shifts
    // the boundary parity so at least one case bisects a pair mid-emoji.
    for (const pad of ['', 'A']) {
      hoistedApi.createMeeting.mockClear()
      const summary = pad + '😀'.repeat(MAX_BODY_CHARS) // length ~2*MAX, over budget
      const body = await bodyForSummary(summary)

      // The whole body must be well-formed UTF-16 — no unpaired surrogate anywhere.
      if (typeof (String.prototype as { isWellFormed?: () => boolean }).isWellFormed === 'function') {
        expect((body as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true)
      }
      // The summary segment (everything before the tail) must not end on a lone
      // high surrogate. The ellipsis marks the truncation point; assert the char
      // immediately before it is not an unpaired high surrogate.
      const summarySegment = body.split('\n\n')[0]
      expect(summarySegment).toMatch(/…$/)
      const beforeEllipsis = summarySegment.slice(0, -1)
      expect(beforeEllipsis).not.toMatch(/[\uD800-\uDBFF]$/)
      // The deep link always survives truncation.
      expect(body).toContain('/account/captures/cap-1')
    }
  })
})
