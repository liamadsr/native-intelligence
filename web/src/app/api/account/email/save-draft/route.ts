import { createClient } from '@/lib/supabase/server'
import { saveDraftToProvider } from '@/lib/crm/email-client'
import { parseComposeAttachments } from '@/lib/email/compose-attachments'
import { isProviderId } from '@/lib/email/provider-drafts'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json()

  if (!body.to?.length) {
    return NextResponse.json({ error: 'Recipients required' }, { status: 400 })
  }

  const attachments = parseComposeAttachments(body.attachments)
  if (attachments === 'invalid') {
    return NextResponse.json({ error: 'Check the attachments: 10 files, 3 MB each and 6 MB in all at most' }, { status: 400 })
  }
  // A reply draft names the message it answers, on its thread, by its provider id.
  const inReplyTo = typeof body.in_reply_to_message_id === 'string' && body.in_reply_to_message_id ? body.in_reply_to_message_id : null
  if (inReplyTo && (!isProviderId(inReplyTo) || typeof body.thread_id !== 'string' || !body.thread_id)) {
    return NextResponse.json({ error: 'A reply draft needs its thread and message' }, { status: 400 })
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
      ...(inReplyTo ? { in_reply_to_message_id: inReplyTo } : {}),
      ...(attachments.length ? { attachments } : {}),
    })

    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to save draft'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
