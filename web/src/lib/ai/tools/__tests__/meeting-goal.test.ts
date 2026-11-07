/**
 * The meeting goal in the chat (migration 356). Pins:
 *   - set_meeting_goal saves the caller's goal for the meeting (event id and
 *     start, normalised) as source 'chat'; an empty goal clears it; it never
 *     touches anyone else's; an unattended run is refused; bad input is an
 *     error result, nothing written;
 *   - the turn seed: a message about a goal for a meeting seeds it
 *     (mentionsMeetingGoal), a goal with no meeting does not;
 *   - get_meeting_prep returns the stored goal (by event id and start, by the
 *     anchor capture, or the event's next occurrence), and only the caller's.
 */
import { describe, it, expect, vi } from 'vitest'
import type { ToolExecutionOptions } from 'ai'
import { CAP, EVENT, ME, OTHER, START, WS, goalRow, meetingGoalDb, type MeetingGoalDb } from '@/lib/meetings/__tests__/helpers/meeting-goal-db'
import { MEETING_GOAL_TOOL_NAMES, mentionsMeetingGoal } from '../../tool-discovery'

// calendar-capture imports the calendar integrations; get_meeting_prep never touches them.
vi.mock('@/lib/integrations/calendar-sync', () => ({ syncCalendarToCaptures: vi.fn(), getUpcomingCaptures: vi.fn() }))
vi.mock('@/lib/integrations/calendar', () => ({ listCalendarEvents: vi.fn(), getCalendarProvider: vi.fn() }))

import { createMeetingGoalTools } from '../meeting-goal'
import { createCalendarCaptureTools } from '../calendar-capture'

const HOUR = 60 * 60_000
const EXEC_OPTS = { toolCallId: 't', messages: [], context: {} } satisfies ToolExecutionOptions<Record<string, unknown>>

function setGoal(db: MeetingGoalDb, args: { calendar_event_id?: string; starts_at?: string; goal: string }, opts: { unattended?: boolean } = {}) {
  const tools = createMeetingGoalTools(ME, db.client, WS, opts.unattended ?? false)
  return tools.set_meeting_goal.execute!(
    { calendar_event_id: args.calendar_event_id ?? EVENT, starts_at: args.starts_at ?? START, goal: args.goal },
    EXEC_OPTS,
  ) as unknown as Promise<Record<string, unknown>>
}

describe('set_meeting_goal', () => {
  it("saves the caller's goal as source chat, its start normalised", async () => {
    const db = meetingGoalDb()
    const res = await setGoal(db, { starts_at: '2026-10-17T14:30:00-04:00', goal: '  close the pilot ' })
    expect(res).toMatchObject({ success: true, goal: 'close the pilot', calendar_event_id: EVENT, starts_at: START })
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0]).toMatchObject({ workspace_id: WS, user_id: ME, source: 'chat', goal: 'close the pilot' })
  })

  it('replaces the goal the prep card set', async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow()] })
    await setGoal(db, { goal: 'get a yes on pricing' })
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0]).toMatchObject({ goal: 'get a yes on pricing', source: 'chat' })
  })

  it("an empty goal clears the caller's own, and only theirs", async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow({ id: 'mine' }), goalRow({ id: 'theirs', user_id: OTHER })] })
    const res = await setGoal(db, { goal: '   ' })
    expect(res).toMatchObject({ success: true, cleared: true, calendar_event_id: EVENT, starts_at: START })
    expect(db.tables.meeting_goal.map((r) => r.id)).toEqual(['theirs'])
  })

  it('refused on an unattended run, nothing written', async () => {
    const db = meetingGoalDb()
    expect(await setGoal(db, { goal: 'x' }, { unattended: true })).toMatchObject({ success: false })
    expect(db.tables.meeting_goal).toHaveLength(0)
  })

  it.each([
    ['no event id', { calendar_event_id: ' ', goal: 'x' }],
    ['an unreadable start', { starts_at: 'at 2:30', goal: 'x' }],
    ['a goal over 500 characters', { goal: 'x'.repeat(501) }],
  ])('%s: an error result, nothing written', async (_label, args) => {
    const db = meetingGoalDb()
    expect(await setGoal(db, args)).toMatchObject({ success: false })
    expect(db.tables.meeting_goal).toHaveLength(0)
  })

  it('a failed write is an error result', async () => {
    const db = meetingGoalDb({}, { failOn: 'upsert' })
    expect(await setGoal(db, { goal: 'x' })).toMatchObject({ success: false, error: 'upsert failed' })
  })
})

describe('the turn seed', () => {
  it('seeds set_meeting_goal', () => {
    expect(MEETING_GOAL_TOOL_NAMES).toEqual(['set_meeting_goal'])
  })

  it.each([
    'the goal of my 2:30 is to close the pilot',
    'My goal for the Acme call: a yes on pricing',
    'objective for tomorrow’s meeting with Dana is to agree the scope',
    'goal for the 3pm: get the intro',
    'for the Acme call I want a yes on pricing',
    'I need a signed SOW out of tomorrow’s meeting with Dana',
  ])('a goal for a meeting: %s', (text) => {
    expect(mentionsMeetingGoal(text)).toBe(true)
  })

  it.each([
    'what are our Q4 goals?',
    'set up a call with Dana',
    'goal',
    '',
    null,
    'I need the notes from my call with Dana',
    'I want to set up a meeting with Dana',
    'I want the summary of the Acme call',
  ])('anything else: %s', (text) => {
    expect(mentionsMeetingGoal(text)).toBe(false)
  })
})

describe('get_meeting_prep returns the goal', () => {
  const prep = (db: MeetingGoalDb, args: Record<string, unknown>) =>
    createCalendarCaptureTools(ME, db.client, WS).get_meeting_prep.execute!(args as never, EXEC_OPTS) as unknown as Promise<
      Record<string, unknown>
    >

  it('by event id and start', async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow()] })
    const res = await prep(db, { event_id: EVENT, starts_at: '2026-10-17T14:30:00-04:00' })
    expect(res).toMatchObject({ success: true, meeting_goal: 'Close the pilot' })
  })

  it("by the event's upcoming capture", async () => {
    const db = meetingGoalDb({
      meeting_goal: [goalRow({ calendar_event_id: 'other', capture_id: CAP })],
      captures: [
        {
          id: CAP,
          workspace_id: WS,
          calendar_event_id: EVENT,
          title: 'Acme sync',
          series_key: null,
          ical_uid: null,
          scheduled_start: new Date(Date.now() + HOUR).toISOString(),
        },
      ],
    })
    const res = await prep(db, { event_id: EVENT })
    expect(res).toMatchObject({ success: true, event_title: 'Acme sync', meeting_goal: 'Close the pilot' })
  })

  describe('a weekly series (one event id for every occurrence)', () => {
    const SERIES = 'eventkit-weekly-1'
    const OLD_CAP = '22222222-2222-4222-8222-222222222222'
    const NEW_CAP = '33333333-3333-4333-8333-333333333333'
    const lastWeek = () => new Date(Date.now() - 7 * 24 * HOUR).toISOString()
    const nextHour = () => new Date(Date.now() + HOUR).toISOString()
    const captures = () => [
      // The past occurrence first, as an unordered read would hand it back.
      { id: OLD_CAP, workspace_id: WS, calendar_event_id: SERIES, title: 'Weekly', series_key: null, ical_uid: null, scheduled_start: lastWeek(), occurrence_start: lastWeek() },
      { id: NEW_CAP, workspace_id: WS, calendar_event_id: SERIES, title: 'Weekly', series_key: null, ical_uid: null, scheduled_start: nextHour(), occurrence_start: nextHour() },
    ]

    it("this week's goal, never last week's", async () => {
      const db = meetingGoalDb({
        meeting_goal: [
          goalRow({ id: 'old', calendar_event_id: SERIES, starts_at: lastWeek(), capture_id: OLD_CAP, goal: 'last week' }),
          goalRow({ id: 'new', calendar_event_id: SERIES, starts_at: nextHour(), goal: 'this week' }),
        ],
        captures: captures(),
      })
      expect(await prep(db, { event_id: SERIES })).toMatchObject({ meeting_goal: 'this week' })
    })

    it("only last week's goal: none", async () => {
      const db = meetingGoalDb({
        meeting_goal: [goalRow({ id: 'old', calendar_event_id: SERIES, starts_at: lastWeek(), capture_id: OLD_CAP, goal: 'last week' })],
        captures: captures(),
      })
      expect(await prep(db, { event_id: SERIES })).not.toHaveProperty('meeting_goal')
    })
  })

  it("by the event's next occurrence when no start is given", async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T15:00:00Z'))
    try {
      const db = meetingGoalDb({ meeting_goal: [goalRow()] })
      expect(await prep(db, { event_id: EVENT })).toMatchObject({ meeting_goal: 'Close the pilot' })
    } finally {
      vi.useRealTimers()
    }
  })

  it("no goal, or only someone else's: no meeting_goal at all", async () => {
    const none = await prep(meetingGoalDb(), { event_id: EVENT, starts_at: START })
    expect(none.success).toBe(true)
    expect(none).not.toHaveProperty('meeting_goal')
    const theirs = await prep(meetingGoalDb({ meeting_goal: [goalRow({ user_id: OTHER })] }), { event_id: EVENT, starts_at: START })
    expect(theirs).not.toHaveProperty('meeting_goal')
  })

  it('a failed goal read never breaks the prep', async () => {
    const res = await prep(meetingGoalDb({ meeting_goal: [goalRow()] }, { failOn: 'select' }), { event_id: EVENT, starts_at: START })
    expect(res.success).toBe(true)
    expect(res).not.toHaveProperty('meeting_goal')
  })
})
