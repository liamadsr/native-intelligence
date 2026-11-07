'use client'

/**
 * The person's goal for one meeting, for the prep card's composer
 * (MeetingGoalComposer; migration 356): read once with
 * GET /api/account/meeting-goal, changed optimistically by PUT and DELETE.
 *
 * One module-level cache, keyed by the meeting (its calendar event id and
 * normalised start): every card for the same meeting (a prep's question, then
 * its result) shares one read and shows one goal, and a card scrolled back
 * into the chat shows it at once. A write that fails puts the goal back and
 * says so. A goal set from the chat (set_meeting_goal) re-reads the meeting
 * once its tool result lands (refreshMeetingGoal), if a card is showing it.
 * A saved write (and a chat-set goal's result for a meeting around now) also
 * says so on the window (MEETING_GOAL_CHANGED_EVENT), for the live HUD. The
 * HUD's own goal line writes through the same cache (saveMeetingGoal, source
 * 'hud').
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { dispatchMeetingGoalChanged, meetingGoalCacheKey, type MeetingGoalSource } from '@/lib/meetings/meeting-goal'

const URL_BASE = '/api/account/meeting-goal'

export type MeetingGoalStatus = 'loading' | 'ready' | 'error'

export interface MeetingGoalEntry {
  status: MeetingGoalStatus
  goal: string | null
}

export interface MeetingGoalMeeting {
  calendarEventId: string
  startsAt: string
  captureId: string | null
}

const IDLE: MeetingGoalEntry = { status: 'loading', goal: null }
const entries = new Map<string, MeetingGoalEntry>()
const listeners = new Map<string, Set<() => void>>()
/** Each meeting's newest write: an older one's answer never undoes a newer one. */
const latestWrite = new Map<string, number>()
let writeSeq = 0

function set(key: string, entry: MeetingGoalEntry) {
  entries.set(key, entry)
  listeners.get(key)?.forEach((fn) => fn())
}

function subscribe(key: string, onChange: () => void) {
  let s = listeners.get(key)
  if (!s) listeners.set(key, (s = new Set()))
  s.add(onChange)
  return () => {
    s.delete(onChange)
    if (s.size === 0) listeners.delete(key)
  }
}

const query = (m: { calendarEventId: string; startsAt: string }) =>
  `?calendar_event_id=${encodeURIComponent(m.calendarEventId)}&starts_at=${encodeURIComponent(m.startsAt)}`

async function read(key: string, m: { calendarEventId: string; startsAt: string }) {
  const seq = latestWrite.get(key)
  try {
    const res = await fetch(`${URL_BASE}${query(m)}`)
    if (!res.ok) throw new Error(String(res.status))
    const body = (await res.json()) as { goal?: { goal?: unknown } | null }
    // A write since this read started knows better.
    if (latestWrite.get(key) !== seq) return
    set(key, { status: 'ready', goal: typeof body.goal?.goal === 'string' ? body.goal.goal : null })
  } catch {
    if (latestWrite.get(key) !== seq) return
    set(key, { status: 'error', goal: null })
  }
}

/** Read the meeting's goal, once per page for each meeting however many cards ask (a failed read is tried again by the next card to mount). */
function load(key: string, m: { calendarEventId: string; startsAt: string }) {
  const known = entries.get(key)
  if (known && known.status !== 'error') return
  entries.set(key, IDLE)
  void read(key, m)
}

/**
 * The chat set (or cleared) this meeting's goal: re-read it, when a card has
 * already read it. `once` (the tool call id) keeps a stored result from re-reading on
 * every render.
 */
const refreshed = new Set<string>()
/** A chat-set goal tells the live HUD only for a meeting starting within this of now. */
const GOAL_EVENT_WINDOW_MS = 12 * 60 * 60_000
export function refreshMeetingGoal(m: { calendarEventId: string; startsAt: string }, once: string) {
  if (refreshed.has(once)) return
  refreshed.add(once)
  // A meeting around now may be the call the live HUD is on: it re-reads its
  // brief. (A stored result for an old or far-off meeting says nothing.)
  const startMs = Date.parse(m.startsAt)
  if (Number.isFinite(startMs) && Math.abs(startMs - Date.now()) <= GOAL_EVENT_WINDOW_MS) {
    dispatchMeetingGoalChanged({ calendarEventId: m.calendarEventId, startsAt: m.startsAt, captureId: null })
  }
  const key = meetingGoalCacheKey(m.calendarEventId, m.startsAt)
  // Only a goal a card already read: a read in flight answers anyway (a stored
  // result on page load adds nothing), and a meeting no card asked for (a
  // finished one) is never read.
  if (entries.get(key)?.status === 'ready') void read(key, m)
}

/** Tests: forget every meeting. */
export function _resetMeetingGoalCacheForTests() {
  entries.clear()
  listeners.clear()
  latestWrite.clear()
  refreshed.clear()
}

async function write(
  key: string,
  m: MeetingGoalMeeting,
  goal: string | null,
  source: MeetingGoalSource,
  quiet = false,
): Promise<boolean> {
  const before = entries.get(key) ?? { status: 'ready' as const, goal: null }
  const seq = ++writeSeq
  latestWrite.set(key, seq)
  set(key, { status: 'ready', goal })
  try {
    const res = goal
      ? await fetch(URL_BASE, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            calendar_event_id: m.calendarEventId,
            starts_at: m.startsAt,
            ...(m.captureId ? { capture_id: m.captureId } : {}),
            goal,
            source,
          }),
        })
      : await fetch(`${URL_BASE}${query(m)}`, { method: 'DELETE' })
    if (!res.ok) throw new Error(String(res.status))
    // The live HUD's Briefing line re-reads (useCaptureBrief).
    dispatchMeetingGoalChanged({ calendarEventId: m.calendarEventId, startsAt: m.startsAt, captureId: m.captureId })
    return true
  } catch {
    if (latestWrite.get(key) === seq) {
      set(key, before)
      if (!quiet) toast.error(goal ? 'The goal wasn’t saved. Try again.' : 'The goal wasn’t cleared. Try again.')
    }
    return false
  }
}

/**
 * Save a meeting's goal from anywhere on the page (trimmed; '' clears it),
 * through the same cache as the cards: a card showing the meeting shows the
 * new goal, and a saved write says so on the window
 * (MEETING_GOAL_CHANGED_EVENT). `source` is where it was set; `quiet` leaves
 * a failure to the caller (no toast). Resolves false when the write failed.
 */
export function saveMeetingGoal(
  m: MeetingGoalMeeting,
  goal: string,
  source: MeetingGoalSource,
  opts: { quiet?: boolean } = {},
): Promise<boolean> {
  const text = goal.trim()
  return write(meetingGoalCacheKey(m.calendarEventId, m.startsAt), m, text || null, source, opts.quiet === true)
}

export interface MeetingGoalHandle extends MeetingGoalEntry {
  /** Save the goal (trimmed; '' clears it), set from `source` (the prep card's, by default). Resolves false when the write failed (the goal is back). */
  save: (goal: string, source?: MeetingGoalSource) => Promise<boolean>
}

/** The meeting's goal, read on mount (null meeting or `enabled` false: nothing is read). */
export function useMeetingGoal(meeting: MeetingGoalMeeting | null, enabled = true): MeetingGoalHandle {
  const key = meeting ? meetingGoalCacheKey(meeting.calendarEventId, meeting.startsAt) : ''
  const entry = useSyncExternalStore(
    useCallback((onChange: () => void) => (key ? subscribe(key, onChange) : () => {}), [key]),
    () => (key ? (entries.get(key) ?? IDLE) : IDLE),
    () => IDLE,
  )
  const calendarEventId = meeting?.calendarEventId
  const startsAt = meeting?.startsAt
  useEffect(() => {
    if (!enabled || !key || !calendarEventId || !startsAt) return
    load(key, { calendarEventId, startsAt })
  }, [enabled, key, calendarEventId, startsAt])

  const captureId = meeting?.captureId ?? null
  const save = useCallback(
    (goal: string, source: MeetingGoalSource = 'prep_card') => {
      if (!key || !calendarEventId || !startsAt) return Promise.resolve(false)
      return saveMeetingGoal({ calendarEventId, startsAt, captureId }, goal, source)
    },
    [key, calendarEventId, startsAt, captureId],
  )
  return { ...entry, save }
}
