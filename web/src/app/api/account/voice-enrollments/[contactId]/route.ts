import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse } from 'next/server'

/**
 * GET /api/account/voice-enrollments/[contactId]
 *
 * Get enrollment count and trust data for a specific contact.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { contactId } = await params

  const { count, error } = await supabase
    .from('voice_enrollment')
    .select('*', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const { data: trust } = await supabase
    .from('voice_contact_trust')
    .select('confirmation_count, total_enrollment_count')
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)
    .single()

  return NextResponse.json({
    contactId,
    enrollmentCount: count || 0,
    confirmationCount: trust?.confirmation_count ?? 0,
    totalEnrollmentCount: trust?.total_enrollment_count ?? count ?? 0,
  })
}

/**
 * DELETE /api/account/voice-enrollments/[contactId]
 *
 * Remove all voice enrollments AND reset trust for a contact.
 * Full voice data reset — used when a profile has drifted or was incorrectly enrolled.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { contactId } = await params

  // Delete all enrollment vectors
  const { error: enrollError } = await supabase
    .from('voice_enrollment')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)

  if (enrollError) return NextResponse.json({ error: enrollError.message }, { status: 500 })

  // Delete trust row (resets confirmation_count to 0)
  await supabase
    .from('voice_contact_trust')
    .delete()
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)

  return NextResponse.json({ deleted: true })
}
