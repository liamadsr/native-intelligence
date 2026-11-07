import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import {
  EDITION_IDS,
  isEditionId,
  resolveWorkspaceEdition,
  setWorkspaceEdition,
} from '@/lib/editions'

/**
 * GET/PATCH /api/admin/workspaces/[id]/edition
 *
 * The admin console's home for the persona-edition switcher (see
 * lib/editions/manifest.ts). The user-facing control was removed from workspace
 * settings — an edition changes the whole app surface for every member, so it is
 * now set on a workspace's behalf from `/admin/users/[id]` rather than by the
 * users themselves, who keep the per-feature toggles.
 *
 * Writes go through the ADMIN service client: the `workspace` UPDATE policy is
 * owner-only (migration 013), so `requireAdmin` is the authorization boundary
 * and `setWorkspaceEdition`'s `.select('id')` row-count assert turns a
 * missing/unwritable workspace into a loud failure rather than a silent 200.
 */

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: workspaceId } = await params
  const supabase = await getAdminServiceClient()

  // resolveWorkspaceEdition never throws and falls back to 'full', so a
  // workspace whose settings blob predates the feature still reads back a
  // valid id.
  const { id } = await resolveWorkspaceEdition(supabase, workspaceId)
  return NextResponse.json({ edition: id })
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    await requireAdmin()
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { id: workspaceId } = await params

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const incoming = (body as { edition?: unknown })?.edition
  // Reject unknown ids loudly rather than letting setWorkspaceEdition normalize
  // them to 'full': an admin picking from a fixed control who somehow sends
  // garbage should see an error, not silently land a workspace on a different
  // edition. The accepted set comes from the manifest, so this message can never
  // drift from the editions that actually exist.
  if (!isEditionId(incoming)) {
    return NextResponse.json(
      { error: `Expected \`edition\` to be one of: ${EDITION_IDS.join(', ')}` },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()

  // A workspace that does not exist would otherwise surface as the writer's
  // 0-rows error, i.e. a 500 for what is really a bad id. Check first so the
  // console can say "no such workspace".
  const { data: existing, error: lookupError } = await supabase
    .from('workspace')
    .select('id')
    .eq('id', workspaceId)
    .maybeSingle()
  if (lookupError) {
    return NextResponse.json({ error: lookupError.message }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: 'Workspace not found' }, { status: 404 })
  }

  const result = await setWorkspaceEdition(supabase, workspaceId, incoming)
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 500 })
  }

  return NextResponse.json({ edition: result.edition })
}
