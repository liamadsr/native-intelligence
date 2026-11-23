import { type NextRequest, NextResponse } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest } from '@/lib/api-errors'
import { deleteSnippet, updateSnippet } from '@/lib/snippets/store'

/**
 * /api/account/snippets/[id] (migration 699, docs/plans/snippets.md).
 *
 *   PATCH  { name?, shortcut?, body?, visibility? } → { snippet }
 *   DELETE → { deleted: true }
 *
 * Its maker; a shared one also the workspace's owner or an admin. Only its
 * maker changes who sees it.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return badRequest('Not a snippet id.')
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body !== 'object') return badRequest('Send the change as JSON.')
  const r = await updateSnippet(supabase, { workspaceId, userId: user.id }, id, body)
  if (!r.ok) return apiError(r.error, { status: r.status })
  return NextResponse.json({ snippet: r.value })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  if (!UUID.test(id)) return badRequest('Not a snippet id.')
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const r = await deleteSnippet(supabase, { workspaceId, userId: user.id }, id)
  if (!r.ok) return apiError(r.error, { status: r.status })
  return NextResponse.json(r.value)
}
