import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { slug } = await params
  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('email_templates')
    .select('*')
    .eq('slug', slug)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  return NextResponse.json(data)
}

export async function PUT(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  let admin
  try {
    admin = await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { slug } = await params
  const body = await request.json()
  const { name, subject, html, description } = body as {
    name?: string
    subject?: string
    html?: string
    description?: string
  }

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    updated_by: admin.email,
  }
  if (name !== undefined) updates.name = name
  if (subject !== undefined) updates.subject = subject
  if (html !== undefined) updates.html = html
  if (description !== undefined) updates.description = description

  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('email_templates')
    .update(updates)
    .eq('slug', slug)
    .select()
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Template not found or update failed' }, { status: 404 })
  }

  return NextResponse.json(data)
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { slug } = await params
  const supabase = await getAdminServiceClient()
  const { error } = await supabase
    .from('email_templates')
    .delete()
    .eq('slug', slug)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
