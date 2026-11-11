/**
 * Team chat's meetings section (calls plan, phase 7 follow-up): which of the
 * person's meetings it shows, and in what order. Pure; client and server.
 *
 * A meeting shows from the moment it is made, used or not: live now first,
 * then upcoming by start, then unscheduled links ("Any time", newest first),
 * then recently ended. An ended one (revoked, run out, or past its planned
 * end) drops out after MEETING_RECENT_MS, unless its conversation has unread
 * messages; it stays reachable through its conversation as before.
 */

/** A meeting of the person's, as the section reads it (GET /api/account/meeting-links?view=mine). */
export interface MyMeeting {
  id: string
  channel_id: string
  title: string
  starts_at: string | null
  ends_at: string | null
  opens_at: string
  closes_at: string
  revoked_at: string | null
  created_at: string
  host_member_id: string | null
  /** The person hosts it (New link, Revoke). */
  is_host: boolean
  /** Its call is live now. */
  live: boolean
  /** Its link (null when revoked). */
  url: string | null
}

export type MeetingPhase = 'live' | 'upcoming' | 'anytime' | 'ended'

/** How long an ended meeting stays in the section. */
export const MEETING_RECENT_MS = 6 * 60 * 60_000

/** Where a meeting is now, and (ended) since when. Pure. */
export function meetingPhase(m: Pick<MyMeeting, 'live' | 'revoked_at' | 'closes_at' | 'starts_at' | 'ends_at'>, now: number): { phase: MeetingPhase; endedAt?: number } {
  if (m.live) return { phase: 'live' }
  if (m.revoked_at) return { phase: 'ended', endedAt: Date.parse(m.revoked_at) }
  if (now >= Date.parse(m.closes_at)) return { phase: 'ended', endedAt: Date.parse(m.closes_at) }
  if (m.starts_at && m.ends_at && now >= Date.parse(m.ends_at)) return { phase: 'ended', endedAt: Date.parse(m.ends_at) }
  return { phase: m.starts_at ? 'upcoming' : 'anytime' }
}

export type SectionMeeting = MyMeeting & { phase: MeetingPhase }

const ORDER: Record<MeetingPhase, number> = { live: 0, upcoming: 1, anytime: 2, ended: 3 }

/**
 * The section: the meetings to show, in order. `unread`: a conversation's
 * unread count (an ended meeting with unread messages stays). Pure.
 */
export function meetingSection(items: readonly MyMeeting[], now: number, unread: (channelId: string) => number = () => 0): SectionMeeting[] {
  const shown: Array<SectionMeeting & { endedAt?: number }> = []
  for (const m of items) {
    const { phase, endedAt } = meetingPhase(m, now)
    if (phase === 'ended' && now - (endedAt ?? 0) > MEETING_RECENT_MS && unread(m.channel_id) <= 0) continue
    shown.push({ ...m, phase, endedAt })
  }
  shown.sort((a, b) => {
    if (a.phase !== b.phase) return ORDER[a.phase] - ORDER[b.phase]
    if (a.phase === 'upcoming') return Date.parse(a.starts_at ?? '') - Date.parse(b.starts_at ?? '')
    if (a.phase === 'ended') return (b.endedAt ?? 0) - (a.endedAt ?? 0)
    return Date.parse(b.created_at) - Date.parse(a.created_at)
  })
  return shown.map(({ endedAt: _e, ...m }) => m)
}

/** The section row's when-line: "Live now", "Any time", the start in the viewer's zone, or "Ended". Pure (the zone given). */
export function meetingWhen(m: Pick<SectionMeeting, 'phase' | 'starts_at'>, now: number, timeZone?: string): string {
  if (m.phase === 'live') return 'Live now'
  if (m.phase === 'ended') return 'Ended'
  if (!m.starts_at) return 'Any time'
  const at = new Date(m.starts_at)
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
  const time = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(at)
  const today = day(new Date(now))
  const tomorrow = day(new Date(now + 24 * 60 * 60_000))
  if (day(at) === today) return `Today ${time}`
  if (day(at) === tomorrow) return `Tomorrow ${time}`
  const date = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', month: 'short', day: 'numeric' }).format(at)
  return `${date}, ${time}`
}
