/**
 * POST /api/account/actions/move
 *
 * Move one or more actions to another workspace. Unlike the capture move
 * (which drags a whole meeting's derived graph along), this is the standalone
 * action move: the actions themselves, their attachments, comments, and
 * sub-action tree within the selection travel; everything that cannot survive
 * the boundary is severed by the engine — the project is left behind, capture
 * links are cut, external tracker links (Jira/Linear/Asana) are unlinked, and
 * agent runs are dropped.
 *
 * All of it happens in one transaction inside the `public.move_actions` RPC
 * (migration 221), which also owns the authorization: plain members may only
 * move actions they created, admins may move any. This route validates the
 * request shape, calls the RPC on the USER client so `auth.uid()` is the
 * caller, and maps the RPC's errcodes onto HTTP.
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

/** Matches the engine's own ceiling (`move_actions` raises 22023 above it). */
const MAX_ACTION_IDS = 500

export async function POST(req: Request) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  let body: {
    action_ids?: unknown
    destination_workspace_id?: unknown
    destination_team_id?: unknown
  } | null = null
  try {
    body = await req.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const rawActionIds = body?.action_ids
  if (
    !Array.isArray(rawActionIds) ||
    rawActionIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return badRequest('action_ids must be an array of action ids')
  }
  const actionIds = [...new Set(rawActionIds as string[])]
  if (actionIds.length === 0) {
    return badRequest('action_ids is required')
  }
  if (actionIds.length > MAX_ACTION_IDS) {
    return badRequest('action_ids is too large')
  }

  const destinationWorkspaceId = body?.destination_workspace_id
  if (!destinationWorkspaceId || typeof destinationWorkspaceId !== 'string') {
    return badRequest('destination_workspace_id is required')
  }

  // Optional: which team in the destination hosts the actions. Omitted means
  // "let the engine pick the destination's default team" — it raises P0003
  // when there isn't one.
  const destinationTeamId = body?.destination_team_id
  if (
    destinationTeamId !== undefined &&
    destinationTeamId !== null &&
    (typeof destinationTeamId !== 'string' || destinationTeamId.length === 0)
  ) {
    return badRequest('destination_team_id must be a workspace team id')
  }

  const { data, error } = await supabase.rpc('move_actions', {
    p_action_ids: actionIds,
    p_destination_workspace_id: destinationWorkspaceId,
    p_destination_team_id: (destinationTeamId as string | undefined) ?? null,
  })

  if (error) {
    // Map Postgres errcodes back to HTTP status (see migration 221).
    //   P0002 — no action matched (also raised when the caller has no
    //           membership in the source workspace — deliberate anti-oracle)
    //   P0003 — destination workspace has no team to host the actions
    //   P0004 — the ids don't all exist in one workspace
    //   22023 — same workspace (also empty / oversized id list)
    //   22P02 — malformed uuid in the id array
    //   42501 — not authorized to move these actions
    //   23505 — unique violation the engine's renumbering didn't absorb
    //
    // Raw Postgres messages interpolate workspace/action ids, so every branch
    // answers with a fixed string and logs the original server-side.
    const code = (error as { code?: string }).code
    const rawMessage = error.message ?? ''

    if (code === 'P0002') return notFound('Actions not found')
    if (code === 'P0003') {
      return badRequest('Destination workspace has no team configured — set one up there first')
    }
    if (code === 'P0004') {
      return badRequest('action_ids must all reference actions in the same workspace')
    }
    if (code === '22023') return badRequest('Source and destination workspace are the same')
    if (code === '22P02') return badRequest('action_ids must be valid UUIDs')
    if (code === '42501') {
      return forbidden('You need admin rights (or ownership of this item) to move it')
    }
    if (code === '23505') {
      console.error('[move_actions] unique violation on move:', rawMessage)
      return badRequest('Move failed: a conflicting record already exists in the destination workspace')
    }

    // PostgREST returns 404 for the RPC when its schema cache is stale (e.g.
    // immediately after the migration is applied). The Supabase client
    // surfaces this without an errcode, so detect it by message and respond
    // with 503 so callers know to retry — and operators know to send
    // NOTIFY pgrst, 'reload schema'.
    if (!code && /could not find the function/i.test(rawMessage)) {
      console.error(
        '[move_actions] PostgREST schema cache stale — run NOTIFY pgrst, \'reload schema\'',
      )
      return apiError('Move temporarily unavailable, please retry shortly', {
        status: 503,
        code: 'SCHEMA_CACHE_STALE',
      })
    }

    console.error('[move_actions] unexpected RPC error:', code, rawMessage)
    return serverError('Move failed')
  }

  if (!data) return serverError('move_actions returned no result')

  // The RPC payload is already the response contract:
  // { action_ids, source_workspace_id, destination_workspace_id,
  //   destination_team_id, counts }
  return NextResponse.json(data)
}
