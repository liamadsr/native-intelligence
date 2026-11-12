/**
 * /api/account/seo/local/grids/[id]/scans: a grid's scans.
 *
 *   GET   { scans: LocalScanView[] }: newest first (the last 20). Free.
 *   POST  { confirmed?, max_estimate_usd? }: start a scan
 *         ({ scan: LocalScanView }, 202). Paid: one Google Maps search per
 *         point per keyword, metered against the workspace's monthly ceiling
 *         in this person's name.
 *           - A scan estimated above CONFIRM_ABOVE_USD needs `confirmed: true`
 *             (the person saw the cost and said yes). Without it: 409
 *             CONFIRMATION_REQUIRED, details { estimate_usd, estimate:
 *             LocalScanEstimate }, and nothing is started or written.
 *           - Pass the estimate the page showed as max_estimate_usd: a grid
 *             that now costs more is refused (409 ESTIMATE_CHANGED, details
 *             { estimate_usd, estimate }) instead of started.
 *           - Then the access check (403 or 503 with its code).
 *           - 409 SCAN_ALREADY_RUNNING (details { scan }) while one runs.
 *         The scan runs in the background; poll the grid or the scan.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import {
  localFailureResponse,
  optionalNumber,
  readBody,
  UUID,
} from '@/lib/seo/local/http'
import { getGrid, listScans } from '@/lib/seo/local/queries'
import { startLocalScan } from '@/lib/seo/local/scans'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Grid not found')
  try {
    const svc = getServiceClient()
    if (!(await getGrid(svc, auth.workspaceId, id)))
      return notFound('Grid not found')
    return NextResponse.json({
      scans: await listScans(svc, auth.workspaceId, id),
    })
  } catch (err) {
    console.error('[seo-local] scans list failed', err)
    return serverError('Could not load the scans just now.')
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Grid not found')
  const body = (await readBody(request)) ?? {}
  try {
    const out = await startLocalScan(
      getServiceClient(),
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      id,
      {
        confirmed: body.confirmed === true,
        maxEstimateUsd: optionalNumber(body.max_estimate_usd) ?? null,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ scan: out.scan }, { status: 202 })
  } catch (err) {
    console.error('[seo-local] scan start failed', err)
    return serverError('Could not start the scan just now.')
  }
}
