import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import {
  EDITION_IDS,
  isEditionId,
  resolveWorkspaceEdition,
  setWorkspaceEdition,
} from '@/lib/editions'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PATCH /api/account/workspace/edition
 *
 * Reads/writes the persona edition at `workspace.settings.edition` — which
 * surfaces, AI tools, and automations this workspace runs (see
 * lib/editions/manifest.ts). Kept separate from the general workspace PATCH for
 * three reasons: merge into the settings jsonb without clobbering other keys,
 * normalize the value, and gate writes to admins/owners.
 *
 * PATCH is the ESCAPE HATCH the whole feature depends on. An edition is chosen
 * for you at signup by the landing page you arrived from; this route is how
 * anyone is never stuck with that guess. It is therefore an unconditional
 * overwrite, not the first-write-wins stamp attribution uses.
 *
 * Any member may READ — the edition scopes what the client renders, so every
 * session needs it, not just admins.
 */

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  // resolveWorkspaceEdition never throws and falls back to 'full', so the
  // client always gets a valid id to render.
  const { id } = await resolveWorkspaceEdition(supabase, workspaceId)
  return NextResponse.json({ edition: id })
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { workspaceId, member } = auth

  // Changing the edition changes the app for EVERY member of the workspace —
  // an admin/owner action, same posture as the trust policy.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change the workspace edition')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const incoming = (body as { edition?: unknown })?.edition
  // Reject unknown ids loudly rather than letting setWorkspaceEdition normalize
  // them to 'full': a user picking from a fixed control who somehow sends
  // garbage should see an error, not silently land on a different edition. The
  // accepted set comes from the manifest, so this message can never drift from
  // the editions that actually exist.
  if (!isEditionId(incoming)) {
    return badRequest(`Expected \`edition\` to be one of: ${EDITION_IDS.join(', ')}`)
  }

  // The role gate above IS the authorization boundary for this write. RLS on
  // `workspace` allows UPDATE to OWNERS only (migration 013, "Owners can update
  // workspace"), so an admin writing through the session client would update 0
  // rows and — a 0-row update reporting no error — get a 200 echoing back an
  // edition that was never stored. The service client is therefore deliberate,
  // used only AFTER the owner/admin check has passed. READS stay on the
  // RLS-scoped session client.
  const service = (await import('@/lib/supabase/service')).getServiceClient()
  const result = await setWorkspaceEdition(service, workspaceId, incoming)
  if (!result.ok) return serverError(result.error)

  return NextResponse.json({ edition: result.edition })
}
