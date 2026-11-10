/**
 * The router (A6 slices 1 and 3, src/lib/agent-events/router.ts).
 *
 * Pinned: the rules ("needs you" = questions, approvals, failures, a meeting
 * in under 30 minutes with prep ready; `turn` = mail from someone the person
 * knows needing a reply, a meeting the live agent left open asks in, an
 * approval an unattended run holds, never past dormancy or usage; everything
 * else quiet); one home turn per pass for its turn rows;
 * the gates (autonomy off ignores all but the notices already out; dormancy
 * stops a new notice; over the usage limit stops Jev); the recorder's notices
 * are recorded, never resent; the meeting notice goes out once per event;
 * Jev's event.needs_person runs on rows no rule forced, at most
 * JEV_SHADOW_MAX per pass, and its answer is stored beside the rule's outcome;
 * it decides only a kind it is proven on (applyJev, provenKindsFrom); a row is
 * routed once (a retried pass changes nothing).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeFakeSupabase, type FakeSupabase } from '@/lib/work/__tests__/fake-supabase'
import {
  EVENT_NEEDS_PERSON_VERSION,
  JEV_PROMOTIONS_DAILY_MAX,
  JEV_PROVEN_MIN_AGREEMENT,
  JEV_PROVEN_MIN_CASES,
  JEV_SHADOW_DAILY_MAX,
  JEV_SHADOW_MAX,
  applyJev,
  eventNeedsPersonInput,
  provenKindsFrom,
  provenLabels,
  provenSides,
  type JevProven,
  jevShadowFrom,
  routeAgentEvents,
  routeEvent,
  routerLogLine,
  type JevShadow,
  type RouterDeps,
  type RouterGates,
} from '../router'
import type { AgentEventRow } from '../types'

const NOW = Date.parse('2026-10-14T12:00:00.000Z')
const at = (min: number) => new Date(NOW + min * 60_000).toISOString()
const open: RouterGates = { paused: false, dormant: false, overUsage: false }

const row = (over: Partial<AgentEventRow>): Pick<AgentEventRow, 'kind' | 'facts' | 'occurs_at' | 'expires_at'> => ({
  kind: 'work.done',
  facts: {},
  occurs_at: at(-5),
  expires_at: null,
  ...over,
})

describe('routeEvent (the rules)', () => {
  it('questions and approvals the recorder noticed are recorded as notify, whatever the gates', () => {
    for (const kind of ['work.needs_input', 'work.approval'] as const) {
      for (const gates of [open, { ...open, paused: true }, { ...open, dormant: true }]) {
        expect(routeEvent(row({ kind, facts: { notified: true } }), gates, NOW)).toMatchObject({
          outcome: 'notify',
          sendNotice: false,
          recordNotice: true,
          forced: true,
        })
      }
    }
  })

  it('a failure the recorder noticed is told in the home thread, its notice recorded, never put to Jev; gated, it is quiet and still recorded', () => {
    const failed = row({ kind: 'work.failed', facts: { notified: true } })
    expect(routeEvent(failed, open, NOW)).toMatchObject({ outcome: 'turn', sendNotice: false, recordNotice: true, forced: true, rule: 'failed' })
    for (const gates of [{ ...open, paused: true }, { ...open, dormant: true }, { ...open, overUsage: true }]) {
      expect(routeEvent(failed, gates, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false, recordNotice: true, forced: true })
    }
    // A chat helper's failure whose report already landed in the home thread was told there (phase 2 review).
    expect(routeEvent(row({ kind: 'work.failed', facts: { notified: true, toldHome: true } }), open, NOW)).toMatchObject({ outcome: 'quiet', recordNotice: true })
  })

  it('a failure with no notice out stays quiet (its writer chose silence); drafts, reviews, done are quiet', () => {
    expect(routeEvent(row({ kind: 'work.failed', facts: { notified: false } }), open, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false })
    for (const kind of ['email.drafted', 'email.needs_reply', 'capture.processed', 'work.done'] as const) {
      expect(routeEvent(row({ kind }), open, NOW).outcome).toBe('quiet')
    }
    // A review the recorder noticed is quiet (decision Defaults), its notice recorded.
    expect(routeEvent(row({ kind: 'work.needs_review', facts: { notified: true } }), open, NOW)).toMatchObject({ outcome: 'quiet', recordNotice: true })
    expect(routeEvent(row({ kind: 'mention' }), open, NOW).recordNotice).toBe(true)
  })

  it('what a teammate aimed at you, a reminder and a sequence failure are told in the home thread; FYI changes and follow-ups wait (decision 1)', () => {
    expect(routeEvent(row({ kind: 'mention' }), open, NOW)).toMatchObject({ outcome: 'turn', recordNotice: true, forced: false, rule: 'aimed_at_you' })
    expect(routeEvent(row({ kind: 'reminder.due' }), open, NOW)).toMatchObject({ outcome: 'turn', recordNotice: true, forced: true, rule: 'reminder_due' })
    expect(routeEvent(row({ kind: 'sequence.failed' }), open, NOW)).toMatchObject({ outcome: 'turn', recordNotice: true, forced: true, rule: 'failed' })
    for (const kind of ['activity', 'contact.followup_due'] as const) {
      expect(routeEvent(row({ kind }), open, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false, recordNotice: true })
    }
    // Every notice's notification is recorded, gated or not: it already went out.
    for (const kind of ['mention', 'reminder.due', 'sequence.failed'] as const) {
      expect(routeEvent(row({ kind }), { ...open, dormant: true }, NOW)).toMatchObject({ outcome: 'quiet', recordNotice: true })
      expect(routeEvent(row({ kind }), { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', recordNotice: true })
    }
  })

  it('a meeting in under 30 minutes notifies through the face, prep ready or not (PROD audit: no prep used to mean no heads-up); dormant, it is quiet', () => {
    const meeting = (facts: AgentEventRow['facts'], start = at(20)) => row({ kind: 'meeting.soon', facts, occurs_at: start, expires_at: start })
    expect(routeEvent(meeting({ prepReady: true }), open, NOW)).toMatchObject({ outcome: 'notify', sendNotice: true, forced: false, rule: 'meeting_prep_ready' })
    expect(routeEvent(meeting({ prepReady: false }), open, NOW)).toMatchObject({ outcome: 'notify', sendNotice: true, forced: false, rule: 'meeting_soon' })
    expect(routeEvent(meeting({ prepReady: false }), { ...open, dormant: true }, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false })
    expect(routeEvent(meeting({ prepReady: true }), { ...open, dormant: true }, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false })
    expect(routeEvent(meeting({ prepReady: true }, at(45)), open, NOW).outcome).toBe('quiet')
    // Started already: expired.
    expect(routeEvent(meeting({ prepReady: true }, at(-1)), open, NOW)).toMatchObject({ outcome: 'ignore', state: 'expired' })
  })

  it('an arrived email interrupts nothing yet (E2): worth knowing or unsure waits quietly for "while you were away" and the digest; Jev\'s clear no is dropped', () => {
    const arrived = (facts: AgentEventRow['facts']) => row({ kind: 'email.arrived', facts, expires_at: at(3 * 24 * 60) })
    expect(routeEvent(arrived({ shouldKnow: true, emailKind: 'meeting' }), open, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false, rule: 'email_worth_knowing' })
    expect(routeEvent(arrived({ emailKind: 'other_notice' }), open, NOW)).toMatchObject({ outcome: 'quiet', rule: 'email_unsure' })
    expect(routeEvent(arrived({ shouldKnow: false, emailKind: 'receipt_or_bill' }), open, NOW)).toMatchObject({ outcome: 'ignore', state: 'routed', rule: 'email_not_for_you' })
    // Paused: quiet like everything else.
    expect(routeEvent(arrived({ shouldKnow: true }), { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'paused' })
  })

  it('a meeting someone else set up that was cancelled, went missing or moved is told in the home thread until its time; dormant or over usage, it is quiet', () => {
    const changed = (start = at(240)) => row({ kind: 'meeting.changed', facts: { title: 'Board prep', change: 'cancelled', attendeeCount: 3 }, occurs_at: start, expires_at: start })
    expect(routeEvent(changed(), open, NOW)).toMatchObject({ outcome: 'turn', sendNotice: false, forced: false, rule: 'meeting_changed' })
    expect(routeEvent(changed(), { ...open, dormant: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'dormant' })
    expect(routeEvent(changed(), { ...open, overUsage: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'over_usage' })
    expect(routeEvent(changed(), { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'paused' })
    // Its time passed before the router saw it: not news any more.
    expect(routeEvent(changed(at(-1)), open, NOW)).toMatchObject({ outcome: 'ignore', state: 'expired' })
  })

  it('autonomy off routes everything quiet (never terminal, no notice, no Jev) but the notices already out; nothing without a turn fact makes a turn', () => {
    expect(routeEvent(row({ kind: 'email.drafted' }), { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', state: 'routed', forced: true, sendNotice: false })
    expect(routeEvent(row({ kind: 'meeting.soon', facts: { prepReady: true }, occurs_at: at(10), expires_at: at(10) }), { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', sendNotice: false })
    const kinds = ['email.drafted', 'email.needs_reply', 'capture.processed', 'meeting.soon', 'work.needs_input', 'work.needs_review', 'work.done', 'activity', 'contact.followup_due'] as const
    for (const kind of kinds) for (const notified of [true, false]) expect(routeEvent(row({ kind, facts: { notified } }), open, NOW).outcome).not.toBe('turn')
  })
})

describe('eventNeedsPersonInput / jevShadowFrom', () => {
  it('hands Jev Native Intelligence’s kind and numbers plus the templated facts; minutes only for a meeting', () => {
    expect(eventNeedsPersonInput({ kind: 'meeting.soon', priority: 2, facts: { title: 'Acme', prepReady: true }, occurs_at: at(20) }, NOW)).toEqual({
      kind: 'meeting.soon',
      priority: 2,
      startsInMinutes: 20,
      facts: { title: 'Acme', prepReady: true },
    })
    expect(eventNeedsPersonInput({ kind: 'email.drafted', priority: 1, facts: { title: 'Re: x' }, occurs_at: at(-90) }, NOW).startsInMinutes).toBeNull()
  })

  it('stores an accepted pick as given, and an uncertain answer as digest', () => {
    expect(jevShadowFrom({ status: 'accepted', value: { pick: 'now', probability: 0.93, trusted: true } })).toMatchObject({ status: 'accepted', pick: 'now', probability: 0.93, trusted: true })
    expect(jevShadowFrom({ status: 'escalate', reason: 'temporarily_unavailable' })).toMatchObject({ status: 'escalate', pick: 'digest', trusted: false, reason: 'temporarily_unavailable' })
  })
})

describe('routeAgentEvents', () => {
  let db: FakeSupabase
  let deps: RouterDeps & { decide: ReturnType<typeof vi.fn>; sendMeetingNotice: ReturnType<typeof vi.fn>; findNotice: ReturnType<typeof vi.fn> }
  const shadow: JevShadow = { version: 'event-needs-person-v1', status: 'accepted', pick: 'digest', probability: 0.9, trusted: true }

  const seed = (rows: Array<Partial<AgentEventRow> & { kind: AgentEventRow['kind'] }>) =>
    db.seed(
      'agent_event',
      rows.map((r, i) => ({
        id: String(i + 1),
        workspace_id: 'w1',
        user_id: 'u1',
        source: 'work',
        priority: 1,
        occurs_at: at(-10),
        expires_at: null,
        ref_type: null,
        ref_id: null,
        facts: {},
        dedupe_key: `k${i}`,
        state: 'new',
        outcome: null,
        notification_id: null,
        created_at: at(-10 + i),
        ...r,
      })),
    )

  beforeEach(() => {
    db = makeFakeSupabase()
    deps = {
      isPaused: vi.fn(async () => false),
      isDormant: vi.fn(async () => false),
      isOverUsage: vi.fn(async () => false),
      decide: vi.fn(async () => shadow),
      sendMeetingNotice: vi.fn(async () => 'notice-meeting'),
      findNotice: vi.fn(async () => 'notice-recorder'),
      now: () => NOW,
    }
  })

  it('routes each new row once: records the recorder’s notice, sends the meeting notice, stores Jev’s shadow answer', async () => {
    seed([
      { kind: 'work.needs_input', facts: { notified: true, title: 'Q' }, ref_type: 'work_item', ref_id: 'job-1' },
      { kind: 'meeting.soon', source: 'meeting', facts: { prepReady: true, title: 'Acme' }, occurs_at: at(20), expires_at: at(20) },
      { kind: 'email.drafted', source: 'email', facts: { title: 'Re: Pricing' } },
      { kind: 'mention', source: 'mention', state: 'routed', outcome: 'quiet' },
      { kind: 'mention', source: 'mention', user_id: 'u2' },
    ])
    const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(result).toMatchObject({ read: 3, routed: 3, outcomes: { notify: 2, quiet: 1, ignore: 0, turn: 0 }, shadowed: 2 })
    const rows = db.rows('agent_event')
    expect(rows[0]).toMatchObject({ state: 'routed', outcome: 'notify', decided_by: 'rule', notification_id: 'notice-recorder' })
    expect(rows[0]).not.toHaveProperty('jev_shadow')
    expect(rows[1]).toMatchObject({ outcome: 'notify', notification_id: 'notice-meeting', jev_shadow: shadow })
    expect(rows[2]).toMatchObject({ outcome: 'quiet', jev_shadow: shadow })
    // Another person's row and an already-routed one are untouched.
    expect(rows[4]).toMatchObject({ state: 'new', outcome: null })
    expect(deps.sendMeetingNotice).toHaveBeenCalledTimes(1)
    // Jev is never asked about a row a rule forced (the recorder's notice).
    expect(deps.decide.mock.calls.map(([input]) => input.kind)).toEqual(['meeting.soon', 'email.drafted'])
    expect(deps.decide.mock.calls[0][1]).toEqual({ userId: 'u1', workspaceId: 'w1', runId: 'agent_event:2' })
    expect(routerLogLine({ workspaceId: 'w1', userId: 'u1' }, result)).toContain('notify=2 quiet=1')

    // A retried pass finds nothing new and sends nothing.
    const again = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(again.read).toBe(0)
    expect(deps.sendMeetingNotice).toHaveBeenCalledTimes(1)
  })

  it('never asks Jev about the notices the notifications page used to hold, mentions included, whatever their priority (review fixes)', async () => {
    seed([
      { kind: 'activity', priority: 2, ref_type: 'notification', ref_id: 'n1' },
      { kind: 'contact.followup_due', priority: 2, ref_type: 'notification', ref_id: 'n2' },
      { kind: 'mention', priority: 1, ref_type: 'notification', ref_id: 'n3' },
      { kind: 'email.drafted', priority: 1 },
    ])
    await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(deps.decide.mock.calls.map(([input]) => input.kind)).toEqual(['email.drafted'])
  })

  it('a dormant workspace’s noticed failure is quiet and never put to Jev (phase 2 review)', async () => {
    deps.isDormant = vi.fn(async () => true)
    seed([{ kind: 'work.failed', priority: 2, facts: { notified: true }, ref_type: 'work_item', ref_id: 'job-1' }])
    const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(result.outcomes).toMatchObject({ quiet: 1, turn: 0 })
    expect(deps.decide).not.toHaveBeenCalled()
    expect(deps.findNotice).toHaveBeenCalledTimes(1)
  })

  it('autonomy off: no notice, no Jev; the rest is quiet (shown once unpaused), the notices already out recorded', async () => {
    deps.isPaused = vi.fn(async () => true)
    seed([
      { kind: 'work.failed', facts: { notified: true }, ref_type: 'work_item', ref_id: 'job-1' },
      { kind: 'meeting.soon', facts: { prepReady: true }, occurs_at: at(20), expires_at: at(20) },
      { kind: 'email.drafted' },
    ])
    const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(result.outcomes).toEqual({ notify: 0, quiet: 3, ignore: 0, turn: 0 })
    // The failure's notice already went out: recorded, paused or not.
    expect(deps.findNotice).toHaveBeenCalledTimes(1)
    expect(deps.sendMeetingNotice).not.toHaveBeenCalled()
    expect(deps.decide).not.toHaveBeenCalled()
  })

  it('over the usage limit: rules still route, Jev is not called; a failed read of the switch fails CLOSED (Jev and turns spend money; paused rows wait, quiet)', async () => {
    deps.isOverUsage = vi.fn(async () => true)
    seed([{ kind: 'email.drafted' }])
    await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(deps.decide).not.toHaveBeenCalled()
    expect(db.rows('agent_event')[0]).toMatchObject({ outcome: 'quiet' })

    const db2 = makeFakeSupabase()
    db = db2
    seed([{ kind: 'email.drafted' }])
    deps.isPaused = vi.fn(async () => { throw new Error('read failed') })
    deps.decide.mockClear()
    const r = await routeAgentEvents(db2 as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(r.gates.paused).toBe(true)
    expect(deps.decide).not.toHaveBeenCalled()
    expect(db2.rows('agent_event')[0]).toMatchObject({ outcome: 'quiet', state: 'routed' })
  })

  it('caps Jev calls per pass, records a Jev error as digest, and leaves a meeting quiet when its notice cannot go out', async () => {
    seed(Array.from({ length: JEV_SHADOW_MAX + 3 }, () => ({ kind: 'email.drafted' as const })))
    deps.decide.mockRejectedValueOnce(new Error('jev down'))
    await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(deps.decide).toHaveBeenCalledTimes(JEV_SHADOW_MAX)
    expect(db.rows('agent_event')[0].jev_shadow).toMatchObject({ status: 'error', pick: 'digest', reason: 'jev down' })
    expect(db.rows('agent_event').filter((r) => r.jev_shadow)).toHaveLength(JEV_SHADOW_MAX)

    const db2 = makeFakeSupabase()
    db = db2
    seed([{ kind: 'meeting.soon', facts: { prepReady: true }, occurs_at: at(20), expires_at: at(20) }])
    deps.sendMeetingNotice.mockResolvedValueOnce(null)
    await routeAgentEvents(db2 as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(db2.rows('agent_event')[0]).toMatchObject({ state: 'routed', outcome: 'quiet' })
  })

  it('Jev is never asked about a plain finish (priority 0), and at most JEV_SHADOW_DAILY_MAX a day per person', async () => {
    seed([
      { kind: 'work.done', priority: 0 },
      { kind: 'email.drafted', priority: 1 },
    ])
    await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(deps.decide.mock.calls.map(([input]) => input.kind)).toEqual(['email.drafted'])

    // A person who already used today's budget: no call, the rule still routes.
    const db2 = makeFakeSupabase()
    db = db2
    db2.seed(
      'agent_event',
      Array.from({ length: JEV_SHADOW_DAILY_MAX }, (_, i) => ({
        id: `old-${i}`,
        workspace_id: 'w1',
        user_id: 'u1',
        kind: 'email.drafted',
        state: 'routed',
        outcome: 'quiet',
        jev_shadow: shadow,
        routed_at: at(-60),
        created_at: at(-61),
        dedupe_key: `old-${i}`,
      })),
    )
    seed([{ kind: 'email.drafted' }])
    deps.decide.mockClear()
    await routeAgentEvents(db2 as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(deps.decide).not.toHaveBeenCalled()
    expect(db2.rows('agent_event').find((r) => r.id === '1')).toMatchObject({ outcome: 'quiet' })
  })

  it('throws when the read fails, so the Inngest step retries', async () => {
    const broken = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: null, error: { message: 'boom' } }) }) }) }) }) }) }) }
    await expect(routeAgentEvents(broken as never, { workspaceId: 'w1', userId: 'u1' }, deps)).rejects.toThrow('boom')
  })
})

describe('the turn outcome (Liam, 2026-10-15: urgent mail = known people only)', () => {
  it('mail needing a reply from someone the person knows is a turn, drafted or not; an unknown sender stays quiet', () => {
    for (const kind of ['email.drafted', 'email.needs_reply'] as const) {
      expect(routeEvent(row({ kind, facts: { title: 'Contract', known: true } }), open, NOW)).toMatchObject({ outcome: 'turn', rule: 'known_sender', sendNotice: false, forced: false })
      expect(routeEvent(row({ kind, facts: { title: 'Newsletter' } }), open, NOW).outcome).toBe('quiet')
      expect(routeEvent(row({ kind, facts: { title: 'Newsletter', known: false } }), open, NOW).outcome).toBe('quiet')
    }
    // A suspicious mail is never a turn, known or not.
    expect(routeEvent(row({ kind: 'email.suspicious', facts: { known: true } }), open, NOW).outcome).toBe('quiet')
  })

  it('a processed meeting with the live agent\'s open asks or staged proposals is a turn (the bridge); a plain one is quiet', () => {
    expect(routeEvent(row({ kind: 'capture.processed', facts: { openAsks: 1 } }), open, NOW)).toMatchObject({ outcome: 'turn', rule: 'live_followups' })
    expect(routeEvent(row({ kind: 'capture.processed', facts: { pendingProposals: 2 } }), open, NOW)).toMatchObject({ outcome: 'turn' })
    expect(routeEvent(row({ kind: 'capture.processed', facts: { openAsks: 0, pendingProposals: 0 } }), open, NOW).outcome).toBe('quiet')
  })

  it('a processed meeting of someone getting started is always a turn (docs/plans/getting-started-skill.md), past Jev, never past the gates', () => {
    const first = row({ kind: 'capture.processed', facts: { title: 'Talking to myself', firstRun: true } })
    expect(routeEvent(first, open, NOW)).toMatchObject({ outcome: 'turn', rule: 'getting_started', forced: true })
    expect(routeEvent(first, { ...open, overUsage: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'over_usage' })
  })

  it('an approval is never a turn (P13): its card already asks in the chat, the home thread for an unattended run', () => {
    for (const door of ['skill_run', 'flow_step', 'mcp', 'chat']) {
      expect(routeEvent(row({ kind: 'work.approval', facts: { door } }), open, NOW), door).toMatchObject({ outcome: 'quiet', rule: 'waiting_quiet' })
    }
  })

  it('never a turn past the gates: paused, dormant or over the usage limit is quiet', () => {
    const known = row({ kind: 'email.drafted', facts: { known: true } })
    expect(routeEvent(known, { ...open, paused: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'paused' })
    expect(routeEvent(known, { ...open, dormant: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'dormant' })
    expect(routeEvent(known, { ...open, overUsage: true }, NOW)).toMatchObject({ outcome: 'quiet', rule: 'over_usage' })
  })

  it('a pass batches its turn rows into ONE home turn request; Jev still answers in shadow beside the fixed rule', async () => {
    const db = makeFakeSupabase()
    db.seed(
      'agent_event',
      [
        { kind: 'email.drafted', facts: { title: 'Contract', known: true } },
        { kind: 'email.needs_reply', facts: { title: 'Intro', known: true } },
        { kind: 'email.drafted', facts: { title: 'Newsletter' } },
        { kind: 'capture.processed', facts: { title: 'Acme', openAsks: 1 } },
      ].map((r, i) => ({
        id: String(i + 1),
        workspace_id: 'w1',
        user_id: 'u1',
        source: 'email',
        priority: 1,
        occurs_at: at(-10),
        expires_at: null,
        ref_type: null,
        ref_id: null,
        dedupe_key: `k${i}`,
        state: 'new',
        outcome: null,
        notification_id: null,
        created_at: at(-10 + i),
        ...r,
      })),
    )
    const requestTurn = vi.fn(async () => true)
    const decide = vi.fn(async (): Promise<JevShadow> => ({ version: 'event-needs-person-v1', status: 'accepted', pick: 'digest', probability: 0.7, trusted: true }))
    const deps: RouterDeps = {
      isPaused: async () => false,
      isDormant: async () => false,
      isOverUsage: async () => false,
      decide,
      sendMeetingNotice: async () => null,
      findNotice: async () => null,
      requestTurn,
      now: () => NOW,
    }
    const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(result.outcomes).toMatchObject({ turn: 3, quiet: 1 })
    expect(result.turnRequested).toBe(true)
    expect(requestTurn).toHaveBeenCalledOnce()
    expect(requestTurn).toHaveBeenCalledWith(db, { workspaceId: 'w1', userId: 'u1' }, ['1', '2', '4'])
    // Shadow, beside the rule: asked, stored, the outcome unchanged.
    expect(decide).toHaveBeenCalledTimes(4)
    expect(db.rows('agent_event')[0]).toMatchObject({ outcome: 'turn', jev_shadow: expect.objectContaining({ pick: 'digest' }) })
    expect(routerLogLine({ workspaceId: 'w1', userId: 'u1' }, result)).toContain('turn=3 turn_requested')

    // A pass with no turn rows asks for nothing.
    requestTurn.mockClear()
    db.seed('agent_event', [{ id: '9', workspace_id: 'w1', user_id: 'u1', kind: 'work.done', facts: {}, priority: 0, occurs_at: at(-1), expires_at: null, dedupe_key: 'k9', state: 'new', outcome: null, created_at: at(-1) }])
    await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
    expect(requestTurn).not.toHaveBeenCalled()
  })
})

describe('Jev decides where it is proven (Liam, 2026-10-16)', () => {
  const answer = (pick: JevShadow['pick'], over: Partial<JevShadow> = {}): JevShadow => ({
    version: EVENT_NEEDS_PERSON_VERSION, status: 'accepted', pick, probability: 0.95, trusted: true, ...over,
  })
  const stored = (kind: string, pick: JevShadow['pick'], rule_outcome: JevShadow['rule_outcome'], over: Partial<JevShadow> = {}) => ({
    kind, jev_shadow: { ...answer(pick, over), rule_outcome, rule: 'quiet' },
  })
  const many = <T,>(n: number, make: () => T): T[] => Array.from({ length: n }, make)
  const agreeing = Math.ceil(JEV_PROVEN_MIN_CASES * JEV_PROVEN_MIN_AGREEMENT)
  const both = { lower: true, raise: true }

  describe('provenKindsFrom (each side on its own)', () => {
    it('proves the lower side on the rows the rules sent (Jev said now) and the raise side on the quiet ones (Jev kept them quiet)', () => {
      const rows = [
        ...many(agreeing, () => stored('email.drafted', 'now', 'turn')),
        ...many(JEV_PROVEN_MIN_CASES - agreeing, () => stored('email.drafted', 'digest', 'turn')),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('email.drafted', 'digest', 'quiet')),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('meeting.soon', 'now', 'notify')),
      ]
      const stats = provenKindsFrom(rows)
      expect(stats.get('email.drafted')).toEqual({
        lower: { cases: JEV_PROVEN_MIN_CASES, agreed: agreeing, proven: true },
        raise: { cases: JEV_PROVEN_MIN_CASES, agreed: JEV_PROVEN_MIN_CASES, proven: true },
      })
      expect(stats.get('meeting.soon')).toMatchObject({ lower: { proven: true }, raise: { cases: 0, proven: false } })
      expect(provenLabels(provenSides(stats))).toEqual(['email.drafted:lower', 'email.drafted:raise', 'meeting.soon:lower'])
    })

    it('a high overall rate never proves a side it does not hold: mostly-quiet mail with every known sender lowered proves only raise', () => {
      // 37 strangers kept quiet (agree), 3 known senders Jev would lower (disagree): 92.5% overall.
      const rows = [
        ...many(37, () => stored('email.needs_reply', 'digest', 'quiet')),
        ...many(3, () => stored('email.needs_reply', 'digest', 'turn')),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('email.needs_reply', 'digest', 'quiet')),
      ]
      const proof = provenKindsFrom(rows).get('email.needs_reply')!
      expect(proof.lower).toEqual({ cases: 3, agreed: 0, proven: false })
      expect(proof.raise.proven).toBe(true)
    })

    it('stays unproven below the case count or the agreement bar', () => {
      expect(provenKindsFrom(many(JEV_PROVEN_MIN_CASES - 1, () => stored('email.drafted', 'digest', 'quiet'))).get('email.drafted')?.raise.proven).toBe(false)
      const rows = [
        ...many(JEV_PROVEN_MIN_CASES, () => stored('capture.processed', 'now', 'turn')),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('capture.processed', 'digest', 'turn')),
      ]
      expect(provenKindsFrom(rows).get('capture.processed')?.lower).toMatchObject({ cases: 2 * JEV_PROVEN_MIN_CASES, proven: false })
    })

    it('counts only this version’s accepted, trusted answers with a stored rule outcome, on decidable kinds, never a gated rule', () => {
      const rows = [
        ...many(JEV_PROVEN_MIN_CASES, () => stored('email.drafted', 'digest', 'quiet', { trusted: false })),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('email.drafted', 'digest', 'quiet', { version: 'event-needs-person-v1' })),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('email.drafted', 'digest', 'quiet', { status: 'escalate' })),
        ...many(JEV_PROVEN_MIN_CASES, () => ({ kind: 'email.drafted', jev_shadow: answer('digest') })),
        ...many(JEV_PROVEN_MIN_CASES, () => ({ kind: 'email.drafted', jev_shadow: { ...answer('now'), rule_outcome: 'quiet', rule: 'dormant' } })),
        ...many(JEV_PROVEN_MIN_CASES, () => stored('work.needs_review', 'digest', 'quiet')),
        { kind: 'email.drafted', jev_shadow: null },
      ]
      expect(provenKindsFrom(rows).size).toBe(0)
    })
  })

  describe('applyJev', () => {
    const proven: JevProven = new Map([['email.drafted', both], ['email.needs_reply', both], ['capture.processed', both], ['meeting.soon', both]])
    const knownRow = row({ kind: 'email.drafted', facts: { known: true } })
    const strangerRow = row({ kind: 'email.drafted', facts: { known: false } })
    const meetingRow = row({ kind: 'meeting.soon', facts: { prepReady: false }, occurs_at: at(20), expires_at: at(20) })
    const known = routeEvent(knownRow, open, NOW)
    const stranger = routeEvent(strangerRow, open, NOW)
    const meeting = routeEvent(meetingRow, open, NOW)

    it('a proven side: Jev’s trusted pick decides, lowering a turn or a notice to quiet and raising a quiet row to a turn', () => {
      expect(applyJev(knownRow, known, answer('digest'), open, proven, 6)).toEqual({ outcome: 'quiet', sendNotice: false, decidedBy: 'jev', change: 'demoted' })
      expect(applyJev(knownRow, known, answer('ignore'), open, proven, 6)).toMatchObject({ outcome: 'quiet', change: 'demoted' })
      expect(applyJev(strangerRow, stranger, answer('now'), open, proven, 6)).toEqual({ outcome: 'turn', sendNotice: false, decidedBy: 'jev', change: 'promoted' })
      expect(applyJev(meetingRow, meeting, answer('digest'), open, proven, 6)).toEqual({ outcome: 'quiet', sendNotice: false, decidedBy: 'jev', change: 'demoted' })
      // Agreeing: Jev decided, nothing changed.
      expect(applyJev(knownRow, known, answer('now'), open, proven, 6)).toEqual({ outcome: 'turn', sendNotice: false, decidedBy: 'jev', change: null })
      expect(applyJev(meetingRow, meeting, answer('now'), open, proven, 6)).toEqual({ outcome: 'notify', sendNotice: true, decidedBy: 'jev', change: null })
    })

    it('only the proven side: raise proven alone never lowers a known sender’s turn; lower proven alone never raises a stranger', () => {
      const raiseOnly: JevProven = new Map([['email.drafted', { lower: false, raise: true }]])
      expect(applyJev(knownRow, known, answer('digest'), open, raiseOnly, 6)).toMatchObject({ outcome: 'turn', decidedBy: 'rule', change: null })
      expect(applyJev(strangerRow, stranger, answer('now'), open, raiseOnly, 6)).toMatchObject({ outcome: 'turn', change: 'promoted' })
      const lowerOnly: JevProven = new Map([['email.drafted', { lower: true, raise: false }]])
      expect(applyJev(strangerRow, stranger, answer('now'), open, lowerOnly, 6)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
      expect(applyJev(knownRow, known, answer('digest'), open, lowerOnly, 6)).toMatchObject({ outcome: 'quiet', change: 'demoted' })
    })

    it('the rules decide when the kind is not proven, the answer is untrusted, failed or missing, or a rule forced the row', () => {
      const rule = { outcome: 'turn', sendNotice: false, decidedBy: 'rule', change: null }
      expect(applyJev(knownRow, known, answer('digest'), open, new Map(), 6)).toEqual(rule)
      expect(applyJev(knownRow, known, answer('digest', { trusted: false }), open, proven, 6)).toEqual(rule)
      expect(applyJev(knownRow, known, answer('digest', { status: 'escalate' }), open, proven, 6)).toEqual(rule)
      expect(applyJev(knownRow, known, null, open, proven, 6)).toEqual(rule)
      const failedRow = row({ kind: 'work.failed', facts: { notified: true } })
      expect(applyJev(failedRow, routeEvent(failedRow, open, NOW), answer('digest'), open, new Map([['work.failed', both]]), 6)).toMatchObject({ decidedBy: 'rule', outcome: 'turn' })
    })

    it('never for kinds outside the list: an approval stays with the rule whatever Jev says', () => {
      const approvalRow = row({ kind: 'work.approval', facts: { door: 'loop' } })
      expect(applyJev(approvalRow, routeEvent(approvalRow, open, NOW), answer('now'), open, new Map([['work.approval', both]]), 6)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
    })

    it('a raise never opens a gate, never beats the daily cap, never lifts a flagged thread, never sends an early meeting notice', () => {
      expect(applyJev(strangerRow, stranger, answer('now'), open, proven, 0)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
      const dormant = routeEvent(knownRow, { ...open, dormant: true }, NOW)
      expect(applyJev(knownRow, dormant, answer('now'), { ...open, dormant: true }, proven, 6)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
      expect(applyJev(strangerRow, stranger, answer('now'), { ...open, overUsage: true }, proven, 6)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
      const flaggedRow = row({ kind: 'email.drafted', facts: { flagged: true } })
      expect(applyJev(flaggedRow, routeEvent(flaggedRow, open, NOW), answer('now'), open, proven, 6)).toMatchObject({ outcome: 'quiet', decidedBy: 'rule' })
      const laterRow = row({ kind: 'meeting.soon', facts: {}, occurs_at: at(45), expires_at: at(45) })
      expect(applyJev(laterRow, routeEvent(laterRow, open, NOW), answer('now'), open, proven, 6)).toMatchObject({ outcome: 'quiet', sendNotice: false, decidedBy: 'rule' })
    })
  })

  describe('routeAgentEvents with proven kinds', () => {
    const seedRows = (db: FakeSupabase, rows: Array<Partial<AgentEventRow> & { kind: AgentEventRow['kind'] }>) =>
      db.seed('agent_event', rows.map((r, i) => ({
        id: String(i + 1), workspace_id: 'w1', user_id: 'u1', source: 'email', priority: 1, occurs_at: at(-10), expires_at: null,
        ref_type: null, ref_id: null, facts: {}, dedupe_key: `k${i}`, state: 'new', outcome: null, notification_id: null, created_at: at(-10 + i), ...r,
      })))
    const depsWith = (picks: Record<string, JevShadow['pick']>, proven: JevProven) => {
      const decide = vi.fn(async (input: { facts: { from?: string; title?: string } }) => answer(picks[input.facts.from ?? input.facts.title ?? ''] ?? 'digest'))
      const requestTurn = vi.fn(async () => true)
      const sendMeetingNotice = vi.fn(async () => 'notice-meeting')
      const deps: RouterDeps = {
        isPaused: async () => false, isDormant: async () => false, isOverUsage: async () => false,
        decide: decide as never, provenKinds: async () => proven,
        sendMeetingNotice, findNotice: async () => null, requestTurn, now: () => NOW,
      }
      return { deps, decide, requestTurn, sendMeetingNotice }
    }

    it('lowers and raises where proven, records the rule’s outcome and the change, and turns only the rows it should', async () => {
      const db = makeFakeSupabase()
      seedRows(db, [
        { kind: 'email.drafted', facts: { from: 'friend@acme.com', known: true } },
        { kind: 'email.needs_reply', facts: { from: 'buyer@bigco.com', known: false } },
        { kind: 'meeting.soon', source: 'meeting', facts: { title: 'Standup', prepReady: false }, occurs_at: at(20), expires_at: at(20) },
        { kind: 'capture.processed', source: 'capture', facts: { title: 'Acme', openAsks: 1 } },
      ])
      const { deps, requestTurn, sendMeetingNotice } = depsWith(
        { 'friend@acme.com': 'digest', 'buyer@bigco.com': 'now', Standup: 'digest', Acme: 'digest' },
        new Map([['email.drafted', both], ['email.needs_reply', both], ['meeting.soon', both]]),
      )
      const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
      const rows = db.rows('agent_event')
      expect(rows[0]).toMatchObject({ outcome: 'quiet', decided_by: 'jev', jev_shadow: expect.objectContaining({ pick: 'digest', rule_outcome: 'turn', rule: 'known_sender', change: 'demoted' }) })
      expect(rows[1]).toMatchObject({ outcome: 'turn', decided_by: 'jev', jev_shadow: expect.objectContaining({ pick: 'now', rule_outcome: 'quiet', change: 'promoted' }) })
      // A meeting Jev lowered gets no notice at all.
      expect(rows[2]).toMatchObject({ outcome: 'quiet', decided_by: 'jev', jev_shadow: expect.objectContaining({ rule_outcome: 'notify', change: 'demoted' }) })
      expect(sendMeetingNotice).not.toHaveBeenCalled()
      // capture.processed is not proven: the rule's turn stands, Jev only recorded.
      expect(rows[3]).toMatchObject({ outcome: 'turn', decided_by: 'rule', jev_shadow: expect.objectContaining({ pick: 'digest', rule_outcome: 'turn' }) })
      expect(rows[3].jev_shadow).not.toHaveProperty('change')
      expect(requestTurn).toHaveBeenCalledWith(db, { workspaceId: 'w1', userId: 'u1' }, ['2', '4'])
      expect(result.jev).toEqual({ decided: 3, promoted: 1, demoted: 2, proven: ['email.drafted:lower', 'email.drafted:raise', 'email.needs_reply:lower', 'email.needs_reply:raise', 'meeting.soon:lower', 'meeting.soon:raise'] })
      expect(routerLogLine({ workspaceId: 'w1', userId: 'u1' }, result)).toContain('jev_decided=3 jev_promoted=1 jev_demoted=2 jev_proven=email.drafted:lower,')
    })

    it('raises at most JEV_PROMOTIONS_DAILY_MAX a day, counting today’s earlier raises', async () => {
      const db = makeFakeSupabase()
      db.seed('agent_event', Array.from({ length: JEV_PROMOTIONS_DAILY_MAX - 1 }, (_, i) => ({
        id: `old-${i}`, workspace_id: 'w1', user_id: 'u1', kind: 'email.drafted', state: 'routed', outcome: 'turn', decided_by: 'jev',
        jev_shadow: { ...answer('now'), rule_outcome: 'quiet', rule: 'quiet', change: 'promoted' }, routed_at: at(-60), created_at: at(-61), dedupe_key: `old-${i}`,
      })))
      seedRows(db, [
        { kind: 'email.drafted', facts: { from: 'a@x.com', known: false } },
        { kind: 'email.drafted', facts: { from: 'b@x.com', known: false } },
      ])
      const { deps } = depsWith({ 'a@x.com': 'now', 'b@x.com': 'now' }, new Map([['email.drafted', both]]))
      const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
      expect(result.jev).toMatchObject({ promoted: 1 })
      expect(db.rows('agent_event').find((r) => r.id === '1')).toMatchObject({ outcome: 'turn', decided_by: 'jev' })
      expect(db.rows('agent_event').find((r) => r.id === '2')).toMatchObject({ outcome: 'quiet', decided_by: 'rule' })
    })

    it('a failing proven read leaves every row to the rules', async () => {
      const db = makeFakeSupabase()
      seedRows(db, [{ kind: 'email.drafted', facts: { from: 'friend@acme.com', known: true } }])
      const { deps } = depsWith({ 'friend@acme.com': 'digest' }, new Map())
      deps.provenKinds = async () => { throw new Error('read failed') }
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const result = await routeAgentEvents(db as never, { workspaceId: 'w1', userId: 'u1' }, deps)
      expect(db.rows('agent_event')[0]).toMatchObject({ outcome: 'turn', decided_by: 'rule' })
      expect(result.jev).toMatchObject({ decided: 0, proven: [] })
    })
  })
})
