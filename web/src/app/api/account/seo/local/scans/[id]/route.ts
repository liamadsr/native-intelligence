/**
 * /api/account/seo/local/scans/[id]: one local rank scan.
 *
 *   GET   { result: LocalScanResult }: the scan, per keyword a square of
 *         cells (north row first) with the place's position at each, the
 *         summary numbers, and the competitors seen most. Free. Poll it
 *         while status is queued or running.
 *   POST  stop a queued or running scan ({ scan: LocalScanView }). Points it
 *         already read stay. 409 NOT_RUNNING when it already ended.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { localFailureResponse, UUID } from '@/lib/seo/local/http'
import { cancelLocalScan, getLocalScanResult } from '@/lib/seo/local/scans'
import { NextResponse } from 'next/server'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Scan not found')
  try {
    const result = await getLocalScanResult(
      getServiceClient(),
      auth.workspaceId,
      id,
    )
    if (!result) return notFound('Scan not found')
    return NextResponse.json({ result })
  } catch (err) {
    console.error('[seo-local] scan read failed', err)
    return serverError('Could not load the scan just now.')
  }
}

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Scan not found')
  try {
    const out = await cancelLocalScan(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ scan: out.scan })
  } catch (err) {
    console.error('[seo-local] scan cancel failed', err)
    return serverError('Could not stop the scan just now.')
  }
}
