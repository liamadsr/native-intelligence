/**
 * /api/account/evals/suites/[id]/cases — a suite's cases, and authoring one.
 *
 * GET returns LIST fields only (`CASE_LIST_FIELDS`): no script, chunks or
 * expected. A suite of twenty cases carries twenty transcripts and the screen
 * renders none of them; the case editor asks for the one row it opens.
 *
 * POST is the workhorse. It hands off to `createEvalCase`, which computes the
 * frozen chunks, writes the template eval capture (`is_eval`, private, demo
 * flag, participant links stripped, a `chat_conversations` row) and the case
 * row together. That work needs the SERVICE client — the capture it writes is
 * private under this user and the participant/conversation rows it seeds are
 * not reachable through the caller's own RLS — so the suite is verified on the
 * RLS-scoped client FIRST and only then does the service write run, scoped to
 * the workspace that read resolved. The service client is never the thing that
 * decides whether the caller may write here.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { getServiceClient } from '@/lib/admin'
import { requireWorkspace, requireWorkspaceFeature } from '@/lib/api-auth'
import { notFound, serverError } from '@/lib/api-errors'
import { createEvalCase } from '@/lib/evals/create-case'
import { getSuite, listCases } from '@/lib/evals/queries'
import { CreateCaseSchema } from '../../../schemas'
import { parseBody } from '../../../parse-body'

export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, workspaceId } = auth
  const { id } = await params

  const suite = await getSuite(supabase, workspaceId, id)
  if (!suite) return notFound('Suite not found')

  const cases = await listCases(supabase, id)
  return NextResponse.json({ cases })
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const gated = await requireWorkspaceFeature(auth, 'evals')
  if (gated) return gated
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const suite = await getSuite(supabase, workspaceId, id)
  if (!suite) return notFound('Suite not found')

  const parsed = await parseBody(request, CreateCaseSchema)
  if (!parsed.ok) return parsed.response
  const body = parsed.data

  try {
    const caseRow = await createEvalCase(getServiceClient(), {
      workspaceId,
      userId: user.id,
      suiteId: id,
      name: body.name,
      script: body.script,
      participants: body.participants,
      expected: body.expected,
      polarity: body.polarity,
      modes: body.modes,
    })
    return NextResponse.json({ case: caseRow }, { status: 201 })
  } catch (err) {
    console.error('[evals] create case failed:', err)
    return serverError()
  }
}
