import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { getServiceClient } from '@/lib/admin'
import { resolveWorkForDeliverable } from '@/lib/work/resolve'
import { draftRowsFor, releaseDraftRows, touchHold } from '@/lib/email/hold'
import { NextResponse, type NextRequest } from 'next/server'

/** A draft the user has acted on (sent, dismissed) stops holding its work item
 *  open (ACTIVITY-AND-REVIEW-DESIGN §4.3). Service role: the ledger is
 *  server-written; best-effort, never fails the draft write. */
const SETTLED_DRAFT_STATUSES = new Set(['sent', 'dismissed'])
async function resolveDraftWork(draftId: string) {
  await resolveWorkForDeliverable(getServiceClient(), { type: 'email_draft', id: draftId })
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  const { data, error } = await supabase
    .from('email_draft')
    .select('*, email_thread:email_thread_id(from_email, participant_emails, provider_thread_id)')
    .eq('id', id)
    .eq('user_id', user.id)
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  return NextResponse.json({ draft: data })
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params
  const body = await request.json()

  // Sent or dismissed: the holding pattern lets nothing linger. The row goes,
  // and its hold (the thread's copy) with it (src/lib/email/hold.ts).
  if (typeof body.status === 'string' && SETTLED_DRAFT_STATUSES.has(body.status)) {
    const admin = getServiceClient()
    const rows = await draftRowsFor(admin, user.id, { draftId: id })
    if (!rows.length) return NextResponse.json({ error: 'Draft not found' }, { status: 404 })
    await releaseDraftRows(admin, user.id, rows, { reviewed: true })
    await resolveDraftWork(id)
    return NextResponse.json({ draft: null, released: true })
  }

  const updates: Record<string, unknown> = {}
  if (body.body_text !== undefined) updates.body_text = body.body_text
  if (body.body_html !== undefined) updates.body_html = body.body_html
  if (body.status !== undefined) updates.status = body.status
  if (body.to_emails !== undefined) updates.to_emails = body.to_emails
  if (body.cc_emails !== undefined) updates.cc_emails = body.cc_emails
  // The person's own edit: a new message on the thread keeps their text and
  // marks it stale instead of re-drafting over it (heldThreadAction).
  const edited = ['body_text', 'body_html', 'to_emails', 'cc_emails'].some((k) => body[k] !== undefined)
  if (edited && body.status === undefined) updates.status = 'edited'

  updates.updated_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('email_draft')
    .update(updates)
    .eq('id', id)
    .eq('user_id', user.id)
    .select()
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Editing is touching: the hold lives another 14 days.
  const holdId = (data as { hold_id?: unknown } | null)?.hold_id
  if (edited && typeof holdId === 'string') await touchHold(getServiceClient(), user.id, holdId)

  return NextResponse.json({ draft: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { id } = await params

  // The row goes, and its hold (the thread's copy) with it.
  const admin = getServiceClient()
  const rows = await draftRowsFor(admin, user.id, { draftId: id })
  if (rows.length) await releaseDraftRows(admin, user.id, rows, { reviewed: true })

  // Discarding the draft is the user's verdict on it.
  await resolveDraftWork(id)

  return NextResponse.json({ success: true })
}
