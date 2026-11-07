import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

// GET /api/account/views/favorites — Get user's favorited views
export async function GET() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { data, error } = await supabase
    .from('view_favorite')
    .select('*, view:view_id(*)')
    .eq('user_id', user.id)
    .order('sort_order', { ascending: true })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Filter to only views in this workspace
  const favorites = (data || []).filter((f) => {
    const view = f.view as unknown as { workspace_id: string } | null
    return view?.workspace_id === workspaceId
  })

  return NextResponse.json({ favorites })
}

// POST /api/account/views/favorites — Add view to favorites
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()
  const { view_id } = body

  if (!view_id) return NextResponse.json({ error: 'view_id is required' }, { status: 400 })

  // Get the max sort_order for this user
  const { data: existing } = await supabase
    .from('view_favorite')
    .select('sort_order')
    .eq('user_id', user.id)
    .order('sort_order', { ascending: false })
    .limit(1)

  const nextOrder = existing && existing.length > 0 ? (existing[0].sort_order || 0) + 1 : 0

  const { data, error } = await supabase
    .from('view_favorite')
    .insert({
      user_id: user.id,
      view_id,
      sort_order: nextOrder,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'Already favorited' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ favorite: data }, { status: 201 })
}
