import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'

/**
 * Look up a skill by its slash-command slug. Workspace items take
 * precedence over system items with the same slug.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { slug } = await params

  const { data, error } = await supabase
    .from('recipe')
    .select('id, name, slug, icon, color, description, system_prompt, agent_config, category, is_system, sort_order, created_at')
    .eq('slug', slug)
    .eq('category', 'skill')
    .or(`workspace_id.eq.${workspaceId},workspace_id.is.null`)
    .order('workspace_id', { ascending: false, nullsFirst: false })
    .limit(1)

  if (error) return serverError(error.message)
  if (!data || data.length === 0) return notFound('Skill not found')

  return NextResponse.json({ skill: data[0] })
}
