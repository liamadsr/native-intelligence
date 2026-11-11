/**
 * Team call notes and recordings, the reads and writes (migrations 566-567)
 * and the work around them. Two kinds of caller, as ./store.ts:
 *
 *   as the person (their client, under RLS; 567's team_call_set_notes reads
 *   auth.uid()): turn the notes on or off;
 *
 *   as the service role: the egresses LiveKit runs (started on a published
 *   microphone while notes are on, stopped when they go off, followed by
 *   LiveKit's egress webhooks), the recording's claim under the server's
 *   cap, each file's transcript (Deepgram, prerecorded), and the notes
 *   themselves once the call ended: one capture, as a recorded meeting's.
 *
 * Every LiveKit call goes through a TeamCallEgressPort (./egress.ts), every
 * Deepgram call through {@link TranscribeDeps}, so tests hand fakes.
 * Privacy: logs carry ids only, never words or names.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { TeamChatError, teamChatErrorOf } from '@/lib/team-chat/store'
import { dmOtherMember } from '@/lib/team-chat/types'
import type { TeamCallEgressPort } from './egress'
import {
  TEAM_CALL_NOTES_MAX_SECONDS,
  TEAM_CALL_RECORDINGS_BUCKET,
  egressFinished,
  mergeNotes,
  notesPreamble,
  notesTitle,
  speakerLabels,
  utterancesOfDeepgram,
  type NotesFile,
  type NotesGap,
  type NotesUtterance,
  type TeamCallEgressStatus,
  type TeamCallTranscriptStatus,
} from './notes'

// ── As the person ───────────────────────────────────────────────────────────

export interface NotesSwitch {
  notes: boolean
  round: number
  changed: boolean
}

/** Turn a call's notes on or off (567's team_call_set_notes: someone in the call, or its starter). */
export async function setNotes(supabase: SupabaseClient, callId: string, on: boolean): Promise<NotesSwitch> {
  const { data, error } = await supabase.rpc('team_call_set_notes', { target_call: callId, turn_on: on })
  if (error) throw teamChatErrorOf(error, 'notes')
  const row = (Array.isArray(data) ? data[0] : data) as { notes?: boolean; notes_round?: number; changed?: boolean } | undefined
  if (!row || typeof row.notes !== 'boolean') throw new TeamChatError('failed', 'notes returned nothing')
  return { notes: row.notes, round: row.notes_round ?? 0, changed: row.changed === true }
}

// ── The egresses, as the service role ───────────────────────────────────────

/** The call a room is, with what the egresses need of it; null for a room that is none of ours or a call that ended. */
export async function liveCallForEgress(svc: SupabaseClient, room: string): Promise<{ id: string; room: string; notes: boolean } | null> {
  const { data, error } = await svc.from('team_call').select('id, room, notes').eq('room', room).eq('status', 'live').maybeSingle<{ id: string; room: string; notes: boolean }>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  return data ?? null
}

export interface EgressEventInput {
  /** The row, read from the file's name (567 names it), or null: found by egressId. */
  rowId: string | null
  egressId: string | null
  status: TeamCallEgressStatus
  /** LiveKit's updatedAt, in nanoseconds (its order); 0 for the app's own word. */
  atNs: bigint | number | string
  fileStartedAt?: string | null
  fileEndedAt?: string | null
  durationMs?: number | null
  sizeBytes?: number | null
  error?: string | null
}

export interface EgressEventResult {
  outcome: 'applied' | 'stale' | 'unknown'
  rowId: string | null
  callId: string | null
  kind: 'notes' | 'recording' | null
  status: TeamCallEgressStatus | null
}

/** An egress's state, applied in LiveKit's order (567's team_call_egress_event). Throws on a failed write. */
export async function applyEgressEvent(svc: SupabaseClient, input: EgressEventInput): Promise<EgressEventResult> {
  const { data, error } = await svc.rpc('team_call_egress_event', {
    row_ref: input.rowId,
    egress_ref: input.egressId,
    new_status: input.status,
    // Nanoseconds pass 2^53: sent as words, Postgres reads the bigint.
    at_ns: String(input.atNs ?? 0),
    file_started: input.fileStartedAt ?? null,
    file_ended: input.fileEndedAt ?? null,
    file_duration_ms: input.durationMs ?? null,
    file_size: input.sizeBytes ?? null,
    failure: input.error ? input.error.slice(0, 500) : null,
  })
  if (error) throw new Error(`team calls: egress event failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string; egress_row?: string | null; call_id?: string | null; kind?: string | null; status?: string | null } | undefined
  return {
    outcome: (row?.outcome as EgressEventResult['outcome']) ?? 'unknown',
    rowId: row?.egress_row ?? null,
    callId: row?.call_id ?? null,
    kind: (row?.kind as EgressEventResult['kind']) ?? null,
    status: (row?.status as TeamCallEgressStatus) ?? null,
  }
}

const shortError = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 300)

/**
 * Notes for one microphone track, once per track and round (567's claim):
 * the row first (its name is the file's), then LiveKit's egress, then its
 * id onto the row. A refused start (the egress service full or down) is
 * that row failed: the notes will say whose words are missing.
 */
export async function startNotesForTrack(
  svc: SupabaseClient,
  port: TeamCallEgressPort,
  call: { id: string; room: string },
  memberId: string,
  trackSid: string,
): Promise<'started' | 'claimed_already' | 'failed'> {
  const { data, error } = await svc.rpc('team_call_egress_claim', { target_call: call.id, member_ref: memberId, track_ref: trackSid })
  if (error) throw new Error(`team calls: notes claim failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { egress_row?: string; file_path?: string } | undefined
  if (!row?.egress_row || !row.file_path) return 'claimed_already'
  try {
    const { egressId } = await port.startTrack(call.room, trackSid, row.file_path)
    await applyEgressEvent(svc, { rowId: row.egress_row, egressId, status: 'starting', atNs: 0 })
    console.info(`[team-call-notes] call=${call.id} egress_row=${row.egress_row} outcome=started`)
    return 'started'
  } catch (err) {
    console.warn(`[team-call-notes] call=${call.id} egress_row=${row.egress_row} not started:`, shortError(err))
    await applyEgressEvent(svc, { rowId: row.egress_row, egressId: null, status: 'failed', atNs: 0, error: `not started: ${shortError(err)}` })
    return 'failed'
  }
}

/** Notes just went on: every microphone in the room now (a later one starts from its track_published webhook). */
export async function startNotesForRoom(svc: SupabaseClient, port: TeamCallEgressPort, call: { id: string; room: string }): Promise<number> {
  let tracks: Array<{ identity: string; trackSid: string }>
  try {
    tracks = await port.microphones(call.room)
  } catch (err) {
    // The room's tracks can't be read: their webhooks start nothing now (published already), so say so.
    console.warn(`[team-call-notes] call=${call.id} microphones not read:`, shortError(err))
    return 0
  }
  let started = 0
  for (const t of tracks) {
    if (!/^[0-9a-f-]{36}$/i.test(t.identity)) continue
    if ((await startNotesForTrack(svc, port, call, t.identity.toLowerCase(), t.trackSid)) === 'started') started++
  }
  return started
}

/** Stop a call's egresses of one kind that are still running (notes went off; a recording stopped; the bound). Never throws for one. */
export async function stopEgresses(svc: SupabaseClient, port: TeamCallEgressPort, callId: string, kind: 'notes' | 'recording'): Promise<number> {
  const { data, error } = await svc
    .from('team_call_egress')
    .select('id, egress_id')
    .eq('call_id', callId)
    .eq('kind', kind)
    .in('status', ['starting', 'active'])
  if (error) throw new Error(`team calls: egress read failed: ${error.message}`)
  let stopped = 0
  for (const row of (data ?? []) as Array<{ id: string; egress_id: string | null }>) {
    if (!row.egress_id) continue
    try {
      await port.stop(row.egress_id)
      stopped++
    } catch (err) {
      console.warn(`[team-call-notes] egress_row=${row.id} not stopped:`, shortError(err))
    }
  }
  return stopped
}

/** Notes off, by the server (the 3-hour bound). True when they were on. */
export async function stopNotesAtBound(svc: SupabaseClient, callId: string): Promise<boolean> {
  const { data, error } = await svc.rpc('team_call_notes_stop', { target_call: callId })
  if (error) throw new Error(`team calls: notes stop failed: ${error.message}`)
  return data === true
}

export type RecordingClaim = 'claimed' | 'already' | 'saved' | 'busy' | 'ended' | 'not_in_call' | 'unknown'

/**
 * Record a call: the claim under the server's cap (567's
 * team_call_recording_begin), then LiveKit's room composite. A refused
 * start is the recording failed (another may be tried).
 */
export async function startRecording(
  svc: SupabaseClient,
  port: TeamCallEgressPort,
  call: { id: string; room: string },
  memberId: string,
  maxLive: number,
): Promise<RecordingClaim | 'failed'> {
  const { data, error } = await svc.rpc('team_call_recording_begin', { target_call: call.id, member_ref: memberId, max_live: maxLive })
  if (error) throw new Error(`team calls: recording claim failed: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: RecordingClaim; egress_row?: string | null; file_path?: string | null } | undefined
  const outcome = row?.outcome ?? 'unknown'
  if (outcome !== 'claimed' || !row?.egress_row || !row.file_path) return outcome
  try {
    const { egressId } = await port.startRecording(call.room, row.file_path)
    await applyEgressEvent(svc, { rowId: row.egress_row, egressId, status: 'starting', atNs: 0 })
    console.info(`[team-call-recording] call=${call.id} egress_row=${row.egress_row} outcome=started`)
    return 'claimed'
  } catch (err) {
    console.warn(`[team-call-recording] call=${call.id} egress_row=${row.egress_row} not started:`, shortError(err))
    await applyEgressEvent(svc, { rowId: row.egress_row, egressId: null, status: 'failed', atNs: 0, error: `not started: ${shortError(err)}` })
    return 'failed'
  }
}

/** The recording's file, for a person who may read the call (their client: 566's storage policy is the check), as a link that lasts `ttl` seconds. */
export async function recordingLink(supabase: SupabaseClient, svc: SupabaseClient, callId: string, ttl: number): Promise<string | null> {
  // The person may read the call (RLS) or this is nothing.
  const { data: call, error: callError } = await supabase.from('team_call').select('id, recording').eq('id', callId).maybeSingle<{ id: string; recording: string }>()
  if (callError) throw teamChatErrorOf(callError, 'recording read')
  if (!call || call.recording !== 'saved') return null
  // team_call_egress is the service role's: the file's name comes from the server's read, the link from the person's.
  const { data: row, error } = await svc
    .from('team_call_egress')
    .select('file_path')
    .eq('call_id', callId)
    .eq('kind', 'recording')
    .in('status', ['complete', 'limit'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle<{ file_path: string }>()
  if (error) throw new Error(`team calls: recording file read failed: ${error.message}`)
  if (!row) return null
  const { data: signed, error: signError } = await supabase.storage.from(TEAM_CALL_RECORDINGS_BUCKET).createSignedUrl(row.file_path, ttl)
  if (signError || !signed?.signedUrl) return null
  return signed.signedUrl
}

// ── A file's words ──────────────────────────────────────────────────────────

export const TEAM_CALL_NOTES_FILE_EVENT = 'team-calls/notes.file' as const
export const TEAM_CALL_NOTES_FINISH_EVENT = 'team-calls/notes.finish' as const

/** The event that transcribes one notes file (its id dedupes: the webhook and the finish may both ask). */
export function notesFileEvent(rowId: string) {
  return { name: TEAM_CALL_NOTES_FILE_EVENT, id: `team-call-notes-file-${rowId}`, data: { rowId } }
}

/** The event that writes a call's notes once its files are in. */
export function notesFinishEvent(callId: string) {
  return { name: TEAM_CALL_NOTES_FINISH_EVENT, id: `team-call-notes-finish-${callId}`, data: { callId } }
}

type SendEvents = (events: Array<{ name: string; id: string; data: Record<string, unknown> }>) => Promise<unknown>

async function send(events: Array<{ name: string; id: string; data: Record<string, unknown> }>, sender?: SendEvents): Promise<void> {
  if (events.length === 0) return
  if (sender) {
    await sender(events)
    return
  }
  const { inngest } = await import('@/lib/inngest/client')
  await inngest.send(events)
}

/** Ask for these files' words. Never throws (the finish asks again; logged). */
export async function requestNotesFiles(rowIds: readonly string[], sender?: SendEvents): Promise<void> {
  try {
    await send(rowIds.map(notesFileEvent), sender)
  } catch (err) {
    console.warn(`[team-call-notes] file events not sent (${rowIds.length}):`, shortError(err))
  }
}

/** A call that just ended: when its notes were ever on, ask for them to be written. Never throws (the sweeper asks again). */
export async function requestNotesFinish(svc: SupabaseClient, callId: string, sender?: SendEvents): Promise<boolean> {
  try {
    const { data, error } = await svc.from('team_call').select('notes_state').eq('id', callId).maybeSingle<{ notes_state: string }>()
    if (error || data?.notes_state !== 'transcribing') return false
    await send([notesFinishEvent(callId)], sender)
    return true
  } catch (err) {
    console.warn(`[team-call-notes] call=${callId} finish not requested:`, shortError(err))
    return false
  }
}

export interface TranscribeDeps {
  /** The file's bytes (default: the bucket, as the service role). */
  download?: (path: string) => Promise<ArrayBuffer>
  /** Deepgram's prerecorded answer for these bytes (default: its API with DEEPGRAM_API_KEY). Throws a DeepgramError. */
  transcribe?: (audio: ArrayBuffer) => Promise<unknown>
  /** Log the audio's seconds against the person the call is billed to. */
  logUsage?: (userId: string, seconds: number) => Promise<unknown>
}

/** Deepgram refused or failed. `retry`: try again later (a 5xx, a timeout); else the file can't be read (a 4xx). */
export class DeepgramError extends Error {
  constructor(
    message: string,
    readonly retry: boolean,
  ) {
    super(message)
    this.name = 'DeepgramError'
  }
}

/** The prerecorded request: Nova-3, punctuated, in utterances (each with its start and end in the file). */
export const DEEPGRAM_PRERECORDED_URL =
  'https://api.deepgram.com/v1/listen?model=nova-3&language=en&smart_format=true&punctuate=true&utterances=true&utt_split=1.2'

export async function deepgramPrerecorded(audio: ArrayBuffer, key = process.env.DEEPGRAM_API_KEY): Promise<unknown> {
  if (!key) throw new DeepgramError('no Deepgram key', false)
  let res: Response
  try {
    res = await fetch(DEEPGRAM_PRERECORDED_URL, {
      method: 'POST',
      headers: { Authorization: `Token ${key}`, 'Content-Type': 'audio/ogg' },
      body: audio,
      signal: AbortSignal.timeout(240_000),
    })
  } catch (err) {
    throw new DeepgramError(`Deepgram unreachable: ${shortError(err)}`, true)
  }
  if (!res.ok) {
    const body = (await res.text().catch(() => '')).slice(0, 200)
    throw new DeepgramError(`Deepgram ${res.status}: ${body}`, res.status >= 500 || res.status === 429 || res.status === 408)
  }
  return res.json()
}

async function downloadFile(path: string): Promise<ArrayBuffer> {
  const { getServiceClient } = await import('@/lib/admin')
  const { data, error } = await getServiceClient().storage.from(TEAM_CALL_RECORDINGS_BUCKET).download(path)
  if (error || !data) throw new DeepgramError(`file not read: ${error?.message ?? 'empty'}`, true)
  return data.arrayBuffer()
}

async function defaultLogUsage(userId: string, seconds: number): Promise<unknown> {
  const { logUsage } = await import('@/lib/ai/auth')
  return logUsage(userId, {
    provider: 'deepgram',
    model: 'nova-3',
    feature: 'team_call_notes',
    inputTokens: 0,
    outputTokens: 0,
    durationMs: seconds * 1000,
    audioSeconds: seconds,
  })
}

interface EgressRow {
  id: string
  call_id: string
  kind: 'notes' | 'recording'
  member_id: string | null
  file_path: string
  status: TeamCallEgressStatus
  started_at: string | null
  created_at: string
  duration_ms: number | null
  transcript_status: TeamCallTranscriptStatus
  transcript: NotesUtterance[] | null
  audio_deleted_at: string | null
  error: string | null
}

const EGRESS_COLUMNS = 'id, call_id, kind, member_id, file_path, status, started_at, created_at, duration_ms, transcript_status, transcript, audio_deleted_at, error'

export type TranscribeOutcome = 'done' | 'empty' | 'failed' | 'skipped'

/**
 * One notes file's words: downloaded, transcribed, stored on its row
 * (done, or empty when nothing was said). A Deepgram failure worth another
 * try throws (Inngest retries the step); one that never will is the file
 * failed, its audio kept. A file already done, or not finished, is skipped.
 */
export async function transcribeNotesFile(svc: SupabaseClient, rowId: string, deps: TranscribeDeps = {}): Promise<TranscribeOutcome> {
  const { data, error } = await svc.from('team_call_egress').select(EGRESS_COLUMNS).eq('id', rowId).maybeSingle<EgressRow>()
  if (error) throw new Error(`team calls: notes file read failed: ${error.message}`)
  if (!data || data.kind !== 'notes' || data.transcript_status !== 'pending' || !(data.status === 'complete' || data.status === 'limit')) return 'skipped'
  let json: unknown
  try {
    const audio = await (deps.download ?? downloadFile)(data.file_path)
    json = await (deps.transcribe ?? deepgramPrerecorded)(audio)
  } catch (err) {
    if (err instanceof DeepgramError && !err.retry) {
      await markTranscript(svc, rowId, 'failed', null)
      console.warn(`[team-call-notes] egress_row=${rowId} outcome=failed:`, err.message.slice(0, 120))
      return 'failed'
    }
    throw err
  }
  const utterances = utterancesOfDeepgram(json)
  const outcome = utterances.length > 0 ? 'done' : 'empty'
  await markTranscript(svc, rowId, outcome, utterances)
  const seconds = Math.round(((json as { metadata?: { duration?: number } })?.metadata?.duration ?? (data.duration_ms ?? 0) / 1000) || 0)
  if (seconds > 0) {
    try {
      const userId = await billedUser(svc, data.call_id)
      if (userId) await (deps.logUsage ?? defaultLogUsage)(userId, seconds)
    } catch (err) {
      console.warn(`[team-call-notes] egress_row=${rowId} usage not logged:`, shortError(err))
    }
  }
  console.info(`[team-call-notes] egress_row=${rowId} outcome=${outcome} utterances=${utterances.length}`)
  return outcome
}

/** A file's words stored, once: a row already settled is left as it is. */
export async function markTranscript(svc: SupabaseClient, rowId: string, status: Exclude<TeamCallTranscriptStatus, 'pending' | 'none'>, utterances: NotesUtterance[] | null): Promise<void> {
  const { error } = await svc
    .from('team_call_egress')
    .update({ transcript_status: status, transcript: utterances, transcribed_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .eq('id', rowId)
    .eq('transcript_status', 'pending')
  if (error) throw new Error(`team calls: notes file write failed: ${error.message}`)
}

/** The account a call's transcription is logged against: its starter's. */
async function billedUser(svc: SupabaseClient, callId: string): Promise<string | null> {
  const { data } = await svc.from('team_call').select('started_by, notes_by').eq('id', callId).maybeSingle<{ started_by: string | null; notes_by: string | null }>()
  const memberId = data?.started_by ?? data?.notes_by
  if (!memberId) return null
  const { data: m } = await svc.from('member').select('user_id').eq('id', memberId).maybeSingle<{ user_id: string | null }>()
  return m?.user_id ?? null
}

// ── The notes ───────────────────────────────────────────────────────────────

interface NotesCall {
  id: string
  workspace_id: string
  channel_id: string
  message_id: string | null
  started_by: string | null
  notes_by: string | null
  status: 'live' | 'ended'
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  notes_seconds: number
  notes_state: string
  notes_changed_at: string | null
  capture_id: string | null
  recording: string
}

const NOTES_CALL_COLUMNS =
  'id, workspace_id, channel_id, message_id, started_by, notes_by, status, started_at, ended_at, duration_seconds, notes_seconds, notes_state, notes_changed_at, capture_id, recording'

export interface NotesProgress {
  call: NotesCall | null
  rows: EgressRow[]
  /** Every file finished and every finished file's words in (or never coming). */
  settled: boolean
  /** Finished files whose words are still to come. */
  pending: string[]
  /** Egresses still running. */
  running: EgressRow[]
}

/** Where a call's notes are. */
export async function notesProgress(svc: SupabaseClient, callId: string): Promise<NotesProgress> {
  const { data: call, error } = await svc.from('team_call').select(NOTES_CALL_COLUMNS).eq('id', callId).maybeSingle<NotesCall>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  const { data: rows, error: rowsError } = await svc.from('team_call_egress').select(EGRESS_COLUMNS).eq('call_id', callId).eq('kind', 'notes').order('created_at', { ascending: true })
  if (rowsError) throw new Error(`team calls: notes files read failed: ${rowsError.message}`)
  const list = (rows ?? []) as EgressRow[]
  const running = list.filter((r) => !egressFinished(r.status))
  const pending = list.filter((r) => egressFinished(r.status) && r.transcript_status === 'pending').map((r) => r.id)
  return { call: call ?? null, rows: list, settled: running.length === 0 && pending.length === 0, pending, running }
}

/** Where a call's notes are, small enough to pass between steps (no words). */
export interface NotesStatus {
  callStatus: 'live' | 'ended' | null
  notesState: string | null
  settled: boolean
  pending: string[]
  running: string[]
}

export async function notesStatus(svc: SupabaseClient, callId: string): Promise<NotesStatus> {
  const p = await notesProgress(svc, callId)
  return { callStatus: p.call?.status ?? null, notesState: p.call?.notes_state ?? null, settled: p.settled, pending: p.pending, running: p.running.map((r) => r.id) }
}

/** Egresses that never finished, or files whose words never came, after the finish gave them their time: failed, their audio kept. */
export async function giveUpOnNotes(svc: SupabaseClient, status: Pick<NotesStatus, 'running' | 'pending'>): Promise<void> {
  for (const rowId of status.running) {
    await applyEgressEvent(svc, { rowId, egressId: null, status: 'failed', atNs: 0, error: 'lost: the egress never finished' })
  }
  for (const rowId of status.pending) await markTranscript(svc, rowId, 'failed', null)
}

export type NotesWritten = { outcome: 'ready'; captureId: string; ownerUserId: string; workspaceId: string } | { outcome: 'silent' | 'failed' | 'skipped' }

interface PersonRow {
  member_id: string
  first_joined_at: string
  left_at: string | null
}

/**
 * Write a settled call's notes: its files' words merged by time under each
 * person's name, a preamble naming whose words are missing and why, then
 * one capture (567's team_call_attach_notes: private to its owner, the
 * call's starter, shared with the conversation). Nothing said at all: no
 * capture ('silent'); every file lost: 'failed'.
 */
export async function writeNotes(svc: SupabaseClient, callId: string): Promise<NotesWritten> {
  const progress = await notesProgress(svc, callId)
  const call = progress.call
  if (!call || call.status !== 'ended') return { outcome: 'skipped' }
  if (call.capture_id) {
    const owner = await ownerOf(svc, call, [])
    return owner ? { outcome: 'ready', captureId: call.capture_id, ownerUserId: owner.userId, workspaceId: call.workspace_id } : { outcome: 'skipped' }
  }
  if (call.notes_state !== 'transcribing') return { outcome: 'skipped' }

  const { data: peopleRows, error: peopleError } = await svc.from('team_call_participant').select('member_id, first_joined_at, left_at').eq('call_id', callId).order('first_joined_at', { ascending: true })
  if (peopleError) throw new Error(`team calls: call people read failed: ${peopleError.message}`)
  const people = (peopleRows ?? []) as PersonRow[]
  const memberIds = [...new Set([...people.map((p) => p.member_id), ...progress.rows.map((r) => r.member_id).filter((id): id is string => !!id)])]
  const names = await memberNames(svc, memberIds)
  const labels = speakerLabels(memberIds.map((id) => ({ memberId: id, name: names.get(id) })))

  const files: NotesFile[] = progress.rows
    .filter((r) => r.transcript_status === 'done' && r.member_id && Array.isArray(r.transcript))
    .map((r) => ({ memberId: r.member_id!, startedAt: r.started_at ?? r.created_at, utterances: r.transcript! }))
  const merged = mergeNotes(call.started_at, files, labels)

  const missing = new Map<string, NotesGap>()
  for (const r of progress.rows) {
    if (!r.member_id) continue
    if (r.status === 'failed') missing.set(r.member_id, 'not_recorded')
    else if (r.transcript_status === 'failed' && !missing.has(r.member_id)) missing.set(r.member_id, 'not_transcribed')
  }

  if (merged.lines.length === 0) {
    const anyLost = progress.rows.some((r) => r.status === 'failed' || r.transcript_status === 'failed')
    const state = anyLost ? 'failed' : 'silent'
    await settleNotes(svc, callId, state)
    console.info(`[team-call-notes] call=${callId} outcome=${state} files=${progress.rows.length}`)
    return { outcome: state }
  }

  const owner = await ownerOf(svc, call, people.map((p) => p.member_id))
  if (!owner) {
    await settleNotes(svc, callId, 'failed')
    return { outcome: 'failed' }
  }
  const title = await titleOf(svc, call, owner.memberId, names)
  const preamble = notesPreamble({
    missing: [...missing.entries()].map(([id, why]) => ({ name: labels.get(id) ?? 'Teammate', why })),
    notesSeconds: call.notes_seconds,
    callSeconds: call.duration_seconds ?? 0,
    stoppedAtBound: call.notes_seconds >= TEAM_CALL_NOTES_MAX_SECONDS,
  })
  const spoke = new Set(merged.lines.map((l) => l.memberId))
  const { data: captureId, error } = await svc.rpc('team_call_attach_notes', {
    target_call: callId,
    owner_user: owner.userId,
    capture_title: title,
    transcript_text: merged.text,
    notes_text: preamble,
    people: memberIds.map((id) => {
      const p = people.find((x) => x.member_id === id)
      return { member_id: id, name: names.get(id) ?? null, label: spoke.has(id) ? labels.get(id) : null, joined_at: p?.first_joined_at ?? null, left_at: p?.left_at ?? null }
    }),
    meta: { capture_mode: 'team_call', missing: [...missing.entries()].map(([member_id, why]) => ({ member_id, why })) },
  })
  if (error || typeof captureId !== 'string') throw new Error(`team calls: notes not written: ${error?.message ?? 'no capture'}`)
  console.info(`[team-call-notes] call=${callId} capture=${captureId} outcome=ready lines=${merged.lines.length} missing=${missing.size}`)
  return { outcome: 'ready', captureId, ownerUserId: owner.userId, workspaceId: call.workspace_id }
}

/** Notes that end with no capture. */
export async function settleNotes(svc: SupabaseClient, callId: string, state: 'silent' | 'failed'): Promise<boolean> {
  const { data, error } = await svc.rpc('team_call_notes_settle', { target_call: callId, final_state: state })
  if (error) throw new Error(`team calls: notes settle failed: ${error.message}`)
  return data === true
}

async function memberNames(svc: SupabaseClient, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await svc.from('member').select('id, display_name').in('id', [...ids])
  if (error) throw new Error(`team calls: names read failed: ${error.message}`)
  return new Map(((data ?? []) as Array<{ id: string; display_name: string | null }>).map((m) => [m.id, m.display_name?.trim() || 'Teammate']))
}

/** The notes' owner: the call's starter, else who turned notes on, else the first person in it; their account in this workspace. */
async function ownerOf(svc: SupabaseClient, call: NotesCall, others: readonly string[]): Promise<{ memberId: string; userId: string } | null> {
  for (const id of [call.started_by, call.notes_by, ...others]) {
    if (!id) continue
    const { data } = await svc.from('member').select('id, user_id').eq('id', id).eq('workspace_id', call.workspace_id).maybeSingle<{ id: string; user_id: string | null }>()
    if (data?.user_id) return { memberId: data.id, userId: data.user_id }
  }
  return null
}

async function titleOf(svc: SupabaseClient, call: NotesCall, ownerMemberId: string, names: Map<string, string>): Promise<string> {
  const { data } = await svc.from('team_chat_channel').select('kind, name, dm_key').eq('id', call.channel_id).maybeSingle<{ kind: 'channel' | 'dm'; name: string | null; dm_key: string | null }>()
  if (!data) return 'Call'
  if (data.kind === 'channel') return notesTitle({ kind: 'channel', name: data.name })
  const other = dmOtherMember(data.dm_key, ownerMemberId)
  let otherName = other && other !== ownerMemberId ? names.get(other) ?? null : null
  if (other && other !== ownerMemberId && !otherName) otherName = (await memberNames(svc, [other])).get(other) ?? null
  return notesTitle({ kind: 'dm', name: null, otherName })
}

/**
 * After the notes are written: each file whose words are in is removed from
 * the bucket, unless the call was also recorded (then they are kept beside
 * the recording). A file whose words could not be read is always kept.
 */
export async function removeNotesAudio(svc: SupabaseClient, callId: string): Promise<number> {
  const progress = await notesProgress(svc, callId)
  if (!progress.call || progress.call.recording === 'saved' || progress.call.recording === 'on' || progress.call.recording === 'starting') return 0
  const done = progress.rows.filter((r) => !r.audio_deleted_at && (r.transcript_status === 'done' || r.transcript_status === 'empty'))
  if (done.length === 0) return 0
  const { error } = await svc.storage.from(TEAM_CALL_RECORDINGS_BUCKET).remove(done.map((r) => r.file_path))
  if (error) throw new Error(`team calls: notes audio not removed: ${error.message}`)
  const { error: markError } = await svc
    .from('team_call_egress')
    .update({ audio_deleted_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    .in('id', done.map((r) => r.id))
  if (markError) throw new Error(`team calls: notes audio not marked: ${markError.message}`)
  return done.length
}
