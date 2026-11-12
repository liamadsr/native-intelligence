/**
 * GET /api/cron/seo-ai-visibility: the AI visibility schedule's clock (hourly,
 * vercel.json -> the server's cron container).
 *
 * Finds the trackers whose next scheduled check is due, advances each one's
 * next time with a compare-and-set (two overlapping ticks can't start one
 * due time twice), checks that the schedule may spend (the server has the
 * provider's key; the person who set the schedule up is still a member and
 * not on the free plan), then writes the check and sends the background
 * lane's event (src/lib/seo/ai-visibility/schedule.ts). A refused or skipped
 * tracker carries the reason in last_skip_reason.
 *
 * The scan is cross-workspace (this is the global scheduler); every write is
 * pinned to the tracker's own row and workspace. Fails closed on an unset
 * secret.
 */
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { runDueTrackers } from '@/lib/seo/ai-visibility/schedule'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied
  try {
    const out = await runDueTrackers(getServiceClient())
    return NextResponse.json({
      ok: true,
      due: out.due,
      started: out.started.length,
      skipped: out.skipped,
    })
  } catch (err) {
    console.error('[seo-ai] schedule tick failed', err)
    return serverError('The AI visibility schedule tick failed.')
  }
}
