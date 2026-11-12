/**
 * /api/account/seo/rank/runs/[id]: one rank check.
 *
 *   GET   the check: status, counts, estimate and real cost, and why it
 *         failed or which keywords got no result. The page polls this while
 *         it is queued or running.
 *   POST  stop a queued or running check. Searches already bought stay
 *         paid for; a stopped check's partial results don't count as a
 *         check. 409 NOT_RUNNING when it already ended.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid, rankFailureResponse } from '@/lib/seo/rank/http'
import { getRankRun } from '@/lib/seo/rank/queries'
import { cancelRankCheck } from '@/lib/seo/rank/runs'
import { NextResponse } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Check not found')
  try {
    const run = await getRankRun(getServiceClient(), auth.workspaceId, id)
    if (!run) return notFound('Check not found')
    return NextResponse.json({ run })
  } catch (err) {
    console.error('[seo-rank] run read failed', err)
    return serverError('Could not load the check just now.')
  }
}

export async function POST(_request: Request, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Check not found')
  try {
    const out = await cancelRankCheck(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    return out.ok
      ? NextResponse.json({ run: out.run })
      : rankFailureResponse(out)
  } catch (err) {
    console.error('[seo-rank] cancel failed', err)
    return serverError('Could not stop the check just now.')
  }
}
