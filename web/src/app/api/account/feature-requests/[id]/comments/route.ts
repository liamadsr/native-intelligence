/**
 * GET  /api/account/feature-requests/[id]/comments  — list comments (oldest first)
 * POST /api/account/feature-requests/[id]/comments  — add a comment
 *
 * comment_count is kept in sync by the trg_update_comment_count DB trigger.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import {
  resolveAuthorNames,
  type FeatureRequestComment,
} from '@/lib/feature-requests/queries'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await params

  // Defense-in-depth on top of migration 139's visibility-aware child RLS: the
  // RLS-scoped client only returns a feature_requests row that's public or the
  // caller's own (migration 138), so a missing row means the post is private/
  // foreign — 404 rather than leak its thread.
  const { data: parent } = await supabase
    .from('feature_requests')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!parent) return notFound('Feature request not found')

  const { data, error } = await supabase
    .from('feature_request_comments')
    .select('*')
    .eq('feature_request_id', id)
    .order('created_at', { ascending: true })

  if (error) return serverError(error.message)

  const rows = (data ?? []) as FeatureRequestComment[]
  const authorNames = await resolveAuthorNames(rows.map((r) => r.user_id))

  const comments = rows.map((c) => ({
    ...c,
    author: {
      user_id: c.user_id,
      name: authorNames[c.user_id] ?? 'Anonymous',
      is_self: c.user_id === user.id,
    },
  }))

  return NextResponse.json({ comments })
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth
  const { id } = await params

  const body = await request.json().catch(() => ({}))
  const text = String(body.body ?? '').trim()
  if (!text) return badRequest('Comment cannot be empty')
  if (text.length > 5000) return badRequest('Comment is too long')

  // Only allow commenting on a post the caller can see (migration 138/139).
  const { data: parent } = await supabase
    .from('feature_requests')
    .select('id')
    .eq('id', id)
    .maybeSingle()
  if (!parent) return notFound('Feature request not found')

  const { data, error } = await supabase
    .from('feature_request_comments')
    .insert({ feature_request_id: id, user_id: user.id, body: text })
    .select('*')
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({
    comment: {
      ...(data as FeatureRequestComment),
      author: { user_id: user.id, name: 'You', is_self: true },
    },
  })
}
