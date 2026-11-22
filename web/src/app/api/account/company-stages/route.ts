import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import { cleanStageName, isUuid, listCompanyStages, MAX_COMPANY_STAGES } from '@/lib/crm/company-stages'

/**
 * The workspace's company stages (migration 679).
 * GET: the stages in order (any member).
 * POST { name }: add one at the end (an owner or admin).
 * PUT { order: [id, ...] }: reorder (an owner or admin).
 * Who may write is the database's call too (company_stage's policies).
 */
export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  try {
    return NextResponse.json({ stages: await listCompanyStages(auth.supabase, auth.workspaceId) })
  } catch (e) {
    return serverError(e instanceof Error ? e.message : 'Could not load the stages')
  }
}

async function requireAdmin() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role !== 'owner' && auth.member.role !== 'admin') return forbidden('Only a workspace owner or admin edits the company stages.')
  return auth
}

export async function POST(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { name?: unknown } | null
  const name = cleanStageName(body?.name)
  if (!name.ok) return badRequest(name.error)
  const stages = await listCompanyStages(auth.supabase, auth.workspaceId)
  if (stages.length >= MAX_COMPANY_STAGES) return badRequest(`A workspace has at most ${MAX_COMPANY_STAGES} stages.`)
  if (stages.some((s) => s.name.toLowerCase() === name.name.toLowerCase())) return badRequest('There is a stage with that name already.')
  const position = stages.reduce((m, s) => Math.max(m, s.position), -1) + 1
  const { data, error } = await auth.supabase
    .from('company_stage')
    .insert({ workspace_id: auth.workspaceId, name: name.name, position })
    .select('id, name, position')
    .single()
  if (error) return serverError(error.message)
  return NextResponse.json({ stage: data }, { status: 201 })
}

export async function PUT(request: NextRequest) {
  const auth = await requireAdmin()
  if (auth instanceof Response) return auth
  const body = (await request.json().catch(() => null)) as { order?: unknown } | null
  const order = Array.isArray(body?.order) ? body!.order.filter(isUuid) : null
  if (!order?.length) return badRequest('Send the stages in their new order.')
  const stages = await listCompanyStages(auth.supabase, auth.workspaceId)
  const known = new Set(stages.map((s) => s.id))
  if (order.length !== stages.length || order.some((id) => !known.has(id))) return badRequest('Send every stage, once.')
  for (const [position, id] of order.entries()) {
    const { error } = await auth.supabase
      .from('company_stage')
      .update({ position, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('workspace_id', auth.workspaceId)
    if (error) return serverError(error.message)
  }
  return NextResponse.json({ stages: await listCompanyStages(auth.supabase, auth.workspaceId) })
}
