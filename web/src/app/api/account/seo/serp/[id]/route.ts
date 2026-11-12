/**
 * GET /api/account/seo/serp/[id]: a stored SERP check (id = its lookup_id),
 * with each read still out checked once more. Free: the reads were paid for
 * when the check was bought. Poll this every few seconds while `status` is
 * partial or collecting. 404 when it is not this workspace's SERP check (or
 * it was dropped because every read came back empty).
 */
import { getServiceClient } from '@/lib/admin'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { notFound } from '@/lib/api-errors'
import { collectSerpLookup } from '@/lib/seo/keywords/serp'
import { seoFailureResponse } from '@/lib/seo/paid'
import { NextResponse } from 'next/server'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!UUID.test(id)) return notFound('Search not found')
  try {
    const result = await collectSerpLookup(
      getServiceClient(),
      auth.workspaceId,
      id,
    )
    if (!result) return notFound('Search not found')
    return NextResponse.json(result)
  } catch (err) {
    return seoFailureResponse(err, 'serp collect')
  }
}
