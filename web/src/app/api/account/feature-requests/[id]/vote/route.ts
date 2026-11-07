/**
 * POST   /api/account/feature-requests/[id]/vote  — upvote (idempotent)
 * DELETE /api/account/feature-requests/[id]/vote  — remove your vote
 *
 * vote_count is kept in sync by the trg_update_vote_count DB trigger, so we
 * only touch the votes table here. The UNIQUE(feature_request_id, user_id)
 * constraint makes a double-vote a no-op rather than an error.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await params

  // Only allow voting on a post the caller can see (migration 138/139). The
  // RLS-scoped client returns no row for a private/foreign post → clean 404
  // instead of an opaque RLS WITH CHECK failure.
  const { data: parent } = await supabase
    .from('feature_requests')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!parent) return notFound('Feature request not found')

  // Upsert-style: ignore a duplicate-key conflict so re-voting is idempotent.
  const { error } = await supabase
    .from('feature_request_votes')
    .upsert(
      { feature_request_id: id, user_id: user.id },
      { onConflict: 'feature_request_id,user_id', ignoreDuplicates: true },
    )

  if (error) return serverError(error.message)
  return NextResponse.json({ has_voted: true })
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await params

  const { error } = await supabase
    .from('feature_request_votes')
    .delete()
    .eq('feature_request_id', id)
    .eq('user_id', user.id)

  if (error) return serverError(error.message)
  return NextResponse.json({ has_voted: false })
}
