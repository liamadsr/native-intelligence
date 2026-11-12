/**
 * /api/account/seo/rank/trackers/[id]/history: positions over time, from the
 * tracker's completed checks (stored results, free).
 *
 *   GET  ?keyword_id&days: one keyword's series per device the tracker
 *        checks, oldest first ({ history: RankKeywordHistory }). Without
 *        keyword_id: the tracker's totals per check per device (found, top 3
 *        / 10 / 100, average position) ({ trend: RankTrackerTrend[] }).
 *        `days` defaults to 90, at most 400.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { isUuid } from '@/lib/seo/rank/http'
import {
  getRankKeywordHistory,
  getRankTracker,
  getRankTrackerTrend,
} from '@/lib/seo/rank/queries'
import { NextResponse, type NextRequest } from 'next/server'

type Ctx = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Ctx) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Tracker not found')
  const search = new URL(request.url).searchParams
  const keywordId = search.get('keyword_id')
  if (keywordId !== null && !isUuid(keywordId))
    return notFound('Keyword not found')
  const daysRaw = Number(search.get('days'))
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined
  try {
    const svc = getServiceClient()
    const tracker = await getRankTracker(svc, auth.workspaceId, id)
    if (!tracker) return notFound('Tracker not found')
    if (keywordId) {
      const history = await getRankKeywordHistory(
        svc,
        auth.workspaceId,
        tracker,
        keywordId,
        { days },
      )
      if (!history) return notFound('Keyword not found')
      return NextResponse.json({ history })
    }
    return NextResponse.json({
      trend: await getRankTrackerTrend(svc, tracker, { days }),
    })
  } catch (err) {
    console.error('[seo-rank] history failed', err)
    return serverError('Could not load the history just now.')
  }
}
