/**
 * Presence rows and the home thread's seen marker (migration 454,
 * docs/plans/reach-follows-you.md §1 and §2). Server only: every call takes
 * the service client, because `user_presence` grants nothing to signed-in
 * clients and the seen marker is fenced here rather than by RLS.
 *
 * Each call is one statement, so a ping costs one upsert and, when it carries
 * a seen, one conditional update.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PresencePing, PresenceRow, PresenceState } from './presence'

/** Rows untouched this long go in the daily notification purge. */
export const PRESENCE_RETENTION_MS = 30 * 24 * 60 * 60_000

/**
 * Write one ping: one upsert on (user_id, client_id). `active_at` moves only
 * when the ping says `active`, so an idle or locked row keeps when the person
 * was last active on that client (the router reads it for "after his last
 * activity in an app"). `updated_at` always moves: it is what the prune reads.
 */
export async function upsertPresence(service: SupabaseClient, userId: string, ping: PresencePing & { state: PresenceState }, now: number = Date.now()): Promise<void> {
  const at = new Date(now).toISOString()
  const row: Record<string, unknown> = {
    user_id: userId,
    client_id: ping.clientId,
    surface: ping.surface,
    state: ping.state,
    updated_at: at,
  }
  if (ping.state === 'active') row.active_at = at
  // The desktop's word on a meeting (migration 666). `meeting_at` moves only while one is on, so it keeps
  // when the last one was (the router reads it for "written while he was in a meeting").
  const meeting = ping.surface === 'desktop' && typeof ping.meeting === 'boolean'
  if (meeting) {
    row.in_meeting = ping.meeting
    if (ping.meeting) row.meeting_at = at
  }
  let { error } = await service.from('user_presence').upsert(row, { onConflict: 'user_id,client_id' })
  if (error && meeting && missingMeetingColumn(error)) {
    // Before migration 666 is applied (or before the API reloaded its schema): the ping still lands, without the meeting mark.
    warnMissingMeetingColumn()
    delete row.in_meeting
    delete row.meeting_at
    ;({ error } = await service.from('user_presence').upsert(row, { onConflict: 'user_id,client_id' }))
  }
  if (error) throw new Error(`user_presence upsert failed: ${error.message}`)
}

/** The store's answer when `user_presence`'s meeting columns are not there yet (migration 666 not applied, or the API's schema not reloaded). */
function missingMeetingColumn(error: { message?: string | null }): boolean {
  return typeof error.message === 'string' && (error.message.includes('meeting_at') || error.message.includes('in_meeting'))
}

let warnedMissingMeetingColumn = false
/** Once per process: without the columns nothing is ever held for a meeting, and that should not be silent. */
function warnMissingMeetingColumn(): void {
  if (warnedMissingMeetingColumn) return
  warnedMissingMeetingColumn = true
  console.warn('[presence] user_presence has no meeting columns (migration 666): meetings hold no messages until it is applied')
}

/**
 * Move the home thread's `seen_at` forward to `throughIso`, clamped to now (a
 * client clock running ahead can never mark future messages read). One
 * conditional update, fenced on the conversation being this person's home
 * thread and on the new value being later than what is stored, so it never
 * moves backwards and never touches another person's or a non-home thread.
 * Nothing matching is not an error: an older report, or a thread that stopped
 * being home, simply changes nothing.
 */
export async function markHomeSeen(
  service: SupabaseClient,
  userId: string,
  conversationId: string,
  throughIso: string,
  now: number = Date.now(),
): Promise<void> {
  const through = Date.parse(throughIso)
  if (!Number.isFinite(through)) throw new Error('markHomeSeen: through is not a time')
  const seenAt = new Date(Math.min(through, now)).toISOString()
  const { error } = await service
    .from('chat_conversations')
    .update({ seen_at: seenAt })
    .eq('id', conversationId)
    .eq('user_id', userId)
    .eq('is_home', true)
    .or(`seen_at.is.null,seen_at.lt.${seenAt}`)
  if (error) throw new Error(`chat_conversations seen_at update failed: ${error.message}`)
}

/** Every presence row of one person, newest first: what the router (part C) reads before it picks a channel. */
export async function readPresence(service: SupabaseClient, userId: string): Promise<PresenceRow[]> {
  const read = (columns: string) => service.from('user_presence').select(columns).eq('user_id', userId).order('updated_at', { ascending: false })
  let { data, error } = await read('client_id, surface, state, active_at, updated_at, in_meeting, meeting_at')
  // Before migration 666 is applied: the rows without the meeting mark, so the router keeps working.
  if (error && missingMeetingColumn(error)) {
    warnMissingMeetingColumn()
    ;({ data, error } = await read('client_id, surface, state, active_at, updated_at'))
  }
  if (error) throw new Error(`user_presence read failed: ${error.message}`)
  return (data ?? []) as unknown as PresenceRow[]
}

/**
 * Delete rows no ping has touched in PRESENCE_RETENTION_MS: browsers that
 * were cleared or never came back. Returns how many went.
 */
export async function prunePresence(service: SupabaseClient, now: number = Date.now()): Promise<number> {
  const cutoff = new Date(now - PRESENCE_RETENTION_MS).toISOString()
  const { count, error } = await service.from('user_presence').delete({ count: 'exact' }).lt('updated_at', cutoff)
  if (error) throw new Error(`user_presence prune failed: ${error.message}`)
  return count ?? 0
}
