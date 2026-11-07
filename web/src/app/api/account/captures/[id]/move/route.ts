/**
 * POST /api/account/captures/[id]/move
 *
 * Move a capture from one workspace to another: the capture, its
 * transcript/summary, attachments, embeddings, participants, pending
 * (unaccepted) AI suggestions — and, as of v2, its derived artifacts:
 *
 *   - `confirmed_action_ids` — confirmed extracted actions to move WITH the
 *     capture. The preflight endpoint flags which ones look hand-edited so
 *     the user chooses explicitly; any confirmed action not listed stays
 *     behind with its capture link severed (v1 behaviour).
 *   - `move_claims` (default true) — knowledge claims whose evidence points
 *     solely at this capture/its attachments move too. Claims with outside
 *     evidence always stay.
 *   - `move_contacts` (default true) — contacts auto-created from the
 *     capture's participants are copied into the destination.
 *
 * The database work happens in a single transaction inside the
 * `public.move_capture` RPC (see migrations 103 + 155 + 221). The route does
 * no storage work: since migration 128 the attachments bucket authorizes via
 * the attachments ROW (workspace membership), so re-stamping the row's
 * workspace_id re-points storage access by itself.
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

interface MoveCounts {
  // v2 keys the shipped client reads.
  unlinked_actions: number
  moved_suggested_actions: number
  moved_confirmed_actions: number
  moved_decisions: number
  moved_proposed_changes: number
  moved_claims: number
  shared_claims_left: number
  copied_contacts: number
  // v3 (migration 221) adds identifier_map, renumbered, labels_remapped,
  // external_tasks_severed, shares_deactivated, ai_threads_unlinked,
  // attachments, links_* and the residue counters. They're passed through
  // verbatim rather than enumerated here.
  [key: string]: unknown
}

interface MoveResult {
  capture_id: string
  source_workspace_id: string
  destination_workspace_id: string
  counts: MoveCounts
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireUser()
  if (auth instanceof Response) return auth
  const { supabase } = auth

  const { id: captureId } = await params

  let body: {
    destination_workspace_id?: string
    confirmed_action_ids?: unknown
    move_claims?: unknown
    move_contacts?: unknown
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

  // Confirmed extracted actions to move with the capture. Omitting the field
  // means "leave them all behind" — never a silent move; the client sends the
  // explicit selection the user made in the move dialog.
  const rawActionIds = body?.confirmed_action_ids ?? []
  if (
    !Array.isArray(rawActionIds) ||
    rawActionIds.some((id) => typeof id !== 'string' || id.length === 0)
  ) {
    return badRequest('confirmed_action_ids must be an array of action ids')
  }
  if (rawActionIds.length > 500) {
    return badRequest('confirmed_action_ids is too large')
  }
  const confirmedActionIds = [...new Set(rawActionIds as string[])]

  if (body?.move_claims !== undefined && typeof body.move_claims !== 'boolean') {
    return badRequest('move_claims must be a boolean')
  }
  if (body?.move_contacts !== undefined && typeof body.move_contacts !== 'boolean') {
    return badRequest('move_contacts must be a boolean')
  }
  const moveClaims = body?.move_claims ?? true
  const moveContacts = body?.move_contacts ?? true

  // Call the move_capture RPC. All membership/preflight checks happen inside it.
  const { data, error } = await supabase.rpc('move_capture', {
    p_capture_id: captureId,
    p_destination_workspace_id: destinationWorkspaceId,
    p_confirmed_action_ids: confirmedActionIds,
    p_move_claims: moveClaims,
    p_move_contacts: moveContacts,
  })

  if (error) {
    // Map Postgres errcodes back to HTTP status (see migrations 103 + 155 + 221).
    //   P0002 — capture not found (also raised when the caller has no
    //           membership in the source workspace — anti-oracle)
    //   P0003 — destination workspace has no team to host moved suggestions
    //   P0004 — confirmed_action_ids didn't match confirmed actions of this capture
    //   22023 — same workspace
    //   42501 — not authorized: guest/non-owner member on the source side,
    //           no membership on the destination side, or unauthenticated
    //   23505 — unique violation (e.g. action identifier collision in destination)
    //
    // Note: raw Postgres messages may include workspace/user IDs from
    // RAISE EXCEPTION interpolation. We map to fixed user-facing strings and
    // log the raw message server-side for diagnosis.
    const code = (error as { code?: string }).code
    const rawMessage = error.message ?? ''

    if (code === 'P0002') return notFound('Capture not found')
    if (code === 'P0003') {
      return badRequest('Destination workspace has no team configured — set one up there first')
    }
    if (code === 'P0004') {
      return badRequest('confirmed_action_ids must reference confirmed actions extracted from this capture')
    }
    if (code === '22023') return badRequest('Source and destination workspace are the same')
    if (code === '22P02') return badRequest('confirmed_action_ids must be valid UUIDs')
    if (code === '42501') {
      return forbidden('You need admin rights (or ownership of this item) to move it')
    }
    if (code === '23505') {
      console.error('[move_capture] unique violation on move:', rawMessage)
      return badRequest('Move failed: a conflicting record already exists in the destination workspace')
    }

    // PostgREST returns 404 for the RPC when its schema cache is stale (e.g.
    // immediately after the migration is applied). The Supabase client
    // surfaces this without an errcode, so detect it by message and respond
    // with 503 so callers know to retry — and operators know to send
    // NOTIFY pgrst, 'reload schema'.
    if (!code && /could not find the function/i.test(rawMessage)) {
      console.error(
        '[move_capture] PostgREST schema cache stale — run NOTIFY pgrst, \'reload schema\'',
      )
      return apiError('Move temporarily unavailable, please retry shortly', {
        status: 503,
        code: 'SCHEMA_CACHE_STALE',
      })
    }

    console.error('[move_capture] unexpected RPC error:', code, rawMessage)
    return serverError('Move failed')
  }

  const result = data as MoveResult | null
  if (!result) {
    return serverError('move_capture returned no result')
  }

  return NextResponse.json({
    capture_id: result.capture_id,
    source_workspace_id: result.source_workspace_id,
    destination_workspace_id: result.destination_workspace_id,
    counts: result.counts,
  })
}
