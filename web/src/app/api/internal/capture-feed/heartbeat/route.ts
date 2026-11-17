/**
 * POST /api/internal/capture-feed/heartbeat { producer, sessions }
 * → { sessions: [{ id, keep, reason, guests }] } the producer is running
 * these (src/lib/capture-feed/contract.ts). keep: go on (and a session the
 * sweeper had marked lost is live again), hearing every member and only the
 * meeting guests in `guests` (said go to this round's notes); keep false:
 * stop, after delivering what it still holds, then say `end` (`reason`: the
 * notes went off, the call ended, the 3-hour bound, the capture was closed,
 * the session is not this producer's, or `feed_off`: the switch was turned
 * off here).
 *
 * `health` (optional): whether each session's words are being written,
 * stamped on the row the members in the call follow (668), one log line per
 * change; a stamp that fails never fails the heartbeat.
 *
 * Server only: the feed's secret. 503 when the database can't be written.
 */
import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { HeartbeatSchema } from '@/lib/capture-feed/contract'
import { feedRequest, feedRetryLater } from '@/lib/capture-feed/route'
import { heartbeatFeeds, stampFeedHealth } from '@/lib/capture-feed/store'
import { CAPTURE_FEED_SOURCES } from '@/lib/capture-feed/sources'

export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  const body = await feedRequest(request, HeartbeatSchema)
  if (body instanceof Response) return body
  // A source kind this server takes no feeds of now (TEAM_CALL_RECORDER turned off): every session
  // stops, after delivering what it holds; the work route offers none until it is on again.
  if (!Object.values(CAPTURE_FEED_SOURCES).some((source) => source.enabled())) {
    return NextResponse.json({ sessions: body.sessions.map((id) => ({ id: id.toLowerCase(), keep: false, reason: 'feed_off', guests: [] })) })
  }
  try {
    const sessions = await heartbeatFeeds(getServiceClient(), body.producer, body.sessions.map((s) => s.toLowerCase()))
    const stopped = sessions.filter((s) => !s.keep)
    if (stopped.length > 0) console.info(`[capture-feed] producer=${body.producer.id} stop=${stopped.map((s) => `${s.id}:${s.reason ?? '-'}`).join(',')}`)
    const kept = new Set(sessions.filter((s) => s.keep).map((s) => s.id))
    const health = (body.health ?? []).map((h) => ({ id: h.id.toLowerCase(), state: h.state })).filter((h) => kept.has(h.id))
    if (health.length > 0) {
      try {
        const stamped = await stampFeedHealth(getServiceClient(), body.producer, health)
        const states = new Map(health.map((h) => [h.id, h.state]))
        for (const s of stamped) if (s.changed) console.info(`[capture-feed] producer=${body.producer.id} session=${s.sessionId} capture=${s.captureId} health=${states.get(s.sessionId) ?? '-'}`)
      } catch (err) {
        console.warn(`[capture-feed] producer=${body.producer.id} health not stamped:`, err instanceof Error ? err.message.slice(0, 160) : 'unknown')
      }
    }
    return NextResponse.json({ sessions })
  } catch (err) {
    console.error(`[capture-feed] producer=${body.producer.id} heartbeat failed:`, err instanceof Error ? err.message.slice(0, 200) : 'unknown')
    return feedRetryLater()
  }
}
