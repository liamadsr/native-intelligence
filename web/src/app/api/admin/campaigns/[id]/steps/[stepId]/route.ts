import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id, stepId } = await params
  const body = await request.json()
  const supabase = await getAdminServiceClient()

  const allowed = [
    'step_name',
    'delivery_channel',
    'delay_days',
    'step_order',
    'is_active',
    // Email fields
    'template_slug',
    // In-app fields
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

  const { data, error } = await supabase
    .from('campaign_steps')
    .update(updates)
    .eq('id', stepId)
    .eq('campaign_id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ step: data })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string; stepId: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id, stepId } = await params
  const supabase = await getAdminServiceClient()

  const { error } = await supabase
    .from('campaign_steps')
    .delete()
    .eq('id', stepId)
    .eq('campaign_id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
