import { trackServerEvent } from '@/lib/posthog'
import { inngest } from '@/lib/inngest/client'
import { getServiceClient } from '@/lib/admin'
import { notifyContactCreated } from '@/lib/flows/emit-contact-created'
import { requireUser, requireWorkspace, requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, notMember, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl

  // Allow explicit workspace_id param (for cross-workspace contact search, e.g. during new workspace invite)
  // Verify the user is a member of the requested workspace
  const requested = searchParams.get('workspace_id')
  const auth = requested ? await requireUser() : await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const workspaceId = requested || ('workspaceId' in auth ? auth.workspaceId : '')

  if (requested) {
    const { data: member } = await supabase
      .from('member')
      .select('id')
      .eq('user_id', user.id)
      .eq('workspace_id', workspaceId)
      .single()
    if (!member) return notMember('Not a member of this workspace')
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

  if (error) return serverError(error.message)

  return NextResponse.json({ contacts: data || [], total: count || 0 })
}

export async function POST(request: NextRequest) {
  // The current member owns the new contact (401 signed out, 400 no workspace, 403 not a member).
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId, member } = auth

  const body = await request.json()

  if (!body.full_name && !body.first_name && !body.email) {
    return badRequest('Name or email required')
  }

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

  if (error) return serverError(error.message)

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

  // The contact_created loops a person's own new contact may start, about five
  // minutes from now (src/lib/flows/emit-contact-created.ts). Only this route
  // and a public intake's new contact emit: an agent's create_contact, an
  // import and a sync never do. Never throws.
  try {
    await notifyContactCreated(getServiceClient(), { workspaceId, contactId: data.id, source: 'person' })
  } catch (err) {
    console.error('[contacts] loop event not sent (non-fatal):', err instanceof Error ? err.message : 'unknown')
  }

  return NextResponse.json({ contact: data })
}
