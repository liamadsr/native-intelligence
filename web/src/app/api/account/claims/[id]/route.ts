/**
 * PATCH a single claim.
 *
 * Exists because the views system patches rows through ONE endpoint per entity
 * type (`ENTITY_ENDPOINTS`, src/lib/views/entity-endpoints.ts): inline cell
 * edits and bulk actions both POST `{field: value}` to it. The pre-existing
 * verbs — POST /confirm and POST /dismiss — are review-queue shaped (no body,
 * one fixed outcome each) and cannot express "set this field to that value",
 * so a claim list would have had no editable cell at all.
 *
 * `confirmation` is the ONLY writable field, deliberately. Everything else on a
 * claim is extraction output — `text`, `type` and `confidence` are what the
 * model said, and letting a row editor rewrite them would silently break the
 * provenance the whole knowledge graph is built on. Superseding a claim (the
 * real "this is wrong" verb) keeps its own route, which writes `superseded_by`
 * and a replacement row together.
 *
 * Confirming stamps `last_verified_at`, matching the /confirm route — the
 * library's "last verified" rollup reads it, so a confirm that skipped it would
 * show a freshly-confirmed claim as never verified.
 */

import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, notFound, serverError } from '@/lib/api-errors'
import { NextResponse, type NextRequest } from 'next/server'

const CONFIRMATIONS = ['suggested', 'confirmed', 'dismissed'] as const
type Confirmation = (typeof CONFIRMATIONS)[number]

function isConfirmation(v: unknown): v is Confirmation {
  return typeof v === 'string' && (CONFIRMATIONS as readonly string[]).includes(v)
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  const { id } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }
  if (typeof body !== 'object' || body === null) return badRequest('Invalid body')

  const { confirmation } = body as { confirmation?: unknown }
  if (confirmation === undefined) {
    return badRequest('Nothing to update: `confirmation` is the only writable field')
  }
  if (!isConfirmation(confirmation)) {
    return badRequest(`\`confirmation\` must be one of ${CONFIRMATIONS.join(', ')}`)
  }

  // Confirming is a verification event; un-confirming is not, so the stamp is
  // only written on the way in. Clearing it on the way out would erase the
  // record that someone once checked this claim.
  const patch: Record<string, unknown> = { confirmation }
  if (confirmation === 'confirmed') patch.last_verified_at = new Date().toISOString()

  const { data, error } = await supabase
    .from('claim')
    .update(patch)
    .eq('id', id)
    // Defence in depth beside RLS: a claim id from another workspace matches
    // nothing rather than 500ing on a policy denial.
    .eq('workspace_id', workspaceId)
    .select('id, confirmation, last_verified_at')
    .maybeSingle()

  if (error) return serverError(error.message)
  if (!data) return notFound('Claim not found')
  return NextResponse.json({ claim: data })
}
