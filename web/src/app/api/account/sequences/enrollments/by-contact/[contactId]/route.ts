/**
 * GET /api/account/sequences/enrollments/by-contact/[contactId]
 *
 * Every enrollment (active + history) for one contact, with the parent
 * sequence's name/status/timezone and the sequence's active-step count so the
 * contact panel can render "Step 2 of 3" without loading each sequence.
 *
 * RLS-scoped client (requireWorkspace) — enrollment reads ride workspace
 * membership plus contact visibility per migration 227, so an empty result
 * for a contact the caller can't see is the correct answer.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { serverError } from '@/lib/api-errors'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ contactId: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { contactId } = await params

  const { data: enrollments, error } = await supabase
    .from('sequence_enrollment')
    .select(
      'id, sequence_id, status, exit_reason, current_step_order, next_send_at, contact_email, created_at, updated_at, sequence:sequence_id(id, name, status, timezone)',
    )
    .eq('workspace_id', workspaceId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: false })
  if (error) {
    console.error('[sequences] by-contact enrollments failed:', error.message)
    return serverError()
  }

  const rows = enrollments ?? []
  const sequenceIds = [...new Set(rows.map((e) => e.sequence_id as string))]

  // Active-step counts per sequence (for "Step X of N").
  const stepCounts = new Map<string, number>()
  if (sequenceIds.length > 0) {
    const { data: steps, error: stepsError } = await supabase
      .from('sequence_step')
      .select('sequence_id')
      .in('sequence_id', sequenceIds)
      .eq('is_active', true)
    if (stepsError) {
      console.error('[sequences] by-contact step counts failed:', stepsError.message)
      return serverError()
    }
    for (const s of steps ?? []) {
      const id = s.sequence_id as string
      stepCounts.set(id, (stepCounts.get(id) ?? 0) + 1)
    }
  }

  return NextResponse.json({
    enrollments: rows.map((e) => ({
      ...e,
      step_count: stepCounts.get(e.sequence_id as string) ?? 0,
    })),
  })
}
