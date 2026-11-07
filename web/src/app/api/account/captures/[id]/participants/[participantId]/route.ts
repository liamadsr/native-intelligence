import { createClient } from '@/lib/supabase/server'
import { NextResponse, type NextRequest } from 'next/server'

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { participantId } = await params
  const body = await request.json()

  const updates: Record<string, unknown> = {}
  if (body.speaker_label !== undefined) updates.speaker_label = body.speaker_label
  if (body.role !== undefined) updates.role = body.role
  if (body.external_name !== undefined) updates.external_name = body.external_name
  if (body.external_email !== undefined) updates.external_email = body.external_email
  if (body.company !== undefined) updates.company = body.company
  if (body.job_title !== undefined) updates.job_title = body.job_title
  if (body.contact_id !== undefined) updates.contact_id = body.contact_id
  if (body.source !== undefined) updates.source = body.source

  const { data, error } = await supabase
    .from('capture_participant')
    .update(updates)
    .eq('id', participantId)
    .select('id, capture_id, member_id, external_name, external_email, company, job_title, speaker_label, role')
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ participant: data })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; participantId: string }> },
) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { participantId } = await params

  const { error } = await supabase
    .from('capture_participant')
    .delete()
    .eq('id', participantId)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
