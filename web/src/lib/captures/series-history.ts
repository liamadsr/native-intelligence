import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Recurring-meeting history: every capture in the workspace matching any of
 * the series keys, grouped by occurrence.
 *
 * MUST run on a USER-scoped client — RLS (mig 223) is what enforces the
 * product's visibility rule (caller sees own + workspace-shared captures,
 * never a teammate's private ones). Passing a service client here would leak.
 */

export interface SeriesKey {
  column: 'series_key' | 'ical_uid' | 'calendar_event_id'
  value: string
}

interface SeriesCaptureRow {
  id: string
  title: string
  user_id: string
  started_at: string | null
  ended_at: string | null
  created_at: string
  duration_seconds: number | null
  visibility: string | null
  occurrence_start: string | null
  calendar_event_id: string | null
  series_key: string | null
}

const ROW_FIELDS =
  'id, title, user_id, started_at, ended_at, created_at, duration_seconds, visibility, occurrence_start, calendar_event_id, series_key'

export interface SeriesOccurrence {
  occurrence_start: string
  captures: Array<{
    id: string
    title: string
    user_id: string
    is_own: boolean
    owner_name: string | null
    owner_avatar_url: string | null
    started_at: string | null
    ended_at: string | null
    duration_seconds: number | null
    visibility: string | null
  }>
}

export async function buildSeriesHistory(
  supabase: SupabaseClient,
  opts: {
    workspaceId: string
    requesterUserId: string
    keys: SeriesKey[]
    /** Never filtered out even when it's an unstarted placeholder (the capture
     *  the user is currently looking at). */
    keepCaptureId?: string
  },
): Promise<SeriesOccurrence[]> {
  const { workspaceId, requesterUserId, keys, keepCaptureId } = opts
  if (keys.length === 0) return []

  // Values (Microsoft base64 ids, iCal UIDs) can contain PostgREST or-syntax
  // metacharacters — run one indexed query per key and merge, instead of a
  // string-built .or() filter.
  const results = await Promise.all(
    keys.map(({ column, value }) =>
      supabase
        .from('captures')
        .select(ROW_FIELDS)
        .eq('workspace_id', workspaceId)
        .eq(column, value)
        .neq('status', 'archived')
        .order('started_at', { ascending: false, nullsFirst: false })
        .limit(100),
    ),
  )

  const byId = new Map<string, SeriesCaptureRow>()
  for (const { data } of results) {
    for (const row of (data as SeriesCaptureRow[] | null) || []) {
      byId.set(row.id, row)
    }
  }

  // Sync pre-creates live PLACEHOLDER rows (never started) for upcoming
  // occurrences — they are not sessions and must not appear in (or inflate)
  // the history. Rows that HAVE started stay, including a teammate currently
  // recording the same call.
  const rows = [...byId.values()]
    .filter((r) => r.started_at !== null || r.id === keepCaptureId)
    .sort((a, b) => {
      const ta = new Date(a.occurrence_start || a.started_at || a.created_at).getTime()
      const tb = new Date(b.occurrence_start || b.started_at || b.created_at).getTime()
      return tb - ta
    })

  // Owner display info for the "captured by" affordance when several people
  // recorded the same call.
  const userIds = [...new Set(rows.map((r) => r.user_id))]
  const { data: members } = userIds.length
    ? await supabase
        .from('member')
        .select('user_id, display_name, avatar_url')
        .eq('workspace_id', workspaceId)
        .in('user_id', userIds)
    : { data: [] }
  const memberByUserId = new Map(
    (members || []).map((m) => [m.user_id as string, m]),
  )

  // Group into occurrences: captures of the SAME occurrence (N teammates on
  // one call) share an exact occurrence_start; legacy rows without one fall
  // back to calendar-day grouping.
  const groups = new Map<string, { occurrence_start: string; captures: SeriesCaptureRow[] }>()
  for (const row of rows) {
    const anchorTs = row.occurrence_start || row.started_at || row.created_at
    const key = row.occurrence_start
      ? `occ:${new Date(row.occurrence_start).getTime()}`
      : `day:${anchorTs.slice(0, 10)}`
    const group = groups.get(key)
    if (group) {
      group.captures.push(row)
    } else {
      groups.set(key, { occurrence_start: anchorTs, captures: [row] })
    }
  }

  return [...groups.values()].map((g) => ({
    occurrence_start: g.occurrence_start,
    captures: g.captures.map((c) => {
      const member = memberByUserId.get(c.user_id)
      return {
        id: c.id,
        title: c.title,
        user_id: c.user_id,
        is_own: c.user_id === requesterUserId,
        owner_name: (member?.display_name as string | undefined) || null,
        owner_avatar_url: (member?.avatar_url as string | undefined) || null,
        started_at: c.started_at,
        ended_at: c.ended_at,
        duration_seconds: c.duration_seconds,
        visibility: c.visibility,
      }
    }),
  }))
}
