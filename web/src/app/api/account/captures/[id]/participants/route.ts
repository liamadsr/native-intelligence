import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  // The workspace ownership check and the participant list are independent —
  // fetch in parallel. A failed ownership check still decides the response
  // (the participant rows are discarded, never returned).
  const [{ data: capture }, { data, error }] = await Promise.all([
    // Verify the capture belongs to this workspace (workspace-shared
    // visibility — teammates can read each other's captures).
    supabase
      .from('captures')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .single(),
    supabase
      .from('capture_participant')
      .select(`
        id, capture_id, member_id, contact_id, external_name, external_email, company, job_title,
        speaker_label, role, joined_at, left_at,
        member:member!member_id(id, display_name, avatar_url),
        contact:contact!contact_id(id, full_name)
      `)
      .eq('capture_id', id)
      .order('role', { ascending: true }),
  ])

  if (!capture) {
    return notFound('Capture not found')
  }

  if (error) {
    return serverError(error.message)
  }

  const participants = (data || []).map((p) => {
    const memberData = p.member as unknown as { id: string; display_name: string; avatar_url: string | null } | null
    const contactData = p.contact as unknown as { id: string; full_name: string } | null
    return {
      id: p.id,
      capture_id: p.capture_id,
      member_id: p.member_id,
      contact_id: p.contact_id || null,
      contact_name: contactData?.full_name || null,
      name: memberData?.display_name || p.external_name || '',
      avatar_url: memberData?.avatar_url || null,
      email: p.external_email,
      company: p.company,
      job_title: p.job_title,
      speaker_label: p.speaker_label,
      role: p.role,
      joined_at: p.joined_at,
      left_at: p.left_at,
      source: (p as Record<string, unknown>).source || 'calendar_event',
      is_member: !!p.member_id,
    }
  })

  return NextResponse.json({ participants })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  const { id } = await params

  // Verify the capture belongs to this user/workspace
  const { data: capture } = await supabase
    .from('captures')
    .select('id')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return notFound('Capture not found')
  }

  const body = await request.json()

  // Validate constraint: member_id or external_name required
  if (!body.member_id && !body.external_name) {
    return badRequest('Either member_id or external_name is required')
  }

  // Deduplicate: if a contact_id is provided, check if this contact is already a participant
  if (body.contact_id) {
    const { data: existing } = await supabase
      .from('capture_participant')
      .select('id')
      .eq('capture_id', id)
      .eq('contact_id', body.contact_id)
      .maybeSingle()

    if (existing) {
      return NextResponse.json({ error: 'This contact is already a participant' }, { status: 409 })
    }
  }

  const insert: Record<string, unknown> = {
    capture_id: id,
  }

  if (body.member_id) insert.member_id = body.member_id
  if (body.contact_id) insert.contact_id = body.contact_id
  if (body.external_name) insert.external_name = body.external_name
  if (body.external_email) insert.external_email = body.external_email
  if (body.company) insert.company = body.company
  if (body.job_title) insert.job_title = body.job_title
  if (body.speaker_label) insert.speaker_label = body.speaker_label
  if (body.role) insert.role = body.role

  // Try inserting with source column first; fall back without it if the migration hasn't run yet
  const source = body.source || null
  let data: Record<string, unknown> | null = null

  if (source) {
    const result = await supabase
      .from('capture_participant')
      .insert({ ...insert, source })
      .select(`
        id, capture_id, member_id, contact_id, external_name, external_email, company, job_title, speaker_label, role,
        contact:contact!contact_id(id, full_name)
      `)
      .single()

    if (result.error && result.error.message.includes('source')) {
      // source column doesn't exist yet — retry without it
      const fallback = await supabase
        .from('capture_participant')
        .insert(insert)
        .select(`
          id, capture_id, member_id, contact_id, external_name, external_email, company, job_title, speaker_label, role,
          contact:contact!contact_id(id, full_name)
        `)
        .single()

      if (fallback.error) {
        return serverError(fallback.error.message)
      }
      data = fallback.data as Record<string, unknown>
    } else if (result.error) {
      return serverError(result.error.message)
    } else {
      data = result.data as Record<string, unknown>
    }
  } else {
    const result = await supabase
      .from('capture_participant')
      .insert(insert)
      .select(`
        id, capture_id, member_id, contact_id, external_name, external_email, company, job_title, speaker_label, role,
        contact:contact!contact_id(id, full_name)
      `)
      .single()

    if (result.error) {
      return serverError(result.error.message)
    }
    data = result.data as Record<string, unknown>
  }

  const contactData = data!.contact as unknown as { id: string; full_name: string } | null
  return NextResponse.json({
    participant: {
      ...data,
      contact_name: contactData?.full_name || null,
      name: (data!.external_name as string) || contactData?.full_name || '',
    },
  })
}
