/**
 * /api/cron/prospecting-watchdog — every five minutes (vercel.json).
 *
 * Settles prospecting runs whose engine went silent, so a run never sits at
 * "Finding companies…" or "Cancelling…" forever. The whole decision lives in
 * `src/lib/prospecting/watchdog.ts`; this is the schedule and the auth.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { getServiceClient } from '@/lib/admin'
import { sweepStaleRuns } from '@/lib/prospecting/watchdog'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    const result = await sweepStaleRuns(getServiceClient(), new Date())
    if (result.stale > 0) console.warn('[prospecting-watchdog] settled stale runs:', result)
    return NextResponse.json({ ok: true, ...result })
  } catch (err) {
    console.error('[prospecting-watchdog] sweep failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'watchdog failed' },
      { status: 500 },
    )
  }
}
