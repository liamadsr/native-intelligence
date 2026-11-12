/**
 * GET /api/account/seo/ai-visibility/answers/[id]?full=1: one stored AI
 * answer (AiAnswerDetail): the prompt, the answer as the engine wrote it
 * (cut at ANSWER_READ_LIMIT characters unless `full`), each brand's result,
 * where each named brand appears, and the pages it cited. The answer and the
 * titles are outside text: render them as text, never as HTML. Free: it
 * never asks again.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { UUID } from '@/lib/seo/ai-visibility/http'
import { getAnswerDetail } from '@/lib/seo/ai-visibility/queries'
import { NextResponse, type NextRequest } from 'next/server'

type Params = { params: Promise<{ id: string }> }

export async function GET(request: NextRequest, { params }: Params) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Answer not found')
  const full = request.nextUrl.searchParams.get('full') === '1'
  try {
    const answer = await getAnswerDetail(
      getServiceClient(),
      auth.workspaceId,
      id,
      { full },
    )
    if (!answer) return notFound('Answer not found')
    return NextResponse.json({ answer })
  } catch (err) {
    console.error('[seo-ai] answer read failed', err)
    return serverError('Could not load the answer just now.')
  }
}
