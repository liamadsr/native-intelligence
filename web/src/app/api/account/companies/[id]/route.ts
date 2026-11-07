import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { requireWorkspaceMember } from '@/lib/api-auth'
import { forbidden, notFound, serverError } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { deleteCompaniesWithContacts } from '@/lib/crm/delete-companies'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  const { data: company, error } = await supabase
    .from('company')
    .select('*')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // People at this company. Merged tombstones keep their company_id but are
  // not people — filter them like every other contact list does.
  const contactsResult = await supabase
    .from('contact')
    .select('id, full_name, email, job_title, relationship_type, relationship_strength, last_interaction_at, avatar_url')
    .eq('company_id', id)
    .eq('workspace_id', workspaceId)
    .is('merged_into_contact_id', null)
    .order('last_interaction_at', { ascending: false, nullsFirst: false })

  const companyContacts = contactsResult.data || []
  // Captures involving this company's contacts. Filter server-side by contact
  // id — an unscoped recent-participants query would only ever see the
  // workspace's latest rows, not this company's. The id list rides in the
  // request URL, so cap it; contacts are ordered by recency, so the cap keeps
  // exactly the people whose captures are most likely recent.
  const contactIds = companyContacts.slice(0, 100).map((c) => c.id)

  const capturesResult = contactIds.length
    ? await supabase
        .from('capture_participant')
        .select('capture:capture_id(id, title, ai_summary, started_at, status)')
        .in('contact_id', contactIds)
        .order('created_at', { ascending: false })
        .limit(20)
    : { data: [] }

  const captures = (capturesResult.data || []).map((cp) => cp.capture).filter(Boolean)

  // Remove duplicate captures
  const uniqueCaptures = Array.from(
    new Map(captures.map((c) => [(c as unknown as Record<string, unknown>).id, c])).values(),
  )

  return NextResponse.json({
    company: {
      ...company,
      contacts: companyContacts,
      captures: uniqueCaptures,
    },
  })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.domain !== undefined) updates.domain = body.domain?.toLowerCase() || null
  if (body.website !== undefined) updates.website = body.website
  if (body.industry !== undefined) updates.industry = body.industry
  if (body.description !== undefined) updates.description = body.description
  if (body.logo_url !== undefined) updates.logo_url = body.logo_url
  if (body.employee_count_range !== undefined) updates.employee_count_range = body.employee_count_range
  if (body.address !== undefined) updates.address = body.address
  if (body.phone !== undefined) updates.phone = body.phone
  if (body.contact_email !== undefined) updates.contact_email = body.contact_email?.toLowerCase() || null
  if (body.city !== undefined) updates.city = body.city
  if (body.state !== undefined) updates.state = body.state
  if (body.country !== undefined) updates.country = body.country
  if (body.tags !== undefined) updates.tags = body.tags

  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('company')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ company: data })
}

/**
 * DELETE /api/account/companies/[id]
 *
 * Cascade-deletes the company AND all its contacts (see
 * src/lib/crm/delete-companies.ts for why this runs on the service client,
 * and companies/bulk-delete for why it is owner/admin only).
 * Returns { success: true, contacts_deleted } so the UI can confirm the
 * cascade's scope.
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // select must name 'role' — the helper defaults to just 'id', which would
  // leave member.role undefined and 403 owners too.
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace owners or admins can delete companies and their people')
  }

  const { id } = await params

  try {
    const result = await deleteCompaniesWithContacts(
      getServiceClient(),
      workspaceId,
      [id],
    )
    if (result.companies === 0) return notFound('Company not found')
    return NextResponse.json({ success: true, contacts_deleted: result.contacts })
  } catch (err) {
    console.error('[companies/[id]] cascade delete failed:', err)
    return serverError()
  }
}
