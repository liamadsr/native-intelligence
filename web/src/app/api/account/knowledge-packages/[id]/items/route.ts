import { requireWorkspace } from '@/lib/api-auth'
import { badRequest, forbidden, notFound, serverError } from '@/lib/api-errors'
import { entityInWorkspace, LINKABLE_ENTITY_TYPES } from '@/lib/ai/tools/claims'
import { canonicalEntityTypeInput } from '@/lib/knowledge/entity-registry'

/**
 * Pinned items on a knowledge package.
 *
 *   POST   {entity_type, entity_id}            → pin
 *   DELETE ?entity_type=...&entity_id=...      → unpin
 *
 * RLS (mig 238) enforces the rules: pins are as visible as their package,
 * and pinning/unpinning requires package-edit rights (creator, edit-share,
 * or admin/owner on non-personal packages). The POST pre-checks edit rights
 * via the same predicate so a see-but-not-edit caller gets a clean 403
 * instead of the upsert's raw RLS violation.
 */

type RouteContext = { params: Promise<{ id: string }> }

const LINKABLE = new Set<string>(LINKABLE_ENTITY_TYPES)

export async function POST(request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, user, workspaceId } = auth
  const { id } = await params

  const body = await request.json().catch(() => null)
  // A retired kind name (an older client's `email`) is read as its successor.
  if (body && typeof body === 'object') body.entity_type = canonicalEntityTypeInput(body.entity_type)
  if (!body || !LINKABLE.has(body.entity_type) || typeof body.entity_id !== 'string') {
    return badRequest('entity_type and entity_id are required')
  }

  // RLS-visible parent check gives a clean 404 instead of a silent no-op.
  const { data: pkg } = await supabase
    .from('knowledge_package')
    .select('id')
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .maybeSingle()
  if (!pkg) return notFound('Package not found')

  // Visible ≠ editable (mig 238): pre-check edit rights for a clean 403.
  // User-JWT client → the RPC resolves the caller via auth.uid().
  const { data: editable } = await supabase.rpc('package_editable_by', { p_package_id: id })
  if (editable !== true) return forbidden('You do not have edit access to this package')

  const ok = await entityInWorkspace(
    supabase,
    workspaceId,
    body.entity_type as (typeof LINKABLE_ENTITY_TYPES)[number],
    body.entity_id,
  )
  if (!ok) return badRequest(`${body.entity_type} ${body.entity_id} not found in this workspace`)

  const { error } = await supabase.from('knowledge_package_item').upsert(
    {
      package_id: id,
      workspace_id: workspaceId,
      entity_type: body.entity_type,
      entity_id: body.entity_id,
      added_by: user.id,
    },
    { onConflict: 'package_id,entity_type,entity_id', ignoreDuplicates: true },
  )
  if (error) return serverError(error.message)
  return Response.json({ ok: true }, { status: 201 })
}

export async function DELETE(request: Request, { params }: RouteContext) {
  const auth = await requireWorkspace()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth
  const { id } = await params

  const url = new URL(request.url)
  const rawType = url.searchParams.get('entity_type')
  const entityType = rawType === null ? null : (canonicalEntityTypeInput(rawType) as string)
  const entityId = url.searchParams.get('entity_id')
  if (!entityType || !entityId || !LINKABLE.has(entityType)) {
    return badRequest('entity_type and entity_id query params are required')
  }

  const { error, count } = await supabase
    .from('knowledge_package_item')
    .delete({ count: 'exact' })
    .eq('package_id', id)
    .eq('workspace_id', workspaceId)
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
  if (error) return serverError(error.message)
  if (!count) return notFound('Pin not found or not removable')
  return Response.json({ ok: true })
}
