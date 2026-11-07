import { NextResponse } from 'next/server'
import { getServiceClient } from '@/lib/admin'

const DISPLAY_COLUMNS = [
  'id',
  'name',
  'display_name',
  'description',
  'feature_highlights',
  'price_display',
  'price_subtext',
  'cta_label',
  'cta_href',
  'sort_order',
  'badge_text',
  'allowed_model_labels',
  'allowed_providers',
  'purchase_action',
  'icon',
].join(', ')

export async function GET() {
  const supabase = getServiceClient()

  const { data, error } = await supabase
    .from('ai_plan_definitions')
    .select(DISPLAY_COLUMNS)
    .eq('is_visible', true)
    .order('sort_order', { ascending: true })

  if (error) {
    console.error('Failed to fetch plans:', error)
    return NextResponse.json({ error: 'Failed to fetch plans' }, { status: 500 })
  }

  return NextResponse.json(
    { plans: data },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=600',
      },
    },
  )
}
