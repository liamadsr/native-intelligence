/**
 * GET /api/cron/studio-sweep — hourly housekeeping of the Studio's files and
 * jobs (src/lib/studio/server/sweep.ts): upload links never committed and
 * uploads no job will use (24 h), the agent's frames (7 days), exports (30
 * days; the job row keeps saying it was exported, and its link answers 404
 * with why) and finished job rows (90 days). The library, videos and
 * thumbnails are never touched.
 *
 * Bounded (SWEEP_LIMIT objects a run) and idempotent: whatever one run leaves
 * the next takes.
 *
 * A server whose database has no Studio yet answers 200 {skipped: 'not set up'}.
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { StudioError } from '@/lib/studio/server/errors'
import { sweepStudio } from '@/lib/studio/server/sweep'

export const runtime = 'nodejs'
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    const removed = await sweepStudio(getServiceClient())
    return NextResponse.json({ ok: true, removed })
  } catch (e) {
    // A server without the Studio's tables yet: nothing to sweep, and nothing wrong.
    if (e instanceof StudioError && e.code === 'STUDIO_NOT_SET_UP') return NextResponse.json({ skipped: 'not set up' })
    console.error('[studio-sweep] failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ ok: false, error: 'The Studio sweep failed. The next run tries again.' }, { status: 500 })
  }
}
