/**
 * The end of a call whose notes the call recorder took (./recorder.ts): its
 * capture, which filled in live, is locked as a recorded meeting's is at
 * Stop. The finish first waits for the recorder to say it has delivered its
 * last words (its `end`, 588's delivered_at), at most FED_TAIL_CAP_MS; then
 * 588's team_call_capture_lock ends every feed of the call, writes the
 * transcript once more in the order things were said (read in the database,
 * every segment: no page cap), puts what the notes lack before the person's
 * own notes (notes on for part of the call, the 3-hour bound, a stretch the
 * recorder did not hear) and locks the capture; a call where nothing was said
 * leaves no capture ('silent'). Anything delivered before the lock is in it.
 * The end-of-meeting pass (batch, title, index) runs after, from the notes'
 * Inngest finish (src/lib/inngest/team-call-notes.ts).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { sourceSessions } from '@/lib/capture-feed/store'
import { gapLines } from '@/lib/capture-feed/transcript'
import { TEAM_CALL_NOTES_MAX_SECONDS, notesPreamble } from './notes'

/** How long the finish waits for the recorder's last words at most, after the call ended. */
export const FED_TAIL_CAP_MS = 2 * 60_000
/** A producer silent this long before the call ended is not waited for (the sweeper's lost bound). */
const FED_QUIET_MS = 90_000

/** A call whose notes are the recorder's, ended, its capture not locked yet: what its finish waits on. */
export interface FedNotesStatus {
  fed: boolean
  callStatus: 'live' | 'ended' | null
  notesState: string | null
  /** When the call ended (ISO). */
  endedAt: string | null
  /** Sessions whose producer has not yet said it delivered everything (a lost one is not waited for). */
  undelivered: number
}

/** Are this call's notes the recorder's (a feed session, or a capture made while they were captured)? */
export async function fedNotesStatus(svc: SupabaseClient, callId: string): Promise<FedNotesStatus> {
  const { data: call, error } = await svc
    .from('team_call')
    .select('status, notes_state, capture_id, ended_at')
    .eq('id', callId)
    .maybeSingle<{ status: 'live' | 'ended'; notes_state: string; capture_id: string | null; ended_at: string | null }>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  if (!call) return { fed: false, callStatus: null, notesState: null, endedAt: null, undelivered: 0 }
  const sessions = await sourceSessions(svc, { kind: 'team_call', ref: callId })
  const fed = sessions.length > 0 || (!!call.capture_id && call.notes_state !== 'ready')
  // A producer that had stopped heartbeating before the call ended has nothing more coming.
  const end = call.ended_at ? Date.parse(call.ended_at) : Date.now()
  const undelivered = sessions.filter((s) => !s.deliveredAt && Date.parse(s.heartbeatAt) > end - FED_QUIET_MS).length
  return { fed, callStatus: call.status, notesState: call.notes_state, endedAt: call.ended_at, undelivered }
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

/** The capture locked, its transcript in the order things were said. Throws on a failed write (Inngest retries the step). */
export async function writeFedNotes(svc: SupabaseClient, callId: string): Promise<FedNotesWritten> {
  const { data: call, error } = await svc
    .from('team_call')
    .select('id, status, started_at, ended_at, duration_seconds, notes_seconds, notes_state, capture_id')
    .eq('id', callId)
    .maybeSingle<CallRow>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  if (!call || call.status !== 'ended') return { outcome: 'skipped' }
  if (!call.capture_id) return { outcome: call.notes_state === 'silent' ? 'silent' : 'skipped' }
  const sessions = await sourceSessions(svc, { kind: 'team_call', ref: callId })
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
  const row = await lockCapture(svc, callId, preamble, true)
  if (row?.outcome === 'silent') {
    console.info(`[team-call-notes] call=${callId} outcome=silent via=recorder`)
    return { outcome: 'silent' }
  }
  if (row?.outcome === 'ready' && row.capture_id && row.owner_user && row.workspace_id) {
    console.info(`[team-call-notes] call=${callId} capture=${row.capture_id} outcome=ready via=recorder spoke=${row.spoke === true}`)
    return { outcome: 'ready', captureId: row.capture_id, ownerUserId: row.owner_user, workspaceId: row.workspace_id, spoke: row.spoke === true }
  }
  return { outcome: 'skipped' }
}

/**
 * A person ended (or locked) a call's capture while the call goes on with its notes on: the notes
 * go off for the call (567's team_call_notes_stop, the switch's own effect: the round's feed ends
 * and the recorder is put out of the room by 588's trigger). Notes on again are a new round, into
 * a new capture. True when they were on.
 */
export async function stopNotesForEndedCapture(svc: SupabaseClient, captureId: string): Promise<boolean> {
  const { data: call, error } = await svc
    .from('team_call')
    .select('id')
    .eq('capture_id', captureId)
    .eq('status', 'live')
    .eq('notes', true)
    .maybeSingle<{ id: string }>()
  if (error) throw new Error(`team calls: call read failed: ${error.message}`)
  if (!call) return false
  const { data, error: stopError } = await svc.rpc('team_call_notes_stop', { target_call: call.id })
  if (stopError) throw new Error(`team calls: notes not stopped: ${stopError.message}`)
  console.info(`[team-call-notes] call=${call.id} capture=${captureId} notes off: the capture was ended by hand`)
  return data === true
}

/** The finish gave out: the capture is locked as it stands (its live transcript), so it is never left open. */
export async function lockFedNotesAsTheyAre(svc: SupabaseClient, callId: string): Promise<string | null> {
  return (await lockCapture(svc, callId, '', false))?.outcome ?? null
}

async function lockCapture(svc: SupabaseClient, callId: string, preamble: string, rebuild: boolean) {
  const { data, error } = await svc.rpc('team_call_capture_lock', { target_call: callId, preamble_text: preamble, rebuild })
  if (error) throw new Error(`team calls: notes not locked: ${error.message}`)
  return (Array.isArray(data) ? data[0] : data) as
    | { outcome?: string; capture_id?: string | null; owner_user?: string | null; workspace_id?: string | null; spoke?: boolean }
    | undefined
}
