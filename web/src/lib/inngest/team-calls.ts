import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { isUuid } from '@/lib/team-chat/types'
import { expireRings, notifyMissedCalls, TEAM_CALL_RING_EVENT, type MissedRing } from '@/lib/team-calls/store'
import { sweepTeamCalls } from '@/lib/team-calls/sweep'
import { openTeamCallRooms, teamCallsConfig } from '@/lib/team-calls/livekit'

/**
 * team-calls/ring.started → a ring's timer (src/lib/team-calls/store.ts):
 * sleep until the ring's time is up, then, if nobody answered (565's
 * team_call_expire_rings: only a ring still open and past its time), it is a
 * missed call and its person is told. A ring answered or ended meanwhile
 * changes nothing. The event's id is the ring's, so a retried request runs
 * one timer. One `[team-call-ring]` line per run, ids only.
 */
export const teamCallRingTimer = inngest.createFunction(
  {
    id: 'team-call-ring-timer',
    retries: 2,
    triggers: [{ event: TEAM_CALL_RING_EVENT }],
  },
  async ({ event, step }) => {
    const data = event.data as { ringId?: unknown; expiresAt?: unknown } | undefined
    const ringId = data?.ringId
    const expiresAt = typeof data?.expiresAt === 'string' ? Date.parse(data.expiresAt) : NaN
    if (!isUuid(ringId) || !Number.isFinite(expiresAt)) {
      console.info('[team-call-ring] ring=- outcome=bad_event')
      return { status: 'skipped', reason: 'bad_event' }
    }
    // A second past the ring's time, so the database's clock has passed it too.
    await step.sleepUntil('ring', new Date(expiresAt + 1000))
    const missed = (await step.run('expire', () => expireRings(getServiceClient(), ringId))) as MissedRing[]
    if (missed.length > 0) await step.run('notify', () => notifyMissedCalls(getServiceClient(), missed))
    console.info(`[team-call-ring] ring=${ringId} outcome=${missed.length > 0 ? 'missed' : 'settled'}`)
    return { status: 'done', missed: missed.length }
  },
)

/**
 * Every five minutes, what a lost webhook or timer left (src/lib/team-calls/
 * sweep.ts): live calls whose room is gone end, rings past their time are
 * missed, old webhook ids are forgotten. With LiveKit unset it still runs
 * the rings and the ids (there are none: calling is off), and ends nothing.
 */
export const teamCallsSweep = inngest.createFunction(
  {
    id: 'team-calls-sweep',
    retries: 1,
    singleton: { mode: 'skip' },
    triggers: [{ cron: '*/5 * * * *' }],
  },
  async ({ step }) => {
    const result = await step.run('sweep', () => {
      const config = teamCallsConfig()
      return sweepTeamCalls(getServiceClient(), { openRooms: config ? (names) => openTeamCallRooms(config, names) : null })
    })
    console.info(
      `[team-calls-sweep] checked=${result.checked} ended=${result.ended} missed=${result.missed} unreachable=${result.unreachable}`,
    )
    return result
  },
)
