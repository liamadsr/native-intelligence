/**
 * The team calls sweeper's part for notes and recordings (the
 * `team-calls-sweep` cron, src/lib/inngest/team-calls.ts, a step of its
 * own): what a lost webhook or a long call left.
 *
 *   1. Notes on past the bound (3 hours of notes in one call) go off, by the
 *      server, and their egresses are stopped. The notes keep what was
 *      written and say they stopped.
 *   2. A recording past its bound (2 hours) is stopped.
 *   2b. Every run, a notes egress still running that is no longer wanted is
 *      stopped: its call's notes are off, or on in a newer round, or the call
 *      ended, or its person is no longer in the call (the off switch's own
 *      stop failed, or came too early). Whatever it writes after the moment
 *      notes went off never reaches the notes (567's cutoff).
 *   3. Egresses not finished a while after they began are asked about:
 *      LiveKit's own list says what became of them (applied as its webhook
 *      would have been); one LiveKit no longer lists (10 minutes old, or 10
 *      minutes after its call ended), or that never got an egress id in 5
 *      minutes, is failed (its call's notes then say whose words are
 *      missing; a recording stops holding the server's cap). When LiveKit
 *      can't be asked, nothing is decided.
 *   4. Calls whose notes are still 'transcribing' long after they ended
 *      (their finish event was lost) are asked to finish again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TeamCallEgressPort } from './egress'
import { TEAM_CALL_NOTES_MAX_SECONDS, TEAM_CALL_RECORDING_MAX_SECONDS, egressStatusOf } from './notes'
import { applyEgressEvent, notesFinishEvent, nowNs, requestNotesFiles, stopEgresses, stopNotesAtBound } from './notes-store'
import { webhookTimeNs } from './webhook'

/** An egress this long without finishing is asked about. */
export const EGRESS_SWEEP_GRACE_MS = 2 * 60_000
/** One without an egress id this long never started. */
export const EGRESS_NEVER_STARTED_MS = 5 * 60_000
/** One LiveKit no longer lists, this long after its call ended, is lost. */
export const EGRESS_LOST_AFTER_END_MS = 10 * 60_000
/** Notes still being written this long after their call ended are asked for again. */
export const NOTES_FINISH_LOST_MS = 20 * 60_000
export const EGRESS_SWEEP_BATCH = 200

export interface NotesSweepDeps {
  egress: TeamCallEgressPort | null
  now?: () => Date
  /** Send events (default: Inngest). */
  send?: (events: Array<{ name: string; id: string; data: Record<string, unknown> }>) => Promise<unknown>
}

export interface NotesSweepResult {
  notesStopped: number
  unwantedStopped: number
  recordingsStopped: number
  egressesChecked: number
  egressesSettled: number
  egressesLost: number
  finishesAsked: number
  unreachable: boolean
}

interface OpenEgress {
  id: string
  call_id: string
  kind: 'notes' | 'recording'
  egress_id: string | null
  created_at: string
}

export async function sweepTeamCallEgress(svc: SupabaseClient, deps: NotesSweepDeps): Promise<NotesSweepResult> {
  const now = deps.now?.() ?? new Date()
  const result: NotesSweepResult = { notesStopped: 0, unwantedStopped: 0, recordingsStopped: 0, egressesChecked: 0, egressesSettled: 0, egressesLost: 0, finishesAsked: 0, unreachable: false }
  const port = deps.egress

  // 1. Notes past the bound.
  const { data: onNow, error: onError } = await svc.from('team_call').select('id, notes_on_since, notes_seconds').eq('notes', true).limit(EGRESS_SWEEP_BATCH)
  if (onError) throw new Error(`team calls sweep: notes read failed: ${onError.message}`)
  for (const c of (onNow ?? []) as Array<{ id: string; notes_on_since: string; notes_seconds: number }>) {
    const since = Date.parse(c.notes_on_since)
    const spent = c.notes_seconds + (Number.isFinite(since) ? Math.max(0, (now.getTime() - since) / 1000) : 0)
    if (!(spent >= TEAM_CALL_NOTES_MAX_SECONDS)) continue
    if (await stopNotesAtBound(svc, c.id)) result.notesStopped++
    if (port) await stopEgresses(svc, port, c.id, 'notes')
  }

  // 2. Recordings past theirs.
  if (port) {
    const { data: recording, error: recError } = await svc
      .from('team_call')
      .select('id')
      .eq('recording', 'on')
      .lt('recording_started_at', new Date(now.getTime() - TEAM_CALL_RECORDING_MAX_SECONDS * 1000).toISOString())
      .limit(EGRESS_SWEEP_BATCH)
    if (recError) throw new Error(`team calls sweep: recordings read failed: ${recError.message}`)
    for (const c of (recording ?? []) as Array<{ id: string }>) result.recordingsStopped += await stopEgresses(svc, port, c.id, 'recording')
  }

  // 2b. Notes egresses running that nobody wants any more.
  if (port) result.unwantedStopped = await stopUnwanted(svc, port, now)

  // 3. Egresses not finished.
  if (port) {
    const { data: open, error: openError } = await svc
      .from('team_call_egress')
      .select('id, call_id, kind, egress_id, created_at')
      .in('status', ['starting', 'active', 'ending'])
      .lt('created_at', new Date(now.getTime() - EGRESS_SWEEP_GRACE_MS).toISOString())
      .order('created_at', { ascending: true })
      .limit(EGRESS_SWEEP_BATCH)
    if (openError) throw new Error(`team calls sweep: egresses read failed: ${openError.message}`)
    const rows = (open ?? []) as OpenEgress[]
    result.egressesChecked = rows.length
    const callIds = [...new Set(rows.map((r) => r.call_id))]
    const calls = new Map<string, { room: string; status: string; ended_at: string | null }>()
    if (callIds.length > 0) {
      const { data: callRows, error: callError } = await svc.from('team_call').select('id, room, status, ended_at').in('id', callIds)
      if (callError) throw new Error(`team calls sweep: calls read failed: ${callError.message}`)
      for (const c of (callRows ?? []) as Array<{ id: string; room: string; status: string; ended_at: string | null }>) calls.set(c.id, c)
    }
    const finishedFiles: string[] = []
    for (const callId of callIds) {
      const call = calls.get(callId)
      if (!call) continue
      let listed: Awaited<ReturnType<TeamCallEgressPort['list']>>
      try {
        listed = await port.list(call.room)
      } catch (err) {
        result.unreachable = true
        console.warn('[team-calls-sweep] egress list failed:', err instanceof Error ? err.message.slice(0, 120) : 'unknown')
        continue
      }
      const byId = new Map(listed.map((e) => [e.egressId, e]))
      for (const row of rows.filter((r) => r.call_id === callId)) {
        const info = row.egress_id ? byId.get(row.egress_id) : undefined
        if (info) {
          const status = egressStatusOf(info.status)
          const applied = await applyEgressEvent(svc, {
            rowId: row.id,
            egressId: info.egressId,
            status,
            atNs: info.updatedAtNs,
            fileStartedAt: webhookTimeNs(info.file?.startedAtNs),
            fileEndedAt: webhookTimeNs(info.file?.endedAtNs),
            durationMs: info.file ? Math.round(Number(info.file.durationNs) / 1_000_000) : null,
            sizeBytes: info.file ? Number(info.file.size) : null,
            error: info.error || null,
          })
          if (applied.outcome === 'applied' && status !== 'starting' && status !== 'active' && status !== 'ending') {
            result.egressesSettled++
            if (row.kind === 'notes' && (status === 'complete' || status === 'limit')) finishedFiles.push(row.id)
          }
          continue
        }
        const age = now.getTime() - Date.parse(row.created_at)
        const endedFor = call.ended_at ? now.getTime() - Date.parse(call.ended_at) : 0
        // LiveKit lists a room's running egresses and those that ended lately: one it doesn't list is gone.
        const lost = row.egress_id
          ? (call.status === 'ended' && endedFor > EGRESS_LOST_AFTER_END_MS) || age > EGRESS_LOST_AFTER_END_MS
          : age > EGRESS_NEVER_STARTED_MS
        if (!lost) continue
        await applyEgressEvent(svc, {
          rowId: row.id,
          egressId: null,
          status: 'failed',
          atNs: nowNs(now.getTime()),
          error: row.egress_id ? 'lost: LiveKit no longer knows this egress' : 'lost: never started',
        })
        result.egressesLost++
      }
    }
    if (finishedFiles.length > 0) await requestNotesFiles(finishedFiles, deps.send)
  }

  // 4. Notes whose finish was lost.
  const { data: stuck, error: stuckError } = await svc
    .from('team_call')
    .select('id')
    .eq('notes_state', 'transcribing')
    .lt('ended_at', new Date(now.getTime() - NOTES_FINISH_LOST_MS).toISOString())
    .limit(EGRESS_SWEEP_BATCH)
  if (stuckError) throw new Error(`team calls sweep: notes read failed: ${stuckError.message}`)
  const events = ((stuck ?? []) as Array<{ id: string }>).map((c) => notesFinishEvent(c.id))
  if (events.length > 0) {
    try {
      if (deps.send) await deps.send(events)
      else {
        const { inngest } = await import('@/lib/inngest/client')
        await inngest.send(events)
      }
      result.finishesAsked = events.length
    } catch (err) {
      console.warn('[team-calls-sweep] notes finishes not asked:', err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    }
  }
  return result
}

/** Notes egresses still running whose notes are off (or on in a newer round), whose call ended, or whose person left: stopped. */
export async function stopUnwanted(svc: SupabaseClient, port: TeamCallEgressPort, now: Date = new Date()): Promise<number> {
  const { data, error } = await svc
    .from('team_call_egress')
    .select('id, call_id, member_id, round, egress_id')
    .eq('kind', 'notes')
    .in('status', ['starting', 'active'])
    .not('egress_id', 'is', null)
    // A minute old at least: a person's join can land just after their microphone's egress began.
    .lt('created_at', new Date(now.getTime() - 60_000).toISOString())
    .order('created_at', { ascending: true })
    .limit(EGRESS_SWEEP_BATCH)
  if (error) throw new Error(`team calls sweep: running notes read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ id: string; call_id: string; member_id: string | null; round: number; egress_id: string }>
  if (rows.length === 0) return 0
  const callIds = [...new Set(rows.map((r) => r.call_id))]
  const [calls, people] = await Promise.all([
    svc.from('team_call').select('id, status, notes, notes_round').in('id', callIds),
    svc.from('team_call_participant').select('call_id, member_id, state').in('call_id', callIds),
  ])
  if (calls.error) throw new Error(`team calls sweep: calls read failed: ${calls.error.message}`)
  if (people.error) throw new Error(`team calls sweep: people read failed: ${people.error.message}`)
  const byId = new Map(((calls.data ?? []) as Array<{ id: string; status: string; notes: boolean; notes_round: number }>).map((c) => [c.id, c]))
  const inCall = new Set(
    ((people.data ?? []) as Array<{ call_id: string; member_id: string; state: string }>).filter((p) => p.state === 'joined').map((p) => `${p.call_id}:${p.member_id}`),
  )
  let stopped = 0
  for (const row of rows) {
    const call = byId.get(row.call_id)
    const wanted = !!call && call.status === 'live' && call.notes && call.notes_round === row.round && !!row.member_id && inCall.has(`${row.call_id}:${row.member_id}`)
    if (wanted) continue
    try {
      await port.stop(row.egress_id)
      stopped++
    } catch (err) {
      console.warn(`[team-calls-sweep] egress_row=${row.id} not stopped:`, err instanceof Error ? err.message.slice(0, 120) : 'unknown')
    }
  }
  return stopped
}
