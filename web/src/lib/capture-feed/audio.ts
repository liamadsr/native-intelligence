/**
 * A fed capture's sound files (migration 650): the producer's upload, the
 * app's checks, and what the capture's page may see of them. Server only.
 *
 *   - The producer asks for an upload (./contract.ts, the audio requests):
 *     650's capture_feed_audio_grant decides (the session's producer, the
 *     source, the 30 days) and names the path; the app then signs a one-time
 *     upload to exactly that path with the service role. The producer never
 *     holds a storage key, and the link is good for that one object only.
 *   - The producer says it is done: 650's capture_feed_audio_stored checks
 *     Storage's own row for the object before the file counts as kept.
 *   - The capture's page: who may read the capture (its RLS, read as the
 *     person) sees its files, and gets a link signed as them, so Storage's
 *     read policy (650's "team call audio read") is checked once more.
 *
 * Files live in the recordings bucket (566), under the call's folder. Kept
 * 30 days from the session's start: from then on nothing plays or links them
 * (here and in 650's read policy), and the daily sweep deletes them
 * (./audio-retention.ts); the capture and its transcript stay. Logs carry
 * ids and counts, never a path's link.
 *
 * Code that reaches a server before migration 650 does nothing worse than
 * show no audio: a missing table or function reads as "no files".
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { CaptureFeedAudioGrant, CaptureFeedProducer } from './contract'

/** Where every fed audio file is kept (566's private bucket). */
export const CAPTURE_AUDIO_BUCKET = 'team-call-recordings'
/** A link to play or download a file lasts this long (a fresh one for each). */
export const CAPTURE_AUDIO_LINK_TTL_SECONDS = 60 * 60
/** A take still not in after this long is not shown as being saved any more. */
export const CAPTURE_AUDIO_SAVING_SHOWN_MS = 24 * 60 * 60_000

export type AudioGrantOutcome = 'granted' | 'stored' | 'not_wanted' | 'too_large' | 'too_many' | 'taken' | 'unknown' | 'invalid'

/**
 * A database without migration 650 yet: Postgres's or PostgREST's word that 650's own table or
 * one of its functions is not there, by its code AND by that object's name. Anything else (a
 * column, an operator, a type inside a function, another table) is a real failure, said loudly
 * every time.
 */
export function missingFromDatabase(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false
  const message = error.message ?? ''
  const fn = /\bpublic\.(capture_audio_(settle|due|orphans|capture_of)|capture_feed_audio_(grant|stored))\b/
  switch (error.code) {
    case '42883': // function public.capture_audio_settle(integer) does not exist
      return /^function /.test(message) && fn.test(message)
    case 'PGRST202': // Could not find the function public.capture_audio_settle(max_rows) in the schema cache
      return /^Could not find the function /.test(message) && fn.test(message)
    case '42P01': // relation "public.capture_audio" does not exist
      return /^relation "(public\.)?capture_audio" does not exist/.test(message)
    case 'PGRST205': // Could not find the table 'public.capture_audio' in the schema cache
      return /^Could not find the table '(public\.)?capture_audio'/.test(message)
    default:
      return false
  }
}

export interface AudioGrant {
  outcome: AudioGrantOutcome
  /** 'granted': where to PUT the file, once. */
  upload: { url: string; method: 'PUT'; headers: Record<string, string> } | null
  expiresAt: string | null
}

/** A producer asks to upload one take (650's capture_feed_audio_grant, then a signed upload to its path). Throws on a failed write. */
export async function grantAudio(svc: SupabaseClient, sessionId: string, producer: CaptureFeedProducer, input: Omit<CaptureFeedAudioGrant, 'producer'>): Promise<AudioGrant> {
  const { data, error } = await svc.rpc('capture_feed_audio_grant', {
    p_session: sessionId,
    p_producer_id: producer.id,
    p_take: input.take,
    p_offset_ms: input.offsetMs,
    p_duration_ms: input.durationMs,
    p_bytes: input.bytes,
    p_content_type: input.contentType,
  })
  if (error) throw new Error(`capture feed: audio grant failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; path?: string | null; expires_at?: string | null } | undefined
  const outcome = (row?.outcome as AudioGrantOutcome) ?? 'unknown'
  const expiresAt = row?.expires_at ? new Date(row.expires_at).toISOString() : null
  if (outcome !== 'granted' || !row?.path) return { outcome: outcome === 'granted' ? 'unknown' : outcome, upload: null, expiresAt }
  // No overwrite: a file once uploaded is never replaced (an upload cut off leaves no object, so a
  // retry still lands; one whose answer was lost is refused, and its "stored" settles it).
  const { data: signed, error: signError } = await svc.storage.from(CAPTURE_AUDIO_BUCKET).createSignedUploadUrl(row.path, { upsert: false })
  if (signError || !signed?.signedUrl) throw new Error(`capture feed: audio upload not signed: ${signError?.message ?? 'no link'}`)
  return {
    outcome,
    upload: { url: signed.signedUrl, method: 'PUT', headers: { 'content-type': input.contentType, 'x-upsert': 'false', 'cache-control': 'max-age=3600' } },
    expiresAt,
  }
}

export type AudioStoredOutcome = 'stored' | 'missing' | 'invalid' | 'not_wanted' | 'taken' | 'unknown'

/** The producer's upload is done (650's capture_feed_audio_stored: the file counts once Storage has it). Throws on a failed write. */
export async function audioStored(svc: SupabaseClient, sessionId: string, producer: CaptureFeedProducer, take: string): Promise<{ outcome: AudioStoredOutcome; expiresAt: string | null }> {
  const { data, error } = await svc.rpc('capture_feed_audio_stored', { p_session: sessionId, p_producer_id: producer.id, p_take: take })
  if (error) throw new Error(`capture feed: audio stored failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; expires_at?: string | null } | undefined
  return { outcome: (row?.outcome as AudioStoredOutcome) ?? 'unknown', expiresAt: row?.expires_at ? new Date(row.expires_at).toISOString() : null }
}

/** One of a capture's sound files, as its page sees it. */
export interface CaptureAudioView {
  id: string
  part: number
  /** 'saving': the call ended moments ago and its file is on its way; 'ready': it plays; 'deleted': its 30 days are over. */
  state: 'saving' | 'ready' | 'deleted'
  durationMs: number | null
  /** When it will be deleted ('ready'), or was due ('deleted'). */
  expiresAt: string
  /** When it was deleted ('deleted'). */
  deletedAt: string | null
}

interface AudioRow {
  id: string
  part: number
  state: 'pending' | 'stored' | 'deleted'
  duration_ms: number | null
  expires_at: string
  stored_at: string | null
  deleted_at: string | null
  created_at: string
}

/**
 * What the page shows of one row: a stored file plays until its day, a deleted one says when it
 * went (only if it was ever kept: a take that never arrived is not "deleted"), and one past its day
 * reads as deleted on that day, before the sweep removes it (the day the person was shown is the
 * day it stops playing). A pending one young enough says it is being saved. Anything else is
 * nothing.
 */
export function audioViewOf(row: AudioRow, now: number = Date.now()): CaptureAudioView | null {
  const base = { id: row.id, part: row.part, durationMs: row.duration_ms === null ? null : Number(row.duration_ms), expiresAt: new Date(row.expires_at).toISOString() }
  if (row.state === 'stored') return now < Date.parse(row.expires_at) ? { ...base, state: 'ready', deletedAt: null } : { ...base, state: 'deleted', deletedAt: base.expiresAt }
  // The day it went is the day it stopped playing (its 30th, or earlier if its call or capture
  // went first), never the later morning the sweep removed the object: what was said stays said.
  if (row.state === 'deleted') return row.stored_at && row.deleted_at ? { ...base, state: 'deleted', deletedAt: new Date(Math.min(Date.parse(row.deleted_at), Date.parse(row.expires_at))).toISOString() } : null
  if (now - Date.parse(row.created_at) < CAPTURE_AUDIO_SAVING_SHOWN_MS && now < Date.parse(row.expires_at)) return { ...base, state: 'saving', deletedAt: null }
  return null
}

/**
 * A capture's sound files, for someone who may read the capture: read as them first (RLS decides;
 * for a call's notes, the owner and the conversation's readers), then its files with the service
 * role (no client reads 650's table). Null when they may not read the capture.
 */
export async function captureAudioFor(supabase: SupabaseClient, svc: SupabaseClient, captureId: string, now: number = Date.now()): Promise<CaptureAudioView[] | null> {
  const { data: capture, error: captureError } = await supabase.from('captures').select('id').eq('id', captureId).maybeSingle<{ id: string }>()
  if (captureError) throw new Error(`capture audio: capture read failed: ${captureError.message}`)
  if (!capture) return null
  // A capture has a file per take: one in nearly every call, a handful at most (50 by 650's bound).
  const { data, error } = await svc
    .from('capture_audio')
    .select('id, part, state, duration_ms, expires_at, stored_at, deleted_at, created_at')
    .eq('capture_id', captureId)
    .order('part', { ascending: true })
    .limit(50)
  if (error && missingFromDatabase(error)) return []
  if (error) throw new Error(`capture audio: files read failed: ${error.message}`)
  return ((data ?? []) as AudioRow[]).map((r) => audioViewOf(r, now)).filter((v): v is CaptureAudioView => v !== null)
}

/** The name a downloaded file is saved under: "Call audio 2026-11-13.m4a" (with its part when there are several). */
export function audioDownloadName(startedAt: string | null, part: number, several: boolean, contentType: string): string {
  const day = startedAt && Number.isFinite(Date.parse(startedAt)) ? new Date(startedAt).toISOString().slice(0, 10) : null
  const ext = contentType === 'audio/ogg' ? 'ogg' : 'm4a'
  return `Call audio${day ? ` ${day}` : ''}${several ? ` part ${part + 1}` : ''}.${ext}`
}

/**
 * A link to one stored file of a capture, to play or to download, signed as the person (Storage's
 * read policy checks them again), lasting CAPTURE_AUDIO_LINK_TTL_SECONDS, and never past the
 * file's day (Storage checks a link when it signs it, not when it is used, so the link itself must
 * end then). Null when they may not read the capture, or the file is not kept (any more).
 */
export async function captureAudioLink(
  supabase: SupabaseClient,
  svc: SupabaseClient,
  captureId: string,
  fileId: string,
  as: 'play' | 'download',
  now: number = Date.now(),
): Promise<{ url: string; expiresIn: number } | null> {
  const { data: capture, error: captureError } = await supabase.from('captures').select('id').eq('id', captureId).maybeSingle<{ id: string }>()
  if (captureError) throw new Error(`capture audio: capture read failed: ${captureError.message}`)
  if (!capture) return null
  const { data: rows, error } = await svc
    .from('capture_audio')
    .select('id, part, path, content_type, state, created_at, expires_at')
    .eq('capture_id', captureId)
    .neq('state', 'deleted')
    .limit(50)
  if (error && missingFromDatabase(error)) return null
  if (error) throw new Error(`capture audio: file read failed: ${error.message}`)
  const all = (rows ?? []) as Array<{ id: string; part: number; path: string; content_type: string; state: string; created_at: string; expires_at: string }>
  // Past its day it is not linked any more, whenever the sweep gets to it.
  const row = all.find((r) => r.id === fileId && r.state === 'stored' && Date.parse(r.expires_at) > now)
  if (!row) return null
  const options = as === 'download' ? { download: audioDownloadName(row.created_at, row.part, all.length > 1, row.content_type) } : undefined
  const ttl = Math.min(CAPTURE_AUDIO_LINK_TTL_SECONDS, Math.floor((Date.parse(row.expires_at) - now) / 1000))
  if (ttl < 1) return null
  const { data: signed, error: signError } = await supabase.storage.from(CAPTURE_AUDIO_BUCKET).createSignedUrl(row.path, ttl, options)
  if (signError || !signed?.signedUrl) return null
  return { url: signed.signedUrl, expiresIn: ttl }
}
