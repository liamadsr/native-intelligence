import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { sendEmail } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export const maxDuration = 30

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const body = await request.json()

  if (!body.to?.length) {
    return NextResponse.json({ error: 'Recipients required' }, { status: 400 })
  }

  if (!body.subject && !body.thread_id) {
    return NextResponse.json({ error: 'Subject required for new emails' }, { status: 400 })
  }

  try {
    const result = await sendEmail(user.id, workspaceId, {
      thread_id: body.thread_id,
      in_reply_to_message_id: body.in_reply_to_message_id,
      to: body.to,
      cc: body.cc,
      bcc: body.bcc,
      subject: body.subject || '',
      body_html: body.body_html || '',
      body_text: body.body_text,
      draft_id: body.draft_id,
      provider_draft_id: body.provider_draft_id,
      // The From mailbox picked in the composer; sendEmail checks it is the
      // caller's own email account. Unset falls back to the default mailbox.
      account_id: typeof body.account_id === 'string' && body.account_id ? body.account_id : undefined,
    })

    return NextResponse.json(result)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Failed to send email'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}
