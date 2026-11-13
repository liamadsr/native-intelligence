import { getServiceClient } from '@/lib/admin'
import { isUuid } from '@/lib/team-chat/types'
import { CALL_LIVE_TURN_EVENT, LIVE_TURN_QUIET_SECONDS, offerLiveTurn, runLiveTurn, teamCallLiveAgentOn } from '@/lib/team-calls/live-turns'
import { inngest } from './client'

/**
 * team-calls/live-turn → one live agent turn on a call's capture, holding the
 * lease the claim gave it (src/lib/team-calls/live-turns.ts, migration 655):
 * the words since the last good turn go to the live agent's route as the
 * capture's owner, and the lease comes back with what became of them. Then,
 * QUIET_SECONDS later, one more look: words said at the end of the turn that
 * nobody followed up on are sent too, so the notes catch up when the room goes
 * quiet as well as while it talks.
 *
 * Never retried: a failed turn is skipped, and its words go with the next one
 * (the lease runs out by itself if this run dies). One at a time per capture
 * (the lease decides; the concurrency key only keeps Inngest from starting a
 * second run of the same capture beside it), and a handful at once in all.
 * One `[call-live-turns]` line per outcome, ids only.
 */

/** What this reads of Inngest's run (a test hands its own). */
export interface LiveTurnRunContext {
  event: { data: unknown }
  step: {
    run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
    sleep: (id: string, duration: string) => Promise<unknown>
  }
}

export async function runTeamCallLiveTurn({ event, step }: LiveTurnRunContext) {
  const data = event.data as { captureId?: unknown; lease?: unknown } | undefined
  if (!isUuid(data?.captureId) || !isUuid(data?.lease)) return { status: 'skipped', reason: 'bad_event' }
  const captureId = data.captureId
  const lease = data.lease
  // Switched off since the turn was offered: the lease runs out by itself; nothing is sent.
  if (!teamCallLiveAgentOn()) return { status: 'skipped', reason: 'off' }
  const outcome = await step.run('turn', () => runLiveTurn(getServiceClient(), { captureId, lease }))
  if (outcome !== 'ok' && outcome !== 'empty') return { status: outcome }
  await step.sleep('quiet', `${LIVE_TURN_QUIET_SECONDS}s`)
  const tail = await step.run('tail', () => offerLiveTurn(getServiceClient(), captureId))
  return { status: outcome, tail }
}

export const teamCallLiveTurn = inngest.createFunction(
  {
    id: 'team-call-live-turn',
    retries: 0,
    concurrency: [{ limit: 1, key: 'event.data.captureId' }, { limit: 5 }],
    triggers: [{ event: CALL_LIVE_TURN_EVENT }],
  },
  runTeamCallLiveTurn,
)
