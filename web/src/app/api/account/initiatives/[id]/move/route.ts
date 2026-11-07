/**
 * POST /api/account/initiatives/[id]/move
 *
 * Move an initiative to another workspace. Only the initiative row travels
 * (with its owner translated to the matching member in the destination, or
 * dropped if that person isn't there) plus its labels, remapped by name.
 *
 * Its projects stay behind and simply lose the initiative link — a project is
 * a heavy object with its own actions, documents and identifiers, so moving
 * one is an explicit act via POST /api/account/projects/[id]/move.
 * Initiative-scoped saved views are deleted (their filter ids don't
 * translate). There is no preflight endpoint: the blast radius is small
 * enough to state in the dialog copy.
 *
 * Runs in one transaction inside the `public.move_initiative` RPC
 * (migration 221), which performs its own membership and admin/ownership
 * checks on BOTH workspaces — hence `requireUser` here.
 */
import { requireUser } from '@/lib/api-auth'
import {
  apiError,
  badRequest,
  forbidden,
  notFound,
  serverError,
} from '@/lib/api-errors'
import { NextResponse } from 'next/server'

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id: initiativeId } = await params

  let body: { destination_workspace_id?: unknown } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const destinationWorkspaceId = body?.destination_workspace_id
  if (!destinationWorkspaceId || typeof destinationWorkspaceId !== 'string') {
    return badRequest('destination_workspace_id is required')
  }

  const { data, error } = await supabase.rpc('move_initiative', {
    p_initiative_id: initiativeId,
    p_destination_workspace_id: destinationWorkspaceId,
  })

  if (error) {
    // Map Postgres errcodes back to HTTP status (see migration 221).
    //   P0002 — initiative not found (also raised when the caller has no
    //           membership in the SOURCE workspace — never confirms existence)
    //   22023 — same workspace
    //   42501 — not authenticated / insufficient rights on either side
    //   23505 — unique violation (safety net)
    //
    // Note: raw Postgres messages may include workspace/user IDs from
    // RAISE EXCEPTION interpolation. We map to fixed user-facing strings and
    // log the raw message server-side for diagnosis.
    const code = (error as { code?: string }).code
    const rawMessage = error.message ?? ''

    if (code === 'P0002') return notFound('Initiative not found')
    if (code === 'P0003') {
      return badRequest('Destination workspace has no team configured — set one up there first')
    }
    if (code === '22023') return badRequest('Source and destination workspace are the same')
    if (code === '22P02') return badRequest('ids must be valid UUIDs')
    if (code === '42501') {
      return forbidden('You need admin rights (or ownership of this item) to move it')
    }
    if (code === '23505') {
      console.error('[move_initiative] unique violation on move:', rawMessage)
      return badRequest('Move failed: a conflicting record already exists in the destination workspace')
    }

    // PostgREST returns 404 for the RPC when its schema cache is stale (e.g.
    // immediately after the migration is applied). The Supabase client
    // surfaces this without an errcode, so detect it by message and respond
    // with 503 so callers know to retry — and operators know to send
    // NOTIFY pgrst, 'reload schema'.
    if (!code && /could not find the function/i.test(rawMessage)) {
      console.error(
        '[move_initiative] PostgREST schema cache stale — run NOTIFY pgrst, \'reload schema\'',
      )
      return apiError('Move temporarily unavailable, please retry shortly', {
        status: 503,
        code: 'SCHEMA_CACHE_STALE',
      })
    }

    console.error('[move_initiative] unexpected RPC error:', code, rawMessage)
    return serverError('Move failed')
  }

  if (!data) return serverError('move_initiative returned no result')

  return NextResponse.json(data)
}
