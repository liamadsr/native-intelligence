import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let adminUser
  try {
    adminUser = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: userId } = await params
  const body = await request.json()
  const { reason } = body

  const supabase = await getAdminServiceClient()

  // Check if user already has an active subscription
  const { data: existing } = await supabase
    .from('subscriptions')
    .select('id, status')
    .eq('user_id', userId)
    .in('status', ['active', 'trialing'])
    .limit(1)
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: 'User already has an active subscription' },
      { status: 400 },
    )
  }

  // Insert a granted subscription record
  const { data: subscription, error: insertError } = await supabase
    .from('subscriptions')
    .insert({
      user_id: userId,
      stripe_subscription_id: `granted_${Date.now()}`,
      stripe_customer_id: null,
      status: 'active',
      current_period_start: new Date().toISOString(),
      current_period_end: null,
      cancel_at_period_end: false,
    })
    .select()
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  // Assign the 'subscriber' AI plan
  const { data: subscriberPlan } = await supabase
    .from('ai_plan_definitions')
    .select('id')
    .eq('name', 'subscriber')
    .single()

  if (subscriberPlan) {
    await supabase
      .from('ai_user_plans')
      .upsert({
        user_id: userId,
        plan_id: subscriberPlan.id,
        is_active: true,
      }, {
        onConflict: 'user_id',
      })
  }

  // Log the grant as an analytics event
  await supabase
    .from('analytics_events')
    .insert({
      user_id: userId,
      device_id: 'admin',
      event: 'subscription_granted',
      properties: {
        granted_by: adminUser.email,
        reason: reason || null,
      },
      created_at: new Date().toISOString(),
    })

  return NextResponse.json({ subscription })
}
