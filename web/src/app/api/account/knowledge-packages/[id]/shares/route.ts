import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'

/**
 * Individual/team grants on a knowledge package (migration 127).
 *
 *   GET    → list shares with member/team display names
 *   POST   {member_id | team_id, access_level?} → grant
 *   DELETE ?share_id=...                        → revoke
 *
 * RLS: anyone in the workspace can read shares; only the package creator or
 * a workspace admin/owner can grant/revoke (an insert/delete the caller isn't
 * entitled to matches zero rows / fails the policy).
 */

type RouteContext = { params: Promise<{ id: string }> }

export async function GET(_request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const { data, error } = await supabase
    .from('knowledge_package_share')
    .select(
      'id, access_level, created_at, member:member!shared_with_member_id(id, display_name), team:team!shared_with_team_id(id, name)',
    )
    .eq('package_id', id)
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })
  if (error) return serverError(error.message)
  return Response.json({ shares: data ?? [] })
}

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const body = await request.json().catch(() => null)
  if (!body || typeof body !== 'object') return badRequest('Invalid body')
  const memberId = typeof body.member_id === 'string' ? body.member_id : null
  const teamId = typeof body.team_id === 'string' ? body.team_id : null
  if (!memberId === !teamId) {
    return badRequest('Provide exactly one of member_id or team_id')
  }
  const accessLevel = body.access_level === 'edit' ? 'edit' : 'view'

  const { data, error } = await supabase
    .from('knowledge_package_share')
    .insert({
      package_id: id,
      workspace_id: workspaceId,
      shared_with_member_id: memberId,
      shared_with_team_id: teamId,
      access_level: accessLevel,
      created_by: user.id,
    })
    .select('id, access_level')
    .maybeSingle()
  if (error) {
    if (error.code === '23505') return badRequest('Already shared with this member/team')
    return serverError(error.message)
  }
  if (!data) return notFound('Package not found or not shareable by you')
  return Response.json({ share: data }, { status: 201 })
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const shareId = new URL(request.url).searchParams.get('share_id')
  if (!shareId) return badRequest('share_id query param is required')

  const { error, count } = await supabase
    .from('knowledge_package_share')
    .delete({ count: 'exact' })
    .eq('id', shareId)
    .eq('package_id', id)
    .eq('workspace_id', workspaceId)
  if (error) return serverError(error.message)
  if (!count) return notFound('Share not found or not revocable')
  return Response.json({ ok: true })
}
