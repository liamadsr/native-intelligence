/**
 * /api/account/sequences/[id]/enrollments/[enrollmentId]
 *
 *   DELETE                      — remove the contact from the sequence: exit
 *                                 'removed'. History (ledger) is kept; the row
 *                                 is never hard-deleted. Idempotent.
 *   POST { action: 'opt_out' }  — the contact asked to stop: add their email
 *                                 to the workspace suppression list (reason
 *                                 'opted_out') AND exit 'opted_out'. The
 *                                 suppression also blocks re-enrollment.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'

async function loadEnrollment(
  supabase: SupabaseClient,
  workspaceId: string,
  sequenceId: string,
  enrollmentId: string,
) {
  const { data, error } = await supabase
    .from('sequence_enrollment')
    .select('id, status, contact_email')
    .eq('id', enrollmentId)
    .eq('sequence_id', sequenceId)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  return { data, error }
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id, enrollmentId } = await params

  const { data: enrollment, error } = await loadEnrollment(supabase, workspaceId, id, enrollmentId)
  if (error) {
    console.error('[sequences] enrollment load failed:', error.message)
    return serverError()
  }
  if (!enrollment) return notFound('Enrollment not found')

  const { error: exitError } = await supabase
    .from('sequence_enrollment')
    .update({ status: 'exited', exit_reason: 'removed', next_send_at: null })
    .eq('id', enrollmentId)
    .eq('status', 'active')
  if (exitError) {
    console.error('[sequences] enrollment remove failed:', exitError.message)
    return serverError()
  }
  return NextResponse.json({ removed: true })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id, enrollmentId } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (body.action !== 'opt_out') {
    return badRequest("action must be 'opt_out'")
  }

  const { data: enrollment, error } = await loadEnrollment(supabase, workspaceId, id, enrollmentId)
  if (error) {
    console.error('[sequences] enrollment load failed:', error.message)
    return serverError()
  }
  if (!enrollment) return notFound('Enrollment not found')

  // Suppress first: even if the exit below races something, the address is
  // protected. Stored lowercased (the unique index is on lower(email)); a
  // duplicate insert (23505) means it's already suppressed — fine.
  const { error: suppressError } = await supabase.from('outreach_suppression').insert({
    workspace_id: workspaceId,
    email: (enrollment.contact_email as string).toLowerCase(),
    reason: 'opted_out',
    created_by: user.id,
  })
  if (suppressError && suppressError.code !== '23505') {
    console.error('[sequences] opt-out suppression insert failed:', suppressError.message)
    return serverError()
  }

  const { error: exitError } = await supabase
    .from('sequence_enrollment')
    .update({ status: 'exited', exit_reason: 'opted_out', next_send_at: null })
    .eq('id', enrollmentId)
    .eq('status', 'active')
  if (exitError) {
    console.error('[sequences] opt-out exit failed:', exitError.message)
    return serverError()
  }

  return NextResponse.json({ opted_out: true })
}
