/**
 * Call notes by the call recorder (one recorder per call, phase 1), the
 * app's side; server only. The recorder (recorder/ at the repo's root, a
 * service in LiveKit's stack) joins a call's room as a hidden participant
 * that publishes nothing, hears every microphone, transcribes each as it is
 * spoken, and delivers the words through the capture feed
 * (src/lib/capture-feed/), which writes them into ONE capture of the call
 * that fills in live.
 *
 * Settings (an empty value counts as unset):
 *   TEAM_CALL_RECORDER=on   the master switch: notes are the recorder's
 *                           (LiveKit Egress takes no notes then; recordings
 *                           of the whole call are Egress's as before). Off
 *                           unless set.
 *   CAPTURE_FEED_SECRET     the feed's own secret, the same value in the
 *                           recorder's settings (deploy/livekit/.env).
 *   LIVEKIT_*               calls themselves (./livekit.ts).
 *
 * The recorder asks for its work (POST /api/internal/team-call-recorder/work,
 * every few seconds): the live calls with notes on that nobody feeds, each
 * with a token for its room alone. The app never calls the recorder: LiveKit's
 * stack is kept off the app's networks (deploy/README.md step 23), and asking
 * makes a restarted recorder find its calls again by itself. Whether it is
 * alive is its heartbeat on the feed; the sweeper marks a quiet one lost and
 * the capture says so.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dmOtherMember } from '@/lib/team-chat/types'
import { teamCallsConfig } from './livekit'
import { notesTitle } from './notes'

function on(name: string, env: NodeJS.ProcessEnv): boolean {
  return env[name]?.trim().toLowerCase() === 'on'
}

/**
 * The recorder takes call notes here: TEAM_CALL_RECORDER=on, calling on, and
 * the feed's secret set. (A secret equal to another internal one turns the
 * feed itself off, src/lib/capture-feed/auth.ts: the recorder then logs that
 * every request was refused, and the `[internal-secret]` line says why.)
 */
export function teamCallRecorderOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return on('TEAM_CALL_RECORDER', env) && !!teamCallsConfig(env) && !!env.CAPTURE_FEED_SECRET?.trim()
}

/** The producer kind the call recorder names itself (587's producer_kind). */
export const CALL_RECORDER_PRODUCER_KIND = 'livekit_recorder'

/** The most calls one ask hands out. */
export const RECORDER_MAX_JOBS = 20

/**
 * The notes' title, from the conversation, as their owner sees it: "Call in
 * #launch", a meeting's own title, "Call with Rosa Lind" (a DM, named for its
 * other person). The owner as 588's team_call_notes_owner picks them.
 */
export async function callNotesTitle(svc: SupabaseClient, callId: string): Promise<string> {
  const { data: call } = await svc
    .from('team_call')
    .select('channel_id, workspace_id, started_by, notes_by')
    .eq('id', callId)
    .maybeSingle<{ channel_id: string; workspace_id: string; started_by: string | null; notes_by: string | null }>()
  if (!call) return 'Call'
  const { data: ch } = await svc.from('team_chat_channel').select('kind, name, dm_key').eq('id', call.channel_id).maybeSingle<{ kind: 'channel' | 'dm' | 'meeting'; name: string | null; dm_key: string | null }>()
  if (!ch) return 'Call'
  if (ch.kind !== 'dm') return notesTitle({ kind: ch.kind, name: ch.name })
  const owner = call.started_by ?? call.notes_by
  const other = owner ? dmOtherMember(ch.dm_key, owner) : null
  if (!other || other === owner) return notesTitle({ kind: 'dm', name: null })
  const { data: m } = await svc.from('member').select('display_name').eq('id', other).maybeSingle<{ display_name: string | null }>()
  return notesTitle({ kind: 'dm', name: null, otherName: m?.display_name ?? null })
}

/**
 * The call's one capture, made now if notes are on and it has none (588's
 * team_call_capture_ensure): the call links to it from the moment notes go
 * on. Null when the call is not live with notes on. Throws on a failed write.
 */
export async function ensureCallCapture(svc: SupabaseClient, callId: string): Promise<string | null> {
  const title = await callNotesTitle(svc, callId)
  const { data, error } = await svc.rpc('team_call_capture_ensure', { target_call: callId, capture_title: title })
  if (error) throw new Error(`team calls: notes capture not made: ${error.message}`)
  return typeof data === 'string' ? data : null
}

/** A call the recorder should be in. */
export interface RecorderJob {
  callId: string
  room: string
  round: number
}

/** The recorder's work (588's team_call_recorder_work): calls nobody feeds, or this one's that it says it lost. */
export async function recorderWork(
  svc: SupabaseClient,
  input: { producerId: string; running: readonly string[]; max: number },
): Promise<RecorderJob[]> {
  const { data, error } = await svc.rpc('team_call_recorder_work', {
    p_producer_id: input.producerId,
    p_running: [...input.running],
    max_jobs: Math.max(0, Math.min(RECORDER_MAX_JOBS, Math.floor(input.max))),
  })
  if (error) throw new Error(`team calls: recorder work read failed: ${error.message}`)
  return ((data ?? []) as Array<{ call_id: string; room: string; round: number }>).map((r) => ({ callId: r.call_id, room: r.room, round: r.round }))
}
