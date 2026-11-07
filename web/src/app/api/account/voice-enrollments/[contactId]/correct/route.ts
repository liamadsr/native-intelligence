import { createClient } from '@/lib/supabase/server'
import { getCurrentWorkspaceId } from '@/lib/workspace'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * POST /api/account/voice-enrollments/[contactId]/correct
 *
 * Apply trust penalty when a user corrects a wrong auto-assignment.
 * - Decrements confirmation_count by 2 (floor 0)
 * - Increments correction_count by 1
 * - Deletes enrollment rows from the specified session (wrong-person audio)
 * - If correction_count >= 3, resets to learning tier (confirmation_count = 0)
 *
 * Body: { session_id: string }
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const workspaceId = await getCurrentWorkspaceId()
  if (!workspaceId) return NextResponse.json({ error: 'No workspace' }, { status: 400 })

  const { contactId } = await params
  const body = await request.json()
  const { session_id } = body as { session_id: string }

  if (!session_id) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 })
  }

  // Delete enrollment rows from this session for the incorrect contact
  const { count: deletedCount } = await supabase
    .from('voice_enrollment')
    .delete({ count: 'exact' })
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)
    .eq('session_id', session_id)

  // Read-modify-write the trust counters under optimistic concurrency. No
  // atomic-increment RPC exists for voice_contact_trust, so we guard the UPDATE
  // with the counter values we just read (in the .eq() conditions) and retry a
  // couple of times if a concurrent writer changed them out from under us.
  const MAX_ATTEMPTS = 3
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    // Fetch current trust row
    const { data: trust } = await supabase
      .from('voice_contact_trust')
      .select('id, confirmation_count, correction_count, total_enrollment_count')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .single()

    if (!trust) {
      return NextResponse.json({ corrected: true, deletedEnrollments: deletedCount || 0 })
    }

    const newCorrectionCount = (trust.correction_count ?? 0) + 1
    // If 3+ corrections, full reset to learning tier
    const shouldFullReset = newCorrectionCount >= 3
    const newConfirmationCount = shouldFullReset
      ? 0
      : Math.max(0, trust.confirmation_count - 2)
    const newTotalEnrollment = Math.max(0, trust.total_enrollment_count - (deletedCount || 0))

    // Optimistic guard: only apply if the counters still match what we read.
    const { data: updated } = await supabase
      .from('voice_contact_trust')
      .update({
        confirmation_count: newConfirmationCount,
        correction_count: shouldFullReset ? 0 : newCorrectionCount,
        total_enrollment_count: newTotalEnrollment,
        updated_at: new Date().toISOString(),
      })
      .eq('id', trust.id)
      .eq('confirmation_count', trust.confirmation_count)
      .eq('correction_count', trust.correction_count)
      .eq('total_enrollment_count', trust.total_enrollment_count)
      .select('id')

    if (updated && updated.length > 0) {
      return NextResponse.json({
        corrected: true,
        deletedEnrollments: deletedCount || 0,
        newConfirmationCount,
        newCorrectionCount: shouldFullReset ? 0 : newCorrectionCount,
        fullReset: shouldFullReset,
      })
    }
    // 0 rows affected — a concurrent update won the race; re-read and retry.
  }

  return NextResponse.json(
    { error: 'Trust update conflict, please retry', code: 'CONFLICT' },
    { status: 409 },
  )
}
