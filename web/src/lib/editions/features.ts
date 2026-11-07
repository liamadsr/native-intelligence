/**
 * Writing a workspace's per-feature TRI-STATE at
 * `workspace.settings.feature_overrides` — the thing that makes an edition a
 * preset rather than a prison.
 *
 * Sibling of `setWorkspaceEdition` in ./resolve.ts, kept in its own module
 * because it needs the manifest's feature functions rather than the edition
 * resolution ones, and because two callers now share it: the user-facing
 * `/api/account/workspace/features` PATCH and the admin
 * `/api/admin/workspaces/[id]/features` PATCH, which writes on a user's behalf.
 * Both must collapse and prune IDENTICALLY — a divergence would let an admin
 * strand override keys a user's own toggle would have pruned.
 *
 * The tri-state is the whole design:
 *
 *   absent  → follow the edition (so retuning a preset reaches this workspace)
 *   'on'    → force-enable regardless of edition
 *   'off'   → force-disable regardless of edition
 *
 * Which is why a write AUTO-COLLAPSES: a state that already matches what the
 * edition would give DELETES the key instead of storing it. Storing the
 * redundant value would silently opt the workspace out of future preset
 * improvements for that feature — a user who switches Email off and back on
 * again must end up exactly where they started, not pinned to `on` forever.
 *
 * And why every write also PRUNES the whole map: per-key collapse judges one key
 * against the edition, but overrides interact through `requires`, so a key can
 * become a no-op because a DIFFERENT key changed.
 *
 * READ and WRITE take separate clients on purpose. The account route reads
 * through the caller's RLS-scoped session client and writes through a service
 * client, because the `workspace` UPDATE policy is owner-only (migration 013) —
 * an admin's session client would update 0 rows and report no error at all. Its
 * own role gate is the authorization boundary. Admin callers pass the same
 * service client for both.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  FEATURES,
  effectiveFeatureKeys,
  getEdition,
  normalizeEditionId,
  normalizeFeatureOverrides,
  type EditionId,
  type FeatureKey,
  type FeatureOverrides,
} from './manifest'

/** The tri-state a caller may write. `'default'` clears the override. */
export type FeatureWriteState = 'on' | 'off' | 'default'

/** Everything a route needs to build its response, and nothing it has to
 *  recompute from a second read. */
export interface FeatureWriteResult {
  edition: EditionId
  overrides: FeatureOverrides
  effectiveFeatures: 'all' | FeatureKey[]
}

export interface SetWorkspaceFeatureStateOptions {
  /** RLS-scoped or service client used for the settings READ. */
  read: SupabaseClient
  /** Service client used for the settings WRITE (workspace UPDATE is owner-only). */
  write: SupabaseClient
  workspaceId: string
  feature: FeatureKey
  state: FeatureWriteState
}

/**
 * Apply one feature's state to a workspace, collapsing and pruning the override
 * map, and write the result back.
 *
 * ONE read of the settings blob, from which both the edition and the current
 * overrides come. Going through `resolveWorkspaceEdition` as well would read the
 * same row twice and open a window where the two disagree.
 *
 * Propagates its error string rather than failing open: the caller is a
 * user-facing PATCH that must be able to say "that didn't save".
 */
export async function setWorkspaceFeatureState({
  read,
  write,
  workspaceId,
  feature,
  state,
}: SetWorkspaceFeatureStateOptions): Promise<
  { ok: true; result: FeatureWriteResult } | { ok: false; error: string }
> {
  const { data, error } = await read
    .from('workspace')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }

  const settings = (data?.settings ?? {}) as Record<string, unknown>
  const editionId: EditionId = normalizeEditionId(settings.edition)

  // What the EDITION alone would say about this feature — i.e. what the caller
  // gets back if the override key is absent. Computed with no overrides at all
  // so it is a property of the preset, not of the current stored state.
  const editionDefaultOn = isOnByDefault(feature, editionId)

  const overrides = normalizeFeatureOverrides(settings.feature_overrides)
  const collapses =
    state === 'default' || (state === 'on' ? editionDefaultOn : !editionDefaultOn)
  if (collapses) {
    delete overrides[feature]
  } else {
    overrides[feature] = state
  }

  const pruned = pruneNoOpOverrides(editionId, overrides)

  // Read-modify-write so trust_policy, edition, and every other settings key
  // survive. An empty override map is stored as `{}` rather than removed: the
  // key's presence is harmless and normalizeFeatureOverrides treats the two
  // identically.
  //
  // `.select('id')` asserts the write's EFFECT: 0 rows is a failure, not a
  // silent success, so any future policy/route mismatch fails loudly.
  const { data: updated, error: writeErr } = await write
    .from('workspace')
    .update({ settings: { ...settings, feature_overrides: pruned } })
    .eq('id', workspaceId)
    .select('id')
  if (writeErr) return { ok: false, error: writeErr.message }
  if (!updated || updated.length === 0) {
    return { ok: false, error: 'Workspace features update affected no rows' }
  }

  return {
    ok: true,
    result: {
      edition: editionId,
      overrides: pruned,
      effectiveFeatures: effectiveFeatureKeys(getEdition(editionId), pruned),
    },
  }
}

/**
 * Drop every stored override key that no longer changes the effective outcome.
 *
 * The per-key auto-collapse above only judges the key being written, against the
 * edition alone. That is not enough once overrides INTERACT: with `off` winning
 * over `requires`, a `sequences: 'off'` in a `{crm: 'off', sequences: 'off'}`
 * pair becomes redundant the moment CRM's own `off` is reset — CRM's cascade
 * already takes Sequences down — and the leftover key would then sit in the blob
 * forever, invisible in the card (no Custom badge, no Reset, because the
 * effective state matches the default) and, on a `full` workspace, collapsing
 * the `'all'` sentinel into a frozen enumerated tool ceiling.
 *
 * So the prune is GENERALIZED rather than special-cased to that pair: recompute
 * the effective set with and without each stored key; a key whose removal
 * changes nothing is a no-op and is deleted. Running it on EVERY write means
 * stranded keys cannot accumulate regardless of which client wrote them, or of
 * how `requires` is retuned later.
 *
 * Each key is judged against the map that survives the pass SO FAR, which is
 * what keeps the result correct rather than merely small: two keys that look
 * redundant only because the other is present (`{crm:'off', sequences:'off'}`
 * on a `full` workspace) must not BOTH be dropped, and this removes exactly one
 * — whichever comes first — leaving the effective outcome identical. A
 * genuinely load-bearing key is never removable, in any order.
 */
export function pruneNoOpOverrides(
  editionId: EditionId,
  overrides: FeatureOverrides,
): FeatureOverrides {
  const edition = getEdition(editionId)
  const out: FeatureOverrides = { ...overrides }
  for (const key of Object.keys(out) as FeatureKey[]) {
    const without: FeatureOverrides = { ...out }
    delete without[key]
    if (sameFeatures(effectiveFeatureKeys(edition, out), effectiveFeatureKeys(edition, without))) {
      delete out[key]
    }
  }
  return out
}

/** Compare two `effectiveFeatureKeys` results. Both sides are either the `'all'`
 *  sentinel or a FEATURE_KEYS-ordered list, so this is an exact comparison —
 *  `'all'` deliberately does NOT equal an exhaustive list (see composeSurface). */
function sameFeatures(a: 'all' | FeatureKey[], b: 'all' | FeatureKey[]): boolean {
  if (a === 'all' || b === 'all') return a === b
  return a.length === b.length && a.every((k, i) => k === b[i])
}

/**
 * Is `feature` on for this edition with NO overrides applied?
 *
 * Goes through `effectiveFeatureKeys` with an EMPTY override map — and against
 * the pristine manifest entry from `getEdition`, never a resolved definition
 * (whose surface already has the workspace's overrides composed in) — so the
 * answer is a property of the preset alone. Routing through the same function
 * the resolver uses also means `requires` closure and the `'all'` passthrough
 * are honored: in a `sales` workspace both `sequences` and the `crm` pulled in
 * behind it correctly read as defaults.
 */
export function isOnByDefault(feature: FeatureKey, editionId: EditionId): boolean {
  const defaults = effectiveFeatureKeys(getEdition(editionId), {})
  // `'all'` means every DEFAULT-ON feature, so a non-default one (hidden or
  // opt-in) is off by default even on `full`. Without this,
  // `setWorkspaceFeatureState('evals','on')` on a full workspace would read as
  // "already on", auto-collapse, and never store the key — leaving the switch
  // inert. (And the converse: an `evals: 'off'` there is a no-op that must
  // collapse away rather than be stored.)
  if (defaults === 'all') return !FEATURES[feature].hidden && !FEATURES[feature].optIn
  return defaults.includes(feature)
}
