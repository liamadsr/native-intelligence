import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { apiError, badRequest, notFound, serverError, unauthorized } from '@/lib/api-errors'
import { validateCaseDraft } from '@/lib/evals/flywheel/case-schema'

/**
 * PATCH /api/admin/evals/candidates/[id]
 *   { status: 'new' | 'dismissed' | 'promoted', case_draft?: { skill, case } }
 *
 * A reviewer's call on one flywheel candidate (/admin/evals):
 *   dismissed  not a useful case;
 *   promoted   a chat skill eval case: `case_draft` is required and must pass
 *              validateCaseDraft (the shape the static test checks), and is
 *              stored as validated;
 *   new        reopened, back in the queue.
 * Every call stamps `reviewed_by` and `reviewed_at`. An exported row can be
 * reopened (`new`) or promoted again with a fixed case: `exported_at` clears,
 * so the next export carries it, and the import dedupes on candidateId, so a
 * re-export is harmless. Dismissing an exported row is refused (409): its
 * case is already in the repository, which a dismissal here wouldn't undo.
 */

const SETTABLE = ['new', 'dismissed', 'promoted'] as const
type SettableStatus = (typeof SETTABLE)[number]

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let admin: { id: string }
  try {
    admin = await requireAdmin()
  } catch {
    return unauthorized()
  }

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  const { status, case_draft } = (body && typeof body === 'object' ? body : {}) as {
    status?: unknown
    case_draft?: unknown
  }
  if (typeof status !== 'string' || !(SETTABLE as readonly string[]).includes(status)) {
    return badRequest(`status must be one of: ${SETTABLE.join(', ')}`)
  }

  const update: Record<string, unknown> = {
    status: status as SettableStatus,
    reviewed_by: admin.id,
    reviewed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  if (status === 'promoted') {
    if (case_draft === undefined || case_draft === null) return badRequest('Promoting needs a case_draft')
    const checked = validateCaseDraft(case_draft)
    if (!checked.ok) return badRequest(checked.error)
    update.case_draft = checked.value
  }

  const supabase = await getAdminServiceClient()

  const { data: existing, error: readError } = await supabase
    .from('eval_candidate')
    .select('id, status')
    .eq('id', id)
    .maybeSingle()
  if (readError) return serverError(readError.message)
  if (!existing) return notFound('Candidate not found')
  if (existing.status === 'exported' && status === 'dismissed') {
    return apiError('Already exported: its case is in the repository. Reopen it instead.', { status: 409, code: 'LOCKED' })
  }
  // Back in the queue or promoted again: the next export carries it.
  if (status !== 'dismissed') update.exported_at = null

  const { data, error } = await supabase
    .from('eval_candidate')
    .update(update)
    .eq('id', id)
    // Fenced on the status read: an export (or another reviewer) that landed
    // between the read and this write wins, rather than being silently undone.
    .eq('status', existing.status)
    .select()
    .maybeSingle()
  if (error) return serverError(error.message)
  if (!data) return apiError('Changed since it was read: reload and try again', { status: 409, code: 'CONFLICT' })

  return NextResponse.json({ candidate: data })
}
