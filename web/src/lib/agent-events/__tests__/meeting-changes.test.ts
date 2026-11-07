/**
 * Meeting changes from the calendar (meeting-changes.ts;
 * docs/plans/email-through-the-agent.md E4): what counts as cancelled,
 * removed or moved, what is never news, and the runner's order (record
 * first, then forget and refresh) and silence when the table is missing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEventInput } from '../record'
import type { MeetingWindowRead, UpcomingMeeting } from '../upcoming-meetings'

const recorded = vi.hoisted(() => ({ inputs: [] as AgentEventInput[] }))
vi.mock('../record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../record')>()),
  recordAgentEvents: vi.fn(async (inputs: AgentEventInput[]) => {
    recorded.inputs.push(...inputs)
    return inputs.length
  }),
}))

const { diffMeetingWatch, meetingChangedEvent, watchMeetingChanges, watchRowOf, MIN_LEAD_MS, MOVE_MIN_MS, STALE_MS } = await import('../meeting-changes')
type Row = import('../meeting-changes').MeetingWatchRow

const NOW = Date.parse('2026-10-20T14:00:00.000Z')
const iso = (minutes: number) => new Date(NOW + minutes * 60_000).toISOString()
const PERSON = { workspaceId: 'ws-1', userId: 'u-1' }

function meeting(key: string, startMin: number, over: Partial<UpcomingMeeting> = {}): UpcomingMeeting {
  return {
    ref: 'calendar_event', id: `evt-${key}`, meetingKey: key, workspaceId: 'ws-1', userId: 'u-1', title: `Meeting ${key}`,
    startIso: iso(startMin), attendees: ['me@x.com', 'sam@y.com'], calendarEventId: `evt-${key}`, captureId: null,
    accountId: 'acct-1', mine: false, others: 1, ...over,
  }
}

function row(key: string, startMin: number, over: Partial<Row> = {}): Row {
  return {
    meeting_key: key, account_id: 'acct-1', event_id: `evt-${key}`, title: `Meeting ${key}`, start_at: iso(startMin),
    attendee_count: 1, mine: false, last_seen_at: iso(-5), ...over,
  }
}

function read(meetings: UpcomingMeeting[], over: Partial<MeetingWindowRead> = {}): MeetingWindowRead {
  return { meetings, cancelled: [], declined: new Set(), completeAccounts: new Set(['acct-1']), ...over }
}

describe('diffMeetingWatch', () => {
  it('a watched meeting gone from a complete read is removed; one the provider marks cancelled is cancelled', () => {
    const d = diffMeetingWatch([row('a', 120), row('b', 180)], read([], { cancelled: [meeting('b', 180)] }), NOW)
    expect(d.changes.map((c) => [c.row.meeting_key, c.change])).toEqual([['a', 'removed'], ['b', 'cancelled']])
    expect(d.deletes).toEqual(['a', 'b'])
  })

  it('a start that shifts by MOVE_MIN_MS or more is a move, with the new start; a smaller shift is not', () => {
    const d = diffMeetingWatch(
      [row('a', 120), row('b', 120)],
      read([meeting('a', 120 + MOVE_MIN_MS / 60_000), meeting('b', 121)]),
      NOW,
    )
    expect(d.changes).toEqual([{ change: 'moved', row: row('a', 120), movedTo: iso(125) }])
    // Both stay watched, seen now at their new starts.
    expect(d.upserts.map((u) => [u.meeting_key, u.start_at, u.last_seen_at])).toEqual([['a', iso(125), iso(0)], ['b', iso(121), iso(0)]])
    expect(d.deletes).toEqual([])
  })

  it('never news: the person’s own meeting, a solo block, one they declined', () => {
    const d = diffMeetingWatch(
      [row('mine', 120, { mine: true }), row('solo', 120, { attendee_count: 0 }), row('declined', 120)],
      read([], { declined: new Set(['declined']) }),
      NOW,
    )
    expect(d.changes).toEqual([])
    // Still forgotten: they are gone from the calendar.
    expect(d.deletes.sort()).toEqual(['declined', 'mine', 'solo'])
  })

  it('a meeting starting within MIN_LEAD_MS (or past) is happening, not changing: forgotten silently', () => {
    const d = diffMeetingWatch([row('now', MIN_LEAD_MS / 60_000), row('past', -10)], read([]), NOW)
    expect(d.changes).toEqual([])
    expect(d.deletes).toEqual(['now', 'past'])
  })

  it('an account not read in full (failed or capped) vouches for nothing: its rows are kept as they were', () => {
    const d = diffMeetingWatch([row('a', 120)], read([], { completeAccounts: new Set() }), NOW)
    expect(d.changes).toEqual([])
    expect(d.deletes).toEqual([])
    expect(d.upserts).toEqual([])
  })

  it('a stale watch row (missed passes) tells no change, but is forgotten when gone', () => {
    const stale = iso(-(STALE_MS / 60_000) - 1)
    const d = diffMeetingWatch([row('gone', 120, { last_seen_at: stale }), row('moved', 120, { last_seen_at: stale })], read([meeting('moved', 180)]), NOW)
    expect(d.changes).toEqual([])
    expect(d.deletes).toEqual(['gone'])
  })

  it('only provider meetings with their account are watched (local events and captures have no cancel signal)', () => {
    const d = diffMeetingWatch([], read([meeting('p', 120), meeting('local', 120, { ref: 'local_calendar_event', accountId: null }), meeting('cap', 120, { ref: 'capture', accountId: null })]), NOW)
    expect(d.upserts.map((u) => u.meeting_key)).toEqual(['p'])
    expect(watchRowOf(meeting('x', 1, { accountId: undefined }), iso(0))).toBeNull()
  })

  it('a meeting seen for the first time is only watched, never announced', () => {
    const d = diffMeetingWatch([], read([meeting('new', 60)]), NOW)
    expect(d.changes).toEqual([])
    expect(d.upserts).toHaveLength(1)
  })
})

describe('meetingChangedEvent', () => {
  it('names the change, keeps the old start as occurs_at, expires at the meeting’s time, and is keyed once per change', () => {
    const cancelled = meetingChangedEvent(PERSON, { change: 'cancelled', row: row('a', 120, { attendee_count: 3 }) })
    expect(cancelled).toMatchObject({
      kind: 'meeting.changed', priority: 2, occursAt: iso(120), expiresAt: iso(120), refType: 'calendar_event', refId: 'evt-a',
      facts: { title: 'Meeting a', change: 'cancelled', attendeeCount: 3, meetingRef: 'calendar_event' },
      dedupeKey: `meeting:a:${iso(120)}:changed:cancelled`,
    })
    expect(cancelled.facts).not.toHaveProperty('movedTo')
    // A move later stays news until the new time.
    const later = meetingChangedEvent(PERSON, { change: 'moved', row: row('a', 120), movedTo: iso(240) })
    expect(later).toMatchObject({ expiresAt: iso(240), facts: { change: 'moved', movedTo: iso(240) }, dedupeKey: `meeting:a:${iso(120)}:changed:moved:${iso(240)}` })
    const earlier = meetingChangedEvent(PERSON, { change: 'moved', row: row('a', 120), movedTo: iso(60) })
    expect(earlier.expiresAt).toBe(iso(120))
  })
})

describe('watchMeetingChanges', () => {
  let ops: Array<{ op: string; table: string; args?: unknown }>
  let watchRows: Row[] | null
  let readError: unknown

  function fake() {
    return {
      from: (table: string) => {
        const q: Record<string, unknown> = {
          select: () => q, eq: () => q, in: (_c: string, v: unknown) => { ops.push({ op: 'delete.in', table, args: v }); return q },
          limit: async () => ({ data: watchRows, error: readError }),
          delete: () => { ops.push({ op: 'delete', table }); return q },
          upsert: async (rows: unknown, opts: unknown) => { ops.push({ op: 'upsert', table, args: { rows, opts } }); return { error: null } },
        }
        return q
      },
    } as never
  }

  beforeEach(() => {
    ops = []
    watchRows = []
    readError = null
    recorded.inputs.length = 0
  })

  it('records the changes, then forgets and refreshes the watch, keyed per person', async () => {
    watchRows = [row('gone', 120), row('kept', 90)]
    const landed = await watchMeetingChanges(fake(), PERSON, read([meeting('kept', 90), meeting('new', 300)]), {}, NOW)
    expect(landed).toBe(1)
    expect(recorded.inputs.map((i) => [i.kind, i.facts?.change])).toEqual([['meeting.changed', 'removed']])
    expect(ops.map((o) => o.op)).toEqual(['delete', 'delete.in', 'upsert'])
    expect(ops[1].args).toEqual(['gone'])
    const upsert = ops[2].args as { rows: Array<Record<string, unknown>>; opts: unknown }
    expect(upsert.opts).toEqual({ onConflict: 'pass_workspace_id,user_id,meeting_key' })
    expect(upsert.rows.map((r) => [r.meeting_key, r.pass_workspace_id, r.user_id])).toEqual([['kept', 'ws-1', 'u-1'], ['new', 'ws-1', 'u-1']])
    // Never a workspace_id column: a workspace merge must pass over the cache (migration 405).
    expect(upsert.rows.every((r) => !('workspace_id' in r))).toBe(true)
  })

  it('a database without migration 405 has no watch: nothing recorded, nothing written, no throw', async () => {
    readError = { message: 'relation "agent_meeting_watch" does not exist' }
    expect(await watchMeetingChanges(fake(), PERSON, read([meeting('a', 60)]), {}, NOW)).toBe(0)
    expect(recorded.inputs).toEqual([])
    expect(ops).toEqual([])
  })
})
