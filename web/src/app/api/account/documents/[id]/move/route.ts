/**
 * POST /api/account/documents/[id]/move
 *
 * Move a standalone document to another workspace: the document, its chunks,
 * comments (author translated where the person exists in the destination),
 * attachments, and — unless `move_claims` is false — the knowledge claims
 * this document is the sole evidence for. Claims with evidence from elsewhere
 * always stay behind.
 *
 * The document's project link does NOT travel (the project stays put), its
 * wiki slug is cleared so it can't collide in the destination, its public
 * share link is deactivated in place (re-stamping would hand external
 * commenters' identities to the destination), and unpublished drafts by other
 * members are discarded. GET .../move/preflight quantifies that.
 *
 * All of it runs in one transaction inside the `public.move_document` RPC
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

  const { id: documentId } = await params

  let body: {
    destination_workspace_id?: unknown
    move_claims?: unknown
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

  if (body?.move_claims !== undefined && typeof body.move_claims !== 'boolean') {
    return badRequest('move_claims must be a boolean')
  }
  const moveClaims = body?.move_claims ?? true

  const { data, error } = await supabase.rpc('move_document', {
    p_document_id: documentId,
    p_destination_workspace_id: destinationWorkspaceId,
    p_move_claims: moveClaims,
  })

  if (error) {
    // Map Postgres errcodes back to HTTP status (see migration 221).
    //   P0002 — document not found (also raised when the caller has no
    //           membership in the SOURCE workspace — never confirms existence)
    //   22023 — same workspace
    //   42501 — not authenticated / insufficient rights on either side
    //   23505 — unique violation (safety net; the engine clears slugs instead)
    //
    // Note: raw Postgres messages may include workspace/user IDs from
    // RAISE EXCEPTION interpolation. We map to fixed user-facing strings and
    // log the raw message server-side for diagnosis.
    const code = (error as { code?: string }).code
    const rawMessage = error.message ?? ''

    if (code === 'P0002') return notFound('Document not found')
    if (code === 'P0003') {
      return badRequest('Destination workspace has no team configured — set one up there first')
    }
    if (code === '22023') return badRequest('Source and destination workspace are the same')
    if (code === '22P02') return badRequest('ids must be valid UUIDs')
    if (code === '42501') {
      // Migration 360: the product doc moves only for an owner or admin. The
      // raw text is ours (no ids in it), but we still answer with a fixed line.
      if (/product doc/i.test(rawMessage)) {
        return forbidden('Only a workspace owner or admin can move the workspace product doc')
      }
      return forbidden('You need admin rights (or ownership of this item) to move it')
    }
    if (code === '23505') {
      console.error('[move_document] unique violation on move:', rawMessage)
      return badRequest('Move failed: a conflicting record already exists in the destination workspace')
    }

    // PostgREST returns 404 for the RPC when its schema cache is stale (e.g.
    // immediately after the migration is applied). The Supabase client
    // surfaces this without an errcode, so detect it by message and respond
    // with 503 so callers know to retry — and operators know to send
    // NOTIFY pgrst, 'reload schema'.
    if (!code && /could not find the function/i.test(rawMessage)) {
      console.error(
        '[move_document] PostgREST schema cache stale — run NOTIFY pgrst, \'reload schema\'',
      )
      return apiError('Move temporarily unavailable, please retry shortly', {
        status: 503,
        code: 'SCHEMA_CACHE_STALE',
      })
    }

    console.error('[move_document] unexpected RPC error:', code, rawMessage)
    return serverError('Move failed')
  }

  if (!data) return serverError('move_document returned no result')

  return NextResponse.json(data)
}
