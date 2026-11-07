/**
 * GET /api/cron/cloud-browser-idle — stop cloud browsers nobody is using.
 *
 * Each person's agent browser is a persistent Vercel Sandbox (cloud_browser,
 * migration 421; docs/plans/cloud-browser.md C0). A running one costs memory and
 * CPU time; a stopped one costs only its snapshot. This cron stops, gracefully
 * (Chrome closed first, then the session's snapshot), every browser that is idle
 * past CLOUD_BROWSER.idleStopMs, near the platform's session cap (a timeout stop
 * would lose recent cookie writes), stuck starting, or stuck stopping. Each stop
 * is claimed with a compare-and-set, so a browser an agent just woke is left
 * alone. The next use resumes it.
 *
 * The server stops browsers, not the VM itself: a stop from inside the sandbox
 * would need a Vercel credential there, and the VM holds none.
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { sweepIdleCloudBrowsers } from '@/lib/cloud-browser/host'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    return NextResponse.json({ ok: true, ...(await sweepIdleCloudBrowsers()) })
  } catch (e) {
    return serverError('Cloud browser idle sweep failed', e instanceof Error ? e.message : String(e))
  }
}
