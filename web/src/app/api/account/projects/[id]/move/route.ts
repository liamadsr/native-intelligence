/**
 * POST /api/account/projects/[id]/move
 *
 * Move a project to another workspace, deeply: the project row, its
 * milestones, every action in it (identifiers kept unless they collide in the
 * destination, then renumbered), its labels remapped by name, and — unless
 * `move_documents` is false — the documents filed under it plus the knowledge
 * claims those documents solely evidence.
 *
 * Things that deliberately do NOT travel: captures linked to the project
 * (they have their own move flow, so they're unlinked), sub-projects, the
 * initiative link, cloud-environment binding, project-scoped saved views
 * (their filter ids don't translate — deleted), and external tracker links on
 * the actions (severed). GET .../move/preflight quantifies all of it.
 *
 * The whole thing runs in one transaction inside the `public.move_project`
 * RPC (migration 221), which performs its own membership and admin/ownership
 * checks on BOTH workspaces — that's why this route only needs `requireUser`.
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

  const { id: projectId } = await params

  let body: {
    destination_workspace_id?: unknown
    destination_team_id?: unknown
    move_documents?: unknown
  } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const destinationWorkspaceId = body?.destination_workspace_id
  if (!destinationWorkspaceId || typeof destinationWorkspaceId !== 'string') {
    return badRequest('destination_workspace_id is required')
  }

  // Optional: which team in the destination hosts the moved actions. Omitted
  // means "let the RPC pick the destination's default team" (P0003 if there
  // isn't one).
  const destinationTeamId = body?.destination_team_id
  if (
    destinationTeamId !== undefined &&
    destinationTeamId !== null &&
    (typeof destinationTeamId !== 'string' || destinationTeamId.length === 0)
  ) {
    return badRequest('destination_team_id must be a team id')
  }

  if (body?.move_documents !== undefined && typeof body.move_documents !== 'boolean') {
    return badRequest('move_documents must be a boolean')
  }
  const moveDocuments = body?.move_documents ?? true

  const { data, error } = await supabase.rpc('move_project', {
    p_project_id: projectId,
    p_destination_workspace_id: destinationWorkspaceId,
    p_destination_team_id: (destinationTeamId as string | undefined) ?? null,
    p_move_documents: moveDocuments,
  })

  if (error) {
    // Map Postgres errcodes back to HTTP status (see migration 221).
    //   P0002 — project not found (also raised when the caller has no
    //           membership in the SOURCE workspace, so it never confirms the
    //           existence of a project in a workspace the caller can't see)
    //   P0003 — destination workspace has no team with a default state
    //   P0004 — bad id selection (ids spanning workspaces)
    //   P0005 — the workspace's default project, which can't move
    //   22023 — same workspace
    //   42501 — not authenticated / insufficient rights on either side
    //   23505 — unique violation (safety net; the engine renumbers instead)
    //
    // Note: raw Postgres messages may include workspace/user IDs from
    // RAISE EXCEPTION interpolation. We map to fixed user-facing strings and
    // log the raw message server-side for diagnosis.
    const code = (error as { code?: string }).code
    const rawMessage = error.message ?? ''

    if (code === 'P0002') return notFound('Project not found')
    if (code === 'P0003') {
      return badRequest('Destination workspace has no team configured — set one up there first')
    }
    if (code === 'P0004') {
      return badRequest('Move failed: the selected items span more than one workspace')
    }
    if (code === 'P0005') return badRequest('The default project cannot be moved')
    if (code === '22023') return badRequest('Source and destination workspace are the same')
    if (code === '22P02') return badRequest('ids must be valid UUIDs')
    if (code === '42501') {
      // Migration 360: the product doc moves only for an owner or admin. The
      // raw text is ours (no ids in it), but we still answer with a fixed line.
      if (/product doc/i.test(rawMessage)) {
        return forbidden('Only a workspace owner or admin can move a project that holds the workspace product doc')
      }
      return forbidden('You need admin rights (or ownership of this item) to move it')
    }
    if (code === '23505') {
      console.error('[move_project] unique violation on move:', rawMessage)
      return badRequest('Move failed: a conflicting record already exists in the destination workspace')
    }

    // PostgREST returns 404 for the RPC when its schema cache is stale (e.g.
    // immediately after the migration is applied). The Supabase client
    // surfaces this without an errcode, so detect it by message and respond
    // with 503 so callers know to retry — and operators know to send
    // NOTIFY pgrst, 'reload schema'.
    if (!code && /could not find the function/i.test(rawMessage)) {
      console.error(
        '[move_project] PostgREST schema cache stale — run NOTIFY pgrst, \'reload schema\'',
      )
      return apiError('Move temporarily unavailable, please retry shortly', {
        status: 503,
        code: 'SCHEMA_CACHE_STALE',
      })
    }

    console.error('[move_project] unexpected RPC error:', code, rawMessage)
    return serverError('Move failed')
  }

  if (!data) return serverError('move_project returned no result')

  return NextResponse.json(data)
}
