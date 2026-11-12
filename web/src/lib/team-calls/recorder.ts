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
 * every few seconds): the live calls with notes on that nobody feeds and that
 * have had two people in them at once (nothing is heard before: a ringing or
 * missed call, one person waiting), each with a token for its room alone. The app never calls the recorder: LiveKit's
 * stack is kept off the app's networks (deploy/README.md step 23), and asking
 * makes a restarted recorder find its calls again by itself. Whether it is
 * alive is its heartbeat on the feed; the sweeper marks a quiet one lost and
 * the capture says so.
 */
import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { dmOtherMember } from '@/lib/team-chat/types'
import { captureFeedSecretUsable } from '@/lib/capture-feed/auth'
import { teamCallsConfig } from './livekit'
import { notesTitle } from './notes'

function on(name: string, env: NodeJS.ProcessEnv): boolean {
  return env[name]?.trim().toLowerCase() === 'on'
}

/**
 * The recorder takes call notes here: TEAM_CALL_RECORDER=on, calling on, and
 * the feed's secret its own (set, and equal to no other internal secret: one
 * that is not turns the feed itself off, src/lib/capture-feed/auth.ts, and
 * then the call would say "Notes on" while nothing could be heard).
 */
export function teamCallRecorderOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return on('TEAM_CALL_RECORDER', env) && !!teamCallsConfig(env) && captureFeedSecretUsable(env)
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
 * team_call_capture_ensure). The recorder's session start makes it (588's
 * capture_feed_start), so a call nobody else joined never shows one; the call
 * links to it from then. Null when the call is not live with notes on. Throws
 * on a failed write.
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

/** People in a call at once (members and let-in guests: 575's peak_participants) before it is heard. */
export const RECORDER_MIN_PEOPLE = 2

/** A lone call's room is looked at in LiveKit at most this often (per app process). */
export const LONE_CALL_LOOK_EVERY_MS = 15_000
/** The most lone calls one work request looks at. */
export const LONE_CALL_LOOKS_PER_ASK = 5
/** A call this young is left to its join webhooks (they come within a second or two). */
export const LONE_CALL_MIN_AGE_MS = 10_000

const lastLook = new Map<string, number>()

/** For a test: forget when each lone call was looked at. */
export function __forgetLoneCallLooks(): void {
  lastLook.clear()
}

/**
 * A two-person call is never left unheard because a join webhook was lost:
 * live calls with notes on whose counter says fewer than RECORDER_MIN_PEOPLE
 * were ever in them at once have their room's people counted from LiveKit's
 * own list, and a room with two or more raises the counter (589's
 * team_call_people_seen), so the next work answer offers the call.
 *
 * Bounded so it is cheap: asked from the recorder's work request (every few
 * seconds, so a lost webhook costs seconds, not the sweep's five minutes), it
 * looks at calls older than LONE_CALL_MIN_AGE_MS (the webhook's own time),
 * each at most every LONE_CALL_LOOK_EVERY_MS, and at most
 * LONE_CALL_LOOKS_PER_ASK rooms per request; a call that has had two people
 * is never looked at again (its counter only grows). Returns how many calls
 * it raised. Never throws (the work answer goes on without it).
 */
export async function reconcileLoneCalls(
  svc: SupabaseClient,
  roomPeople: (room: string) => Promise<number>,
  now: number = Date.now(),
): Promise<number> {
  try {
    const { data, error } = await svc
      .from('team_call')
      .select('id, room, started_at')
      .eq('status', 'live')
      .eq('notes', true)
      .lt('peak_participants', RECORDER_MIN_PEOPLE)
      .lt('started_at', new Date(now - LONE_CALL_MIN_AGE_MS).toISOString())
      .order('started_at', { ascending: false })
      .limit(100)
    if (error) throw new Error(error.message)
    const lone = (data ?? []) as Array<{ id: string; room: string }>
    const loneIds = new Set(lone.map((c) => c.id))
    for (const id of lastLook.keys()) if (!loneIds.has(id)) lastLook.delete(id)
    const due = lone.filter((c) => now - (lastLook.get(c.id) ?? 0) >= LONE_CALL_LOOK_EVERY_MS).slice(0, LONE_CALL_LOOKS_PER_ASK)
    let raised = 0
    for (const c of due) {
      lastLook.set(c.id, now)
      const people = await roomPeople(c.room).catch(() => 0)
      if (people < RECORDER_MIN_PEOPLE) continue
      const { data: peak, error: seenError } = await svc.rpc('team_call_people_seen', { target_call: c.id, people })
      if (seenError) throw new Error(seenError.message)
      if (typeof peak === 'number') {
        raised++
        console.warn(`[team-call-recorder] call=${c.id} people=${people} counted from the room: its join webhook was lost`)
      }
    }
    return raised
  } catch (err) {
    console.warn('[team-call-recorder] lone calls not looked at:', err instanceof Error ? err.message.slice(0, 160) : 'unknown')
    return 0
  }
}

/**
 * The recorder's work (589's team_call_recorder_work): calls nobody feeds, or
 * this one's that it says it lost, that have had at least RECORDER_MIN_PEOPLE
 * people in them at the same time (565/575's peak_participants, members and
 * let-in guests; the recorder itself is never counted), filtered in the
 * database before its limit, so a call two people are in is never kept out
 * by older ones nobody joined. A call ringing, missed, or that one person
 * waits in is not heard: no Deepgram socket, no capture (it is made when the
 * recorder's session starts), and at its end it is silent. Once two were in,
 * it is heard to its end, one person left or not (the recorder leaves only a
 * room nobody is in). The same filter here as well: a database still on 588
 * (the app rolled out before 589) never offers a lone call.
 */
export async function recorderWork(
  svc: SupabaseClient,
  input: { producerId: string; running: readonly string[]; max: number },
): Promise<RecorderJob[]> {
  const max = Math.max(0, Math.min(RECORDER_MAX_JOBS, Math.floor(input.max)))
  if (max === 0) return []
  const { data, error } = await svc.rpc('team_call_recorder_work', {
    p_producer_id: input.producerId,
    p_running: [...input.running],
    max_jobs: max,
  })
  if (error) throw new Error(`team calls: recorder work read failed: ${error.message}`)
  const offered = ((data ?? []) as Array<{ call_id: string; room: string; round: number }>).map((r) => ({ callId: r.call_id, room: r.room, round: r.round }))
  if (offered.length === 0) return []
  const { data: calls, error: callsError } = await svc
    .from('team_call')
    .select('id, peak_participants')
    .in(
      'id',
      offered.map((o) => o.callId),
    )
  if (callsError) throw new Error(`team calls: recorder work's calls read failed: ${callsError.message}`)
  const peak = new Map(((calls ?? []) as Array<{ id: string; peak_participants: number | null }>).map((c) => [c.id, c.peak_participants ?? 0]))
  return offered.filter((o) => (peak.get(o.callId) ?? 0) >= RECORDER_MIN_PEOPLE).slice(0, max)
}
