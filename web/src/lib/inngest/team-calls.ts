import { getServiceClient } from '@/lib/admin'
import { inngest } from './client'
import { isUuid } from '@/lib/team-chat/types'
import {
  expireRings,
  fenceTeamCalls,
  missedRingsNobodyWasToldOf,
  notifyMissedCalls,
  TEAM_CALL_MISSED_EVENT,
  TEAM_CALL_RING_EVENT,
  untoldMissedRings,
  type MissedRing,
} from '@/lib/team-calls/store'
import { drainTeamCallEjections, liveEjectDeps, TEAM_CALL_EJECT_EVENT } from '@/lib/team-calls/eject'
import { sweepTeamCalls } from '@/lib/team-calls/sweep'
import { openTeamCallRooms, teamCallsConfig } from '@/lib/team-calls/livekit'

/** What the ring's timer reads of Inngest's run (a test hands its own). */
export interface TeamCallRingTimerContext {
  event: { data: unknown }
  step: {
    sleepUntil: (id: string, until: Date) => Promise<unknown>
    run: <T>(id: string, fn: () => Promise<T>) => Promise<unknown>
  }
}

/**
 * team-calls/ring.started → a ring's timer (src/lib/team-calls/store.ts):
 * sleep until the ring's time is up, then, if nobody answered (565's
 * team_call_expire_rings: only a ring still open and past its time), it is a
 * missed call and its person is told. A ring answered or ended meanwhile
 * changes nothing. The event's id is the ring's, so a retried request runs
 * one timer. One `[team-call-ring]` line per run, ids only.
 */
export async function runTeamCallRingTimer({ event, step }: TeamCallRingTimerContext) {
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
}

export const teamCallRingTimer = inngest.createFunction(
  {
    id: 'team-call-ring-timer',
    retries: 2,
    triggers: [{ event: TEAM_CALL_RING_EVENT }],
  },
  runTeamCallRingTimer,
)

/**
 * team-calls/missed.requested → one missed ring's notice (the event's id is
 * the ring's), once: a ring whose person was told already is skipped
 * (src/lib/team-calls/store.ts notifyMissedCalls). Sent when a call ends
 * with rings open, out of the request path.
 */
export const teamCallMissed = inngest.createFunction(
  {
    id: 'team-call-missed',
    retries: 3,
    triggers: [{ event: TEAM_CALL_MISSED_EVENT }],
  },
  async ({ event, step }) => {
    const ringId = (event.data as { ringId?: unknown } | undefined)?.ringId
    if (!isUuid(ringId)) return { status: 'skipped', reason: 'bad_event' }
    const told = await step.run('notify', async () => notifyMissedCalls(getServiceClient(), await untoldMissedRings(getServiceClient(), [ringId])))
    console.info(`[team-call-missed] ring=${ringId} told=${told}`)
    return { status: 'done', told }
  },
)

/**
 * Taking people out of calls whose conversation they may no longer read
 * (src/lib/team-calls/eject.ts): on team-calls/eject.requested (the routes
 * that remove people send it) and every minute (whatever else removed
 * them: the database wrote the outbox either way). Nothing while calling
 * is off.
 */
export const teamCallsEject = inngest.createFunction(
  {
    id: 'team-calls-eject',
    retries: 1,
    concurrency: [{ limit: 1 }],
    triggers: [{ event: TEAM_CALL_EJECT_EVENT }, { cron: '* * * * *' }],
  },
  async ({ step }) => {
    const config = teamCallsConfig()
    if (!config) return { status: 'skipped', reason: 'calls_off' }
    const result = await step.run('drain', () => drainTeamCallEjections(getServiceClient(), liveEjectDeps(config)))
    if (result.done || result.failed) console.info(`[team-calls-eject] done=${result.done} failed=${result.failed}`)
    return { status: 'done', ...result }
  },
)

/**
 * Every five minutes, what a lost webhook or timer left (src/lib/team-calls/
 * sweep.ts): live calls whose room is gone end, rings past their time are
 * missed, old webhook ids are forgotten; then everyone connected who may no
 * longer read their call's conversation is put out (565's team_call_fence,
 * drained by team-calls-eject), and the missed rings nobody was told of are
 * told, in steps of their own. With LiveKit unset it still runs the rings
 * and the ids (there are none: calling is off), and ends nothing.
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
    const fenced = teamCallsConfig() ? await step.run('fence', () => fenceTeamCalls(getServiceClient())) : 0
    if (fenced > 0) await step.sendEvent('eject', { name: TEAM_CALL_EJECT_EVENT, data: {} })
    // Their own step: a failed notice is retried alone (the rings are already missed), with any a lost event left untold.
    await step.run('notify', async () => {
      const backlog = await missedRingsNobodyWasToldOf(getServiceClient())
      const all = [...(result.missedRings as MissedRing[]), ...backlog.filter((b) => !result.missedRings.some((r) => r.ring_id === b.ring_id))]
      return all.length ? notifyMissedCalls(getServiceClient(), all) : 0
    })
    console.info(
      `[team-calls-sweep] checked=${result.checked} ended=${result.ended} missed=${result.missed} unreachable=${result.unreachable}`,
    )
    return { checked: result.checked, ended: result.ended, missed: result.missed, unreachable: result.unreachable }
  },
)
