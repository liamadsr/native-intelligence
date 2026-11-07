/**
 * GET /api/cron/cloud-browser-reconcile — delete cloud browsers nobody owns.
 *
 * A browser's row (cloud_browser, migration 421) can go while its sandbox stays:
 * a workspace merge or deletion cascades the row away, and a delete can fail
 * half-way. The sandbox and its snapshots hold that person's cookies, so once a
 * day every browser sandbox of THIS database (its name prefix: DEV and PROD
 * share the Vercel project's sandboxes) with no row is deleted, snapshots and
 * all (docs/plans/cloud-browser.md, Cross-cutting).
 *
 * Mandated cron pattern: vercel.json cron → this route (see cron/prospecting-prune).
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireCronSecret } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'
import { reconcileCloudBrowsers } from '@/lib/cloud-browser/host'

export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  try {
    return NextResponse.json({ ok: true, ...(await reconcileCloudBrowsers()) })
  } catch (e) {
    return serverError('Cloud browser reconcile failed', e instanceof Error ? e.message : String(e))
  }
}
