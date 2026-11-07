import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { getPostHogServerClient, serverDefaultProperties } from '@/lib/posthog'

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export async function GET() {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = await getAdminServiceClient()

  const { data: campaigns, error } = await supabase
    .from('campaigns')
    .select('*, campaign_steps(id, delivery_channel)')
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  // Per-campaign sent counts. Count in the database (head: true): selecting
  // every log row and counting in JS silently truncates at PostgREST's
  // 1000-row cap.
  const emailCounts: Record<string, number> = {}
  const inAppCounts: Record<string, number> = {}
  await Promise.all(
    (campaigns ?? []).map(async (c) => {
      const [{ count: emails }, { count: messages }] = await Promise.all([
        supabase
          .from('email_campaign_log')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', c.id),
        supabase
          .from('in_app_messages')
          .select('id', { count: 'exact', head: true })
          .eq('campaign_id', c.id),
      ])
      emailCounts[c.id] = emails ?? 0
      inAppCounts[c.id] = messages ?? 0
    }),
  )

  const result = (campaigns ?? []).map((c) => {
    const steps = Array.isArray(c.campaign_steps) ? c.campaign_steps : []
    return {
      ...c,
      steps_count: steps.length,
      emails_sent: emailCounts[c.id] ?? 0,
      messages_sent: inAppCounts[c.id] ?? 0,
      campaign_steps: undefined,
    }
  })

  return NextResponse.json({ campaigns: result })
}

export async function POST(request: Request) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { title, description, trigger_type, audience_source } = body as {
    title: string
    description?: string
    trigger_type?: string
    audience_source?: string
  }

  if (!title) {
    return NextResponse.json({ error: 'title is required' }, { status: 400 })
  }

  const slug = slugify(title)
  if (!slug) {
    return NextResponse.json(
      { error: 'Title must contain at least one letter or number' },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()

  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      title,
      slug,
      description: description ?? null,
      trigger_type: trigger_type ?? 'manual',
      audience_source: audience_source ?? 'early_access',
      message_title: title,
      message_body: '',
      message_type: 'announcement',
      priority: 'normal',
      is_active: true,
      created_by: admin.email,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `A campaign with slug "${slug}" already exists` },
        { status: 409 },
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const posthog = getPostHogServerClient()
  posthog?.capture({
    distinctId: admin.id,
    event: 'admin_campaign_created',
    properties: {
      ...serverDefaultProperties,
      campaign_id: data.id,
      campaign_title: title,
      trigger_type: trigger_type ?? 'manual',
      audience_source: audience_source ?? 'early_access',
    },
  })

  return NextResponse.json({ campaign: data })
}
