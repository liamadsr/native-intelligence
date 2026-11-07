import { NextResponse } from 'next/server'
import { requireAdmin, getAdminServiceClient } from '@/lib/admin'
import {
  ADMIN_TOGGLEABLE_FEATURE_KEYS,
  FEATURES,
  effectiveFeatureKeys,
  isFeatureKey,
  resolveWorkspaceEdition,
  setWorkspaceFeatureState,
} from '@/lib/editions'

/**
 * GET/PATCH /api/admin/workspaces/[id]/features
 *
 * The admin console's mirror of `/api/account/workspace/features`: the same
 * per-feature TRI-STATE at `workspace.settings.feature_overrides`, written on a
 * workspace's behalf rather than by one of its own owners.
 *
 * The collapse/prune logic is SHARED (`setWorkspaceFeatureState` in
 * lib/editions/features.ts), not reimplemented — a divergence between the two
 * routes would let an admin's toggle strand override keys the user-facing one
 * would have pruned, which on a `full` workspace silently freezes the AI tool
 * ceiling (see that module for why).
 *
 * `requireAdmin` is the authorization boundary; both the read and the write go
 * through the env-aware admin service client because the `workspace` UPDATE
 * policy is owner-only (migration 013).
 *
 * This route can also switch on a HIDDEN feature (admin-only: in no edition
 * preset and rejected by the user-facing route), which is why it validates a
 * `feature` key against `ADMIN_TOGGLEABLE_FEATURE_KEYS` rather than
 * `TOGGLEABLE_FEATURE_KEYS`. No feature is hidden today: every feature is on
 * for every workspace (lib/editions/manifest.ts, invariant 5).
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

  // resolveWorkspaceEdition never throws and fails open to `full` with no
  // overrides, so the panel always has something valid to render.
  const resolved = await resolveWorkspaceEdition(supabase, workspaceId)
  return NextResponse.json({
    edition: resolved.id,
    overrides: resolved.overrides,
    // `resolved.edition` already carries the composed surface, but the panel
    // needs the FEATURE list (to render a switch per feature), not the surface
    // it composes to.
    effectiveFeatures: effectiveFeatureKeys(resolved.edition, resolved.overrides),
  })
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

  const { feature, state } = (body ?? {}) as { feature?: unknown; state?: unknown }

  // Reject unknown keys loudly rather than dropping them the way
  // normalizeFeatureOverrides does for stored garbage: a client toggling a
  // control it rendered from the manifest cannot legitimately send anything
  // else, and a silent no-op would look like a switch that does nothing.
  if (!isFeatureKey(feature)) {
    return NextResponse.json(
      { error: `Expected \`feature\` to be one of: ${ADMIN_TOGGLEABLE_FEATURE_KEYS.join(', ')}` },
      { status: 400 },
    )
  }
  // `core` is locked on by construction (invariant: no workspace can be left
  // without a way to capture or act on anything), so there is no honest answer
  // to a request to change it — not even from an admin.
  if (FEATURES[feature].locked) {
    return NextResponse.json(
      { error: `\`${feature}\` is always on and cannot be changed` },
      { status: 400 },
    )
  }
  if (state !== 'on' && state !== 'off' && state !== 'default') {
    return NextResponse.json(
      { error: 'Expected `state` to be one of: on, off, default' },
      { status: 400 },
    )
  }

  const supabase = await getAdminServiceClient()

  // A workspace that does not exist would otherwise surface as the writer's
  // 0-rows error, i.e. a 500 for what is really a bad id.
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

  const written = await setWorkspaceFeatureState({
    read: supabase,
    write: supabase,
    workspaceId,
    feature,
    state,
  })
  if (!written.ok) {
    return NextResponse.json({ error: written.error }, { status: 500 })
  }

  return NextResponse.json(written.result)
}
