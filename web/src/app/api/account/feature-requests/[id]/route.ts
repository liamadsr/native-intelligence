/**
 * GET /api/account/feature-requests/[id] — single request, enriched with author
 * identity + the current user's vote/edit state. Powers the detail panel.
 *
 * Global, cross-workspace board — see lib/feature-requests/queries.ts.
 */
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import {
  getUserVotedIds,
  resolveAuthorNames,
  type FeatureRequestRow,
} from '@/lib/feature-requests/queries'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const { id } = await params

  const { data, error } = await supabase
    .from('feature_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!data) return notFound('Feature request not found')

  const row = data as FeatureRequestRow
  const [authorNames, votedIds] = await Promise.all([
    resolveAuthorNames([row.user_id]),
    getUserVotedIds(supabase, user.id, [row.id]),
  ])

  const feature_request = {
    ...row,
    author: {
      user_id: row.user_id,
      name: authorNames[row.user_id] ?? 'Anonymous',
      is_self: row.user_id === user.id,
    },
    has_voted: votedIds.has(row.id),
    can_edit: row.user_id === user.id,
  }

  return NextResponse.json({ feature_request })
}
