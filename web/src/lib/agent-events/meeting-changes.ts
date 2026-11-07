/**
 * Meeting changes from the calendar (docs/plans/email-through-the-agent.md
 * E4; Liam, 2026-10-20: "if a meeting was canceled, the main agent can
 * decide: Hey Liam, the meeting you had at 4 p.m. got canceled").
 *
 * The 5-minute meeting pass (./meeting-pass.ts) reads the next
 * MEETING_WATCH_WINDOW_MS of the person's provider calendars once
 * (./upcoming-meetings.ts readMeetingWindow). This file keeps what that read
 * saw in `agent_meeting_watch` (migration 405) and compares each read with
 * the last one:
 *   • a watched meeting the provider now marks cancelled → `cancelled`;
 *   • one gone from a complete read of its account → `removed` (cancelled or
 *     deleted, or moved past the window: the read can't tell which);
 *   • one whose start moved by MOVE_MIN_MS or more → `moved`.
 * Each is one `meeting.changed` event; the router sends it to the home thread
 * as a turn, and the agent decides what to say (./router.ts turnRuleFor).
 *
 * Never news, so never an event: the person's own meetings (they organize
 * them, so the change was theirs), solo blocks (nobody else invited), a
 * meeting they declined, one starting within MIN_LEAD_MS (it is happening, or
 * the read's window just moved past it), and anything seen through a read
 * that wasn't whole: an account whose read failed or hit the per-read cap, or
 * a watch row not refreshed within STALE_MS (the pass was paused or dormant).
 * The desktop's local events and pending captures are not watched: neither
 * says when a meeting is cancelled.
 *
 * The diff is pure (diffMeetingWatch); the runner (watchMeetingChanges) never
 * throws.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordAgentEvents, type AgentEventInput, type RecordAgentEventsDeps } from './record'
import { agentEventKey } from './types'
import type { MeetingPerson, MeetingWindowRead, UpcomingMeeting } from './upcoming-meetings'

/** How far ahead the watch looks (Liam's decision 4: today's and tomorrow's changes interrupt). */
export const MEETING_WATCH_WINDOW_MS = 24 * 60 * 60_000
/** A meeting this close to its start (or past it) is not watched: it is happening. */
export const MIN_LEAD_MS = 5 * 60_000
/** A start that shifts by less than this did not move. */
export const MOVE_MIN_MS = 5 * 60_000
/** A watch row not refreshed within this long can't vouch for a change (missed passes). */
export const STALE_MS = 20 * 60_000
/** At most this many watch rows are read per person. */
const MAX_WATCH_ROWS = 500

export type MeetingChangeKind = 'cancelled' | 'removed' | 'moved'

/** One `agent_meeting_watch` row, as read and written (its owner columns aside). */
export interface MeetingWatchRow {
  meeting_key: string
  account_id: string
  event_id: string
  title: string | null
  start_at: string
  attendee_count: number
  mine: boolean
  last_seen_at: string
}

export interface MeetingChange {
  change: MeetingChangeKind
  /** The meeting as it was last seen (its old start). */
  row: MeetingWatchRow
  /** A moved meeting's new start. */
  movedTo?: string
}

export interface MeetingWatchDiff {
  changes: MeetingChange[]
  /** The rows to write: every watched meeting in this read, seen now. */
  upserts: MeetingWatchRow[]
  /** The meeting keys to forget: started, gone or changed away. */
  deletes: string[]
}

/** The watch row for a meeting seen now (a provider meeting with its account). Pure. */
export function watchRowOf(m: UpcomingMeeting, nowIso: string): MeetingWatchRow | null {
  if (m.ref !== 'calendar_event' || !m.accountId) return null
  return {
    meeting_key: m.meetingKey,
    account_id: m.accountId,
    event_id: m.id.slice(0, 300),
    title: m.title ? m.title.slice(0, 200) : null,
    start_at: m.startIso,
    attendee_count: Math.max(0, Math.min(10_000, m.others ?? 0)),
    mine: m.mine === true,
    last_seen_at: nowIso,
  }
}

/** A change to this meeting is news to the person: someone else is in it and they don't organize it. Pure. */
function isNews(row: MeetingWatchRow): boolean {
  return !row.mine && row.attendee_count > 0
}

/**
 * Compare the last pass's watch with this read (see the header). Pure.
 */
export function diffMeetingWatch(
  prev: readonly MeetingWatchRow[],
  read: Pick<MeetingWindowRead, 'meetings' | 'cancelled' | 'declined' | 'completeAccounts'>,
  nowMs: number,
): MeetingWatchDiff {
  const nowIso = new Date(nowMs).toISOString()
  const current = new Map<string, MeetingWatchRow>()
  for (const m of read.meetings) {
    const row = watchRowOf(m, nowIso)
    if (row) current.set(row.meeting_key, row)
  }
  const cancelled = new Set(read.cancelled.map((m) => m.meetingKey))
  const changes: MeetingChange[] = []
  const deletes: string[] = []
  for (const p of prev) {
    const startMs = Date.parse(p.start_at)
    const ahead = Number.isFinite(startMs) && startMs > nowMs + MIN_LEAD_MS
    const fresh = nowMs - Date.parse(p.last_seen_at) <= STALE_MS
    const now = current.get(p.meeting_key)
    if (now) {
      const shift = Math.abs(Date.parse(now.start_at) - startMs)
      if (ahead && fresh && isNews(p) && shift >= MOVE_MIN_MS) changes.push({ change: 'moved', row: p, movedTo: now.start_at })
      continue
    }
    // Started (or about to): it is happening, not changing.
    if (!ahead) {
      deletes.push(p.meeting_key)
      continue
    }
    // Its account wasn't read in full: no word on it either way (kept until its start passes).
    if (!read.completeAccounts.has(p.account_id)) continue
    deletes.push(p.meeting_key)
    if (read.declined.has(p.meeting_key)) continue
    if (!fresh || !isNews(p)) continue
    changes.push({ change: cancelled.has(p.meeting_key) ? 'cancelled' : 'removed', row: p })
  }
  return { changes, upserts: [...current.values()], deletes }
}

/** The `meeting.changed` event for one change. Pure. */
export function meetingChangedEvent(person: Pick<MeetingPerson, 'workspaceId' | 'userId'>, c: MeetingChange): AgentEventInput {
  const movedTo = c.change === 'moved' ? c.movedTo : undefined
  // A move later stays news until the new time; anything else, until the old one.
  const expiresAt = movedTo && Date.parse(movedTo) > Date.parse(c.row.start_at) ? movedTo : c.row.start_at
  return {
    workspaceId: person.workspaceId,
    userId: person.userId,
    kind: 'meeting.changed',
    priority: 2,
    occursAt: c.row.start_at,
    expiresAt,
    refType: 'calendar_event',
    refId: c.row.event_id,
    facts: {
      title: c.row.title ?? 'Untitled meeting',
      change: c.change,
      ...(movedTo ? { movedTo } : {}),
      attendeeCount: c.row.attendee_count,
      meetingRef: 'calendar_event',
    },
    dedupeKey: agentEventKey.meetingChanged(c.row.meeting_key, c.row.start_at, c.change, movedTo),
  }
}

const WATCH_COLUMNS = 'meeting_key, account_id, event_id, title, start_at, attendee_count, mine, last_seen_at'

/**
 * One pass of the watch for one person: read the last watch, record the
 * changes, then forget and refresh. A change is recorded before the watch is
 * written, and its dedupe key tells it once, so a failed write only means the
 * next pass looks again. Returns how many events newly landed. Never throws:
 * a database without migration 405 has no watch.
 */
export async function watchMeetingChanges(
  supabase: SupabaseClient,
  person: Pick<MeetingPerson, 'workspaceId' | 'userId'>,
  read: Pick<MeetingWindowRead, 'meetings' | 'cancelled' | 'declined' | 'completeAccounts'>,
  deps: { record?: RecordAgentEventsDeps } = {},
  nowMs: number = Date.now(),
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('agent_meeting_watch')
      .select(WATCH_COLUMNS)
      .eq('pass_workspace_id', person.workspaceId)
      .eq('user_id', person.userId)
      .limit(MAX_WATCH_ROWS)
    if (error) return 0
    // Postgres answers `…+00:00`; the event's key and times use the app's ISO form (`…Z`).
    const prev = ((data as MeetingWatchRow[] | null) ?? []).flatMap((r) => {
      const start = Date.parse(r.start_at)
      const seen = Date.parse(r.last_seen_at)
      return Number.isFinite(start) && Number.isFinite(seen)
        ? [{ ...r, start_at: new Date(start).toISOString(), last_seen_at: new Date(seen).toISOString() }]
        : []
    })
    const diff = diffMeetingWatch(prev, read, nowMs)
    const landed = diff.changes.length
      ? await recordAgentEvents(diff.changes.map((c) => meetingChangedEvent(person, c)), supabase, deps.record ?? {})
      : 0
    if (diff.deletes.length) {
      await supabase
        .from('agent_meeting_watch')
        .delete()
        .eq('pass_workspace_id', person.workspaceId)
        .eq('user_id', person.userId)
        .in('meeting_key', diff.deletes)
    }
    if (diff.upserts.length) {
      await supabase
        .from('agent_meeting_watch')
        .upsert(
          // pass_workspace_id, not workspace_id: a cache a workspace merge drops, never re-stamps (migration 405).
          diff.upserts.map((r) => ({ ...r, pass_workspace_id: person.workspaceId, user_id: person.userId })),
          { onConflict: 'pass_workspace_id,user_id,meeting_key' },
        )
    }
    return landed
  } catch (err) {
    console.warn('[meeting-changes] skipped:', err instanceof Error ? err.message : err)
    return 0
  }
}
