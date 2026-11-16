import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { runPageWatchPass } from '@/lib/flows/page-watch/tick'

// A pass reads at most 100 pages, ten at a time, each within the fetcher's
// 10 s plus one short decision. On our own server nothing ends a route at
// maxDuration (`next start` ignores it, and the cron's caller waits up to 15
// minutes: deploy/app/README.md "Cron"); it stays for the earlier host. A pass
// that runs past the next tick is safe: each loop is claimed by a
// compare-and-set on its next_run_at, so a page is read by one pass only.
export const maxDuration = 60

/**
 * GET /api/cron/page-watch: the page watch pass (every 5 minutes,
 * vercel.json, run by the server's cron container). Each due page_changed
 * loop's page is read with no model call and compared with its last read;
 * only new lines are put to Jev, and only lines that matter fire the loop
 * (src/lib/flows/page-watch/tick.ts says how, and how nothing is lost).
 *
 * The scan is cross-workspace, as the schedule pass's is (this is a global
 * clock); every write is pinned to the loop's own workspace. The pass never
 * throws: what it did comes back as counts.
 *
 * The server's cron issues GET with `Authorization: Bearer ${CRON_SECRET}`.
 */
export async function GET(request: NextRequest) {
  // Fails CLOSED on an unset secret (see requireCronSecret): this pass writes and fetches.
  const denied = requireCronSecret(request)
  if (denied) return denied

  const result = await runPageWatchPass(getServiceClient(), new Date())
  return NextResponse.json({ ok: true, ...result })
}
