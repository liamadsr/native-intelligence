import { createClient } from '@/lib/supabase/server'
import { requireWorkspaceFeature } from '@/lib/api-auth'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { executeView } from '@/lib/views/query-engine'
import type { View, ViewFilter } from '@/lib/views/types'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/account/views/[id]/results — Execute view query and return results
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  // Get the view config
  const { data: view, error: viewError } = await supabase
    .from('view')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (viewError || !view) {
    return NextResponse.json({ error: 'View not found' }, { status: 404 })
  }

  // Evals is a hidden, per-workspace feature and every other route in its REST
  // surface is gated — including /api/account/views/query. A saved view
  // outlives the toggle, so without this check executing one by id would be the
  // one way left to list a workspace's suites, cases or runs with Evals off.
  if (String((view as View).entity_type).startsWith('eval_')) {
    const gated = await requireWorkspaceFeature({ supabase, user, workspaceId }, 'evals')
    if (gated) return gated
  }

  const { searchParams } = request.nextUrl
  const page = parseInt(searchParams.get('page') || '1', 10)
  const perPage = Math.min(parseInt(searchParams.get('per_page') || '50', 10), 200)

  let overrideFilters: ViewFilter[] = []
  const overrideParam = searchParams.get('override_filters')
  if (overrideParam) {
    try {
      overrideFilters = JSON.parse(overrideParam)
    } catch {
      // ignore malformed override
    }
  }

  try {
    // Resolve member ID for action scoping
    let memberId: string | undefined
    if ((view as View).entity_type === 'action') {
      const { data: member } = await supabase
        .from('member')
        .select('id')
        .eq('user_id', user.id)
        .eq('workspace_id', workspaceId)
        .single()
      memberId = member?.id
    }

    const result = await executeView(supabase, view as View, user.id, {
      page,
      per_page: perPage,
      override_filters: overrideFilters,
      queryOptions: { memberId },
    })
    return NextResponse.json(result)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Query execution failed'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
