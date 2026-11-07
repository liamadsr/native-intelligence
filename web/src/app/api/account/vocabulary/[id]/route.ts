import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, notFound, serverError } from '@/lib/api-errors'
import { deleteVocabularyTerm, updateVocabularyTerm } from '@/lib/vocabulary/store'

/**
 * /api/account/vocabulary/[id] — one word (migration 430).
 *
 *   PATCH { term?, sounds_like?, status?: 'active' | 'dismissed', scope? } → { term }
 *         { status: 'dismissed' } turns a word off; a harvested word that is
 *         off stays off (the harvest never revives it).
 *   DELETE → { deleted }
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return badRequest('id must be a UUID')
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send { term?, sounds_like?, status?, scope? }')

  const result = await updateVocabularyTerm(supabase, {
    workspaceId,
    userId: user.id,
    id,
    term: body.term,
    soundsLike: body.sounds_like,
    status: body.status,
    scope: body.scope,
  })
  if (!result.ok) {
    if (result.status === 400) return badRequest(result.message)
    if (result.status === 404) return notFound(result.message)
    return apiError(result.message, { status: result.status })
  }
  return NextResponse.json({ term: result.term })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params
  if (!UUID_RE.test(id)) return badRequest('id must be a UUID')
  const result = await deleteVocabularyTerm(supabase, { workspaceId, userId: user.id, id })
  if (!result.ok) return serverError(result.message)
  if (!result.deleted) return notFound('That word is not in this workspace’s vocabulary')
  return NextResponse.json({ deleted: true })
}
