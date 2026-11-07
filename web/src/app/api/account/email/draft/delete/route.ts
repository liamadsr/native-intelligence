import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { deleteProviderDraftReport } from '@/lib/integrations/email'
import { getServiceClient } from '@/lib/admin'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'

export async function POST(req: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json()
  const { draft_id } = body as { draft_id?: string }

  if (!draft_id) {
    return NextResponse.json({ error: 'draft_id is required' }, { status: 400 })
  }

  try {
    // The draft, its review row and its hold go (deleteProviderDraftReport releases
    // them whatever the mailbox said); discarding is the person's verdict, so
    // the work that delivered it stops waiting, by the provider id and by the
    // row. Success once those are released; mailbox_deleted says whether the
    // mailbox's copy went too (false: it is still in their Drafts folder).
    const { released, mailboxDeleted, mailboxError } = await deleteProviderDraftReport(user.id, draft_id, { reviewed: true })
    if (mailboxError) console.warn('[email] draft released; mailbox delete failed:', mailboxError instanceof Error ? mailboxError.message : mailboxError)
    const admin = getServiceClient()
    for (const id of [draft_id, ...released]) await resolveWorkForDeliverable(admin, { type: 'email_draft', id })
    return NextResponse.json({ success: true, mailbox_deleted: mailboxDeleted })
  } catch {
    return NextResponse.json({ error: 'Failed to delete draft' }, { status: 500 })
  }
}
