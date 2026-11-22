import { NextResponse } from 'next/server'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, serverError } from '@/lib/api-errors'
import type { CompanyStage } from '@/lib/crm/company-stages'

/**
 * POST: reset the company stages to Lead, Demo, Customer, Churned
 * (reset_company_stages, migration 679): a stage named like a default keeps
 * its companies; every other stage goes and its companies move to No stage.
 * An owner or admin only (the function checks it again).
 */
export async function POST() {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  if (auth.member.role !== 'owner' && auth.member.role !== 'admin') return forbidden('Only a workspace owner or admin edits the company stages.')
  const { data, error } = await auth.supabase.rpc('reset_company_stages', { p_workspace_id: auth.workspaceId })
  if (error) return serverError(error.message)
  const stages = ((data ?? []) as Array<CompanyStage & Record<string, unknown>>).map((s) => ({ id: s.id, name: s.name, position: s.position }))
  return NextResponse.json({ stages })
}
