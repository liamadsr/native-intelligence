/**
 * GET /api/account/seo/ai-visibility/[id]/trend?days=7|30|90: whether the
 * brand shows up more or less in AI answers: the latest N days against the N
 * days before, over neutral prompts of completed checks, with a point per
 * check (AiTrend). Read `comparison` before showing a change: only
 * `comparable` carries one. Free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { UUID } from '@/lib/seo/ai-visibility/http'
import { DEFAULT_TREND_DAYS, TREND_DAYS } from '@/lib/seo/ai-visibility/limits'
import { getTrend } from '@/lib/seo/ai-visibility/queries'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Tracker not found')
  const asked = Number(
    request.nextUrl.searchParams.get('days') ?? DEFAULT_TREND_DAYS,
  )
  const days = (TREND_DAYS as readonly number[]).includes(asked)
    ? asked
    : DEFAULT_TREND_DAYS
  try {
    const trend = await getTrend(getServiceClient(), auth.workspaceId, id, days)
    if (!trend) return notFound('Tracker not found')
    return NextResponse.json({ trend })
  } catch (err) {
    console.error('[seo-ai] trend read failed', err)
    return serverError('Could not load the trend just now.')
  }
}
