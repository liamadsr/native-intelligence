import { createClient } from '@/lib/supabase/server'
import { trackServerEvent } from '@/lib/posthog'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { inngest } from '@/lib/inngest/client'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { searchParams } = request.nextUrl

  // Allow explicit workspace_id param (for cross-workspace contact search, e.g. during new workspace invite)
  // Verify the user is a member of the requested workspace
  let workspaceId = searchParams.get('workspace_id') || (await getCurrentWorkspaceId())
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  if (searchParams.get('workspace_id')) {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()
    if (!member) return NextResponse.json({ error: 'Not a member of this workspace' }, { status: 403 })
  }
  const search = searchParams.get('search')
  const companyId = searchParams.get('company_id')
  const relationshipType = searchParams.get('relationship_type')
  const relationshipStrength = searchParams.get('relationship_strength')
  const tag = searchParams.get('tag')
  const visibility = searchParams.get('visibility')
  const mine = searchParams.get('mine')
  const sort = searchParams.get('sort') || 'last_interaction_at'
  const direction = searchParams.get('direction') || 'desc'
  const limit = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200)
  const offset = parseInt(searchParams.get('offset') || '0', 10)

  let query = supabase
    .from('contact')
    .select('*, company:company_id(id, name, domain, logo_url)', { count: 'exact' })
    .eq('workspace_id', workspaceId)
    // Hide contacts that have been merged away into another contact.
    .is('merged_into_contact_id', null)

  if (search) {
    // PostgREST parses the `.or()` filter string itself, so commas, parens and
    // quotes in user input break the expression (a typed `,` 500s). Strip them.
    const safeSearch = search.replace(/[,()"`\\]/g, '').trim()
    if (safeSearch) {
      query = query.or(`full_name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`)
    }
  }
  if (companyId) query = query.eq('company_id', companyId)
  if (relationshipType) query = query.eq('relationship_type', relationshipType)
  if (relationshipStrength) query = query.eq('relationship_strength', relationshipStrength)
  if (tag) query = query.contains('tags', [tag])
  if (visibility) query = query.eq('visibility', visibility)
  if (mine === 'true') {
    // Resolve the current user's member_id to filter by creator
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()
    if (member) {
      query = query.eq('created_by_member_id', member.id)
    }
  }

  query = query.order(sort, { ascending: direction === 'asc', nullsFirst: false })
  query = query.range(offset, offset + limit - 1)

  const { data, error, count } = await query

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ contacts: data || [], total: count || 0 })
}

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()

  if (!body.full_name && !body.first_name && !body.email) {
    return NextResponse.json({ error: 'Name or email required' }, { status: 400 })
  }

  // Resolve current member for ownership
  const { data: member } = await supabase
    .from('member')
    .select('id')
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!member) return NextResponse.json({ error: 'Not a workspace member' }, { status: 403 })

  const fullName = body.full_name || [body.first_name, body.last_name].filter(Boolean).join(' ') || body.email

  const insert: Record<string, unknown> = {
    workspace_id: workspaceId,
    created_by_member_id: member.id,
    visibility: body.visibility || 'private',
    full_name: fullName,
    first_name: body.first_name || null,
    last_name: body.last_name || null,
    email: body.email?.toLowerCase() || null,
    phone: body.phone || null,
    job_title: body.job_title || null,
    department: body.department || null,
    linkedin_url: body.linkedin_url || null,
    company_id: body.company_id || null,
    relationship_type: body.relationship_type || 'contact',
    notes: body.notes || null,
    tags: body.tags || [],
    source: 'manual',
  }

  const { data, error } = await supabase
    .from('contact')
    .insert(insert)
    .select('*, company:company_id(id, name, domain)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  trackServerEvent('contact_created', { userId: user.id, workspaceId, email: user.email }, { contact_id: data.id })

  // Fan out to the HubSpot contact-push writeback. Fire-and-forget: the
  // hubspot-push-contact function owns ALL gating (workspace opt-in flag, the
  // scope decision of which sources are eligible, whether the workspace has a
  // HubSpot account, dedupe) and no-ops cleanly when any is absent, so a failed
  // send must never fail contact creation. We only gate on email-presence here
  // (the dedupe/create key) — the fn is the sole authority on scope, so this
  // route no longer pre-filters on source.
  if (data.email) {
    inngest
      .send({
        name: 'crm/hubspot-push-contact',
        data: { contactId: data.id, workspaceId },
      })
      .catch((err) => {
        console.error('[contacts] hubspot-push-contact send failed', err)
      })
  }

  return NextResponse.json({ contact: data })
}
