/**
 * GET /api/cron/email-scheduled-send, every 5 minutes: send later's sweep
 * (src/lib/email/scheduled-send.ts). Each due row the timed Inngest event
 * missed is sent, oldest first, one at a time, through the same
 * 'scheduled' → 'sending' claim (so never twice); a row cut off mid-send long
 * ago is failed, never sent again.
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { sweepScheduledSends } from '@/lib/email/scheduled-send'

export const maxDuration = 60

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    const counts = await sweepScheduledSends()
    return NextResponse.json({ ok: true, ...counts })
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
