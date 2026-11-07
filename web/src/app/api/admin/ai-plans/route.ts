import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('ai_plan_definitions')
    .select('*')
    .order('monthly_cost_limit_usd', { ascending: true, nullsFirst: false })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ plans: data })
}

export async function POST(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { name, display_name } = body

  if (!name || !display_name) {
    return NextResponse.json(
      { error: 'name and display_name are required' },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('ai_plan_definitions')
    .insert({
      name: name.toLowerCase().trim(),
      display_name: display_name.trim(),
      monthly_cost_limit_usd: body.monthly_cost_limit_usd ?? null,
      monthly_token_limit: body.monthly_token_limit ?? null,
      max_requests_per_day: body.max_requests_per_day ?? null,
      allowed_providers: body.allowed_providers ?? ['claude', 'groq', 'openai'],
      is_default: body.is_default ?? false,
      description: body.description ?? null,
      feature_highlights: body.feature_highlights ?? [],
      price_display: body.price_display ?? null,
      price_subtext: body.price_subtext ?? null,
      cta_label: body.cta_label ?? null,
      cta_href: body.cta_href ?? null,
      sort_order: body.sort_order ?? 0,
      is_visible: body.is_visible ?? true,
      badge_text: body.badge_text ?? null,
      allowed_model_labels: body.allowed_model_labels ?? [],
      purchase_action: body.purchase_action ?? null,
      icon: body.icon ?? null,
      stripe_price_id: body.stripe_price_id ?? null,
    })
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ plan: data }, { status: 201 })
}

export async function PUT(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { id, ...fields } = body

  if (!id) {
    return NextResponse.json({ error: 'id is required' }, { status: 400 })
  }

  const allowed = [
    'display_name', 'monthly_cost_limit_usd', 'monthly_token_limit',
    'max_requests_per_day', 'allowed_providers', 'is_default',
    'description', 'feature_highlights', 'price_display', 'price_subtext',
    'cta_label', 'cta_href', 'sort_order', 'is_visible', 'badge_text',
    'allowed_model_labels', 'purchase_action', 'icon', 'stripe_price_id',
  ]
  const updates: Record<string, unknown> = {}
  for (const key of allowed) {
    if (key in fields) updates[key] = fields[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: 'No valid fields to update' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('ai_plan_definitions')
    .update(updates)
    .eq('id', id)
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ plan: data })
}

export async function DELETE(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const id = searchParams.get('id')

  if (!id) {
    return NextResponse.json({ error: 'id query parameter is required' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  // Check if any users are assigned to this plan
  const { count } = await supabase
    .from('ai_user_plans')
    .select('*', { count: 'exact', head: true })
    .eq('plan_id', id)

  if (count && count > 0) {
    return NextResponse.json(
      { error: `Cannot delete: ${count} user(s) are assigned to this plan` },
      { status: 409 },
    )
  }

  const { error } = await supabase
    .from('ai_plan_definitions')
    .delete()
    .eq('id', id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
