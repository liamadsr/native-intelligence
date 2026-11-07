import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const supabase = await getAdminServiceClient()

  const { data: campaign, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', id)
    .single()

  if (error || !campaign) {
    return NextResponse.json({ error: 'Campaign not found' }, { status: 404 })
  }

  // Get email stats
  const { count: emailsSent } = await supabase
    .from('email_campaign_log')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', id)

  const { data: lastEmailLog } = await supabase
    .from('email_campaign_log')
    .select('sent_at')
    .eq('campaign_id', id)
    .order('sent_at', { ascending: false })
    .limit(1)

  // Get in-app message stats
  const { data: messages } = await supabase
    .from('in_app_messages')
    .select('id, status, message_responses(id)')
    .eq('campaign_id', id)

  const allMessages = messages ?? []
  const responded = allMessages.filter(
    (m) => Array.isArray(m.message_responses) && m.message_responses.length > 0,
  ).length

  return NextResponse.json({
    campaign,
    stats: {
      emails_sent: emailsSent ?? 0,
      messages_sent: allMessages.length,
      delivered: allMessages.filter((m) => m.status !== 'pending').length,
      responded,
      response_rate:
        allMessages.length > 0
          ? Math.round((responded / allMessages.length) * 100)
          : 0,
      last_activity: lastEmailLog?.[0]?.sent_at ?? null,
    },
  })
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json()
  const supabase = await getAdminServiceClient()

  const allowed = [
    'title',
    'description',
    'trigger_type',
    'is_active',
    'audience_source',
    'schedule_trigger',
    'message_title',
    'message_body',
    'message_type',
    'cta_text',
    'cta_action',
    'cta_url',
    'priority',
    'expires_after_days',
  ]
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  for (const key of allowed) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length <= 1) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const { data, error } = await supabase
    .from('campaigns')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ campaign: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const supabase = await getAdminServiceClient()

  // Steps cascade-delete via FK
  const { error } = await supabase
    .from('campaigns')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: admin.id,
    event: 'admin_campaign_deleted',
    properties: {
      ...serverDefaultProperties,
      campaign_id: id,
    },
  })

  return NextResponse.json({ success: true })
}
