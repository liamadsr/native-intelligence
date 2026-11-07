import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { purgeOldEvents } from '@/lib/local-agent/retention'

export const maxDuration = 60

/**
 * GET /api/cron/local-agent-purge — daily: a local agent's transcript goes 30
 * days after the job's last activity (docs/plans/local-agents.md §6). The
 * rule, its bounds and what it never touches are in
 * src/lib/local-agent/retention.ts.
 *
 * Schedule: daily via Vercel cron at 03:40 UTC (vercel.json), GET with
 * `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const r = await purgeOldEvents(getServiceClient())
  console.info(
    `[local-agent-purge] deleted=${r.eventsDeleted} sessions=${r.sessionsPurged} kept=${r.sessionsKept} truncated=${r.truncated} ok=${r.ok}`,
  )
  return NextResponse.json(r, { status: r.ok ? 200 : 500 })
}
