import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createStepMock, type StepMock } from '@/test/inngest-step-mock'

/**
 * Tests for src/lib/inngest/capture-ingest.ts — the auto-trigger that turns a
 * finished meeting (flow/capture.processed) into a claim/extract-from-source
 * send.
 *
 * Invariants locked in:
 *  - the extraction event is sent with the exact payload shape
 *    claim-extraction.ts expects (camelCase keys, sourceType 'capture'),
 *  - memberId is resolved from the member table by user_id + workspace_id
 *    (mirroring conversation-ingest),
 *  - junk captures never burn extraction: null/short summaries, demo
 *    captures, reconciler re-fires and ownerless rows are all skipped.
 */

// ---- Hoisted mocks --------------------------------------------------------

type Handler = (ctx: {
  event: { data: Record<string, unknown> }
  step: StepMock
}) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

// Capture the Inngest handler + config so tests can invoke it directly.
vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.config = config
      hoisted.handler = fn
      return { id: 'capture-ingest' }
    },
  },
}))

vi.mock('@/lib/admin', () => ({
  getServiceClient: () => ({ from: vi.fn() }),
}))

// Evaluate the module so createFunction runs and the handler is captured.
const mod = await import('@/lib/inngest/capture-ingest')

// ---- Helpers ---------------------------------------------------------------

/**
 * Shared Inngest step mock — vi.fn per method plus the nesting tripwire
 * (step tooling inside a step.run callback throws; it deadlocks in production).
 */
function makeStep(): StepMock {
  return createStepMock()
}

const LONG_SUMMARY =
  '## Summary\n' +
  'The team agreed to ship the billing rework on Friday after the QA pass. '.repeat(
    4,
  )

/**
 * Chainable fake supabase: `.from(table)` returns a query whose terminal
 * `.maybeSingle()` resolves per-table rows supplied by the test.
 */
function makeSupabase(rows: {
  captures?: Record<string, unknown> | null
  member?: Record<string, unknown> | null
}) {
  function makeQuery(table: string) {
    const q: Record<string, unknown> = {}
    const chain = () => q
    q.select = chain
    q.eq = chain
    q.maybeSingle = () =>
      Promise.resolve({
        data:
          table === 'captures'
            ? (rows.captures ?? null)
            : table === 'member'
              ? (rows.member ?? null)
              : null,
      })
    return q
  }
  return { from: (table: string) => makeQuery(table) }
}

async function mockServiceClient(rows: Parameters<typeof makeSupabase>[0]) {
  const adminMod = await import('@/lib/admin')
  return vi
    .spyOn(adminMod, 'getServiceClient')
    .mockReturnValue(makeSupabase(rows) as never)
}

function makeEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      workspace_id: 'ws-1',
      capture_id: 'cap-1',
      processed_at: '2026-07-09T10:00:00Z',
      ...overrides,
    },
  }
}

const HAPPY_CAPTURE = {
  id: 'cap-1',
  title: 'Weekly sync',
  user_id: 'u-owner',
  ai_summary: LONG_SUMMARY,
  content: null,
  metadata: null,
}

// ---- Tests -----------------------------------------------------------------

describe('captureIngest', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('is triggered by flow/capture.processed', () => {
    expect(hoisted.config.id).toBe('capture-ingest')
    expect(hoisted.config.triggers).toEqual([
      { event: 'flow/capture.processed' },
    ])
  })

  it('sends claim/extract-from-source with the exact payload claim-extraction expects', async () => {
    await mockServiceClient({
      captures: HAPPY_CAPTURE,
      member: { id: 'm-owner' },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).toHaveBeenCalledWith('send-extraction', {
      name: 'claim/extract-from-source',
      data: {
        workspaceId: 'ws-1',
        userId: 'u-owner',
        memberId: 'm-owner',
        sourceType: 'capture',
        sourceId: 'cap-1',
        sourceLabel: 'Meeting: Weekly sync',
      },
    })
    expect(result).toMatchObject({ status: 'queued', captureId: 'cap-1' })
  })

  it('ALSO sends crm/hubspot-log-capture alongside the extraction send', async () => {
    await mockServiceClient({
      captures: HAPPY_CAPTURE,
      member: { id: 'm-owner' },
    })
    const step = makeStep()

    await hoisted.handler({ event: makeEvent(), step })

    // Both fan-out events fire on a real capture.
    expect(step.sendEvent).toHaveBeenCalledTimes(2)
    expect(step.sendEvent).toHaveBeenCalledWith('send-hubspot-log', {
      name: 'crm/hubspot-log-capture',
      data: {
        captureId: 'cap-1',
        workspaceId: 'ws-1',
        ownerUserId: 'u-owner',
      },
    })
  })

  it('resolves memberId to null when the owner has no member row in the workspace', async () => {
    await mockServiceClient({ captures: HAPPY_CAPTURE, member: null })
    const step = makeStep()

    await hoisted.handler({ event: makeEvent(), step })

    // Both fan-out events fire; the extraction send is first.
    expect(step.sendEvent).toHaveBeenCalledTimes(2)
    const sent = step.sendEvent.mock.calls[0][1] as {
      data: { memberId: string | null; userId: string }
    }
    expect(sent.data.memberId).toBeNull()
    expect(sent.data.userId).toBe('u-owner')
  })

  it('skips when ai_summary is missing (no extraction burn on junk blips)', async () => {
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, ai_summary: null, content: null },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'summary_too_short',
    })
  })

  it('skips when ai_summary is trivially short (< MIN_SUMMARY_CHARS)', async () => {
    const short = 'x'.repeat(mod.MIN_SUMMARY_CHARS - 1)
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, ai_summary: short },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'summary_too_short',
    })
  })

  it('sends when the summary is exactly MIN_SUMMARY_CHARS', async () => {
    const exact = 'x'.repeat(mod.MIN_SUMMARY_CHARS)
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, ai_summary: exact },
      member: { id: 'm-owner' },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'queued' })
  })

  it('falls back to legacy content when ai_summary is null', async () => {
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, ai_summary: null, content: LONG_SUMMARY },
      member: { id: 'm-owner' },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ status: 'queued' })
  })

  it('skips reconciler re-fires (reconciled: true) without touching the DB', async () => {
    const spy = await mockServiceClient({ captures: HAPPY_CAPTURE })
    const step = makeStep()

    const result = await hoisted.handler({
      event: makeEvent({ reconciled: true }),
      step,
    })

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'reconciled_refire',
    })
    expect(step.run).not.toHaveBeenCalled()
    expect(step.sendEvent).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('skips demo captures', async () => {
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, metadata: { demo: true } },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'demo_capture' })
  })

  it('skips when the capture row is missing (deleted between emit and dispatch)', async () => {
    await mockServiceClient({ captures: null })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'missing_capture',
    })
  })

  it('skips ownerless captures instead of sending an unattributed extraction', async () => {
    // guardBackgroundUsage fails OPEN on a missing userId — sending without an
    // owner would bypass usage limits, so the conservative move is to skip.
    await mockServiceClient({
      captures: { ...HAPPY_CAPTURE, user_id: null },
    })
    const step = makeStep()

    const result = await hoisted.handler({ event: makeEvent(), step })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toMatchObject({ status: 'skipped', reason: 'no_owner' })
  })
})
