import { createClient } from '@/lib/supabase/server'
import { getServiceClient } from '@/lib/admin'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) {
    return NextResponse.json({ error: 'No workspace' }, { status: 400 })
  }

  const { id } = await params
  const body = await request.json()
  const contactId = body.contact_id

  if (!contactId) {
    return NextResponse.json({ error: 'contact_id is required' }, { status: 400 })
  }

  // Get capture title for the interaction record
  const { data: capture } = await supabase
    .from('captures')
    .select('id, title, started_at, created_at')
    .eq('id', id)
    .eq('user_id', user.id)
    .eq('workspace_id', workspaceId)
    .single()

  if (!capture) {
    return NextResponse.json({ error: 'Capture not found' }, { status: 404 })
  }

  // Check for existing interaction to avoid duplicates
  const { data: existing } = await supabase
    .from('contact_interaction')
    .select('id')
    .eq('contact_id', contactId)
    .eq('reference_type', 'capture')
    .eq('reference_id', id)
    .maybeSingle()

  if (existing) {
    return NextResponse.json({ success: true, message: 'Interaction already exists' })
  }

  const occurredAt = capture.started_at || capture.created_at || new Date().toISOString()

  // Create interaction record
  const { error: interactionError } = await supabase
    .from('contact_interaction')
    .insert({
      workspace_id: workspaceId,
      contact_id: contactId,
      interaction_type: 'capture',
      reference_type: 'capture',
      reference_id: id,
      title: capture.title || null,
      occurred_at: occurredAt,
    })

  if (interactionError) {
    return NextResponse.json({ error: interactionError.message }, { status: 500 })
  }

  // Update contact stats. This SECURITY DEFINER RPC is revoked from the
  // authenticated role (migration 193) — call it on the service client, as the
  // other three call sites (crm/contacts.ts, crm/email-client.ts, drafts/send)
  // already do. Surface the error instead of swallowing it: the interaction row
  // is written, but if the rollup silently fails the contact's stats drift.
  const { error: statsError } = await getServiceClient().rpc(
    'update_contact_interaction_stats',
    { p_contact_id: contactId, p_occurred_at: occurredAt },
  )
  if (statsError) {
    console.error('update_contact_interaction_stats error:', statsError)
  }

  return NextResponse.json({ success: true })
}
