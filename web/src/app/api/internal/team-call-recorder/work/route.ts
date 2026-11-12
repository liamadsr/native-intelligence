/**
 * POST /api/internal/team-call-recorder/work { producer, running, capacity }
 * → { jobs: [{ callId, room, round, token }], pollMs } the call recorder's
 * work (src/lib/team-calls/recorder.ts): live calls with notes on that no
 * producer feeds, and this one's own that it no longer lists in `running`
 * (it restarted, or lost the room), at most `capacity`. Each job carries a
 * token for its room alone: hidden, a recorder, subscribe only. The
 * recorder then starts the call's feed (POST /api/internal/capture-feed/
 * start) and joins the room. Its identity there is its own
 * (`notes-recorder-<producer id>`); one recorder instance is what the
 * deployment runs today (deploy/livekit's `recorder`, RECORDER_ID).
 *
 * Asked every few seconds; an empty list is the usual answer. Server only:
 * the feed's secret. 404 while the recorder is off here (TEAM_CALL_RECORDER
 * not on, or calling off).
 */
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { getServiceClient } from '@/lib/admin'
import { notFound } from '@/lib/api-errors'
import { ProducerSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { teamCallRecorderToken, teamCallsConfig } from '@/lib/team-calls/livekit'
import { RECORDER_MAX_JOBS, recorderWork, teamCallRecorderOn } from '@/lib/team-calls/recorder'

export const dynamic = 'force-dynamic'

/** How long the recorder waits before it asks again. */
const RECORDER_POLL_MS = 3000

const WorkSchema = z.object({
  producer: ProducerSchema,
  running: z.array(z.string().uuid()).max(500),
  capacity: z.number().int().min(0).max(RECORDER_MAX_JOBS),
})

export async function POST(request: Request) {
  const config = teamCallsConfig()
  if (!config || !teamCallRecorderOn()) return notFound()
  const body = await feedRequest(request, WorkSchema)
  if (body instanceof Response) return body
  try {
    const work = body.capacity > 0 ? await recorderWork(getServiceClient(), { producerId: body.producer.id, running: body.running.map((r) => r.toLowerCase()), max: body.capacity }) : []
    const jobs = await Promise.all(work.map(async (j) => ({ ...j, token: await teamCallRecorderToken(config, j.room, body.producer.id) })))
    if (jobs.length > 0) console.info(`[team-call-recorder] producer=${body.producer.id} jobs=${jobs.map((j) => j.callId).join(',')}`)
    return NextResponse.json({ jobs, pollMs: RECORDER_POLL_MS })
  } catch (err) {
    console.error(`[team-call-recorder] producer=${body.producer.id} work failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
