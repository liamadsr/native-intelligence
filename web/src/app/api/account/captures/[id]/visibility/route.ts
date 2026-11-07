import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const VISIBILITY_VALUES = ['workspace', 'private'] as const

/**
 * PATCH /api/account/captures/[id]/visibility
 *
 * Scope changes live on their own route because the general capture PATCH is
 * workspace-scoped by design (teammates edit each other's metadata), whereas
 * flipping a capture to "Only me" is creator-only. The creator check here is
 * EXPLICIT rather than left to RLS so a non-creator gets a truthful 403 instead
 * of a silent zero-row update.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params
  const body = await request.json()
  const { visibility } = body as { visibility?: string }

  if (!visibility || !VISIBILITY_VALUES.includes(visibility as typeof VISIBILITY_VALUES[number])) {
    return badRequest('visibility must be workspace or private')
  }

  const { data: capture, error: fetchError } = await supabase
    .from('captures')
    .select('id, user_id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()

  if (fetchError) return serverError(fetchError.message)
  if (!capture) return notFound('Capture not found')
  if (capture.user_id !== user.id) {
    return forbidden('Only the capture creator can change its visibility')
  }

  const { data, error } = await supabase
    .from('captures')
    .update({ visibility })
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .eq('user_id', user.id)
    .select('id, visibility')
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({ capture: data })
}
