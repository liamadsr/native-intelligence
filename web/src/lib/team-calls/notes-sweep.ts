/**
 * The team calls sweeper's part for notes and recordings (the
 * `team-calls-sweep` cron, src/lib/inngest/team-calls.ts, a step of its
 * own): what a lost webhook or a long call left.
 *
 *   1. Notes on past the bound (3 hours of notes in one call) go off, by the
 *      server, and their egresses are stopped. The notes keep what was
 *      written and say they stopped.
 *   2. A recording past its bound (2 hours) is stopped.
 *   3. Egresses not finished a while after they began are asked about:
 *      LiveKit's own list says what became of them (applied as its webhook
 *      would have been); one LiveKit no longer knows, or that never got an
 *      egress id, is failed (its call's notes then say whose words are
 *      missing). When LiveKit can't be asked, nothing is decided.
 *   4. Calls whose notes are still 'transcribing' long after they ended
 *      (their finish event was lost) are asked to finish again.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type { TeamCallEgressPort } from './egress'
import { TEAM_CALL_NOTES_MAX_SECONDS, TEAM_CALL_RECORDING_MAX_SECONDS, egressStatusOf } from './notes'
import { applyEgressEvent, notesFinishEvent, requestNotesFiles, stopEgresses, stopNotesAtBound } from './notes-store'
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
  const result: NotesSweepResult = { notesStopped: 0, recordingsStopped: 0, egressesChecked: 0, egressesSettled: 0, egressesLost: 0, finishesAsked: 0, unreachable: false }
  const port = deps.egress

  // 1. Notes past the bound.
  const { data: onNow, error: onError } = await svc.from('team_call').select('id, notes_on_since, notes_seconds').eq('notes', true).limit(EGRESS_SWEEP_BATCH)
  if (onError) throw new Error(`team calls sweep: notes read failed: ${onError.message}`)
  for (const c of (onNow ?? []) as Array<{ id: string; notes_on_since: string; notes_seconds: number }>) {
    const spent = c.notes_seconds + Math.max(0, (now.getTime() - Date.parse(c.notes_on_since)) / 1000)
    if (spent < TEAM_CALL_NOTES_MAX_SECONDS) continue
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
        const lost = row.egress_id ? call.status === 'ended' && endedFor > EGRESS_LOST_AFTER_END_MS : age > EGRESS_NEVER_STARTED_MS
        if (!lost) continue
        await applyEgressEvent(svc, {
          rowId: row.id,
          egressId: null,
          status: 'failed',
          atNs: 0,
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
