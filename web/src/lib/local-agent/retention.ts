/**
 * Local agents: transcript retention (docs/plans/local-agents.md §6). A
 * job's `local_agent_event` rows are kept until 30 days after the job's last
 * activity, then they go as a whole. The daily cron
 * (/api/cron/local-agent-purge) runs this.
 *
 * - The clock is the SESSION's `updated_at` (every claim, upload, message and
 *   reap bumps it), not each event's own age, so a transcript never loses its
 *   beginning while the job is still in use. A session untouched for 30 days
 *   is over: any live status is reaped on read after 24 h idle (store.ts).
 * - Only events go. The session row stays, with its request, status, report
 *   (`last_signal_text`), branch and commit, so the Environment card's
 *   branches, the ledger's link and `read_local_agent` keep working; the
 *   transcript simply reads as empty. Messages are small and stay too.
 * - An event younger than 30 days is never deleted, whatever its session
 *   says (the DELETE carries the cutoff as well).
 * - Flat cost: it walks the oldest events by id (the primary key), a bounded
 *   page at a time, and stops at the first event inside the window. Old
 *   events of a session still in use are stepped over by the id cursor, and
 *   the walk is capped per tick, so it can never read the whole table. The
 *   sweep is idempotent: what one tick leaves, the next takes.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

type Svc = SupabaseClient

export const EVENT_RETENTION_DAYS = 30

/** Events read per page, oldest first. */
const EVENT_PAGE = 1000
/** Pages one tick reads at most. */
const MAX_PAGES = 5
/** Sessions per lookup and per DELETE (keeps the `in (...)` list short). */
const SESSION_CHUNK = 50

export interface EventPurgeResult {
  ok: boolean
  cutoff: string
  /** Old events read (not deleted ones). */
  scanned: number
  sessionsPurged: number
  /** Sessions with old events that were active inside the window, so kept. */
  sessionsKept: number
  eventsDeleted: number
  /** More old events than one tick reads; the next tick goes on. */
  truncated: boolean
}

function chunks<T>(xs: readonly T[], n: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

export async function purgeOldEvents(svc: Svc, now = Date.now()): Promise<EventPurgeResult> {
  const cutoffMs = now - EVENT_RETENTION_DAYS * 24 * 60 * 60_000
  const cutoff = new Date(cutoffMs).toISOString()
  // Postgres writes `…+00:00` (fractions optional): compare instants, not strings.
  const old = (at: string) => Date.parse(at) < cutoffMs
  const result: EventPurgeResult = {
    ok: true,
    cutoff,
    scanned: 0,
    sessionsPurged: 0,
    sessionsKept: 0,
    eventsDeleted: 0,
    truncated: false,
  }
  // Sessions decided this tick: a long transcript spans pages.
  const decided = new Set<string>()
  let cursor = 0

  for (let page = 0; page < MAX_PAGES; page++) {
    const { data, error } = await svc
      .from('local_agent_event')
      .select('id, session_id, created_at')
      .gt('id', cursor)
      .order('id', { ascending: true })
      .limit(EVENT_PAGE)
    if (error) {
      console.error('[local-agent-purge] event page failed:', error.message)
      return { ...result, ok: false }
    }
    const rows = (data ?? []) as Array<{ id: number; session_id: string; created_at: string }>
    if (rows.length === 0) return result

    // Ids follow insertion, so the first event inside the window ends the walk.
    const inside = rows.findIndex((r) => !old(r.created_at))
    const aged = inside === -1 ? rows : rows.slice(0, inside)
    result.scanned += aged.length

    const fresh = [...new Set(aged.map((r) => r.session_id))].filter((id) => !decided.has(id))
    for (const ids of chunks(fresh, SESSION_CHUNK)) {
      const { data: sessions, error: sErr } = await svc
        .from('local_agent_session')
        .select('id, updated_at')
        .in('id', ids)
      if (sErr) {
        console.error('[local-agent-purge] session lookup failed:', sErr.message)
        return { ...result, ok: false }
      }
      const idle: string[] = []
      for (const s of (sessions ?? []) as Array<{ id: string; updated_at: string }>) {
        decided.add(s.id)
        if (old(s.updated_at)) idle.push(s.id)
        else result.sessionsKept++
      }
      if (idle.length === 0) continue
      const { count, error: dErr } = await svc
        .from('local_agent_event')
        .delete({ count: 'exact' })
        .in('session_id', idle)
        .lt('created_at', cutoff)
      if (dErr) {
        // The next tick retries it; the other chunks are independent.
        console.error('[local-agent-purge] delete failed:', dErr.message)
        result.ok = false
        continue
      }
      result.sessionsPurged += idle.length
      result.eventsDeleted += count ?? 0
    }

    if (inside !== -1 || rows.length < EVENT_PAGE) return result
    cursor = rows[rows.length - 1].id
  }
  result.truncated = true
  return result
}
