/**
 * The meeting-goal store (src/lib/meetings/meeting-goal.ts). Pins: a start
 * keys the same meeting however it is spelled; reads and writes fence on the
 * workspace AND the person (the service role sees every row); one goal per
 * meeting, a second write replaces it and keeps a linked capture; an empty or
 * over-long goal is refused; clear removes only the person's own; a capture
 * finds its goal by link, else by its calendar event and start, else (an
 * ad-hoc call) under its own synthetic meeting; the meeting a capture's goal
 * is written under (meetingKeyForCapture).
 */
import { describe, it, expect } from 'vitest'
import {
  MEETING_GOAL_MAX_CHARS,
  clearMeetingGoal,
  captureMeetingEventId,
  findMeetingGoalForCapture,
  findUpcomingMeetingGoalForEvent,
  getMeetingGoal,
  meetingGoalCacheKey,
  meetingKeyForCapture,
  normalizeGoalText,
  normalizeStartsAt,
  upsertMeetingGoal,
} from '../meeting-goal'
import { CAP, EVENT, ME, OTHER, START, WS, goalRow, meetingGoalDb } from './helpers/meeting-goal-db'

const KEY = { workspaceId: WS, userId: ME, calendarEventId: EVENT, startsAt: START }

describe('normalizeStartsAt', () => {
  it('one instant, however it is spelled', () => {
    expect(normalizeStartsAt('2026-10-17T18:30:00Z')).toBe(START)
    expect(normalizeStartsAt('2026-10-17T14:30:00-04:00')).toBe(START)
    expect(normalizeStartsAt('2026-10-17T18:30:00+00:00')).toBe(START)
    expect(meetingGoalCacheKey(EVENT, '2026-10-17T14:30:00-04:00')).toBe(meetingGoalCacheKey(EVENT, START))
  })

  it('null for anything unreadable', () => {
    for (const v of ['', 'soon', null, 42, undefined]) expect(normalizeStartsAt(v)).toBeNull()
  })
})

describe('normalizeGoalText', () => {
  it('trims; empty is no goal; over the limit is refused, never cut', () => {
    expect(normalizeGoalText('  close it  ')).toEqual({ ok: true, goal: 'close it' })
    expect(normalizeGoalText('   ')).toEqual({ ok: true, goal: '' })
    expect(normalizeGoalText('x'.repeat(MEETING_GOAL_MAX_CHARS))).toEqual({ ok: true, goal: 'x'.repeat(MEETING_GOAL_MAX_CHARS) })
    expect(normalizeGoalText('x'.repeat(MEETING_GOAL_MAX_CHARS + 1))).toEqual({ ok: false, reason: 'too_long' })
    expect(normalizeGoalText(7)).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('getMeetingGoal', () => {
  it("the person's goal for the meeting, its start as an ISO instant", async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow()] })
    const goal = await getMeetingGoal(db.client, { ...KEY, startsAt: '2026-10-17T14:30:00-04:00' })
    expect(goal).toMatchObject({ goal: 'Close the pilot', calendarEventId: EVENT, startsAt: START, source: 'prep_card' })
  })

  it("never someone else's, nor another workspace's, nor another occurrence's", async () => {
    const db = meetingGoalDb({
      meeting_goal: [
        goalRow({ id: 'a', user_id: OTHER }),
        goalRow({ id: 'b', workspace_id: 'ws-2' }),
        goalRow({ id: 'c', starts_at: '2026-10-24T18:30:00.000Z' }),
      ],
    })
    expect(await getMeetingGoal(db.client, KEY)).toBeNull()
  })

  it('an unusable key reads nothing', async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow()] })
    expect(await getMeetingGoal(db.client, { ...KEY, startsAt: 'soon' })).toBeNull()
    expect(db.reads).toEqual([])
  })

  it('a failed read throws', async () => {
    const db = meetingGoalDb({}, { failOn: 'select' })
    await expect(getMeetingGoal(db.client, KEY)).rejects.toThrow('select failed')
  })
})

describe('upsertMeetingGoal', () => {
  it('writes one row per meeting; a second write replaces the goal and keeps the capture', async () => {
    const db = meetingGoalDb()
    const first = await upsertMeetingGoal(db.client, { ...KEY, goal: ' Close the pilot ', source: 'prep_card', captureId: CAP })
    expect(first).toMatchObject({ ok: true, goal: { goal: 'Close the pilot', captureId: CAP, startsAt: START } })
    const second = await upsertMeetingGoal(db.client, {
      ...KEY,
      startsAt: '2026-10-17T14:30:00-04:00',
      goal: 'Get a yes on pricing',
      source: 'chat',
    })
    expect(second).toMatchObject({ ok: true, goal: { goal: 'Get a yes on pricing', source: 'chat', captureId: CAP } })
    expect(db.tables.meeting_goal).toHaveLength(1)
    expect(db.tables.meeting_goal[0]).toMatchObject({ workspace_id: WS, user_id: ME, calendar_event_id: EVENT })
  })

  it('refuses an empty goal, an over-long one, and a bad key, writing nothing', async () => {
    const db = meetingGoalDb()
    expect(await upsertMeetingGoal(db.client, { ...KEY, goal: '  ', source: 'chat' })).toMatchObject({ ok: false, reason: 'empty' })
    expect(await upsertMeetingGoal(db.client, { ...KEY, goal: 'x'.repeat(501), source: 'chat' })).toMatchObject({ ok: false, reason: 'too_long' })
    expect(await upsertMeetingGoal(db.client, { ...KEY, calendarEventId: ' ', goal: 'x', source: 'chat' })).toMatchObject({ ok: false, reason: 'bad_key' })
    expect(db.tables.meeting_goal).toHaveLength(0)
  })

  it('a failed write is an error result', async () => {
    const db = meetingGoalDb({}, { failOn: 'upsert' })
    expect(await upsertMeetingGoal(db.client, { ...KEY, goal: 'x', source: 'chat' })).toMatchObject({ ok: false, reason: 'error' })
  })
})

describe('clearMeetingGoal', () => {
  it("removes the person's own goal only, saying whether there was one", async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow({ id: 'mine' }), goalRow({ id: 'theirs', user_id: OTHER })] })
    expect(await clearMeetingGoal(db.client, KEY)).toBe(true)
    expect(db.tables.meeting_goal.map((r) => r.id)).toEqual(['theirs'])
    expect(await clearMeetingGoal(db.client, KEY)).toBe(false)
  })
})

describe('findMeetingGoalForCapture', () => {
  it('the goal linked to the capture', async () => {
    const db = meetingGoalDb({ meeting_goal: [goalRow({ capture_id: CAP, calendar_event_id: 'other-evt' })] })
    expect(await findMeetingGoalForCapture(db.client, { workspaceId: WS, userId: ME, captureId: CAP })).toMatchObject({ goal: 'Close the pilot' })
    expect(db.reads).toEqual(['meeting_goal'])
  })

  it("else the goal for the capture's calendar event at its occurrence start", async () => {
    const db = meetingGoalDb({
      meeting_goal: [goalRow()],
      captures: [{ id: CAP, workspace_id: WS, calendar_event_id: EVENT, occurrence_start: '2026-10-17T18:30:00+00:00', scheduled_start: null }],
    })
    expect(await findMeetingGoalForCapture(db.client, { workspaceId: WS, userId: ME, captureId: CAP })).toMatchObject({ goal: 'Close the pilot' })
  })

  it('or at its scheduled start', async () => {
    const db = meetingGoalDb({
      meeting_goal: [goalRow()],
      captures: [{ id: CAP, workspace_id: WS, calendar_event_id: EVENT, occurrence_start: null, scheduled_start: '2026-10-17T14:30:00-04:00' }],
    })
    expect(await findMeetingGoalForCapture(db.client, { workspaceId: WS, userId: ME, captureId: CAP })).toMatchObject({ goal: 'Close the pilot' })
  })

  it("null for another person's goal, a capture with no event, or one in another workspace", async () => {
    const capture = { id: CAP, workspace_id: WS, calendar_event_id: EVENT, occurrence_start: START, scheduled_start: START }
    const theirs = meetingGoalDb({ meeting_goal: [goalRow({ user_id: OTHER, capture_id: CAP })], captures: [capture] })
    expect(await findMeetingGoalForCapture(theirs.client, { workspaceId: WS, userId: ME, captureId: CAP })).toBeNull()
    const noEvent = meetingGoalDb({ meeting_goal: [goalRow()], captures: [{ ...capture, calendar_event_id: null }] })
    expect(await findMeetingGoalForCapture(noEvent.client, { workspaceId: WS, userId: ME, captureId: CAP })).toBeNull()
    const elsewhere = meetingGoalDb({ meeting_goal: [goalRow()], captures: [{ ...capture, workspace_id: 'ws-2' }] })
    expect(await findMeetingGoalForCapture(elsewhere.client, { workspaceId: WS, userId: ME, captureId: CAP })).toBeNull()
  })
})

describe('an ad-hoc call (no calendar event)', () => {
  const ADHOC = { id: CAP, workspace_id: WS, calendar_event_id: null, occurrence_start: null, scheduled_start: null, started_at: '2026-10-18T11:00:00-04:00', created_at: '2026-10-18T14:59:00+00:00' }

  it("the meeting a capture's goal is written under: its event at its start, else its own synthetic meeting at its start", () => {
    expect(meetingKeyForCapture(CAP, { calendar_event_id: EVENT, occurrence_start: '2026-10-17T14:30:00-04:00', scheduled_start: '2026-10-17T19:00:00Z' })).toEqual({ calendarEventId: EVENT, startsAt: START })
    expect(meetingKeyForCapture(CAP, { calendar_event_id: EVENT, occurrence_start: null, scheduled_start: START })).toEqual({ calendarEventId: EVENT, startsAt: START })
    expect(captureMeetingEventId(CAP)).toBe(`capture:${CAP}`)
    expect(meetingKeyForCapture(CAP, ADHOC)).toEqual({ calendarEventId: `capture:${CAP}`, startsAt: '2026-10-18T15:00:00.000Z' })
    expect(meetingKeyForCapture(CAP, { ...ADHOC, started_at: null })).toEqual({ calendarEventId: `capture:${CAP}`, startsAt: '2026-10-18T14:59:00.000Z' })
    // An event with no start of its own is the capture's own meeting too.
    expect(meetingKeyForCapture(CAP, { ...ADHOC, calendar_event_id: EVENT })).toEqual({ calendarEventId: `capture:${CAP}`, startsAt: '2026-10-18T15:00:00.000Z' })
    expect(meetingKeyForCapture(CAP, { ...ADHOC, started_at: null, created_at: null })).toBeNull()
    expect(meetingKeyForCapture(CAP, null)).toBeNull()
  })

  it('a goal saved under the synthetic meeting with the link is found by the capture', async () => {
    const db = meetingGoalDb({ captures: [ADHOC] })
    const key = meetingKeyForCapture(CAP, ADHOC)!
    const saved = await upsertMeetingGoal(db.client, { workspaceId: WS, userId: ME, ...key, goal: 'Agree the rollout', source: 'hud', captureId: CAP })
    expect(saved).toMatchObject({ ok: true, goal: { calendarEventId: `capture:${CAP}`, captureId: CAP, source: 'hud' } })
    expect(await findMeetingGoalForCapture(db.client, { workspaceId: WS, userId: ME, captureId: CAP })).toMatchObject({ goal: 'Agree the rollout', source: 'hud' })
  })

  it('and without the link, under its own synthetic meeting; never another capture’s or person’s', async () => {
    const own = goalRow({ calendar_event_id: `capture:${CAP}`, starts_at: '2026-10-18T15:00:00Z', goal: 'Mine, unlinked', source: 'hud' })
    const db = meetingGoalDb({ meeting_goal: [own], captures: [ADHOC] })
    expect(await findMeetingGoalForCapture(db.client, { workspaceId: WS, userId: ME, captureId: CAP })).toMatchObject({ goal: 'Mine, unlinked' })
    const other = meetingGoalDb({ meeting_goal: [{ ...own, calendar_event_id: 'capture:someone-else' }], captures: [ADHOC] })
    expect(await findMeetingGoalForCapture(other.client, { workspaceId: WS, userId: ME, captureId: CAP })).toBeNull()
    const theirs = meetingGoalDb({ meeting_goal: [{ ...own, user_id: OTHER }], captures: [ADHOC] })
    expect(await findMeetingGoalForCapture(theirs.client, { workspaceId: WS, userId: ME, captureId: CAP })).toBeNull()
  })
})

describe('findUpcomingMeetingGoalForEvent', () => {
  it("the event's next goal from the given moment on", async () => {
    const db = meetingGoalDb({
      meeting_goal: [
        goalRow({ id: 'past', starts_at: '2026-10-10T18:30:00.000Z', goal: 'old' }),
        goalRow({ id: 'next', goal: 'next one' }),
        goalRow({ id: 'later', starts_at: '2026-10-24T18:30:00.000Z', goal: 'later one' }),
      ],
    })
    const goal = await findUpcomingMeetingGoalForEvent(db.client, { workspaceId: WS, userId: ME, calendarEventId: EVENT, sinceMs: Date.parse('2026-10-17T00:00:00Z') })
    expect(goal?.goal).toBe('next one')
  })
})
