/**
 * How long call audio is kept (the daily `team-call-notes-retention` cron,
 * src/lib/inngest/team-call-notes.ts). Bounded work per run
 * (RETENTION_BATCH of each kind; the next day takes the rest):
 *
 *   1. A microphone's raw notes audio whose words are in (done, or empty):
 *      removed, whether or not the call was also recorded. The notes are the
 *      kept record, and a recording, when there is one, is the call's own
 *      file; the per-person audio is not kept beside it.
 *   2. Raw notes audio whose words could not be read (failed): kept for
 *      FAILED_AUDIO_DAYS (someone may want to look into it), then removed.
 *   3. Objects in the bucket whose call row is gone (a channel deleted takes
 *      its calls' rows with it): removed, recordings included, since nobody
 *      can reach them any more (569's team_call_recordings_orphans). A call
 *      recorder's audio file among them (650) has its row marked deleted,
 *      so its capture says so rather than offering a file that is gone.
 *
 * Each removal is the storage API's (the file and its row go together), as
 * the service role. Privacy: logs carry counts only.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { markAudioDeleted } from '@/lib/capture-feed/audio-retention'
import { TEAM_CALL_RECORDINGS_BUCKET } from './notes'

export const RETENTION_BATCH = 200
export const FAILED_AUDIO_DAYS = 7

export interface RetentionResult {
  settled: number
  failedExpired: number
  orphans: number
}

async function removePaths(svc: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await svc.storage.from(TEAM_CALL_RECORDINGS_BUCKET).remove(paths)
  if (error) throw new Error(`team calls retention: files not removed: ${error.message}`)
}

async function markRemoved(svc: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  const at = new Date().toISOString()
  const { error } = await svc.from('team_call_egress').update({ audio_deleted_at: at, updated_at: at }).in('id', ids)
  if (error) throw new Error(`team calls retention: rows not marked: ${error.message}`)
}

export async function sweepCallAudio(svc: SupabaseClient, deps: { now?: () => Date } = {}): Promise<RetentionResult> {
  const now = deps.now?.() ?? new Date()
  const result: RetentionResult = { settled: 0, failedExpired: 0, orphans: 0 }

  // 1. Words in: the audio goes.
  const { data: settled, error: settledError } = await svc
    .from('team_call_egress')
    .select('id, file_path')
    .eq('kind', 'notes')
    .is('audio_deleted_at', null)
    .in('transcript_status', ['done', 'empty'])
    .order('created_at', { ascending: true })
    .limit(RETENTION_BATCH)
  if (settledError) throw new Error(`team calls retention: read failed: ${settledError.message}`)
  const done = (settled ?? []) as Array<{ id: string; file_path: string }>
  await removePaths(svc, done.map((r) => r.file_path))
  await markRemoved(svc, done.map((r) => r.id))
  result.settled = done.length

  // 2. Words never read: kept a week, then gone.
  const { data: failed, error: failedError } = await svc
    .from('team_call_egress')
    .select('id, file_path')
    .eq('kind', 'notes')
    .is('audio_deleted_at', null)
    .eq('transcript_status', 'failed')
    .lt('updated_at', new Date(now.getTime() - FAILED_AUDIO_DAYS * 24 * 60 * 60_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(RETENTION_BATCH)
  if (failedError) throw new Error(`team calls retention: read failed: ${failedError.message}`)
  const expired = (failed ?? []) as Array<{ id: string; file_path: string }>
  await removePaths(svc, expired.map((r) => r.file_path))
  await markRemoved(svc, expired.map((r) => r.id))
  result.failedExpired = expired.length

  // 3. Files of calls that are gone.
  const { data: orphans, error: orphanError } = await svc.rpc('team_call_recordings_orphans', { max_rows: RETENTION_BATCH })
  if (orphanError) throw new Error(`team calls retention: orphans read failed: ${orphanError.message}`)
  const names = ((orphans ?? []) as Array<{ name: string } | string>).map((o) => (typeof o === 'string' ? o : o.name)).filter(Boolean)
  await removePaths(svc, names)
  await markAudioDeleted(svc, { paths: names.filter((n) => n.split('/')[2] === 'audio') }, now)
  result.orphans = names.length

  console.info(`[team-call-notes-retention] settled=${result.settled} failed_expired=${result.failedExpired} orphans=${result.orphans}`)
  return result
}
