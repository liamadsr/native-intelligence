/**
 * The team calls sweeper (the `team-calls-sweep` Inngest cron,
 * src/lib/inngest/team-calls.ts): what a lost webhook or a lost timer left.
 *
 *   1. Live calls older than TEAM_CALL_SWEEP_GRACE_MS whose LiveKit room is
 *      gone are ended ('swept'): their room_finished never arrived. When
 *      LiveKit can't be asked (unset, or down), nothing is ended: a call is
 *      never ended on a guess.
 *   2. Rings past their time are missed (their own timer never ran).
 *   3. Webhook ids older than TEAM_CALL_WEBHOOK_MEMORY_MS are forgotten
 *      (LiveKit repeats an event within minutes, not days).
 *
 * The rings 1 and 2 left missed are handed back (`missedRings`): the cron
 * tells their people in a step of its own, so a failed notice is retried on
 * its own and never lost behind a ring already marked missed.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { endCall, expireRings, type MissedRing } from './store'

export const TEAM_CALL_SWEEP_GRACE_MS = 2 * 60_000
export const TEAM_CALL_WEBHOOK_MEMORY_MS = 2 * 24 * 60 * 60_000
/** The most live calls one sweep looks at. */
export const TEAM_CALL_SWEEP_BATCH = 200

export interface TeamCallSweepDeps {
  /** The rooms among these that are open on the server; null when LiveKit is off. Throws when it can't be asked. */
  openRooms: ((names: readonly string[]) => Promise<Set<string>>) | null
  now?: () => Date
}

export interface TeamCallSweepResult {
  checked: number
  ended: number
  missed: number
  /** LiveKit could not be asked: no call was ended. */
  unreachable: boolean
  /** The rings now missed, for their people to be told. */
  missedRings: MissedRing[]
}

export async function sweepTeamCalls(svc: SupabaseClient, deps: TeamCallSweepDeps): Promise<TeamCallSweepResult> {
  const now = deps.now?.() ?? new Date()
  const result: TeamCallSweepResult = { checked: 0, ended: 0, missed: 0, unreachable: false, missedRings: [] }

  if (deps.openRooms) {
    const { data, error } = await svc
      .from('team_call')
      .select('id, room')
      .eq('status', 'live')
      .lt('started_at', new Date(now.getTime() - TEAM_CALL_SWEEP_GRACE_MS).toISOString())
      .order('started_at', { ascending: true })
      .limit(TEAM_CALL_SWEEP_BATCH)
    if (error) throw new Error(`team calls sweep: live calls read failed: ${error.message}`)
    const live = (data ?? []) as Array<{ id: string; room: string }>
    result.checked = live.length
    if (live.length > 0) {
      let open: Set<string> | null = null
      try {
        open = await deps.openRooms(live.map((c) => c.room))
      } catch (err) {
        result.unreachable = true
        console.warn('[team-calls-sweep] LiveKit not reachable:', err instanceof Error ? err.message : 'unknown')
      }
      if (open) {
        for (const call of live) {
          if (open.has(call.room)) continue
          const missed = await endCall(svc, call.id, 'swept', now)
          result.ended++
          result.missedRings.push(...missed)
        }
      }
    }
  }

  result.missedRings.push(...(await expireRings(svc, null)))
  result.missed = result.missedRings.length

  const { error: pruneError } = await svc
    .from('team_call_webhook_event')
    .delete()
    .lt('received_at', new Date(now.getTime() - TEAM_CALL_WEBHOOK_MEMORY_MS).toISOString())
  if (pruneError) console.warn('[team-calls-sweep] webhook ids not pruned:', pruneError.message)
  return result
}
