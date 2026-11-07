import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import { badRequest, serverError, unauthorized } from '@/lib/api-errors'
import {
  EVAL_CANDIDATE_SOURCES,
  EVAL_CANDIDATE_STATUSES,
  type EvalCandidateRow,
  type EvalCandidateSource,
  type EvalCandidateStatus,
} from '@/lib/evals/flywheel/types'

/**
 * GET /api/admin/evals/candidates?status=&source=&limit=
 *
 * The evals flywheel's review queue (/admin/evals; migration 349), newest
 * first, in the environment the admin switcher selects. Each row carries its
 * workspace's name and its person's email, for triage context. `counts` is
 * the number of rows per source under the same status filter (the queue's
 * source tabs), whatever `source` and `limit` say.
 *
 * An empty or `all` status or source means no filter.
 */

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 500

type AdminEvalCandidate = EvalCandidateRow & { workspace_name?: string; user_email?: string }

export async function GET(request: Request) {
  try {
    await requireAdmin()
  } catch {
    return unauthorized()
  }

  const { searchParams } = new URL(request.url)
  const status = filterParam(searchParams.get('status'))
  const source = filterParam(searchParams.get('source'))
  if (status && !(EVAL_CANDIDATE_STATUSES as readonly string[]).includes(status)) {
    return badRequest(`status must be one of: ${EVAL_CANDIDATE_STATUSES.join(', ')}`)
  }
  if (source && !(EVAL_CANDIDATE_SOURCES as readonly string[]).includes(source)) {
    return badRequest(`source must be one of: ${EVAL_CANDIDATE_SOURCES.join(', ')}`)
  }
  const rawLimit = Number.parseInt(searchParams.get('limit') ?? '', 10)
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), MAX_LIMIT) : DEFAULT_LIMIT

  const supabase = await getAdminServiceClient()

  let query = supabase
    .from('eval_candidate')
    .select('*, workspace:workspace_id(name)')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (status) query = query.eq('status', status as EvalCandidateStatus)
  if (source) query = query.eq('source', source as EvalCandidateSource)

  const countFor = async (s: EvalCandidateSource) => {
    let q = supabase.from('eval_candidate').select('id', { count: 'exact', head: true }).eq('source', s)
    if (status) q = q.eq('status', status)
    const { count } = await q
    return [s, count ?? 0] as const
  }

  const [{ data, error }, countPairs] = await Promise.all([
    query,
    Promise.all(EVAL_CANDIDATE_SOURCES.map(countFor)),
  ])
  if (error) return serverError(error.message)

  const rows = (data ?? []) as Array<EvalCandidateRow & { workspace?: { name?: string | null } | null }>

  // One lookup per person in the page (the feature-requests route's way): a
  // page holds a few hundred rows at most, from far fewer people.
  const emailById = new Map<string, string>()
  await Promise.all(
    [...new Set(rows.map((r) => r.user_id))].map(async (id) => {
      const { data: u } = await supabase.auth.admin.getUserById(id)
      if (u?.user?.email) emailById.set(id, u.user.email)
    }),
  )

  const candidates: AdminEvalCandidate[] = rows.map(({ workspace, ...row }) => ({
    ...row,
    workspace_name: workspace?.name ?? undefined,
    user_email: emailById.get(row.user_id),
  }))

  return NextResponse.json({
    candidates,
    counts: Object.fromEntries(countPairs) as Record<EvalCandidateSource, number>,
  })
}

function filterParam(v: string | null): string | null {
  const s = v?.trim()
  return s && s !== 'all' ? s : null
}
