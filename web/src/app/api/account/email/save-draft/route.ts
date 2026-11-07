import { createClient } from '@/lib/supabase/server'
import { saveDraftToProvider } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  if (!body.to?.length) {
    return NextResponse.json({ error: 'Recipients required' }, { status: 400 })
  }

  try {
    const result = await saveDraftToProvider(user.id, {
      thread_id: body.thread_id,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject || '',
      body_html: body.body_html || '',
      account_id: typeof body.account_id === 'string' && body.account_id ? body.account_id : null,
    })

    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to save draft'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
