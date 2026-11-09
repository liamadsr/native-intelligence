/**
 * Which home-thread messages follow the person out of the app, and what each
 * one says (src/lib/reach/route-policy.ts; docs/plans/reach-follows-you.md §3).
 * Every row of the table: the background home-turn reasons route, a channel
 * turn never does; a prep-only report banners; the look-ahead routes its
 * checked text or nothing; a guest's note goes whole, a JOIN request never
 * carries the name they texted; an approval asked at home is claimed as the
 * approval; report chips, batched suggestions and an approval's result never
 * route. The text is the final answer (no narration) and each approval's code.
 */
import { describe, expect, it } from 'vitest'
import {
  ROUTED_HOME_TURN_REASONS,
  ROUTED_MESSAGE_KINDS,
  URGENT_AFTER_QUIET_MS,
  agentMessageNoticeCopy,
  awayTextBody,
  heldApprovalIds,
  lookAheadUntil,
  routeOf,
  urgentNow,
  type RouteRow,
} from '../route-policy'
import { HOME_TURN_REASONS } from '@/lib/chat/home-turn'
import { lookAheadTextKey } from '@/lib/look-ahead/message'

const USER = '22222222-2222-4222-8222-222222222222'
const ROW = '55555555-5555-4555-8555-555555555555'
const APPROVAL = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b'
const NOTE = '7a1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4c'

const row = (metadata: Record<string, unknown>, parts: unknown[] = [], id = 'home-turn:t1'): RouteRow => ({
  id: ROW,
  created_at: '2026-10-31T12:00:00.000Z',
  ui_message: { id, parts, metadata },
})
const text = (t: string) => ({ type: 'text', text: t })
const held = (approvalId = APPROVAL) => ({
  type: 'dynamic-tool',
  toolName: 'delete_action',
  toolCallId: 'c1',
  state: 'output-available',
  input: { action_id: 'GEN-12' },
  output: { success: false, code: 'APPROVAL_REQUIRED', approval_id: approvalId, message: 'Nothing ran.' },
})
const tool = (name = 'get_calendar_events') => ({ type: 'dynamic-tool', toolName: name, toolCallId: 'c0', state: 'output-available', input: {}, output: { ok: true } })

describe('home turns', () => {
  it.each([...ROUTED_HOME_TURN_REASONS])('%s routes its final answer, claimed as the home message', (reason) => {
    const out = routeOf(row({ kind: 'home_turn', reason }, [text('Let me check the calendar.'), tool(), text('Want me to cancel your call with Ken?')]), USER)
    expect(out).toMatchObject({ routes: true, kind: 'home_turn', ref: { type: 'home_message', id: ROW }, text: 'Want me to cancel your call with Ken?', textable: true, approvalIds: [] })
  })

  it('a text, Slack, call, team chat or linked agent turn never routes: it was answered where it came from', () => {
    const channelReasons = HOME_TURN_REASONS.filter((r) => !ROUTED_HOME_TURN_REASONS.has(r))
    expect([...channelReasons].sort()).toEqual(['agent_ask', 'call', 'slack', 'team_chat', 'text'])
    for (const reason of channelReasons) expect(routeOf(row({ kind: 'home_turn', reason }, [text('Done.')]), USER)).toEqual({ routes: false })
    // A routed reason that was posted to a channel all the same is not sent twice.
    expect(routeOf(row({ kind: 'home_turn', reason: 'event', channel: 'sms' }, [text('Done.')]), USER)).toEqual({ routes: false })
  })

  it('the digest and the check-in already notified: no banner of the router’s, but they still text', () => {
    for (const reason of ['digest', 'check_in']) expect(routeOf(row({ kind: 'home_turn', reason }, [text('Morning.')]), USER)).toMatchObject({ routes: true, notifies: true, textable: true })
    expect(routeOf(row({ kind: 'home_turn', reason: 'helper_report' }, [text('Done.')]), USER)).toMatchObject({ notifies: false })
  })

  it('a prep-only report is a banner, never a text', () => {
    expect(routeOf(row({ kind: 'home_turn', reason: 'helper_report', prep_only: true }, [text('Your prep is ready.')]), USER)).toMatchObject({ routes: true, textable: false })
  })

  it('carries each held approval; a quiet turn written only for its card sends the card alone; nothing at all never routes', () => {
    const second = '8b1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4d'
    expect(routeOf(row({ kind: 'home_turn', reason: 'event' }, [text('Dana wants Friday.'), held(), held(second), held()]), USER)).toMatchObject({ approvalIds: [APPROVAL, second] })
    expect(routeOf(row({ kind: 'home_turn', reason: 'event', ended_quiet: true }, [text('Let me hold this.'), held()]), USER)).toMatchObject({ routes: true, text: '', approvalIds: [APPROVAL] })
    expect(routeOf(row({ kind: 'home_turn', reason: 'event' }, []), USER)).toEqual({ routes: false })
  })

  it('reads the urgency the agent marked (an ISO time with an offset), nothing else', () => {
    expect(routeOf(row({ kind: 'home_turn', reason: 'event', urgent_by: '2026-11-01T09:00:00-04:00' }, [text('Jess moved the call.')]), USER)).toMatchObject({ urgentBy: '2026-11-01T09:00:00-04:00' })
    expect(routeOf(row({ kind: 'home_turn', reason: 'event', urgent_by: '2026-11-01T09:00:00' }, [text('x')]), USER)).toMatchObject({ urgentBy: null })
    expect(routeOf(row({ kind: 'home_turn', reason: 'event', urgent_by: 'soon' }, [text('x')]), USER)).toMatchObject({ urgentBy: null })
  })
})

describe('the look-ahead', () => {
  // 2026-10-31 in New York (EDT).
  const at = (hhmm: string, day = 31) => Date.parse(`2026-10-${day}T${hhmm}:00-04:00`)
  const look = (id: string, meta: Record<string, unknown>, createdAt = at('19:00')): RouteRow => ({
    id: ROW,
    created_at: new Date(createdAt).toISOString(),
    ui_message: { id, parts: [text('**For tomorrow**')], metadata: { kind: 'look_ahead', ...meta } },
  })
  const evening = (until = at('21:00')) => look('look-ahead:2026-11-01', { look_ahead_sms: 'Tomorrow morning:\n7:30 am: Rental car.', look_ahead_until: new Date(until).toISOString() })

  it('routes its checked text before its shelf life ends, claimed once per person, slot and date', () => {
    expect(routeOf(evening(), USER, at('19:02'))).toEqual({
      routes: true,
      kind: 'look_ahead',
      ref: { type: 'look_ahead', id: lookAheadTextKey(USER, 'look-ahead:2026-11-01') },
      text: 'Tomorrow morning:\n7:30 am: Rental car.',
      textable: true,
      notifies: true,
      approvalIds: [],
      urgentBy: null,
    })
  })

  it('never once its shelf life ends: the evening’s message at 08:05 the next day says the wrong morning', () => {
    expect(routeOf(evening(), USER, at('21:00'))).toEqual({ routes: false })
    expect(routeOf(evening(), USER, at('08:05') + 24 * 3_600_000)).toEqual({ routes: false })
  })

  it('a travel heads-up only before its departure; one pushed into quiet hours never goes out at 08:05', () => {
    const start = '2026-11-01T03:58:00.000Z' // 23:58 in New York
    const heads = look(`look-ahead:travel:gcal:abc:${start}`, { look_ahead_travel: 'gcal:abc', look_ahead_sms: 'In about 3 hours: 11:58 pm: Flight.', look_ahead_until: start }, at('20:58'))
    expect(routeOf(heads, USER, at('20:59'))).toMatchObject({ routes: true })
    expect(routeOf(heads, USER, at('08:05') + 24 * 3_600_000)).toEqual({ routes: false })
  })

  it('an older row without look_ahead_until: a departure by the time in its id, a slot two hours after it was written', () => {
    const start = '2026-11-01T03:58:00.000Z'
    const oldTravel = look(`look-ahead:travel:gcal:abc:${start}`, { look_ahead_sms: 'x' }, at('20:58'))
    expect(lookAheadUntil(oldTravel)).toBe(Date.parse(start))
    const oldSlot = look('look-ahead:2026-11-01', { look_ahead_sms: 'x' }, at('19:00'))
    expect(lookAheadUntil(oldSlot)).toBe(at('21:00'))
    expect(routeOf(oldSlot, USER, at('20:59'))).toMatchObject({ routes: true })
    expect(routeOf(oldSlot, USER, at('21:01'))).toEqual({ routes: false })
  })

  it('with nothing textable (mail-only bookings, unanswered invites) there is nothing to do: it already notified', () => {
    expect(routeOf(look('look-ahead:2026-11-01', {}), USER, at('19:02'))).toEqual({ routes: false })
  })
})

describe('guests', () => {
  const note = (data: Record<string, unknown>, metadata: Record<string, unknown> = {}) =>
    row({ kind: 'guest_message', guest_id: 'g1', ...metadata }, [{ type: 'data-guest-message', id: `guest-message:${NOTE}`, data }], `guest-message:${NOTE}`)
  const words = 'Locked out. ' + 'The spare key is not under the mat, can you call the landlord? '.repeat(8)

  it('a note goes in their own words, whole, saying who and how; claimed as the note', () => {
    const out = routeOf(note({ guest: { id: 'g1', name: 'Sam', preset: 'household', channel: 'sms' }, text: words, urgent: true }), USER)
    expect(out).toMatchObject({ routes: true, kind: 'guest_message', ref: { type: 'guest_message', id: NOTE }, textable: true, notifies: false })
    expect((out as { text: string }).text).toBe(`Sam (to your agent, by text): ${words.trim()}`)
    expect(routeOf(note({ guest: { name: 'Sam', channel: 'slack' }, text: 'hi' }), USER)).toMatchObject({ text: 'Sam (to your agent, on Slack): hi' })
    // The note's id from metadata wins; a nameless or empty note never routes.
    expect(routeOf(note({ guest: { name: 'Sam' }, text: 'hi' }, { note_id: '9c1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4e' }), USER)).toMatchObject({ ref: { id: '9c1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4e' } })
    expect(routeOf(note({ guest: { name: '' }, text: 'hi' }), USER)).toEqual({ routes: false })
    expect(routeOf(note({ guest: { name: 'Sam' }, text: '  ' }), USER)).toEqual({ routes: false })
  })

  it('a note the guest’s agent gave a `by` carries it as its urgency', () => {
    expect(routeOf(note({ guest: { name: 'Sam' }, text: 'Locked out', urgent: true, urgent_by: '2026-11-01T09:00:00-04:00' }, { urgent_by: '2026-11-01T09:00:00-04:00' }), USER)).toMatchObject({ urgentBy: '2026-11-01T09:00:00-04:00' })
    expect(routeOf(note({ guest: { name: 'Sam' }, text: 'Locked out', urgent: true, urgent_by: '2026-11-01T09:00:00-04:00' }), USER)).toMatchObject({ urgentBy: '2026-11-01T09:00:00-04:00' })
  })

  it('a JOIN request names the last four digits, never the name they texted; a settled one never routes', () => {
    const req = (data: Record<string, unknown>) => row({ kind: 'guest_request', guest_id: 'g1' }, [{ type: 'data-guest-request', id: 'guest-request:g1', data }], 'guest-request:g1')
    const out = routeOf(req({ guest_id: 'g1', guest_name: 'Call 1-800-555-0100 now', phone_last4: '4567', status: 'pending' }), USER)
    expect(out).toMatchObject({ routes: true, kind: 'guest_request', ref: { type: 'home_message', id: ROW } })
    expect((out as { text: string }).text).toBe('Someone asked to text your agent from a number ending 4567. Allow or ignore them in Dial8.')
    expect((out as { text: string }).text).not.toContain('1-800')
    expect(routeOf(req({ guest_id: 'g1', guest_name: 'x', status: 'approved' }), USER)).toEqual({ routes: false })
  })
})

describe('approvals asked at home', () => {
  it('route their line and the approval, claimed as the approval', () => {
    const out = routeOf(row({ kind: 'ask_card', approval_id: APPROVAL, card_id: 'card-1' }, [text('One of your loops stopped here for your yes.'), { type: 'data-ask-card', data: {} }], `approval-ask-${APPROVAL}`), USER)
    expect(out).toEqual({
      routes: true,
      kind: 'approval_ask',
      ref: { type: 'tool_approval', id: APPROVAL },
      text: 'One of your loops stopped here for your yes.',
      textable: true,
      notifies: false,
      approvalIds: [APPROVAL],
      urgentBy: null,
    })
  })
})

describe('never routes', () => {
  it.each([
    ['a teammate report chip', { kind: 'teammate_report' }],
    ['a run’s batched suggestions', { kind: 'ask_cards' }],
    ['an approval’s result', { kind: 'approval_result', approval_id: APPROVAL }],
    ['a guest activity line', { kind: 'guest_activity' }],
    ['CI is still red', { kind: 'ci_red' }],
    ['no kind', {}],
  ])('%s', (_label, metadata) => {
    expect(routeOf(row(metadata, [text('Something.')]), USER)).toEqual({ routes: false })
  })

  it('the router queries exactly the kinds that can route', () => {
    expect([...ROUTED_MESSAGE_KINDS].sort()).toEqual(['ask_card', 'guest_message', 'guest_request', 'home_turn', 'look_ahead'])
  })
})

describe('the text', () => {
  it('is the words, then each approval’s prompt, blank lines between; nothing when there is nothing', () => {
    const prompt = (a: { approvalId: string }) => `reply "yes ${a.approvalId}"`
    expect(awayTextBody({ text: 'Dana wants Friday.', approvals: [{ approvalId: 'K7Q2' }] }, prompt)).toBe('Dana wants Friday.\n\nreply "yes K7Q2"')
    expect(awayTextBody({ text: '', approvals: [{ approvalId: 'A' }, { approvalId: 'B' }] }, prompt)).toBe('reply "yes A"\n\nreply "yes B"')
    expect(awayTextBody({ text: '  ', approvals: [] }, prompt)).toBe('')
  })

  it('heldApprovalIds skips a connected app’s own result and a call still running', () => {
    expect(heldApprovalIds([held(), { ...held(), toolName: 'mcp__linear__create' }, { ...held(), state: 'input-available' }])).toEqual([APPROVAL])
    expect(heldApprovalIds(null)).toEqual([])
  })
})

describe('urgentNow', () => {
  // 21:07 New York (EDT) on 2026-10-31; quiet hours end 08:00 the next morning (EST after the clocks change).
  const NOW = Date.parse('2026-10-31T21:07:00-04:00')
  const QUIET_END = Date.parse('2026-11-01T08:00:00-05:00')

  it('Jess at 21:07 about a 09:00 call: through', () => {
    expect(urgentNow('2026-11-01T09:00:00-05:00', NOW, QUIET_END)).toBe(true)
  })

  it('not past the deadline, not more than 18 h ahead, not later than 2 h after quiet hours end', () => {
    expect(urgentNow('2026-10-31T21:00:00-04:00', NOW, QUIET_END)).toBe(false)
    expect(urgentNow(new Date(QUIET_END + URGENT_AFTER_QUIET_MS).toISOString(), NOW, QUIET_END)).toBe(true)
    expect(urgentNow(new Date(QUIET_END + URGENT_AFTER_QUIET_MS + 60_000).toISOString(), NOW, QUIET_END)).toBe(false)
    expect(urgentNow(new Date(NOW + 19 * 3_600_000).toISOString(), NOW, NOW + 18 * 3_600_000)).toBe(false)
    expect(urgentNow(null, NOW, QUIET_END)).toBe(false)
    expect(urgentNow('garbage', NOW, QUIET_END)).toBe(false)
  })
})

describe('the banner’s words', () => {
  it('the newest message’s first words, how many more, or a plain line', () => {
    expect(agentMessageNoticeCopy('Want me to cancel\nyour call with Ken?', 1)).toEqual({ title: 'New message', sentence: 'Want me to cancel your call with Ken?' })
    expect(agentMessageNoticeCopy('Done.', 3).sentence).toBe('Done. (+2 more)')
    expect(agentMessageNoticeCopy('x'.repeat(300), 1).sentence).toHaveLength(140)
    expect(agentMessageNoticeCopy(null, 1).sentence).toBe('A new message in our thread.')
    expect(agentMessageNoticeCopy('', 2).sentence).toBe('2 new messages in our thread.')
  })
})
