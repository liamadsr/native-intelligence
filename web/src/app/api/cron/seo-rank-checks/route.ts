import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { runScheduledRankChecksNow } from '@/lib/seo/rank/schedule'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 300

/**
 * GET /api/cron/seo-rank-checks: the rank trackers' clock (every 15 minutes,
 * vercel.json, and the server's crontab generated from it). Like
 * /api/cron/flow-schedule, the tick is this cron and not an Inngest cron,
 * whose registration has silently failed before.
 *
 * One pass (src/lib/seo/rank/schedule.ts): every tracker whose next check is
 * due, oldest first, is asked through the schedule's gate (the server has
 * search data, the tracker isn't paused, the person who set it up is still a
 * member and not on the free plan), its next_check_at advanced with a
 * compare-and-set so two overlapping ticks can't start the same check, and
 * its run written and sent to the background lane. The checks spend against
 * each workspace's monthly ceiling.
 *
 * The due scan is cross-workspace (this is the global scheduler); every write
 * is pinned to the tracker's own workspace_id.
 *
 * Cron callers send `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  // Fails closed on an unset secret: this pass starts paid checks.
  const denied = requireCronSecret(request)
  if (denied) return denied
  try {
    const summary = await runScheduledRankChecksNow(getServiceClient())
    const log =
      summary.errors + summary.unreadable > 0 ? console.error : console.log
    log('[seo-rank cron] tick', summary)
    return NextResponse.json({ ok: true, ...summary })
  } catch (err) {
    console.error('[seo-rank cron] tick failed', err)
    return NextResponse.json(
      { ok: false, error: 'tick failed' },
      { status: 500 },
    )
  }
}
