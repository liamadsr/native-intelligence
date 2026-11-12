/**
 * /api/account/seo/ai-visibility/runs/[id]: one check.
 *
 *   GET   ?scope=neutral|branded|all&offset=  the check's results
 *         (AiRunResults): coverage, the brand by engine and by prompt, the
 *         brand against its competitors, the gaps, and a page of answers.
 *         While the check is live, read it again after
 *         run.poll_after_seconds. Free.
 *   POST  stop it (a queued or running check). Answers already collected
 *         stay; the rest are not bought.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { aiFailureResponse, UUID } from '@/lib/seo/ai-visibility/http'
import { getRunResults } from '@/lib/seo/ai-visibility/queries'
import { cancelRun } from '@/lib/seo/ai-visibility/runs'
import type { AiPromptScope } from '@/lib/seo/ai-visibility/view'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Check not found')
  const search = request.nextUrl.searchParams
  const scopeParam = search.get('scope')
  const scope: AiPromptScope =
    scopeParam === 'branded' || scopeParam === 'all' ? scopeParam : 'neutral'
  const offset = Number(search.get('offset') ?? 0)
  try {
    const results = await getRunResults(
      getServiceClient(),
      auth.workspaceId,
      id,
      { scope, offset: Number.isFinite(offset) ? offset : 0 },
    )
    if (!results) return notFound('Check not found')
    return NextResponse.json({ results })
  } catch (err) {
    console.error('[seo-ai] results read failed', err)
    return serverError('Could not load the check just now.')
  }
}

export async function POST(_request: Request, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Check not found')
  try {
    const out = await cancelRun(
      getServiceClient(),
      { workspaceId: auth.workspaceId },
      id,
    )
    if (!out.ok) return aiFailureResponse(out)
    return NextResponse.json({ run: out.run })
  } catch (err) {
    console.error('[seo-ai] cancel check failed', err)
    return serverError('Could not stop the check just now.')
  }
}
