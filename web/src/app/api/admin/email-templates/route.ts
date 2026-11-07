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
    .from('email_templates')
    .select('*')
    .order('created_at', { ascending: true })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data)
}

export async function POST(request: Request) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const { slug, name, subject, html, description } = body as {
    slug: string
    name: string
    subject: string
    html: string
    description?: string
  }

  if (!slug || !name || !subject || !html) {
    return NextResponse.json(
      { error: 'slug, name, subject, and html are required' },
      { status: 400 },
    )
  }

  // Validate slug format
  if (!/^[a-z0-9_-]+$/.test(slug)) {
    return NextResponse.json(
      { error: 'slug must be lowercase alphanumeric with hyphens or underscores' },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('email_templates')
    .insert({
      slug,
      name,
      subject,
      html,
      description: description || null,
      updated_by: admin.email,
    })
    .select()
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json({ error: 'A template with this slug already exists' }, { status: 409 })
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json(data, { status: 201 })
}
