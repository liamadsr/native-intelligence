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
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { closeTeamCallRoom, removeFromTeamCallRoom, teamCallsConfig, type TeamCallsConfig } from './livekit'

export const TEAM_CALL_EJECT_EVENT = 'team-calls/eject.requested' as const
/** The most entries one drain takes. */
export const TEAM_CALL_EJECT_BATCH = 100

export interface EjectDeps {
  remove: (room: string, identity: string) => Promise<void>
  close: (room: string) => Promise<void>
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
    .select('id, room, identity, attempts')
    .is('done_at', null)
    .order('created_at', { ascending: true })
    .limit(TEAM_CALL_EJECT_BATCH)
  if (error) throw new Error(`team calls: eject outbox read failed: ${error.message}`)
  const result: EjectResult = { done: 0, failed: 0 }
  for (const row of (data ?? []) as Array<{ id: string; room: string; identity: string | null; attempts: number | null }>) {
    try {
      if (row.identity) await deps.remove(row.room, row.identity)
      else await deps.close(row.room)
      await svc.from('team_call_eject').update({ done_at: new Date().toISOString() }).eq('id', row.id)
      result.done++
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
