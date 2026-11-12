/**
 * The end of a call whose notes the call recorder took (./recorder.ts): its
 * capture, which filled in live, is locked as a recorded meeting's is at
 * Stop. The transcript is written once more from the feed's segments in the
 * order things were said (live they were appended as they arrived), the
 * notes open with what they lack (notes on for part of the call, the 3-hour
 * bound, a stretch the recorder did not hear), then 588's
 * team_call_capture_lock ends every feed of the call and locks the capture;
 * a call where nothing was said leaves no capture ('silent'). The
 * end-of-meeting pass (batch, title, index) runs after, from the notes'
 * Inngest finish (src/lib/inngest/team-call-notes.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { capturedSegments, sourceSessions } from '@/lib/capture-feed/store'
import { gapLines, orderedTranscript } from '@/lib/capture-feed/transcript'
import { TEAM_CALL_NOTES_MAX_SECONDS, notesPreamble } from './notes'

/** A call whose notes are the recorder's, ended, its capture not locked yet: what its finish waits on. */
export interface FedNotesStatus {
  fed: boolean
  callStatus: 'live' | 'ended' | null
  notesState: string | null
  /** Sessions still running (each ended when the call did; a producer may still be sending its last words). */
  open: number
}

/** Are this call's notes the recorder's (a feed session, or a capture made while they were captured)? */
export async function fedNotesStatus(svc: SupabaseClient, callId: string): Promise<FedNotesStatus> {
  const { data: call, error } = await svc.from('team_call').select('status, notes_state, capture_id').eq('id', callId).maybeSingle<{ status: 'live' | 'ended'; notes_state: string; capture_id: string | null }>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  if (!call) return { fed: false, callStatus: null, notesState: null, open: 0 }
  const sessions = await sourceSessions(svc, { kind: 'team_call', ref: callId })
  const fed = sessions.length > 0 || (!!call.capture_id && call.notes_state !== 'ready')
  return { fed, callStatus: call.status, notesState: call.notes_state, open: sessions.filter((s) => s.status !== 'ended').length }
}

export type FedNotesWritten =
  | { outcome: 'ready'; captureId: string; ownerUserId: string; workspaceId: string; spoke: boolean }
  | { outcome: 'silent' | 'skipped' }

interface CallRow {
  id: string
  status: 'live' | 'ended'
  started_at: string
  ended_at: string | null
  duration_seconds: number | null
  notes_seconds: number
  notes_state: string
  capture_id: string | null
}

/**
 * The capture locked, its transcript in the order things were said. When
 * words arrived between the read and the lock, it reads them again (a few
 * times). Throws on a failed write (Inngest retries the step).
 */
export async function writeFedNotes(svc: SupabaseClient, callId: string, tries = 3): Promise<FedNotesWritten> {
  for (let attempt = 1; attempt <= tries; attempt++) {
    const { data: call, error } = await svc
      .from('team_call')
      .select('id, status, started_at, ended_at, duration_seconds, notes_seconds, notes_state, capture_id')
      .eq('id', callId)
      .maybeSingle<CallRow>()
    if (error) throw new Error(`team calls: call read failed: ${error.message}`)
    if (!call || call.status !== 'ended') return { outcome: 'skipped' }
    if (!call.capture_id) return { outcome: call.notes_state === 'silent' ? 'silent' : 'skipped' }
    const [segments, sessions] = await Promise.all([capturedSegments(svc, call.capture_id), sourceSessions(svc, { kind: 'team_call', ref: callId })])
    const transcript = orderedTranscript(segments)
    const preamble = [
      notesPreamble({
        missing: [],
        notesSeconds: call.notes_seconds,
        callSeconds: call.duration_seconds ?? 0,
        stoppedAtBound: call.notes_seconds >= TEAM_CALL_NOTES_MAX_SECONDS,
      }),
      ...gapLines(sessions.flatMap((s) => s.gaps), call.started_at, call.ended_at),
    ]
      .filter(Boolean)
      .join('\n')
    const { data, error: lockError } = await svc.rpc('team_call_capture_lock', {
      target_call: callId,
      transcript_text: transcript.text || null,
      preamble_text: preamble,
      segment_count: segments.length,
    })
    if (lockError) throw new Error(`team calls: notes not locked: ${lockError.message}`)
    const row = (Array.isArray(data) ? data[0] : data) as
      | { outcome?: string; capture_id?: string | null; owner_user?: string | null; workspace_id?: string | null; spoke?: boolean }
      | undefined
    if (row?.outcome === 'changed') continue
    if (row?.outcome === 'silent') {
      console.info(`[team-call-notes] call=${callId} outcome=silent via=recorder`)
      return { outcome: 'silent' }
    }
    if (row?.outcome === 'ready' && row.capture_id && row.owner_user && row.workspace_id) {
      console.info(`[team-call-notes] call=${callId} capture=${row.capture_id} outcome=ready via=recorder lines=${transcript.lines} segments=${segments.length}`)
      return { outcome: 'ready', captureId: row.capture_id, ownerUserId: row.owner_user, workspaceId: row.workspace_id, spoke: row.spoke === true }
    }
    return { outcome: 'skipped' }
  }
  throw new Error('team calls: notes kept changing while they were locked')
}

/** The finish gave out: the capture is locked as it stands (its live transcript), so it is never left open. */
export async function lockFedNotesAsTheyAre(svc: SupabaseClient, callId: string): Promise<string | null> {
  const { data, error } = await svc.rpc('team_call_capture_lock', { target_call: callId, transcript_text: null, preamble_text: '', segment_count: -1 })
  if (error) throw new Error(`team calls: notes not locked: ${error.message}`)
  const row = (Array.isArray(data) ? data[0] : data) as { outcome?: string } | undefined
  return row?.outcome ?? null
}
