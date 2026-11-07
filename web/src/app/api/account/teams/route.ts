import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET() {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { data, error } = await supabase
    .from('team')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: true })

  if (error) return serverError(error.message)

  // Fetch member counts separately — humans + AI team members.
  const teamIds = (data || []).map((t) => t.id)
  const countMap: Record<string, number> = {}
  const aiCountMap: Record<string, number> = {}

  if (teamIds.length > 0) {
    const [{ data: counts }, { data: aiCounts }] = await Promise.all([
      supabase.from('team_member').select('team_id').in('team_id', teamIds),
      supabase.from('ai_team_member').select('team_id').in('team_id', teamIds),
    ])

    if (counts) {
      for (const row of counts) {
        countMap[row.team_id] = (countMap[row.team_id] || 0) + 1
      }
    }
    if (aiCounts) {
      for (const row of aiCounts) {
        aiCountMap[row.team_id] = (aiCountMap[row.team_id] || 0) + 1
      }
    }
  }

  const teams = (data || []).map((t) => ({
    ...t,
    member_count: countMap[t.id] || 0,
    ai_member_count: aiCountMap[t.id] || 0,
  }))

  return NextResponse.json({ teams })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const body = await request.json()
  const name = (body.name || '').trim()
  if (!name) return badRequest('Name is required')

  const slug = (body.slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')).trim()
  const issue_prefix = (body.issue_prefix || name.slice(0, 3).toUpperCase()).trim()
  const color = body.color || '#6366f1'

  const { data, error } = await supabase
    .from('team')
    .insert({
      workspace_id: workspaceId,
      name,
      slug,
      issue_prefix,
      color,
      ...(body.is_private ? { is_private: true } : {}),
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      const msg = error.message.includes('issue_prefix')
        ? 'A team with that issue prefix already exists'
        : 'A team with that slug already exists'
      return apiError(msg, { status: 409, code: 'CONFLICT' })
    }
    return serverError(error.message)
  }

  // Creator is auto-added as team lead via database trigger (handle_new_team_creator)

  return NextResponse.json({ team: data })
}
