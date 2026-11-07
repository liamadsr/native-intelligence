import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id } = await params
  const body = await request.json()
  const { feature_id, reason } = body

  if (!feature_id || typeof feature_id !== 'string') {
    return NextResponse.json({ error: 'feature_id is required' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()

  // Verify the feature exists
  const { data: feature, error: featureError } = await supabase
    .from('features')
    .select('id, display_name')
    .eq('id', feature_id)
    .single()

  if (featureError || !feature) {
    return NextResponse.json({ error: 'Feature not found' }, { status: 404 })
  }

  // Check for existing active purchase of this feature
  const { data: existing } = await supabase
    .from('purchases')
    .select('id')
    .eq('user_id', id)
    .eq('feature_id', feature_id)
    .eq('status', 'completed')
    .maybeSingle()

  if (existing) {
    return NextResponse.json(
      { error: `User already has an active purchase for ${feature.display_name}` },
      { status: 409 },
    )
  }

  // Insert a complimentary purchase
  const { data: purchase, error: insertError } = await supabase
    .from('purchases')
    .insert({
      user_id: id,
      feature_id,
      purchase_option: feature_id,
      price_paid: 0,
      status: 'completed',
      metadata: {
        promotional: true,
        campaign: 'admin_grant',
        granted_by: admin.email,
        granted_at: new Date().toISOString(),
        ...(reason ? { reason } : {}),
      },
    })
    .select()
    .single()

  if (insertError) {
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  return NextResponse.json({ purchase })
}
