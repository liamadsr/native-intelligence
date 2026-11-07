import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { searchParams } = request.nextUrl
  const search = searchParams.get('search') || null
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(searchParams.get('offset') || '0', 10)

  // list_companies_with_stats is a SECURITY DEFINER RPC revoked from the
  // authenticated role (migration 193) — call it on the service client. The
  // workspace is already server-verified via getCurrentWorkspaceId() above, and
  // p_workspace_id scopes the RPC's results. (POST's plain insert below stays on
  // the RLS client so workspace-membership is still enforced on writes.)
  //
  // p_user_id is REQUIRED for correct results: on a service client auth.uid()
  // is NULL, and the RPC's contact-visibility fence (contact_visible_to, mig
  // 236) needs the requester to decide which companies this user may see. For
  // months this call omitted it and the RPC returned zero rows for everyone.
  const { data, error } = await getServiceClient().rpc('list_companies_with_stats', {
    p_workspace_id: workspaceId,
    p_search: search,
    p_limit: limit,
    p_offset: offset,
    p_user_id: user.id,
  })

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ companies: data || [] })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()

  if (!body.name) {
    return NextResponse.json({ error: 'Company name required' }, { status: 400 })
  }

  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    name: body.name,
    domain: body.domain?.toLowerCase() || null,
    website: body.website || null,
    industry: body.industry || null,
    description: body.description || null,
    logo_url: body.logo_url || null,
    employee_count_range: body.employee_count_range || null,
    address: body.address || null,
    phone: body.phone || null,
    contact_email: body.contact_email?.toLowerCase() || null,
    city: body.city || null,
    state: body.state || null,
    country: body.country || null,
    tags: body.tags || [],
  }

  const { data, error } = await supabase
    .from('company')
    .insert(insert)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ company: data })
}
