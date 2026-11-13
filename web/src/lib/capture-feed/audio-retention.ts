/**
 * Call audio files are kept 30 days (migration 650), then deleted: a step of
 * the daily `team-call-notes-retention` cron (src/lib/inngest/team-call-notes.ts).
 * Only the file goes: the capture, its transcript and its notes stay, and the
 * capture's page says the day the file was deleted. The same 30 days for
 * everyone; nothing sets it. Bounded work per run (AUDIO_RETENTION_BATCH of
 * each kind; the next day takes the rest), and every part may run again:
 *
 *   1. A pending take whose file landed over an hour ago is stored (its
 *      producer stopped between the upload and saying so), on the same checks
 *      as the producer's own "stored"; one that fails them (another type, too
 *      large) has its object removed and its row marked deleted, never kept.
 *   2. Takes past their 30 days: each object removed through the storage API
 *      (the file and its row go together; one already gone is no error),
 *      then the row marked deleted, with the day. A removal that fails leaves
 *      the row as it is, for the next run.
 *   3. Audio objects no row keeps (their capture was deleted): removed.
 *
 * It never touches anything but 650's audio files: the bucket's notes and
 * recordings are ./notes-retention's (src/lib/team-calls/), and a person's
 * own captures keep no sound at all. Logs carry counts only.
 *
 * It runs whatever TEAM_CALL_AUDIO says: files kept before the switch went
 * off are still deleted on their day. On a database without migration 650
 * yet (650's own function not there, by its code and its name) it does
 * nothing, says so every run, and the job succeeds; any other failure fails
 * the step, every time.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { CAPTURE_AUDIO_BUCKET, missingFromDatabase } from './audio'

export const AUDIO_RETENTION_BATCH = 200

export interface AudioRetentionResult {
  settled: number
  deleted: number
  orphans: number
  /** Migration 650 is not on this database yet: nothing was done. */
  skipped?: true
  /** Takes whose landed file was not the one their grant named: removed, never kept. */
  invalid?: number
}

async function remove(svc: SupabaseClient, paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const { error } = await svc.storage.from(CAPTURE_AUDIO_BUCKET).remove(paths)
  if (error) throw new Error(`call audio retention: files not removed: ${error.message}`)
}

/** Rows whose objects were removed: deleted, with the day (a row deleted already keeps its day). */
export async function markAudioDeleted(svc: SupabaseClient, by: { ids?: string[]; paths?: string[] }, now: Date = new Date()): Promise<void> {
  const at = now.toISOString()
  const patch = { state: 'deleted', deleted_at: at, updated_at: at }
  if (by.ids && by.ids.length > 0) {
    const { error } = await svc.from('capture_audio').update(patch).in('id', by.ids).neq('state', 'deleted')
    if (error) throw new Error(`call audio retention: rows not marked: ${error.message}`)
  }
  if (by.paths && by.paths.length > 0) {
    const { error } = await svc.from('capture_audio').update(patch).in('path', by.paths).neq('state', 'deleted')
    if (error) throw new Error(`call audio retention: rows not marked: ${error.message}`)
  }
}

export async function expireCallAudio(svc: SupabaseClient, deps: { now?: () => Date } = {}): Promise<AudioRetentionResult> {
  const now = deps.now?.() ?? new Date()
  const result: AudioRetentionResult = { settled: 0, invalid: 0, deleted: 0, orphans: 0 }

  // 1. Landed, never said.
  const { data: settled, error: settleError } = await svc.rpc('capture_audio_settle', { max_rows: AUDIO_RETENTION_BATCH })
  if (settleError && missingFromDatabase(settleError)) {
    console.warn('[call-audio-retention] skipped: migration 650 is not applied to this database')
    return { ...result, skipped: true }
  }
  if (settleError) throw new Error(`call audio retention: settle failed: ${settleError.message}`)
  const settledRows = (Array.isArray(settled) ? settled : []) as Array<{ outcome: string; id: string; path: string }>
  result.settled = settledRows.filter((r) => r.outcome === 'stored').length
  const invalid = settledRows.filter((r) => r.outcome === 'invalid' && r.id && r.path)
  await remove(svc, invalid.map((r) => r.path))
  await markAudioDeleted(svc, { ids: invalid.map((r) => r.id) }, now)
  result.invalid = invalid.length

  // 2. Past their 30 days.
  const { data: due, error: dueError } = await svc.rpc('capture_audio_due', { max_rows: AUDIO_RETENTION_BATCH })
  if (dueError) throw new Error(`call audio retention: due read failed: ${dueError.message}`)
  const rows = ((due ?? []) as Array<{ id: string; path: string }>).filter((r) => r.id && r.path)
  await remove(svc, rows.map((r) => r.path))
  await markAudioDeleted(svc, { ids: rows.map((r) => r.id) }, now)
  result.deleted = rows.length

  // 3. Files no row keeps.
  const { data: orphans, error: orphanError } = await svc.rpc('capture_audio_orphans', { max_rows: AUDIO_RETENTION_BATCH })
  if (orphanError) throw new Error(`call audio retention: orphans read failed: ${orphanError.message}`)
  const names = ((orphans ?? []) as Array<{ name: string } | string>).map((o) => (typeof o === 'string' ? o : o.name)).filter(Boolean)
  await remove(svc, names)
  // A deleted row's file left behind by a failed run: its row already says deleted.
  await markAudioDeleted(svc, { paths: names }, now)
  result.orphans = names.length

  console.info(`[call-audio-retention] settled=${result.settled} invalid=${result.invalid} deleted=${result.deleted} orphans=${result.orphans}`)
  return result
}
