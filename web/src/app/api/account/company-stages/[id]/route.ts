import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { cleanStageName, isUuid, listCompanyStages } from '@/lib/crm/company-stages'

/**
 * One company stage (migration 679), an owner or admin only.
 * PATCH { name }: rename. DELETE: remove it; its companies move to No stage
 * (the foreign key sets null), and the answer says how many moved.
 */
async function requireAdmin() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role !== 'owner' && auth.member.role !== 'admin') return forbidden('Only a workspace owner or admin edits the company stages.')
  return auth
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Stage not found')
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const name = cleanStageName(body?.name)
  if (!name.ok) return badRequest(name.error)
  const stages = await listCompanyStages(auth.supabase, auth.workspaceId)
  if (!stages.some((s) => s.id === id)) return notFound('Stage not found')
  if (stages.some((s) => s.id !== id && s.name.toLowerCase() === name.name.toLowerCase())) return badRequest('There is a stage with that name already.')
  const { data, error } = await auth.supabase
    .from('company_stage')
    .update({ name: name.name, updated_at: new Date().toISOString() })
    .eq('id', id)
    .eq('workspace_id', auth.workspaceId)
    .select('id, name, position')
    .single()
  if (error) return serverError(error.message)
  return NextResponse.json({ stage: data })
}

export async function DELETE(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireAdmin()
  if (auth instanceof Response) return auth
  const { id } = await params
  if (!isUuid(id)) return notFound('Stage not found')
  const { count } = await auth.supabase
    .from('company')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', auth.workspaceId)
    .eq('stage_id', id)
  const { data, error } = await auth.supabase
    .from('company_stage')
    .delete()
    .eq('id', id)
    .eq('workspace_id', auth.workspaceId)
    .select('id')
  if (error) return serverError(error.message)
  if (!data?.length) return notFound('Stage not found')
  return NextResponse.json({ deleted: true, companies_moved: count ?? 0 })
}
