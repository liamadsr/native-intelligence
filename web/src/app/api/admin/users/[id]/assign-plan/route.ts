import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: userId } = await params
  const body = await request.json()
  const { plan_id } = body as { plan_id: string }

  if (!plan_id) {
    return NextResponse.json({ error: 'plan_id is required' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  // Verify the plan exists
  const { data: plan, error: planError } = await supabase
    .from('ai_plan_definitions')
    .select('id, display_name')
    .eq('id', plan_id)
    .single()

  if (planError || !plan) {
    return NextResponse.json({ error: 'Plan not found' }, { status: 404 })
  }

  // Upsert user plan assignment (preserving existing counters on plan change)
  // admin_override = true so this plan takes priority over subscription status
  const { data, error } = await supabase
    .from('ai_user_plans')
    .upsert(
      {
        user_id: userId,
        plan_id,
        admin_override: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' },
    )
    .select('*, ai_plan_definitions(name, display_name)')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ user_plan: data })
}
