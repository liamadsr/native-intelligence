import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function GET(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getAdminServiceClient()
  const { searchParams } = new URL(request.url)
  const status = searchParams.get('status')
  const limit = parseInt(searchParams.get('limit') ?? '100', 10)
  const sort = searchParams.get('sort') ?? 'vote_count'

  let query = supabase
    .from('feature_requests')
    .select('*, feature_request_comments(count), feature_request_votes(count)')
    .order(sort === 'newest' ? 'created_at' : 'vote_count', { ascending: false })
    .limit(limit)

  if (status) query = query.eq('status', status)

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Fetch user emails
  const userIds = [...new Set((data ?? []).map((r) => r.user_id))]
  const usersMap: Record<string, string> = {}
  for (const uid of userIds) {
    const { data: userData } = await supabase.auth.admin.getUserById(uid)
    if (userData?.user?.email) {
      usersMap[uid] = userData.user.email
    }
  }

  const enriched = (data ?? []).map((r) => ({
    ...r,
    user_email: usersMap[r.user_id] ?? null,
  }))

  return NextResponse.json({ feature_requests: enriched })
}

// Admin can update status of feature requests (planned, in_progress, completed, declined)
export async function PATCH(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { id, status } = body as { id: string; status: string }

  if (!id || !status) {
    return NextResponse.json({ error: 'id and status are required' }, { status: 400 })
  }

  const validStatuses = ['open', 'planned', 'in_progress', 'completed', 'declined']
  if (!validStatuses.includes(status)) {
    return NextResponse.json(
      { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('feature_requests')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ feature_request: data })
}
