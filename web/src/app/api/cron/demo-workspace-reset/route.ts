import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireCronSecret } from '@/lib/api-auth'
import { listDemoWorkspaces, resetDemoWorkspace, type DemoResetReport } from '@/lib/demo/reset'

/**
 * GET /api/cron/demo-workspace-reset: nightly, every workspace flagged as a
 * demo (migration 667) is put back: what visitors added goes, the made-up
 * Fernhill Studio content is written again, members stay
 * (src/lib/demo/reset.ts, which refuses any workspace that is not flagged).
 *
 * A job, not a button: a demo that is only clean when somebody remembers to
 * clean it is not clean. The admin route (/api/admin/demo-workspace/reset)
 * runs the same reset on demand, before a visit.
 *
 * With no flagged workspace this reads one empty table and does nothing.
 *
 * Schedule: daily from the server's cron at 09:40 UTC (vercel.json), after
 * the servers' 08:37 UTC restart and in the small hours of the Americas. GET
 * with `Authorization: Bearer ${CRON_SECRET}`.
 */
export const maxDuration = 300

export async function GET(request: NextRequest) {
  const denied = requireCronSecret(request)
  if (denied) return denied

  const service = getServiceClient()
  let ids: string[]
  try {
    ids = await listDemoWorkspaces(service)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[demo-workspace-reset] list failed:', message)
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }

  const reports: DemoResetReport[] = []
  const errors: Record<string, string> = {}
  for (const id of ids) {
    try {
      const report = await resetDemoWorkspace(service, id)
      reports.push(report)
      console.info(
        `[demo-workspace-reset] ${id}: seeded=${report.seeded} members=${report.members} cleared=${JSON.stringify(report.cleared)}` +
          (Object.keys(report.failed).length ? ` failed=${JSON.stringify(report.failed)}` : '') +
          (report.seedError ? ` seedError=${report.seedError}` : ''),
      )
    } catch (err) {
      errors[id] = err instanceof Error ? err.message : String(err)
      console.error(`[demo-workspace-reset] ${id} failed:`, errors[id])
    }
  }
  const ok = Object.keys(errors).length === 0 && reports.every((r) => r.seeded)
  return NextResponse.json({ ok, reports, errors }, { status: ok ? 200 : 500 })
}
