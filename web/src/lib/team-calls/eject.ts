/**
 * Taking people out of a call when their access to its conversation ends
 * (migrations 564-565). A connected participant is never cut off by their
 * token running out, so the app has to say so to LiveKit.
 *
 * The database writes the outbox (team_call_eject) the moment access ends,
 * whatever ended it: 565's triggers on team_member, team_chat_member,
 * member and team_chat_channel (a person taken off the team or out of a
 * DM, removed from the workspace, a channel archived or deleted); the
 * participant event, when someone without access joins (a removed person
 * rejoining on a token LiveKit refreshed); and team_call_fence, the
 * sweeper's check of everyone connected. This module drains it:
 *
 *   identity set   RoomService.removeParticipant(room, identity)
 *   identity null  RoomService.deleteRoom(room) (the call ended with its channel)
 *
 * Who drains, and when: the webhook route at once for a refused join; the
 * `team-calls-eject` Inngest function on `team-calls/eject.requested` (the
 * routes that remove people send it) and every minute (anything else); the
 * sweeper after its check. An entry LiveKit can't take now stays pending
 * and is tried again (attempts counts); one for a room or person already
 * gone is done. Nothing here runs while calling is off.
 *
 * The outbox is also how the app learns a trigger ended a call or took
 * someone out of one: each entry done stops the phones still ringing for
 * it (./ring-push.ts: the call's rings, or that member's, their cancel
 * once, when they were pushed and settled before their time).
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { closeTeamCallRoom, removeFromTeamCallRoom, teamCallsConfig, type TeamCallsConfig } from './livekit'
import { requestNotesFinish } from './notes-store'
import { cancelRingPushes, liveRingPushDeps } from './ring-push'

export const TEAM_CALL_EJECT_EVENT = 'team-calls/eject.requested' as const
/** The most entries one drain takes. */
export const TEAM_CALL_EJECT_BATCH = 100

export interface EjectDeps {
  remove: (room: string, identity: string) => Promise<void>
  close: (room: string) => Promise<void>
  /** Stop the phones still ringing for this call (one member's rings, or all when null). */
  stopPhones?: (svc: SupabaseClient, callId: string, memberId: string | null) => Promise<unknown>
}

export function liveEjectDeps(config: TeamCallsConfig): EjectDeps {
  return {
    remove: (room, identity) => removeFromTeamCallRoom(config, room, identity),
    close: (room) => closeTeamCallRoom(config, room),
  }
}

export interface EjectResult {
  done: number
  failed: number
}

/** Drain the outbox: each pending entry to LiveKit, then done. Throws only on a failed read. */
export async function drainTeamCallEjections(svc: SupabaseClient, deps: EjectDeps): Promise<EjectResult> {
  const { data, error } = await svc
    .from('team_call_eject')
    .select('id, call_id, room, identity, attempts')
    .is('done_at', null)
    .order('created_at', { ascending: true })
    .limit(TEAM_CALL_EJECT_BATCH)
  if (error) throw new Error(`team calls: eject outbox read failed: ${error.message}`)
  const result: EjectResult = { done: 0, failed: 0 }
  const stop = deps.stopPhones ?? ((s: SupabaseClient, callId: string, memberId: string | null) => cancelRingPushes(liveRingPushDeps(s), { callId, memberId: memberId ?? undefined }))
  for (const row of (data ?? []) as Array<{ id: string; call_id: string | null; room: string; identity: string | null; attempts: number | null }>) {
    try {
      if (row.identity) await deps.remove(row.room, row.identity)
      else {
        await deps.close(row.room)
        // The call ended with its channel (565's 'archived'): its notes, if any, are written next.
        try {
          const { data: ended } = await svc.from('team_call').select('id').eq('room', row.room).maybeSingle<{ id: string }>()
          if (ended?.id) await requestNotesFinish(svc, ended.id)
        } catch {
          // The sweeper asks for notes left unfinished.
        }
      }
      await svc.from('team_call_eject').update({ done_at: new Date().toISOString() }).eq('id', row.id)
      result.done++
      if (row.call_id) await stop(svc, row.call_id, row.identity).catch(() => undefined)
    } catch (err) {
      result.failed++
      await svc.from('team_call_eject').update({ attempts: (row.attempts ?? 0) + 1 }).eq('id', row.id)
      console.warn(`[team-calls-eject] room=${row.room} not done:`, err instanceof Error ? err.message : 'unknown')
    }
  }
  return result
}

/**
 * Ask for the outbox to be drained now (after a route removed someone).
 * Never throws; with calling off, does nothing. The minute's drain is the
 * floor either way.
 */
export async function requestTeamCallEjections(send?: (event: { name: string; data: Record<string, unknown> }) => Promise<unknown>): Promise<void> {
  if (!teamCallsConfig()) return
  try {
    const event = { name: TEAM_CALL_EJECT_EVENT, data: {} }
    if (send) await send(event)
    else {
      const { inngest } = await import('@/lib/inngest/client')
      await inngest.send(event)
    }
  } catch (err) {
    console.warn('[team-calls-eject] drain not requested:', err instanceof Error ? err.message : 'unknown')
  }
}
