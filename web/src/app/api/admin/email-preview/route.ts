import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'

export async function GET(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { searchParams } = new URL(request.url)
  const slug = searchParams.get('step')

  if (!slug) {
    return NextResponse.json({ error: 'Missing step parameter' }, { status: 400 })
  }

  const supabase = await getAdminServiceClient()
  const { data, error } = await supabase
    .from('email_templates')
    .select('html')
    .eq('slug', slug)
    .single()

  if (error || !data) {
    return NextResponse.json({ error: 'Template not found' }, { status: 404 })
  }

  return new NextResponse(data.html, {
    headers: { 'Content-Type': 'text/html' },
  })
}
