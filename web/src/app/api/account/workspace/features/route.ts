import { requireWorkspaceMember } from '@/lib/api-auth'
import { badRequest, forbidden, serverError } from '@/lib/api-errors'
import {
  FEATURES,
  TOGGLEABLE_FEATURE_KEYS,
  effectiveFeatureKeys,
  isFeatureKey,
  resolveWorkspaceEdition,
  setWorkspaceFeatureState,
  type FeatureKey,
  type FeatureOverrides,
} from '@/lib/editions'
import { NextResponse, type NextRequest } from 'next/server'

/**
 * GET/PATCH /api/account/workspace/features
 *
 * Reads/writes the per-feature TRI-STATE at `workspace.settings.feature_overrides`
 * — the thing that makes an edition a preset rather than a prison. Sibling of
 * `../edition/route.ts` in every respect (same auth helpers, same owner/admin
 * write gate, same read-modify-write of the settings jsonb) because it edits the
 * same blob for the same reason.
 *
 * The tri-state is the whole design:
 *
 *   absent  → follow the edition (so retuning a preset reaches this workspace)
 *   'on'    → force-enable regardless of edition
 *   'off'   → force-disable regardless of edition
 *
 * Which is why PATCH AUTO-COLLAPSES: writing a state that already matches what
 * the edition would give DELETES the key instead of storing it. Storing the
 * redundant value would silently opt the workspace out of future preset
 * improvements for that feature — a user who switches Email off and back on
 * again must end up exactly where they started, not pinned to `on` forever.
 *
 * And why EVERY write also PRUNES the whole map (`pruneNoOpOverrides` below):
 * per-key collapse judges one key against the edition, but overrides interact
 * through `requires`, so a key can become a no-op because a DIFFERENT key
 * changed. A key that no longer changes the effective outcome is invisible in
 * the settings card and would otherwise be stranded in the blob forever.
 *
 * Any member may READ (the effective feature set scopes what every session
 * renders); only owner/admin may WRITE (a toggle changes the app for everyone).
 */

/** The response body both verbs return — one shape, so the client never has to
 *  reconcile a PATCH result against a stale GET. */
function payload(
  edition: Awaited<ReturnType<typeof resolveWorkspaceEdition>>,
): {
  edition: string
  overrides: FeatureOverrides
  effectiveFeatures: 'all' | FeatureKey[]
} {
  return {
    edition: edition.id,
    overrides: edition.overrides,
    // `edition.edition` already carries the composed surface, but the settings
    // card needs the FEATURE list (to render a switch per feature), not the
    // surface it composes to.
    effectiveFeatures: effectiveFeatureKeys(edition.edition, edition.overrides),
  }
}

export async function GET(): Promise<Response> {
  const auth = await requireWorkspaceMember()
  if (auth instanceof Response) return auth
  const { supabase, workspaceId } = auth

  // resolveWorkspaceEdition never throws and fails open to `full` with no
  // overrides, so the card always has something valid to render.
  const resolved = await resolveWorkspaceEdition(supabase, workspaceId)
  return NextResponse.json(payload(resolved))
}

export async function PATCH(request: NextRequest): Promise<Response> {
  const auth = await requireWorkspaceMember({ select: 'id, role' })
  if (auth instanceof Response) return auth
  const { supabase, workspaceId, member } = auth

  // Turning a feature on or off changes the nav rail and the AI's tool ceiling
  // for EVERY member — same posture as the edition switcher and trust policy.
  if (member.role !== 'owner' && member.role !== 'admin') {
    return forbidden('Only workspace admins can change workspace features')
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return badRequest('Invalid JSON body')
  }

  const { feature, state } = (body ?? {}) as { feature?: unknown; state?: unknown }

  // Reject unknown keys loudly rather than dropping them the way
  // normalizeFeatureOverrides does for stored garbage: a client toggling a
  // control it rendered from the manifest cannot legitimately send anything
  // else, and a silent no-op would look to the user like a switch that does
  // nothing.
  if (!isFeatureKey(feature)) {
    return badRequest(
      `Expected \`feature\` to be one of: ${TOGGLEABLE_FEATURE_KEYS.join(', ')}`,
    )
  }
  // `core` is locked on by construction (invariant: no workspace can be left
  // without a way to capture or act on anything), so there is no honest answer
  // to a request to change it.
  if (FEATURES[feature].locked) {
    return badRequest(`\`${feature}\` is always on and cannot be changed`)
  }
  // A HIDDEN feature is staff/internal: off in every edition, and switched on
  // for a workspace only from the admin console. It is never rendered in the
  // user-facing card, so a request naming one did not come from that card.
  //
  // Keys on `hidden` ALONE, never on the preset axis: an OPT-IN feature is also
  // off in every edition, but it is a normal user-toggleable feature that the
  // card DOES render, so it must be accepted here.
  if (FEATURES[feature].hidden) {
    return badRequest(`\`${feature}\` is not user-configurable`)
  }
  if (state !== 'on' && state !== 'off' && state !== 'default') {
    return badRequest('Expected `state` to be one of: on, off, default')
  }

  // The collapse/prune/write is shared with the admin route that changes a
  // workspace's features on a user's behalf (`/api/admin/workspaces/[id]/features`)
  // so the two can never diverge and strand override keys.
  //
  // The READ stays on the RLS-scoped session client; the WRITE goes through the
  // service client. The role gate above IS the authorization boundary. RLS on
  // `workspace` allows UPDATE to OWNERS only (migration 013, "Owners can update
  // workspace"), so an admin writing through the session client would update 0
  // rows and — a 0-row update reporting no error — get a 200 echoing back a
  // toggle that was never stored.
  const service = (await import('@/lib/supabase/service')).getServiceClient()
  const written = await setWorkspaceFeatureState({
    read: supabase,
    write: service,
    workspaceId,
    feature,
    state,
  })
  if (!written.ok) return serverError(written.error)

  return NextResponse.json(written.result)
}
