/**
 * POST /api/account/seo/local/businesses/[id]/questions: read the questions
 * and answers on the tracked place's Google profile.
 *
 *   { depth?, refresh? } -> { result: GoogleBusinessQuestionsResult }
 *
 * Paid, live, kept for a day: a stored read answers for free.
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { seoErrorResponse } from '@/lib/seo/http'
import { readGoogleBusinessQuestions } from '@/lib/seo/local/business-data'
import { resolveBusinessRef } from '@/lib/seo/local/businesses'
import {
  localFailureResponse,
  optionalNumber,
  readBody,
  UUID,
} from '@/lib/seo/local/http'
import { NextResponse } from 'next/server'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Business not found')
  const body = (await readBody(request)) ?? {}
  try {
    const svc = getServiceClient()
    const resolved = await resolveBusinessRef(svc, auth.workspaceId, {
      business_id: id,
    })
    if (!resolved.ok) return notFound('Business not found')
    const out = await readGoogleBusinessQuestions(
      svc,
      { workspaceId: auth.workspaceId, userId: auth.user.id },
      resolved.ref,
      {
        depth: optionalNumber(body.depth) ?? null,
        refresh: body.refresh === true,
      },
    )
    if (!out.ok) return localFailureResponse(out)
    return NextResponse.json({ result: out.result })
  } catch (err) {
    return seoErrorResponse(err, 'google business questions')
  }
}
