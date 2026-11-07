import { createClient } from '@/lib/supabase/server'
import { createEmailDraft } from '@/lib/integrations/email'
import { logSentEmailInteractions } from '@/lib/crm/email-client'
import { NextResponse, type NextRequest } from 'next/server'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data: draft, error } = await supabase
    .from('email_draft')
    .select('*')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (error || !draft) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })

  // Save to provider as draft (NOT send)
  try {
    const result = await createEmailDraft(user.id, {
      to: draft.to_emails || [],
      subject: draft.subject || '',
      body: draft.body_text || draft.body_html || '',
      cc: draft.cc_emails || [],
    })

    // Update our record
    await supabase
      .from('email_draft')
      .update({
        provider_draft_id: result.id,
        status: 'approved',
        updated_at: new Date().toISOString(),
      })
      .eq('id', id)

    // Interaction records for contacts: a template title and a pointer, never the subject.
    await logSentEmailInteractions(draft.workspace_id, draft.to_emails || [], { referenceId: draft.provider_thread_id })

    return NextResponse.json({ provider_draft_id: result.id })
  } catch (e) {
    return NextResponse.json({ error: 'Failed to save to provider' }, { status: 500 })
  }
}
