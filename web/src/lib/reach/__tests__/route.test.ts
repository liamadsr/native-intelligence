/**
 * The router (src/lib/reach/route.ts, docs/plans/reach-follows-you.md §3 and
 * §7), over fake deps. Pinned: seen messages stay put (the marker, or his own
 * message after them from any channel); present → one banner, then a recheck;
 * away → the channel he last talked on, then a text, then Slack; a text needs
 * the away words; quiet hours hold routine messages until 08:05 and let an
 * urgent one through (Jess at 21:07 about a 09:00 call); each message is
 * claimed once, oldest first, its final answer and its approvals' codes; the
 * kill switch sends nothing; and nothing caps the person.
 */
import { describe, expect, it, vi } from 'vitest'
import type { ChannelApproval } from '@/lib/attention/channel-approvals'
import type { PresenceRow } from '@/lib/presence/presence'
import {
  QUIET_RELEASE_MS,
  REACH_ROUTE_EVENT,
  parseRouteRequested,
  pickRouteChannel,
  planRoute,
  routeChoice,
  routeLive,
  routeLogLine,
  routeRequestEvent,
  type LatestUserMessage,
  type RouteChannel,
  type RouteDeps,
  type RouteTargets,
} from '../route'
import type { OutboundMessage, RouteRef, RouteRow } from '../route-policy'

const DATA = {
  userId: '22222222-2222-4222-8222-222222222222',
  workspaceId: '33333333-3333-4333-8333-333333333333',
  conversationId: '11111111-1111-4111-8111-111111111111',
}
const NY = 'America/New_York'
/** A wall-clock time in New York on 2026-10-28 (EDT, UTC-4), or another day. */
const ny = (hhmm: string, day = 28) => Date.parse(`2026-10-${String(day).padStart(2, '0')}T${hhmm}:00-04:00`)
const SLACK = { installationId: 'inst-1', slackUserId: 'U1' }
const APPROVAL: ChannelApproval = { approvalId: '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b', cardId: 'card-1', title: 'Cancel the call with Ken', why: 'it deletes a calendar event' }

let seq = 0
const rid = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`
const text = (t: string) => ({ type: 'text', text: t })
const tool = { type: 'dynamic-tool', toolName: 'get_calendar_events', toolCallId: 'c0', state: 'output-available', input: {}, output: {} }
const heldPart = (approvalId = APPROVAL.approvalId) => ({
  type: 'dynamic-tool',
  toolName: 'delete_calendar_event',
  toolCallId: 'c1',
  state: 'output-available',
  input: {},
  output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: approvalId, message: 'Nothing ran.' },
})
/** A home turn's written message at `at`. */
const homeTurn = (at: number, words: string, extra: { reason?: string; parts?: unknown[]; meta?: Record<string, unknown> } = {}): RouteRow => ({
  id: rid(),
  created_at: new Date(at).toISOString(),
  ui_message: { id: `home-turn:${seq}`, parts: extra.parts ?? [text(words)], metadata: { kind: 'home_turn', reason: extra.reason ?? 'event', ...extra.meta } },
})

interface World {
  now: number
  rows: RouteRow[]
  seenAt?: string | null
  latest?: LatestUserMessage | null
  presence?: PresenceRow[]
  targets?: Partial<RouteTargets>
  zone?: string | null
  pending?: ChannelApproval[]
  /** Pre-claimed refs: `<type>:<id>:<channel>`. */
  claims?: string[]
  claimResult?: 'taken' | 'unavailable'
  home?: boolean
}

function harness(world: World) {
  const claims = new Set(world.claims ?? [])
  const sent: Array<{ channel: RouteChannel; message: OutboundMessage<ChannelApproval> }> = []
  const banners: Array<{ rowId: string; messageId: string | null; preview: string | null; count: number }> = []
  const claimCalls: Array<{ ref: RouteRef; channel: RouteChannel | 'banner'; urgent: boolean }> = []
  const deps: RouteDeps = {
    now: () => world.now,
    thread: vi.fn(async () => (world.home === false ? null : { seenAt: world.seenAt ?? null })),
    latestUserMessage: vi.fn(async () => world.latest ?? null),
    messagesSince: vi.fn(async ({ sinceIso, limit }) =>
      world.rows
        .filter((r) => Date.parse(r.created_at) > Date.parse(sinceIso))
        .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
        .slice(0, limit),
    ),
    claimed: vi.fn(async ({ refs }: { refs: RouteRef[] }) => new Set<string>(refs.filter((r) => [...claims].some((c) => c.startsWith(`${r.type}:${r.id}:`))).map((r) => `${r.type}:${r.id}`))),
    pendingApprovals: vi.fn(async ({ approvalIds }) => new Map((world.pending ?? []).filter((a) => approvalIds.includes(a.approvalId)).map((a) => [a.approvalId, a]))),
    presence: vi.fn(async () => world.presence ?? []),
    targets: vi.fn(async (): Promise<RouteTargets> => ({ push: false, sms: 'away', slack: null, ...world.targets })),
    timeZone: vi.fn(async () => (world.zone === undefined ? NY : world.zone)),
    claim: vi.fn(async ({ ref, channel, urgent }) => {
      claimCalls.push({ ref, channel, urgent })
      if (world.claimResult) return world.claimResult
      const key = `${ref.type}:${ref.id}:${channel}`
      if (claims.has(key)) return 'taken' as const
      claims.add(key)
      return 'claimed' as const
    }),
    send: vi.fn(async ({ channel, message }) => {
      sent.push({ channel, message })
      return true
    }),
    banner: vi.fn(async ({ rowId, messageId, preview, count }) => {
      banners.push({ rowId, messageId, preview, count })
      return true
    }),
  }
  return { deps, sent, banners, claimCalls, claims }
}

const active = (at: number): PresenceRow => ({ client_id: 'client-web-1', surface: 'web', state: 'active', active_at: new Date(at).toISOString(), updated_at: new Date(at).toISOString() })

describe('the event', () => {
  it('carries three ids, keyed per message so a retried writer sends once', () => {
    expect(parseRouteRequested(DATA)).toEqual(DATA)
    expect(parseRouteRequested({ ...DATA, userId: 'nope' })).toBeNull()
    expect(parseRouteRequested(null)).toBeNull()
    expect(routeRequestEvent({ ...DATA, extra: 'x' } as never, 'home-turn:r1')).toEqual({ name: REACH_ROUTE_EVENT, data: DATA, id: 'reach-route:home-turn:r1' })
    expect(routeRequestEvent(DATA)).toEqual({ name: REACH_ROUTE_EVENT, data: DATA })
  })

  it('is live unless REACH_ROUTE_LIVE is off (a kill switch, never a shadow default)', () => {
    expect(routeLive({})).toBe(true)
    expect(routeLive({ REACH_ROUTE_LIVE: 'on' })).toBe(true)
    expect(routeLive({ REACH_ROUTE_LIVE: ' OFF ' })).toBe(false)
  })
})

describe('seen', () => {
  it('nothing goes for a message no newer than the seen marker', async () => {
    const m = homeTurn(ny('14:00'), 'Is the car drop-off off?')
    const h = harness({ now: ny('14:05'), rows: [m], seenAt: new Date(ny('14:01')).toISOString() })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    expect(h.sent).toEqual([])
  })

  it('nor once he wrote in the thread after it, from any channel (a text counts)', async () => {
    const m = homeTurn(ny('14:00'), 'Is the car drop-off off?')
    const h = harness({ now: ny('14:05'), rows: [m], latest: { createdAt: new Date(ny('14:03')).toISOString(), channel: 'sms' } })
    expect((await planRoute(DATA, h.deps)).kind).toBe('done')
    expect(h.sent).toEqual([])
  })

  it('a thread that is not his home thread routes nothing', async () => {
    const h = harness({ now: ny('14:05'), rows: [homeTurn(ny('14:00'), 'x')], home: false })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'not_home', rows: 0 })
  })
})

describe('present', () => {
  it('one banner for the newest message, then a recheck; no text', async () => {
    const a = homeTurn(ny('14:00'), 'First.')
    const b = homeTurn(ny('14:01'), 'Want me to cancel your call with Ken?')
    const h = harness({ now: ny('14:03'), rows: [a, b], presence: [active(ny('14:02'))] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'banner', rows: 2, bannered: true })
    // Its ui message id rides along: a click lands on that message (lib/chat/home-message.ts).
    expect(h.banners).toEqual([{ rowId: b.id, messageId: b.ui_message!.id, preview: 'Want me to cancel your call with Ken?', count: 2 }])
    expect(h.sent).toEqual([])
  })

  it('no banner of its own for what already notified (a digest); still a recheck, since it could be texted', async () => {
    const h = harness({ now: ny('08:03'), rows: [homeTurn(ny('08:00'), 'Morning.', { reason: 'digest' })], presence: [active(ny('08:02'))] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'banner', rows: 1, bannered: false })
    expect(h.banners).toEqual([])
  })

  it('a stale ping or an idle desktop is away', async () => {
    const stale = harness({ now: ny('14:20'), rows: [homeTurn(ny('14:10'), 'x')], presence: [active(ny('14:00'))] })
    expect((await planRoute(DATA, stale.deps)).kind).toBe('sent')
    const idle = harness({ now: ny('14:20'), rows: [homeTurn(ny('14:10'), 'x')], presence: [{ ...active(ny('14:19')), state: 'idle' }] })
    expect((await planRoute(DATA, idle.deps)).kind).toBe('sent')
  })
})

describe('away: the channel', () => {
  it('a text first when his phone takes the away texts, one per message, claimed as the message', async () => {
    const m = homeTurn(ny('14:00'), 'Want me to cancel your call with Ken?')
    const h = harness({ now: ny('14:02'), rows: [m], targets: { sms: 'away', slack: SLACK } })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'sent', channel: 'sms', sent: 1, failed: 0, skipped: 0, urgent: false, rowIds: [m.id] })
    expect(h.sent).toEqual([{ channel: 'sms', message: { text: 'Want me to cancel your call with Ken?', approvals: [] } }])
    expect(h.claimCalls).toEqual([{ ref: { type: 'home_message', id: m.id }, channel: 'sms', urgent: false }])
  })

  it('without consent at the new words: Slack, or nothing', async () => {
    const slack = harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), 'x')], targets: { sms: null, slack: SLACK } })
    expect(await planRoute(DATA, slack.deps)).toMatchObject({ kind: 'sent', channel: 'slack' })
    const none = harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), 'x')], targets: { sms: null, slack: null } })
    expect(await planRoute(DATA, none.deps)).toEqual({ kind: 'done', outcome: 'no_channel', rows: 1 })
    expect(none.sent).toEqual([])
  })

  it('sticks to Slack when he last talked there (within 12 h, after his last app activity)', async () => {
    const latest = { createdAt: new Date(ny('11:00')).toISOString(), channel: 'slack' }
    const rows = [homeTurn(ny('14:00'), 'Report is ready.')]
    expect(await planRoute(DATA, harness({ now: ny('14:02'), rows, latest, targets: { sms: 'away', slack: SLACK } }).deps)).toMatchObject({ channel: 'slack' })
    // Typing in the app since takes it back to the default order.
    const backInApp = harness({ now: ny('14:02'), rows, latest, presence: [active(ny('12:00'))], targets: { sms: 'away', slack: SLACK } })
    expect(await planRoute(DATA, backInApp.deps)).toMatchObject({ channel: 'sms' })
    // Older than 12 h: the default order.
    const old = { createdAt: new Date(ny('01:00')).toISOString(), channel: 'slack' }
    expect(await planRoute(DATA, harness({ now: ny('14:02'), rows, latest: old, targets: { sms: 'away', slack: SLACK } }).deps)).toMatchObject({ channel: 'sms' })
  })

  it('sticks to a text when he last texted, even with Slack linked', () => {
    const latest = { createdAt: new Date(ny('13:00')).toISOString(), channel: 'sms' }
    expect(pickRouteChannel({ targets: { push: false, sms: 'away', slack: SLACK }, latest, presence: [], nowMs: ny('14:00') })).toBe('sms')
    // ...but never a text he hasn't agreed to: Slack then.
    expect(pickRouteChannel({ targets: { push: false, sms: null, slack: SLACK }, latest, presence: [], nowMs: ny('14:00') })).toBe('slack')
  })

  it('orders push (the iOS app) before a text; without a live install, a text as before', () => {
    expect(pickRouteChannel({ targets: { push: true, sms: 'away', slack: SLACK }, latest: null, presence: [], nowMs: ny('14:00') })).toBe('push')
    expect(pickRouteChannel({ targets: { push: false, sms: 'away', slack: SLACK }, latest: null, presence: [], nowMs: ny('14:00') })).toBe('sms')
    expect(pickRouteChannel({ targets: { push: false, sms: null, slack: null }, latest: null, presence: [], nowMs: ny('14:00') })).toBeNull()
    // The channel he last talked on still wins over push.
    const latest = { createdAt: new Date(ny('13:00')).toISOString(), channel: 'sms' }
    expect(pickRouteChannel({ targets: { push: true, sms: 'away', slack: SLACK }, latest, presence: [], nowMs: ny('14:00') })).toBe('sms')
  })

  it('a message carrying an approval goes where a plain yes answers it: a text, Slack, then push', () => {
    expect(routeChoice({ targets: { push: true, sms: 'away', slack: SLACK }, sticky: null, asks: true })).toEqual({ channel: 'sms' })
    expect(routeChoice({ targets: { push: true, sms: null, slack: SLACK }, sticky: null, asks: true })).toEqual({ channel: 'slack' })
    expect(routeChoice({ targets: { push: true, sms: null, slack: null }, sticky: null, asks: true })).toEqual({ channel: 'push' })
  })
})

describe('away: push (the iOS app)', () => {
  it('a live install: the message goes by push, claimed on push, nothing texted', async () => {
    const m = homeTurn(ny('13:00'), 'Ken moved to Friday.')
    const h = harness({ now: ny('14:00'), rows: [m], targets: { push: true, sms: 'away' } })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', channel: 'push', sent: 1, rowIds: [m.id] })
    expect(h.sent).toEqual([{ channel: 'push', message: { text: 'Ken moved to Friday.', approvals: [] } }])
    expect(h.claimCalls.map((c) => c.channel)).toEqual(['push'])
    expect(h.deps.send).toHaveBeenCalledWith(expect.objectContaining({ conversationId: DATA.conversationId, channel: 'push' }))
  })

  it('no live install (or push not set up): exactly as before, a text', async () => {
    const h = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:00'), 'x')], targets: { push: false, sms: 'away' } })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', channel: 'sms', sent: 1 })
    expect(h.claimCalls.map((c) => c.channel)).toEqual(['sms'])
  })

  it('a push that doesn’t go falls through to the next channel, claimed there too, once', async () => {
    const m = homeTurn(ny('13:00'), 'Ken moved to Friday.')
    const h = harness({ now: ny('14:00'), rows: [m], targets: { push: true, sms: 'away', slack: SLACK } })
    ;(h.deps.send as ReturnType<typeof vi.fn>).mockImplementation(async ({ channel, message }: { channel: RouteChannel; message: OutboundMessage<ChannelApproval> }) => {
      h.sent.push({ channel, message })
      return channel !== 'push'
    })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 1, failed: 0, rowIds: [m.id] })
    expect(h.sent.map((s) => s.channel)).toEqual(['push', 'sms'])
    expect(h.claimCalls.map((c) => c.channel)).toEqual(['push', 'sms'])
    // Done for good: the next run finds it claimed.
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
  })

  it('a push that doesn’t go with nowhere else to fall: failed, at most once', async () => {
    const h = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:00'), 'x')], targets: { push: true, sms: null, slack: null } })
    ;(h.deps.send as ReturnType<typeof vi.fn>).mockResolvedValue(false)
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', channel: 'push', sent: 0, failed: 1 })
    expect(h.deps.send).toHaveBeenCalledTimes(1)
  })

  it('an approval still goes by text with push set up (a plain yes answers it there)', async () => {
    const turn = homeTurn(ny('13:30'), '', { parts: [text('Dana wants Friday.'), heldPart()] })
    const h = harness({ now: ny('14:00'), rows: [turn], pending: [APPROVAL], targets: { push: true, sms: 'away' } })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', channel: 'sms', sent: 1 })
    expect(h.sent).toEqual([{ channel: 'sms', message: { text: 'Dana wants Friday.', approvals: [APPROVAL] } }])
  })
})

describe('away: what goes', () => {
  it('oldest first, each its final answer (never the narration), with each pending approval it held', async () => {
    const a = homeTurn(ny('13:00'), '', { parts: [text('Let me check his calendar first.'), tool, text('Ken moved to Friday.')] })
    const b = homeTurn(ny('13:30'), '', { parts: [text('I put the cancellation up for your OK.'), heldPart()] })
    const h = harness({ now: ny('14:00'), rows: [b, a], pending: [APPROVAL] })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 2, rowIds: [a.id, b.id] })
    expect(h.sent.map((s) => s.message)).toEqual([
      { text: 'Ken moved to Friday.', approvals: [] },
      { text: 'I put the cancellation up for your OK.', approvals: [APPROVAL] },
    ])
    expect(h.sent[0].message.text).not.toContain('Let me check')
    // The approval is claimed too, so a text turn's own prompt for it never repeats.
    expect(h.claimCalls.map((c) => c.ref)).toEqual([
      { type: 'home_message', id: a.id },
      { type: 'home_message', id: b.id },
      { type: 'tool_approval', id: APPROVAL.approvalId },
    ])
  })

  it('an approval answered meanwhile drops out: its code is not sent, and an ask with nothing else says nothing', async () => {
    const turn = homeTurn(ny('13:30'), '', { parts: [text('Dana wants Friday.'), heldPart()] })
    const ask: RouteRow = {
      id: rid(),
      created_at: new Date(ny('13:40')).toISOString(),
      ui_message: { id: `approval-ask-${APPROVAL.approvalId}`, parts: [text('One of your loops stopped here for your yes.')], metadata: { kind: 'ask_card', approval_id: APPROVAL.approvalId } },
    }
    const h = harness({ now: ny('14:00'), rows: [turn, ask], pending: [] })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 1, rowIds: [turn.id] })
    expect(h.sent.map((s) => s.message)).toEqual([{ text: 'Dana wants Friday.', approvals: [] }])
  })

  it('an approval asked at home goes with its line and its code, claimed once as the approval', async () => {
    const ask: RouteRow = {
      id: rid(),
      created_at: new Date(ny('13:40')).toISOString(),
      ui_message: { id: `approval-ask-${APPROVAL.approvalId}`, parts: [text('One of your loops stopped here for your yes.')], metadata: { kind: 'ask_card', approval_id: APPROVAL.approvalId } },
    }
    const h = harness({ now: ny('14:00'), rows: [ask], pending: [APPROVAL] })
    await planRoute(DATA, h.deps)
    expect(h.sent.map((s) => s.message)).toEqual([{ text: 'One of your loops stopped here for your yes.', approvals: [APPROVAL] }])
    expect(h.claimCalls.map((c) => c.ref)).toEqual([{ type: 'tool_approval', id: APPROVAL.approvalId }])
  })

  it('a held approval a text turn already sent on this channel goes without its code', async () => {
    const turn = homeTurn(ny('13:30'), '', { parts: [text('Dana wants Friday.'), heldPart()] })
    const h = harness({ now: ny('14:00'), rows: [turn], pending: [APPROVAL], claims: [`tool_approval:${APPROVAL.approvalId}:sms`] })
    await planRoute(DATA, h.deps)
    expect(h.sent.map((s) => s.message)).toEqual([{ text: 'Dana wants Friday.', approvals: [] }])
  })

  it('a message claimed already (on any channel) is skipped; a lost race sends nothing; a ledger that can’t be written sends nothing', async () => {
    const m = homeTurn(ny('13:00'), 'x')
    const claimed = harness({ now: ny('14:00'), rows: [m], claims: [`home_message:${m.id}:slack`] })
    expect(await planRoute(DATA, claimed.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    const raced = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:00'), 'x')], claimResult: 'taken' })
    expect(await planRoute(DATA, raced.deps)).toMatchObject({ kind: 'sent', sent: 0, failed: 0, skipped: 1 })
    expect(raced.sent).toEqual([])
    const down = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:00'), 'x')], claimResult: 'unavailable' })
    expect(await planRoute(DATA, down.deps)).toMatchObject({ kind: 'sent', sent: 0, skipped: 1 })
    expect(down.sent).toEqual([])
  })

  it('a send that fails after its claim is not retried (at most once)', async () => {
    const m = homeTurn(ny('13:00'), 'x')
    const h = harness({ now: ny('14:00'), rows: [m] })
    ;(h.deps.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 0, failed: 1 })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
  })

  // A plain "yes" by text answers only asks that reached the phone (src/lib/sms/approvals.ts).
  it('a text that fails takes back its approvals’ text claims, never the message’s own', async () => {
    const turn = homeTurn(ny('13:30'), '', { parts: [text('Dana wants Friday.'), heldPart()] })
    const h = harness({ now: ny('14:00'), rows: [turn], pending: [APPROVAL] })
    const released: unknown[] = []
    h.deps.releaseTexted = vi.fn(async (input) => {
      released.push(input)
    })
    ;(h.deps.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false)
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 0, failed: 1 })
    expect(released).toEqual([{ userId: DATA.userId, approvalId: APPROVAL.approvalId }])
    // The message itself stays claimed: at most once.
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    // A text that went keeps them.
    const ok = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:30'), '', { parts: [text('x'), heldPart()] })], pending: [APPROVAL] })
    ok.deps.releaseTexted = vi.fn(async () => {})
    await planRoute(DATA, ok.deps)
    expect(ok.deps.releaseTexted).not.toHaveBeenCalled()
  })

  it('a look-ahead with no text: nothing to do (no text, and no banner of its own: it already notified)', async () => {
    const look: RouteRow = { id: rid(), created_at: new Date(ny('19:00')).toISOString(), ui_message: { id: 'look-ahead:2026-10-29', parts: [text('**For tomorrow**')], metadata: { kind: 'look_ahead' } } }
    const h = harness({ now: ny('19:02'), rows: [look] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    expect(h.sent).toEqual([])
    expect(h.banners).toEqual([])
  })

  it('a prep-only report away: a banner in the app, never a text, and done once bannered (settled on banner)', async () => {
    const prep = homeTurn(ny('13:00'), 'Your prep for the 3:00 PM meeting is ready.', { reason: 'helper_report', meta: { prep_only: true } })
    const h = harness({ now: ny('13:02'), rows: [prep] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'banner_only', rows: 1 })
    expect(h.sent).toEqual([])
    expect(h.banners).toHaveLength(1)
    expect(h.claimCalls).toEqual([{ ref: { type: 'home_message', id: prep.id }, channel: 'banner', urgent: false }])
    // The next run finds it settled: no second banner, never a text.
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    expect(h.banners).toHaveLength(1)
  })

  it('no cap on the person: thirty messages all go', async () => {
    const rows = Array.from({ length: 30 }, (_, i) => homeTurn(ny('10:00') + i * 60_000, `Message ${i}`))
    const h = harness({ now: ny('11:00'), rows })
    const first = await planRoute(DATA, h.deps)
    expect(first).toMatchObject({ kind: 'sent', sent: 25 })
    const second = await planRoute(DATA, h.deps)
    expect(second).toMatchObject({ kind: 'sent', sent: 5 })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'done', outcome: 'nothing' })
    expect(h.sent.map((s) => s.message.text)).toEqual(rows.map((_, i) => `Message ${i}`))
  })
})

describe('quiet hours', () => {
  it('a routine message at night waits until 08:05 his time, on every channel', async () => {
    const m = homeTurn(ny('23:00'), 'Your report is ready.')
    const h = harness({ now: ny('23:02'), rows: [m] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'wait', untilMs: ny('08:00', 29) + QUIET_RELEASE_MS, rows: 1, channel: 'sms' })
    const slack = harness({ now: ny('23:02'), rows: [m], targets: { sms: null, slack: SLACK } })
    expect(await planRoute(DATA, slack.deps)).toMatchObject({ kind: 'wait', channel: 'slack' })
    expect(h.sent).toEqual([])
  })

  it('Jess at 21:07 about a 09:00 call: texted at 21:09, marked urgent; the routine ones wait', async () => {
    const routine = homeTurn(ny('21:00'), 'Your evening brief is ready.')
    const jess = homeTurn(ny('21:07'), 'Jess moved the 9:00 call with Ken to 8:30.', { meta: { urgent_by: '2026-10-29T09:00:00-04:00' } })
    const h = harness({ now: ny('21:09'), rows: [routine, jess] })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'sent', channel: 'sms', sent: 1, failed: 0, skipped: 0, urgent: true, rowIds: [jess.id] })
    expect(h.claimCalls).toEqual([{ ref: { type: 'home_message', id: jess.id }, channel: 'sms', urgent: true }])
    // The next round: only the routine one is left, and it waits.
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'wait', untilMs: ny('08:00', 29) + QUIET_RELEASE_MS, rows: 1 })
  })

  it('an urgent deadline too far out (past 10:00, or past 18 h) waits like any other', async () => {
    const noon = homeTurn(ny('22:00'), 'The lunch is moved.', { meta: { urgent_by: '2026-10-29T12:00:00-04:00' } })
    expect(await planRoute(DATA, harness({ now: ny('22:02'), rows: [noon] }).deps)).toMatchObject({ kind: 'wait' })
    const past = homeTurn(ny('22:00'), 'Already over.', { meta: { urgent_by: '2026-10-28T21:30:00-04:00' } })
    expect(await planRoute(DATA, harness({ now: ny('22:02'), rows: [past] }).deps)).toMatchObject({ kind: 'wait' })
  })

  it('a three-day absence: by day each goes as it comes; at night they batch with the digest at 08:05', async () => {
    const all: RouteRow[] = []
    const h = harness({ now: 0, rows: all })
    const at = async (now: number, ...rows: RouteRow[]) => {
      all.push(...rows)
      h.deps.now = () => now
      return planRoute(DATA, h.deps)
    }
    for (const day of [28, 29, 30]) {
      expect(await at(ny('14:02', day), homeTurn(ny('14:00', day), `Day ${day} afternoon.`))).toMatchObject({ kind: 'sent', sent: 1 })
      expect(await at(ny('23:02', day), homeTurn(ny('23:00', day), `Day ${day} night.`))).toMatchObject({ kind: 'wait', untilMs: ny('08:00', day + 1) + QUIET_RELEASE_MS })
      expect(await at(ny('02:00', day + 1), homeTurn(ny('01:58', day + 1), `Day ${day + 1} small hours.`))).toMatchObject({ kind: 'wait', rows: 2 })
      const morning = await at(ny('08:05', day + 1), homeTurn(ny('08:00', day + 1), `Digest ${day + 1}.`, { reason: 'digest' }))
      expect(morning).toMatchObject({ kind: 'sent', sent: 3 })
    }
    expect(h.sent.map((s) => s.message.text)).toEqual([
      'Day 28 afternoon.', 'Day 28 night.', 'Day 29 small hours.', 'Digest 29.',
      'Day 29 afternoon.', 'Day 29 night.', 'Day 30 small hours.', 'Digest 30.',
      'Day 30 afternoon.', 'Day 30 night.', 'Day 31 small hours.', 'Digest 31.',
    ])
  })
})

describe('the kill switch', () => {
  it('REACH_ROUTE_LIVE=off: it decides and logs, and sends nothing (no banner, no claim, no text)', async () => {
    const away = harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), 'x')] })
    expect(await planRoute(DATA, away.deps, { live: false })).toEqual({ kind: 'done', outcome: 'off', rows: 1, would: { action: 'send', channel: 'sms', rows: 1 } })
    const present = harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), 'x')], presence: [active(ny('14:01'))] })
    expect(await planRoute(DATA, present.deps, { live: false })).toMatchObject({ outcome: 'off', would: { action: 'banner' } })
    const night = harness({ now: ny('23:02'), rows: [homeTurn(ny('23:00'), 'x')] })
    expect(await planRoute(DATA, night.deps, { live: false })).toMatchObject({ outcome: 'off', would: { action: 'wait', channel: 'sms' } })
    for (const h of [away, present, night]) {
      expect(h.sent).toEqual([])
      expect(h.banners).toEqual([])
      expect(h.claimCalls).toEqual([])
    }
  })
})

describe('the decision is a step output', () => {
  it('carries ids and counts, never a message’s words', async () => {
    const words = 'Want me to cancel your call with Ken?'
    const away = await planRoute(DATA, harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), words)] }).deps)
    const present = await planRoute(DATA, harness({ now: ny('14:02'), rows: [homeTurn(ny('14:00'), words)], presence: [active(ny('14:01'))] }).deps)
    for (const d of [away, present]) expect(JSON.stringify(d)).not.toContain('Ken')
    expect(routeLogLine({ data: DATA, rounds: 2, outcome: 'nothing', sent: 1, channel: 'sms' })).toBe(
      `[reach-route] user=${DATA.userId} conversation=${DATA.conversationId} rounds=2 outcome=nothing sent=1 channel=sms`,
    )
    expect(routeLogLine({ data: null, rounds: 0, outcome: 'off', would: { action: 'send', channel: 'sms', rows: 2, urgent: true } })).toContain('would=send:sms:2:urgent')
  })
})

describe('present but never opened: done for good', () => {
  it('the last recheck, still at an app: what the banner covered is settled on banner, and no later run texts it', async () => {
    const a = homeTurn(ny('14:00'), 'Is the car drop-off off?')
    const b = homeTurn(ny('14:30'), 'Want me to cancel your call with Ken?')
    const h = harness({ now: ny('16:35'), rows: [a, b], presence: [active(ny('16:34'))] })
    expect(await planRoute(DATA, h.deps, { settle: true })).toEqual({ kind: 'done', outcome: 'present_unread', rows: 2 })
    expect(h.claimCalls).toEqual([
      { ref: { type: 'home_message', id: a.id }, channel: 'banner', urgent: false },
      { ref: { type: 'home_message', id: b.id }, channel: 'banner', urgent: false },
    ])
    // He leaves; the next message's run texts only the next message.
    const c = homeTurn(ny('18:00'), 'Dana replied.')
    h.deps.now = () => ny('18:02')
    ;(h.deps.presence as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const rows = [a, b, c]
    ;(h.deps.messagesSince as ReturnType<typeof vi.fn>).mockImplementation(async ({ sinceIso }: { sinceIso: string }) => rows.filter((r) => Date.parse(r.created_at) > Date.parse(sinceIso)))
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 1, rowIds: [c.id] })
    expect(h.sent.map((x) => x.message.text)).toEqual(['Dana replied.'])
  })

  it('gone by the last recheck: texted as usual, nothing settled', async () => {
    const a = homeTurn(ny('14:00'), 'Is the car drop-off off?')
    const h = harness({ now: ny('16:05'), rows: [a] })
    expect(await planRoute(DATA, h.deps, { settle: true })).toMatchObject({ kind: 'sent', sent: 1 })
    expect(h.claimCalls.map((c) => c.channel)).toEqual(['sms'])
  })

  it('the evening look-ahead bannered at his Mac is never texted the next morning; the digest is', async () => {
    const look: RouteRow = {
      id: rid(),
      created_at: new Date(ny('19:00')).toISOString(),
      ui_message: { id: 'look-ahead:2026-10-29', parts: [text('**For tomorrow morning**')], metadata: { kind: 'look_ahead', look_ahead_sms: 'Tomorrow morning:\n7:30 am: Pick up rental car.', look_ahead_until: new Date(ny('21:00')).toISOString() } },
    }
    const event = homeTurn(ny('18:30'), 'Rita asked for the signed SOW by Thursday.')
    const rows = [event, look]
    const h = harness({ now: ny('19:05'), rows, presence: [active(ny('19:04'))] })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'banner' })
    // 21:05, still at his Mac: the run's last recheck settles the event; the look-ahead is past its shelf life already.
    h.deps.now = () => ny('21:05')
    ;(h.deps.presence as ReturnType<typeof vi.fn>).mockResolvedValue([active(ny('21:04'))])
    expect(await planRoute(DATA, h.deps, { settle: true })).toEqual({ kind: 'done', outcome: 'present_unread', rows: 1 })
    // 08:05, away: the digest's run texts the digest alone.
    rows.push(homeTurn(ny('08:00', 29), 'Morning: two things wait on you.', { reason: 'digest' }))
    h.deps.now = () => ny('08:05', 29)
    ;(h.deps.presence as ReturnType<typeof vi.fn>).mockResolvedValue([])
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 1 })
    expect(h.sent.map((x) => x.message.text)).toEqual(['Morning: two things wait on you.'])
  })

  it('even without a settling run (cancelled, or never present), a look-ahead past its shelf life never goes out', async () => {
    const heads: RouteRow = {
      id: rid(),
      created_at: new Date(ny('20:58')).toISOString(),
      ui_message: { id: `look-ahead:travel:k1:2026-10-29T03:58:00.000Z`, parts: [text('x')], metadata: { kind: 'look_ahead', look_ahead_sms: 'In about 3 hours: 11:58 pm: Flight.', look_ahead_until: '2026-10-29T03:58:00.000Z' } },
    }
    // Held by quiet hours from 21:00, then 08:05: the departure is long gone.
    const h = harness({ now: ny('21:00'), rows: [heads] })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'wait' })
    h.deps.now = () => ny('08:05', 29)
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'nothing', rows: 0 })
    expect(h.sent).toEqual([])
  })
})

describe('a linked phone is enough: no second switch for texts while he is away (Liam, 2026-10-31)', () => {
  it('every message goes whole by text to a phone that hasn’t said STOP, its approvals’ codes with it', async () => {
    const plain = homeTurn(ny('13:00'), 'Rita asked for the SOW.')
    const turn = homeTurn(ny('13:20'), '', { parts: [text('Dana wants Friday.'), heldPart()] })
    const h = harness({ now: ny('14:00'), rows: [plain, turn], pending: [APPROVAL], targets: { sms: 'away', slack: null } })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', channel: 'sms', sent: 2, rowIds: [plain.id, turn.id] })
    expect(h.sent).toEqual([
      { channel: 'sms', message: { text: 'Rita asked for the SOW.', approvals: [] } },
      { channel: 'sms', message: { text: 'Dana wants Friday.', approvals: [APPROVAL] } },
    ])
  })

  it('a phone that said STOP, and no Slack: nowhere to go', async () => {
    const h = harness({ now: ny('14:00'), rows: [homeTurn(ny('13:00'), 'Rita asked for the SOW.')], targets: { sms: null, slack: null } })
    expect(await planRoute(DATA, h.deps)).toEqual({ kind: 'done', outcome: 'no_channel', rows: 1 })
  })
})

describe('the gather: dead rows never hide a live one', () => {
  it('thirty asks answered meanwhile, then a real message: the message goes', async () => {
    const asks: RouteRow[] = Array.from({ length: 30 }, (_, i) => ({
      id: rid(),
      created_at: new Date(ny('09:00') + i * 60_000).toISOString(),
      ui_message: { id: `approval-ask-${i}`, parts: [text('A loop stopped here.')], metadata: { kind: 'ask_card', approval_id: `00000000-0000-4000-8000-${String(900 + i).padStart(12, '0')}` } },
    }))
    const live = homeTurn(ny('11:00'), 'Want me to cancel your call with Ken?')
    const h = harness({ now: ny('11:02'), rows: [...asks, live], pending: [] })
    expect(await planRoute(DATA, h.deps)).toMatchObject({ kind: 'sent', sent: 1, rowIds: [live.id] })
  })
})
