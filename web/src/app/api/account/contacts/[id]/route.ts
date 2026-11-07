import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'
import { forbidden, notFound } from '@/lib/api-errors'
import { getServiceClient } from '@/lib/admin'
import { HEADER_ROW_COLUMNS, withLiveHeaders, type HeaderRow } from '@/lib/email/thread-headers'

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

  const { data: contact, error } = await supabase
    .from('contact')
    .select('*, company:company_id(*)')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // All of this contact's addresses (primary + any merged-in secondaries) so
  // email threads from every address they've used show on the one timeline.
  const contactEmails = [contact.email, ...(contact.secondary_emails || [])]
    .filter((e): e is string => !!e)

  // Get recent interactions, captures, email threads in parallel
  const [interactionsResult, capturesResult, emailThreadsResult] = await Promise.all([
    supabase
      .from('contact_interaction')
      .select('*')
      .eq('contact_id', id)
      .order('occurred_at', { ascending: false })
      .limit(20),

    supabase
      .from('capture_participant')
      .select('capture:capture_id(id, title, ai_summary, started_at, ended_at, status)')
      .eq('contact_id', id)
      .limit(50),

    contactEmails.length > 0
      ? supabase
          .from('email_thread_index')
          .select(`${HEADER_ROW_COLUMNS}, last_message_at, needs_reply, auto_classified`)
          .eq('user_id', user.id)
          .eq('workspace_id', workspaceId)
          .overlaps('participant_emails', contactEmails)
          .order('last_message_at', { ascending: false })
          .limit(10)
      : { data: [] },
  ])

  // Fetch actions: assigned to contact's member OR extracted from captures the contact was on
  type CaptureRow = { id: string; title: string; ai_summary: string | null; started_at: string | null; ended_at: string | null; status: string }
  const captureRowsRaw = (capturesResult.data || [])
    .map((cp) => cp.capture as unknown as CaptureRow | null)
    .filter(Boolean) as CaptureRow[]
  // A merged contact can carry two participant rows for the same capture (one
  // per original address) — dedupe so each meeting is listed once.
  const seenCaptureIds = new Set<string>()
  const captureRows = captureRowsRaw.filter((c) => {
    if (seenCaptureIds.has(c.id)) return false
    seenCaptureIds.add(c.id)
    return true
  })
  const captureIds = captureRows.map(c => c.id)

  // Actions assigned to this contact OR extracted from their captures — run in parallel
  const [actionsFromMember, actionsFromCaptures] = await Promise.all([
    contact.member_id
      ? supabase
          .from('actions')
          .select('id, title, identifier, priority, due_at, workflow_state:workflow_state!status_id(name, category, color)')
          .eq('workspace_id', workspaceId)
          .eq('assignee_id', contact.member_id)
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as never[] }),

    captureIds.length > 0
      ? supabase
          .from('actions')
          .select('id, title, identifier, priority, due_at, workflow_state:workflow_state!status_id(name, category, color)')
          .eq('workspace_id', workspaceId)
          .in('source_capture_id', captureIds)
          .order('created_at', { ascending: false })
          .limit(50)
      : Promise.resolve({ data: [] as never[] }),
  ])

  // Merge and deduplicate
  const seenActionIds = new Set<string>()
  const mergedActions = [...(actionsFromMember.data || []), ...(actionsFromCaptures.data || [])]
    .filter((a) => {
      if (seenActionIds.has(a.id)) return false
      seenActionIds.add(a.id)
      return true
    })

  const allActions = mergedActions.map((a) => {
    const ws = a.workflow_state as unknown as { name: string; category: string; color: string | null } | null
    return {
      id: a.id,
      title: a.title,
      identifier: a.identifier,
      priority: a.priority,
      due_at: a.due_at,
      status_name: ws?.name ?? null,
      status_category: ws?.category ?? null,
      status_color: ws?.color ?? null,
    }
  })

  return NextResponse.json({
    contact: {
      ...contact,
      interactions: interactionsResult.data || [],
      captures: captureRows.sort((a, b) => {
        const aTime = a.started_at ? new Date(a.started_at).getTime() : 0
        const bTime = b.started_at ? new Date(b.started_at).getTime() : 0
        return bTime - aTime
      }),
      // Subjects and previews come live from the mailbox (no stored mail).
      email_threads: await withLiveHeaders(getServiceClient(), {
        userId: user.id,
        workspaceId,
        rows: (emailThreadsResult.data ?? []) as unknown as HeaderRow[],
      }),
      actions: allActions,
      open_actions: allActions.filter((a) => a.status_category !== 'completed' && a.status_category !== 'canceled'),
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
  if (body.full_name !== undefined) updates.full_name = body.full_name
  if (body.first_name !== undefined) updates.first_name = body.first_name
  if (body.last_name !== undefined) updates.last_name = body.last_name
  if (body.email !== undefined) updates.email = body.email?.toLowerCase() || null
  if (body.phone !== undefined) updates.phone = body.phone
  if (body.job_title !== undefined) updates.job_title = body.job_title
  if (body.department !== undefined) updates.department = body.department
  if (body.linkedin_url !== undefined) updates.linkedin_url = body.linkedin_url
  if (body.company_id !== undefined) updates.company_id = body.company_id || null
  if (body.relationship_type !== undefined) updates.relationship_type = body.relationship_type
  if (body.relationship_strength !== undefined) updates.relationship_strength = body.relationship_strength
  if (body.next_followup_at !== undefined) updates.next_followup_at = body.next_followup_at || null
  if (body.notes !== undefined) updates.notes = body.notes
  if (body.tags !== undefined) updates.tags = body.tags
  if (body.avatar_url !== undefined) updates.avatar_url = body.avatar_url
  if (body.secondary_emails !== undefined) updates.secondary_emails = body.secondary_emails

  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('contact')
    .update(updates)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('*, company:company_id(id, name, domain)')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // A contact an UNATTENDED run created carries a HubSpot push HOLD
  // (metadata.hubspot_push_hold). Editing a field here is NOT the review that
  // lifts it: the release is explicit — POST ./hubspot-hold, from the contact's
  // own badge or the run's review card (Sequence step 2, plan A.1).
  return NextResponse.json({ contact: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { id } = await params

  // count: 'exact' because RLS (contact_delete: creator or owner/admin) skips
  // a refused row without an error, which would otherwise read as success.
  const { error, count } = await supabase
    .from('contact')
    .delete({ count: 'exact' })
    .eq('id', id)
    .eq('workspace_id', workspaceId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  if (!count) {
    const { data: visible } = await supabase
      .from('contact')
      .select('id')
      .eq('id', id)
      .eq('workspace_id', workspaceId)
      .maybeSingle()
    return visible
      ? forbidden('Only the person who added this contact or a workspace admin can delete it')
      : notFound('Contact not found')
  }

  return NextResponse.json({ success: true })
}
