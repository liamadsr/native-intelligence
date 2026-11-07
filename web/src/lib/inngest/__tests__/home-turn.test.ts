/**
 * home/turn.requested → one batched server turn in the home thread (A4 slice
 * 5), via the createFunction-capture pattern. Pinned: the config (debounced
 * 90 s per conversation with a cap, one run per conversation); a bad event or
 * a skip returns without claiming (a skip with something to deliver records
 * its row); a duplicate claim stops; the reads continue from each step's
 * cursor until the turn is done; a failed send stops before finish; a
 * written turn of a routed reason asks the router to take its message to the
 * person (`route`, ids only); one `[home-turn]` line per run.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest'
import { createStepMock } from '@/test/inngest-step-mock'
import { ROUTED_HOME_TURN_REASONS } from '@/lib/reach/route-policy'

type Handler = (ctx: { event: { data: Record<string, unknown> }; step: ReturnType<typeof createStepMock> }) => Promise<unknown>

const hoisted = vi.hoisted(() => ({
  handler: null as unknown as Handler,
  config: null as unknown as Record<string, unknown>,
}))

vi.mock('@/lib/inngest/client', () => ({
  inngest: {
    createFunction: (config: Record<string, unknown>, fn: Handler) => {
      hoisted.handler = fn
      hoisted.config = config
      return { id: config.id }
    },
    send: vi.fn(),
  },
}))
vi.mock('@/lib/admin', () => ({ getServiceClient: () => ({ db: true }) }))

const server = vi.hoisted(() => ({
  planHomeTurn: vi.fn(),
  recordSkippedHomeTurn: vi.fn(async () => undefined),
  claimHomeTurn: vi.fn(),
  sendHomeTurn: vi.fn(),
  continueHomeTurn: vi.fn(),
  finishHomeTurn: vi.fn(),
}))
vi.mock('@/lib/chat/home-turn-server', async () => {
  const actual = await vi.importActual<typeof import('@/lib/chat/home-turn-server')>('@/lib/chat/home-turn-server')
  return { ...actual, ...server }
})

const digestLib = vi.hoisted(() => ({
  markDigestDelivered: vi.fn(async () => 2),
  sendDigestNotice: vi.fn(async () => 'notice-1'),
}))
vi.mock('@/lib/agent-events/digest', () => digestLib)
const eventLib = vi.hoisted(() => ({
  markEventsDelivered: vi.fn(async () => 2),
  markWorkEventsDelivered: vi.fn(async () => 1),
}))
vi.mock('@/lib/agent-events/event-turn', () => eventLib)
// The Now file's check-in: its one notice when it replied (src/lib/now/check-in.ts).
const checkInLib = vi.hoisted(() => ({ sendCheckInNotice: vi.fn(async () => true) }))
vi.mock('@/lib/now/check-in', () => checkInLib)
// An approval turn's calls are marked carried (approval-turn.ts, 445).
const approvalLib = vi.hoisted(() => ({ markApprovalsCarried: vi.fn(async () => undefined) }))
vi.mock('@/lib/safety/approval-turn', () => approvalLib)

import '../home-turn'

const IDS = {
  conversationId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
}
const EVENT = { data: { ...IDS, workItemIds: ['44444444-4444-4444-8444-444444444444'], reason: 'helper_report' } }
const PLAN = { ok: true, sessionId: 'sess', reports: [{ messageId: 'r1', report: {} }], workItemIds: [], dedupeKey: 'k' }
const ROW = { id: 'row-1', status: 'claimed', eve_session_id: 'sess', eve_turn_id: null, stream_position: null }
const state = (nextIndex: number) => ({ nextIndex, ownDeliveryIds: ['d'], eveTurnId: 't', parts: { parts: [] } })
/** The route request a written routed turn sends (src/lib/reach/route.ts): ids only, keyed on the turn. */
const ROUTE = ['route', { name: 'reach/route.requested', data: { userId: IDS.userId, workspaceId: IDS.workspaceId, conversationId: IDS.conversationId }, id: 'reach-route:home-turn:row-1' }]

describe('homeTurn', () => {
  let info: MockInstance<typeof console.info>
  const lines = () => info.mock.calls.map(([l]) => String(l))

  beforeEach(() => {
    for (const fn of Object.values(server)) fn.mockReset()
    digestLib.markDigestDelivered.mockClear()
    digestLib.sendDigestNotice.mockClear()
    eventLib.markEventsDelivered.mockClear()
    eventLib.markWorkEventsDelivered.mockClear()
    server.recordSkippedHomeTurn.mockResolvedValue(undefined)
    info = vi.spyOn(console, 'info').mockImplementation(() => {})
  })
  afterEach(() => info.mockRestore())

  it('is debounced 90 s per conversation and reason (capped), one run per conversation, on home/turn.requested', () => {
    expect(hoisted.config).toMatchObject({
      id: 'home-turn',
      // Per conversation AND reason: a digest and a report in one window are two turns.
      debounce: { key: 'event.data.conversationId + ":" + event.data.reason', period: '90s', timeout: '10m' },
      concurrency: [{ limit: 1, key: 'event.data.conversationId' }],
      triggers: [{ event: 'home/turn.requested' }],
    })
  })

  it('a malformed event stops before any step', async () => {
    const step = createStepMock()
    expect(await hoisted.handler({ event: { data: { conversationId: 'x' } }, step })).toEqual({ status: 'skipped', reason: 'bad_event' })
    expect(step.run).not.toHaveBeenCalled()
  })

  it('a skip with something to deliver records its row; one without does not; neither claims', async () => {
    const step = createStepMock()
    server.planHomeTurn.mockResolvedValueOnce({ ok: false, reason: 'autonomy_off', record: { dedupeKey: 'k', reports: [], workItemIds: [], sessionId: 's' } })
    expect(await hoisted.handler({ event: EVENT, step })).toEqual({ status: 'skipped', reason: 'autonomy_off' })
    expect(server.recordSkippedHomeTurn).toHaveBeenCalledOnce()
    server.planHomeTurn.mockResolvedValueOnce({ ok: false, reason: 'not_member' })
    expect(await hoisted.handler({ event: EVENT, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'not_member' })
    expect(server.recordSkippedHomeTurn).toHaveBeenCalledOnce()
    expect(server.claimHomeTurn).not.toHaveBeenCalled()
    expect(lines()).toEqual([expect.stringContaining('outcome=autonomy_off'), expect.stringContaining('outcome=not_member')])
  })

  it('while another home turn holds the conversation’s lease, it sleeps and plans again; it gives up after the last wait', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValueOnce({ kind: 'busy', holder: 'h' }).mockResolvedValueOnce({ kind: 'claimed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(3) } })
    server.finishHomeTurn.mockResolvedValue({ outcome: 'quiet', written: false })
    const step = createStepMock()
    expect(await hoisted.handler({ event: EVENT, step })).toMatchObject({ status: 'done' })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'plan-1', 'claim-1', 'send', 'finish'])
    expect(step.sleep).toHaveBeenCalledWith('lease-wait-1', '2m')

    server.claimHomeTurn.mockReset()
    server.claimHomeTurn.mockResolvedValue({ kind: 'busy', holder: 'h' })
    server.sendHomeTurn.mockClear()
    const step2 = createStepMock()
    expect(await hoisted.handler({ event: EVENT, step: step2 })).toEqual({ status: 'skipped', reason: 'busy' })
    expect(step2.sleep).toHaveBeenCalledTimes(15)
    expect(server.sendHomeTurn).not.toHaveBeenCalled()
  })

  it('a duplicate claim stops: nothing is sent', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValue({ kind: 'duplicate', status: 'done' })
    expect(await hoisted.handler({ event: EVENT, step: createStepMock() })).toEqual({ status: 'skipped', reason: 'duplicate' })
    expect(server.sendHomeTurn).not.toHaveBeenCalled()
  })

  it('sends, reads on from each step’s cursor until done, then finishes once', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: false, state: state(4) } })
    server.continueHomeTurn
      .mockResolvedValueOnce({ kind: 'read', result: { done: false, state: state(9) } })
      .mockResolvedValueOnce({ kind: 'read', result: { done: true, end: 'completed', state: state(12) } })
    server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
    const step = createStepMock()
    expect(await hoisted.handler({ event: EVENT, step })).toEqual({ status: 'done', outcome: 'written', rowId: 'row-1', written: true })
    expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'read-1', 'read-2', 'finish'])
    // Written: the router takes it to the person (no forward step of its own any more).
    expect(step.sendEvent.mock.calls).toEqual([ROUTE])
    expect(server.continueHomeTurn.mock.calls.map((c) => (c[4] as { nextIndex: number }).nextIndex)).toEqual([4, 9])
    expect(server.finishHomeTurn).toHaveBeenCalledWith({ db: true }, expect.objectContaining(IDS), ROW, { done: true, end: 'completed', state: state(12) }, expect.any(String), { prepOnly: false })
    expect(lines()).toEqual([expect.stringContaining('row=row-1 reports=1 outcome=written')])
  })

  it('a report that is only meeting preps is stamped prep_only (a banner, never a text); a mixed one is not', async () => {
    server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(3) } })
    server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
    const prep = { messageId: 'r1', report: { meeting: { start_iso: '2026-10-31T16:00:00.000Z', label: '12:00 PM EDT on Saturday, October 31' } } }
    server.planHomeTurn.mockResolvedValue({ ...PLAN, reports: [prep, { ...prep, messageId: 'r2' }] })
    await hoisted.handler({ event: EVENT, step: createStepMock() })
    expect(server.finishHomeTurn.mock.calls.at(-1)?.[5]).toEqual({ prepOnly: true })
    server.planHomeTurn.mockResolvedValue({ ...PLAN, reports: [prep, { messageId: 'r3', report: {} }] })
    await hoisted.handler({ event: EVENT, step: createStepMock() })
    expect(server.finishHomeTurn.mock.calls.at(-1)?.[5]).toEqual({ prepOnly: false })
  })

  it('a quiet turn, or one that wrote nothing it meant to, asks no route', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(3) } })
    for (const finished of [{ outcome: 'quiet', written: false }, { outcome: 'watch_exhausted', written: false }, { outcome: 'written', written: false }]) {
      server.finishHomeTurn.mockResolvedValue(finished)
      const step = createStepMock()
      await hoisted.handler({ event: EVENT, step })
      expect(step.sendEvent).not.toHaveBeenCalled()
    }
  })

  it('routes exactly the background reasons (never a text, Slack or linked agent turn: those answer where they came from)', () => {
    expect([...ROUTED_HOME_TURN_REASONS].sort()).toEqual(['agent_answer', 'approval', 'check_in', 'digest', 'event', 'guest_ask', 'helper_report'])
  })

  it('a steered turn logs how it ended', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValue({ kind: 'resumed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'steered', state: state(3) } })
    server.finishHomeTurn.mockResolvedValue({ outcome: 'steered_quiet', written: false })
    expect(await hoisted.handler({ event: EVENT, step: createStepMock() })).toMatchObject({ status: 'done', outcome: 'steered_quiet:steered' })
  })

  it('a failed send stops before finish', async () => {
    server.planHomeTurn.mockResolvedValue(PLAN)
    server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
    server.sendHomeTurn.mockResolvedValue({ kind: 'failed', error: 'send_refused_403' })
    expect(await hoisted.handler({ event: EVENT, step: createStepMock() })).toEqual({ status: 'failed', reason: 'send_refused_403', rowId: 'row-1' })
    expect(server.finishHomeTurn).not.toHaveBeenCalled()
  })

  describe('the daily digest (A6 slice 4)', () => {
    const DIGEST = { date: '2026-10-14', timeZone: 'Europe/London', counts: ['1 waiting on you'], lines: ['- x'], eventIds: ['7', '8'] }
    const DIGEST_EVENT = { data: { ...IDS, workItemIds: [], reason: 'digest', eventIds: ['7', '8'], digestDate: '2026-10-14' } }
    const DIGEST_PLAN = { ok: true, sessionId: 'sess', reports: [], workItemIds: [], dedupeKey: 'digest:2026-10-14', digest: DIGEST }

    beforeEach(() => {
      server.planHomeTurn.mockResolvedValue(DIGEST_PLAN)
      server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
      server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(5) } })
    })

    it('a written digest marks its rows delivered after the finish, then sends ONE face notice', async () => {
      server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
      const step = createStepMock()
      expect(await hoisted.handler({ event: DIGEST_EVENT, step })).toMatchObject({ status: 'done', outcome: 'written' })
      expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'finish', 'deliver-digest', 'digest-notice'])
      // The morning digest routes like any other message: texted when he is away.
      expect(step.sendEvent.mock.calls).toEqual([ROUTE])
      expect(digestLib.markDigestDelivered).toHaveBeenCalledWith({ db: true }, { workspaceId: IDS.workspaceId, userId: IDS.userId, eventIds: ['7', '8'], date: '2026-10-14', homeTurnId: 'row-1' })
      expect(digestLib.sendDigestNotice).toHaveBeenCalledOnce()
      expect(digestLib.sendDigestNotice).toHaveBeenCalledWith({ db: true }, { ...IDS, homeTurnId: 'row-1', digest: DIGEST })
    })

    it('a [quiet] digest delivers nothing (its rows stay for the away section) and sends no notice', async () => {
      server.finishHomeTurn.mockResolvedValue({ outcome: 'quiet', written: false })
      const step = createStepMock()
      await hoisted.handler({ event: DIGEST_EVENT, step })
      expect(digestLib.markDigestDelivered).not.toHaveBeenCalled()
      expect(digestLib.sendDigestNotice).not.toHaveBeenCalled()
    })

    it('a failed send delivers nothing (the rows wait for "while you were away")', async () => {
      server.sendHomeTurn.mockResolvedValue({ kind: 'failed', error: 'send_refused_403' })
      await hoisted.handler({ event: DIGEST_EVENT, step: createStepMock() })
      expect(digestLib.markDigestDelivered).not.toHaveBeenCalled()
      expect(digestLib.sendDigestNotice).not.toHaveBeenCalled()
    })

    it('a helper report never touches the digest steps', async () => {
      server.planHomeTurn.mockResolvedValue(PLAN)
      server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
      await hoisted.handler({ event: EVENT, step: createStepMock() })
      expect(digestLib.markDigestDelivered).not.toHaveBeenCalled()
      expect(digestLib.sendDigestNotice).not.toHaveBeenCalled()
    })
  })

  describe('events a turn covered are delivered (one telling)', () => {
    beforeEach(() => {
      server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
      server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(5) } })
    })

    it('a helper report turn marks its work items\' inbox rows delivered; a quiet one leaves what waits (a question, a failure, an approval)', async () => {
      server.planHomeTurn.mockResolvedValue({ ...PLAN, workItemIds: ['item-a', 'item-b'] })
      for (const [finished, exceptWaiting] of [[{ outcome: 'written', written: true }, false], [{ outcome: 'quiet', written: false }, true]] as const) {
        eventLib.markWorkEventsDelivered.mockClear()
        server.finishHomeTurn.mockResolvedValue(finished)
        const step = createStepMock()
        await hoisted.handler({ event: EVENT, step })
        // A written report is routed to the person; a quiet one sends nothing.
        expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'finish', 'deliver-work-events'])
        expect(step.sendEvent.mock.calls).toEqual(finished.written ? [ROUTE] : [])
        expect(eventLib.markWorkEventsDelivered).toHaveBeenCalledWith({ db: true }, { workspaceId: IDS.workspaceId, userId: IDS.userId, workItemIds: ['item-a', 'item-b'], homeTurnId: 'row-1', exceptWaiting })
      }
      expect(eventLib.markEventsDelivered).not.toHaveBeenCalled()
    })

    it('an event turn marks its rows delivered: all when it spoke; when [quiet], all but what still waits (so the next mail does not bring them back)', async () => {
      const EVENTS_EVENT = { data: { ...IDS, workItemIds: [], reason: 'event', eventIds: ['3', '4'] } }
      server.planHomeTurn.mockResolvedValue({ ok: true, sessionId: 'sess', reports: [], workItemIds: [], dedupeKey: 'event:x', events: { lines: ['- a', '- b'], eventIds: ['3', '4'] } })
      server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
      const step = createStepMock()
      await hoisted.handler({ event: EVENTS_EVENT, step })
      expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'finish', 'deliver-events'])
      expect(eventLib.markEventsDelivered).toHaveBeenCalledWith({ db: true }, { workspaceId: IDS.workspaceId, userId: IDS.userId, eventIds: ['3', '4'], homeTurnId: 'row-1', exceptWaiting: false })

      eventLib.markEventsDelivered.mockClear()
      server.finishHomeTurn.mockResolvedValue({ outcome: 'quiet', written: false })
      await hoisted.handler({ event: EVENTS_EVENT, step: createStepMock() })
      expect(eventLib.markEventsDelivered).toHaveBeenCalledWith({ db: true }, { workspaceId: IDS.workspaceId, userId: IDS.userId, eventIds: ['3', '4'], homeTurnId: 'row-1', exceptWaiting: true })
      expect(digestLib.markDigestDelivered).not.toHaveBeenCalled()

      // A turn that wrote nothing it meant to (cut off at the read cap, a refused write) delivers nothing (phase 2 review).
      for (const finished of [{ outcome: 'watch_exhausted', written: false }, { outcome: 'written', written: false }]) {
        eventLib.markEventsDelivered.mockClear()
        server.finishHomeTurn.mockResolvedValue(finished)
        await hoisted.handler({ event: EVENTS_EVENT, step: createStepMock() })
        expect(eventLib.markEventsDelivered).not.toHaveBeenCalled()
      }
    })

    it('an approval turn marks its calls carried, in the finish step that frees the lease, when it spoke or judged them done; one cut off carries none (445)', async () => {
      const APPROVAL_EVENT = { data: { ...IDS, workItemIds: [], reason: 'approval' } }
      server.planHomeTurn.mockResolvedValue({ ok: true, sessionId: 'sess', reports: [], workItemIds: [], dedupeKey: 'approval:x', approvals: { lines: ['approval_id a · t · ran'], approvalIds: ['a'] } })
      for (const finished of [{ outcome: 'written', written: true }, { outcome: 'quiet', written: false }]) {
        approvalLib.markApprovalsCarried.mockClear()
        server.finishHomeTurn.mockResolvedValue(finished)
        const step = createStepMock()
        await hoisted.handler({ event: APPROVAL_EVENT, step })
        // No step of its own (a waiting run never re-plans between them); routed when it spoke.
        expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'finish'])
        expect(step.sendEvent.mock.calls).toEqual(finished.written ? [ROUTE] : [])
        expect(approvalLib.markApprovalsCarried).toHaveBeenCalledWith({ db: true }, { approvalIds: ['a'], homeTurnId: 'row-1' })
      }
      approvalLib.markApprovalsCarried.mockClear()
      server.finishHomeTurn.mockResolvedValue({ outcome: 'watch_exhausted', written: false })
      await hoisted.handler({ event: APPROVAL_EVENT, step: createStepMock() })
      expect(approvalLib.markApprovalsCarried).not.toHaveBeenCalled()
    })
  })

  describe('the check-in (docs/plans/now-file.md): a reply delivers what it carried and sends one notice', () => {
    const CHECK_IN_EVENT = { data: { ...IDS, workItemIds: [], reason: 'check_in', checkInSlot: { date: '2026-10-27', hour: 12 } } }
    const CHECK_IN = { date: '2026-10-27', hour: 12, timeZone: 'UTC', revision: 3, lines: ['Line 5 (In flight), item work:w: - x (Oct 26)'], eventIds: ['7', '9'] }
    const CHECK_IN_PLAN = { ok: true, sessionId: 'sess-check-in', reports: [], workItemIds: [], dedupeKey: 'check_in:2026-10-27:12', checkIn: CHECK_IN }

    beforeEach(() => {
      checkInLib.sendCheckInNotice.mockClear()
      server.planHomeTurn.mockResolvedValue(CHECK_IN_PLAN)
      server.claimHomeTurn.mockResolvedValue({ kind: 'claimed', row: ROW })
      server.sendHomeTurn.mockResolvedValue({ kind: 'read', result: { done: true, end: 'completed', state: state(5) } })
    })

    it('a written check-in marks its events delivered (as a written event turn does), sends ONE agent_check_in notice, and is routed', async () => {
      server.finishHomeTurn.mockResolvedValue({ outcome: 'written', written: true })
      const step = createStepMock()
      expect(await hoisted.handler({ event: CHECK_IN_EVENT, step })).toMatchObject({ status: 'done', outcome: 'written' })
      expect(step.run.mock.calls.map(([id]) => id)).toEqual(['plan', 'claim', 'send', 'finish', 'deliver-check-in', 'check-in-notice'])
      expect(eventLib.markEventsDelivered).toHaveBeenCalledWith({ db: true }, { workspaceId: IDS.workspaceId, userId: IDS.userId, eventIds: ['7', '9'], homeTurnId: 'row-1' })
      expect(checkInLib.sendCheckInNotice).toHaveBeenCalledOnce()
      expect(checkInLib.sendCheckInNotice).toHaveBeenCalledWith({ db: true }, { ...IDS, homeTurnId: 'row-1', date: '2026-10-27', hour: 12 })
      expect(step.sendEvent.mock.calls).toEqual([ROUTE])
      // Its label is its own.
      expect(server.finishHomeTurn.mock.calls[0][4]).toBe('Check-in')
    })

    it('a check-in that called no_reply (or wrote nothing it meant to) marks nothing and sends nothing: its events still show in the away section and the digest', async () => {
      for (const finished of [{ outcome: 'quiet', written: false }, { outcome: 'steered_quiet', written: false }, { outcome: 'watch_exhausted', written: false }, { outcome: 'written', written: false }]) {
        eventLib.markEventsDelivered.mockClear()
        checkInLib.sendCheckInNotice.mockClear()
        server.finishHomeTurn.mockResolvedValue(finished)
        await hoisted.handler({ event: CHECK_IN_EVENT, step: createStepMock() })
        expect(eventLib.markEventsDelivered).not.toHaveBeenCalled()
        expect(checkInLib.sendCheckInNotice).not.toHaveBeenCalled()
      }
    })
  })
})
