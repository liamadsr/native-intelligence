import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

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

  const { data: steps, error } = await supabase
    .from('campaign_steps')
    .select('*')
    .eq('campaign_id', id)
    .order('step_order', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ steps: steps ?? [] })
}

export async function POST(
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

  const deliveryChannel = body.delivery_channel ?? 'in_app'

  // Validate based on delivery channel
  if ((deliveryChannel === 'email' || deliveryChannel === 'both') && !body.template_slug) {
    return NextResponse.json(
      { error: 'template_slug is required for email steps' },
      { status: 400 },
    )
  }

  // Get current max step_order
  const { data: existing } = await supabase
    .from('campaign_steps')
    .select('step_order')
    .eq('campaign_id', id)
    .order('step_order', { ascending: false })
    .limit(1)

  const nextOrder = existing && existing.length > 0 ? existing[0].step_order + 1 : 0

  const { data, error } = await supabase
    .from('campaign_steps')
    .insert({
      campaign_id: id,
      step_order: nextOrder,
      step_name: body.step_name ?? `Step ${nextOrder + 1}`,
      delivery_channel: deliveryChannel,
      delay_days: body.delay_days ?? 0,
      // Email fields
      template_slug: body.template_slug ?? null,
      // In-app fields
      message_title: body.message_title ?? null,
      message_body: body.message_body ?? null,
      message_type: body.message_type ?? 'announcement',
      cta_text: body.cta_text ?? null,
      cta_action: body.cta_action ?? 'dismiss',
      cta_url: body.cta_url ?? null,
      priority: body.priority ?? 'normal',
      expires_after_days: body.expires_after_days ?? 7,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ step: data })
}
