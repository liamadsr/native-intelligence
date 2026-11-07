/**
 * GET   /api/account/feature-requests  — list the public board (sort/filter)
 * POST  /api/account/feature-requests  — create a feature request
 * PATCH /api/account/feature-requests  — edit your own request's title/description
 *
 * Global, cross-workspace board — see lib/feature-requests/queries.ts.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireUser } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import {
  FEATURE_REQUEST_STATUSES,
  FEEDBACK_TYPES,
  FEEDBACK_VISIBILITIES,
  getUserVotedIds,
  resolveAuthorNames,
  type FeatureRequestRow,
  type FeedbackType,
  type FeedbackVisibility,
} from '@/lib/feature-requests/queries'

export async function GET(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const params = request.nextUrl.searchParams
  const status = params.get('status')
  const type = params.get('type')
  const sort = params.get('sort') === 'newest' ? 'created_at' : 'vote_count'
  const limit = Math.min(parseInt(params.get('limit') ?? '100', 10) || 100, 200)

  let query = supabase
    .from('feature_requests')
    .select('*')
    .order(sort, { ascending: false })
    .limit(limit)

  if (status && FEATURE_REQUEST_STATUSES.includes(status as never)) {
    query = query.eq('status', status)
  }
  if (type && FEEDBACK_TYPES.includes(type as never)) {
    query = query.eq('type', type)
  }

  const { data, error } = await query
  if (error) return serverError(error.message)

  const rows = (data ?? []) as FeatureRequestRow[]
  const [authorNames, votedIds] = await Promise.all([
    resolveAuthorNames(rows.map((r) => r.user_id)),
    getUserVotedIds(supabase, user.id, rows.map((r) => r.id)),
  ])

  const feature_requests = rows.map((r) => ({
    ...r,
    author: {
      user_id: r.user_id,
      name: authorNames[r.user_id] ?? 'Anonymous',
      is_self: r.user_id === user.id,
    },
    has_voted: votedIds.has(r.id),
    can_edit: r.user_id === user.id,
  }))

  return NextResponse.json({ feature_requests })
}

export async function POST(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const body = await request.json().catch(() => ({}))
  const title = String(body.title ?? '').trim()
  const description =
    body.description != null ? String(body.description).trim() : null
  const type: FeedbackType = FEEDBACK_TYPES.includes(body.type as never)
    ? (body.type as FeedbackType)
    : 'feature_request'
  const visibility: FeedbackVisibility = FEEDBACK_VISIBILITIES.includes(body.visibility as never)
    ? (body.visibility as FeedbackVisibility)
    : 'public'

  if (!title) return badRequest('Title is required')
  if (title.length > 200) return badRequest('Title must be 200 characters or fewer')

  const { data, error } = await supabase
    .from('feature_requests')
    .insert({ user_id: user.id, title, description: description || null, type, visibility })
    .select('*')
    .single()

  if (error) return serverError(error.message)

  return NextResponse.json({
    feature_request: {
      ...(data as FeatureRequestRow),
      author: { user_id: user.id, name: 'You', is_self: true },
      has_voted: false,
      can_edit: true,
    },
  })
}

export async function PATCH(request: NextRequest) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase, user } = auth

  const body = await request.json().catch(() => ({}))
  const id = String(body.id ?? '')
  if (!id) return badRequest('id is required')

  // Confirm ownership before update so we can return a clean 403/404 rather
  // than a silent zero-row RLS update.
  const { data: existing } = await supabase
    .from('feature_requests')
    .select('user_id')
    .eq('id', id)
    .maybeSingle<{ user_id: string }>()

  if (!existing) return notFound('Feature request not found')
  if (existing.user_id !== user.id) return forbidden('You can only edit your own requests')

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() }
  if (body.title !== undefined) {
    const title = String(body.title).trim()
    if (!title) return badRequest('Title cannot be empty')
    if (title.length > 200) return badRequest('Title must be 200 characters or fewer')
    updates.title = title
  }
  if (body.description !== undefined) {
    updates.description = body.description ? String(body.description).trim() : null
  }
  if (body.visibility !== undefined) {
    if (!FEEDBACK_VISIBILITIES.includes(body.visibility as never)) {
      return badRequest('Invalid visibility')
    }
    updates.visibility = body.visibility
  }

  const { data, error } = await supabase
    .from('feature_requests')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single()

  if (error) return serverError(error.message)
  return NextResponse.json({ feature_request: data })
}
