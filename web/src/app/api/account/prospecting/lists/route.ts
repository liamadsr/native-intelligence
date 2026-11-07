/**
 * /api/account/prospecting/lists — index + create.
 *
 * Like the sequence routes, every query runs on the RLS-scoped client from
 * `requireWorkspace` — never the service client. Migration 248's policies are
 * the boundary (workspace membership for read/write, creator-or-admin for
 * DELETE on the list itself), and the lib functions carry an explicit
 * `workspace_id` filter on top, so neither layer is load-bearing alone.
 *
 * Decision 5: ANY member can create and run a list. There is no
 * `requireWorkspaceMember` role gate here — the spend ceiling is the control,
 * not a permission.
 */
import { NextResponse, type NextRequest } from 'next/server'
import { requireWorkspace } from '@/lib/api-auth'
import { apiError, badRequest, serverError } from '@/lib/api-errors'
import { createList, listLists } from '@/lib/prospecting/lists'

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const includeArchived = request.nextUrl.searchParams.get('include_archived') === 'true'
  const result = await listLists(supabase, { workspaceId, includeArchived })
  if (!result.ok) return serverError()
  return NextResponse.json({ lists: result.lists })
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const result = await createList(supabase, {
    workspaceId,
    userId: user.id,
    input: {
      name: typeof body.name === 'string' ? body.name : '',
      description: typeof body.description === 'string' ? body.description : null,
      purpose: body.purpose,
      icp: body.icp,
      source_company_id: typeof body.source_company_id === 'string' ? body.source_company_id : null,
      exclude_crm: body.exclude_crm,
      exclude_other_lists: body.exclude_other_lists,
      exclude_contacted: body.exclude_contacted,
      max_spend_dollars: body.max_spend_dollars,
      target_new_candidates: body.target_new_candidates,
      max_rounds: body.max_rounds,
      people_per_company: body.people_per_company,
    },
  })

  if (!result.ok) {
    // A duplicate name is a 409 the user fixes in one keystroke, never a 500.
    if (result.code === 'LIST_NAME_TAKEN') {
      return apiError(result.error, { status: 409, code: 'LIST_NAME_TAKEN' })
    }
    if (result.code === 'INVALID_INPUT') return badRequest(result.error)
    return serverError()
  }

  return NextResponse.json({ list: result.list }, { status: 201 })
}
