/**
 * Reading and writing a workspace's edition.
 *
 * Storage: `workspace.settings.edition` (the preset) plus
 * `workspace.settings.feature_overrides` (the per-feature tri-state on top of
 * it) — two keys on the existing jsonb settings column, following the
 * `settings.trust_policy` precedent (src/lib/proposed-changes/trust-policy.ts):
 * no new table, no migration, member-readable through the workspace RLS the app
 * already enforces.
 *
 * `resolveWorkspaceEdition` returns the EFFECTIVE surface — edition composed
 * with overrides — under the manifest's own field names, so a consumer that
 * reads `edition.toolCategories` or `.autoCreateEntities` is automatically
 * override-aware and needs no change. There is deliberately no way to read a
 * workspace's edition WITHOUT its overrides through this module's main path:
 * that would be the shape of a bug where a ceiling ignores a user's choice.
 *
 * Three operations with deliberately different write semantics:
 *
 *   - resolveWorkspaceEdition — fail-open READ. Never throws; any error (missing
 *     row, RLS, network) yields the `full` default, so callers may treat the
 *     result as authoritative without try/catch. Invariant 1: an unreadable
 *     edition is today's behavior, not a broken app.
 *
 *   - stampWorkspaceEdition — FIRST-WRITE-WINS. Used by signup attribution:
 *     records where the workspace came from only if nothing has claimed it yet.
 *     A user who already switched editions in settings must never be silently
 *     reverted by a stale attribution cookie.
 *
 *   - setWorkspaceEdition — UNCONDITIONAL overwrite. The settings switcher; the
 *     escape hatch that guarantees nobody is ever trapped in an edition.
 *
 * Both writers read-modify-write the settings blob so they touch only the
 * `edition` key and leave trust_policy and every other settings key intact.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  BUSINESS_EDITION_ID,
  DEFAULT_EDITION_ID,
  EDITIONS,
  withEffectiveSurface,
  isEditionId,
  normalizeEditionId,
  normalizeFeatureOverrides,
  type EditionDefinition,
  type EditionId,
  type FeatureOverrides,
} from './manifest'

/** A resolved edition plus its PROVENANCE. `explicit` distinguishes a workspace
 *  that has actually been stamped/chosen from one running on the pure default —
 *  which is exactly what `stampWorkspaceEdition` needs to decide whether to
 *  write, and what analytics needs to avoid counting defaults as choices. */
export interface ResolvedEdition {
  id: EditionId
  /**
   * The edition definition with its surface fields already resolved to the
   * workspace's EFFECTIVE surface — the edition's features, plus every `on`
   * override, minus every `off`, closed under `requires`.
   *
   * Same field names, same types, same shape as the manifest entry, so every
   * consumer (chat route, live-agent ×2, device/ask, verdict-apply,
   * chat-run-rebuild, onboarding research) keeps reading exactly what it read
   * before and needs no change. `id`, `label`, `description` and
   * `onboardingDefaultRoles` still come straight from the manifest — only the composed surface differs, and only when the workspace
   * has actually overridden something.
   */
  edition: EditionDefinition
  explicit: boolean
  /**
   * Convenience passthrough of `edition.autoCreateEntities` — the auto-apply
   * gate's `GateContext.allowedEntityTypes` takes exactly this shape, and it is
   * the one manifest field consumers reach for without wanting the whole
   * definition. Widened to `string[]` because the gate compares it against a
   * raw `proposal.entity_type` string.
   */
  autoCreateEntities: 'all' | string[]
  /**
   * The workspace's RAW tri-state overrides, normalized. Absent key = follow
   * the edition; `'on'`/`'off'` = forced. Exposed for the features settings API
   * (which must render "custom" markers and reset affordances, and therefore
   * needs to distinguish "on because the edition says so" from "on because the
   * user said so") — surface gating should read `edition` instead.
   */
  overrides: FeatureOverrides
}

/**
 * Read the effective edition for a workspace. Never throws — on any error it
 * returns the `full` default with no overrides, marked non-explicit. Works with
 * a user-session client (RLS) or a service-role client (background jobs, the
 * stamp path).
 *
 * Reads `settings.edition` and `settings.feature_overrides` from the SAME row
 * read — overrides are part of resolving an edition, not a second concern, so
 * no consumer can accidentally enforce a ceiling that ignores them.
 *
 * `settings` is a `workspace.settings` blob the caller already read
 * (fetchWorkspaceSettings: `null` when the read failed); the edition then
 * comes from it and nothing is read here. Absent, this reads the row itself.
 */
export async function resolveWorkspaceEdition(
  supabase: SupabaseClient,
  workspaceId: string,
  settings?: unknown,
): Promise<ResolvedEdition> {
  if (settings !== undefined) return resolveWorkspaceEditionFromSettings(settings)
  try {
    const { data } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    return resolveWorkspaceEditionFromSettings(data?.settings)
  } catch {
    return resolved(DEFAULT_EDITION_ID, false, {})
  }
}

/**
 * The PURE half of `resolveWorkspaceEdition`: given an already-read
 * `workspace.settings` blob, compose the effective edition. Never throws — any
 * garbage (including `null`/a non-object) yields the `full` default with no
 * overrides, marked non-explicit, exactly like the fetching variant's catch.
 *
 * Split out so a caller holding the settings row can normalize the edition
 * alongside the other settings-derived policies (trust, claims auto-accept)
 * from ONE read — the live-agent turn path, which runs every ~3s during a
 * recording, did three serial reads of this same row.
 */
export function resolveWorkspaceEditionFromSettings(settings: unknown): ResolvedEdition {
  if (!settings || typeof settings !== 'object') {
    return resolved(DEFAULT_EDITION_ID, false, {})
  }
  const s = settings as Record<string, unknown>
  const overrides = normalizeFeatureOverrides(s.feature_overrides)
  if (isEditionId(s.edition)) return resolved(s.edition, true, overrides)
  // A present-but-garbage value normalizes to the default and is NOT
  // explicit — it expressed no valid intent, so a later stamp may claim it.
  // Overrides still apply: they are keyed by feature, not by edition, and a
  // workspace that turned Email on meant it regardless of its edition.
  return resolved(DEFAULT_EDITION_ID, false, overrides)
}

/** The one place a ResolvedEdition is built, so its derived fields can never
 *  disagree with the manifest entry and overrides they came from. */
function resolved(
  id: EditionId,
  explicit: boolean,
  overrides: FeatureOverrides,
): ResolvedEdition {
  // The composed surface written back over the
  // manifest entry — the SAME projection the client's `useWorkspaceEdition`
  // applies, shared so the two can never drift.
  const edition: EditionDefinition = withEffectiveSurface(EDITIONS[id], overrides)
  return {
    id,
    edition,
    explicit,
    autoCreateEntities:
      edition.autoCreateEntities === 'all' ? 'all' : [...edition.autoCreateEntities],
    overrides,
  }
}

/** Just the id, for callers that don't need the definition. Same fail-open
 *  contract as `resolveWorkspaceEdition`. */
export async function resolveWorkspaceEditionId(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<EditionId> {
  return (await resolveWorkspaceEdition(supabase, workspaceId)).id
}

/** What a stamp attempt did, for logging/analytics. */
export type StampResult =
  /** The workspace had no valid edition and now carries `edition`. */
  | { stamped: true; edition: EditionId }
  /** Already claimed (or the write failed) — nothing changed. */
  | { stamped: false; reason: 'already-set' | 'invalid' | 'error' }

/**
 * FIRST-WRITE-WINS attribution stamp. Writes `settings.edition` only when the
 * workspace does not already carry a VALID one.
 *
 * Never throws: signup attribution must not be able to break onboarding. A
 * failure returns `{ stamped: false, reason: 'error' }` and the workspace stays
 * on the `full` default — invariant 1.
 *
 * Note the read-check/write is not transactional. That is deliberate and safe:
 * the only concurrent writer is the settings switcher, and the worst outcome of
 * a race is a stamp landing microseconds before an explicit user choice that
 * immediately overwrites it.
 */
export async function stampWorkspaceEdition(
  supabase: SupabaseClient,
  workspaceId: string,
  edition: unknown,
): Promise<StampResult> {
  if (!isEditionId(edition)) return { stamped: false, reason: 'invalid' }
  try {
    const { data, error } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    if (error) return { stamped: false, reason: 'error' }

    const settings = (data?.settings ?? {}) as Record<string, unknown>
    if (isEditionId(settings.edition)) return { stamped: false, reason: 'already-set' }

    // `.select('id')` makes the write ASSERT its effect. The workspace UPDATE
    // policy is owner-only (migration 013), so a caller whose client cannot see
    // the row gets a 0-row update — which without a select returns no error and
    // looks exactly like success. Callers pass a service client for that reason;
    // this turns any future mismatch into a visible failure instead of a
    // silent no-op.
    const { data: updated, error: writeErr } = await supabase
      .from('workspace')
      .update({ settings: { ...settings, edition } })
      .eq('id', workspaceId)
      .select('id')
    if (writeErr) return { stamped: false, reason: 'error' }
    if (!updated || updated.length === 0) return { stamped: false, reason: 'error' }

    return { stamped: true, edition }
  } catch {
    return { stamped: false, reason: 'error' }
  }
}

/**
 * Who set a workspace's edition, kept beside it at `settings.edition_source`
 * (absent: attribution's stamp, or nothing yet). Only `adoptBusinessEdition`
 * reads it: a business profile may replace a stamp, never a person's choice.
 */
export type EditionSource =
  /** A person picked it (the settings or admin switcher: setWorkspaceEdition's default). */
  | 'chosen'
  /** The workspace set up as a business (adoptBusinessEdition). */
  | 'business'

export const EDITION_SOURCE_KEY = 'edition_source'

/** How a workspace became a business, for `adoptBusinessEdition`. */
export type BusinessAdoption =
  /** A text sign-up's fresh workspace (roadmap track A). */
  | 'signup'
  /** The workspace's FIRST business profile was just written (track B). */
  | 'profile'

/**
 * A workspace that just set up as a business takes the business edition
 * (`BUSINESS_EDITION_ID`), so the app and the agent say the owner's words.
 *
 *   'signup'   FIRST-WRITE-WINS, like attribution (stampWorkspaceEdition): the
 *              workspace was made a moment ago by the sign-up itself.
 *   'profile'  REPLACES attribution's stamp. Every web sign-up is stamped
 *              (sales by default), so a first-write-wins stamp would never
 *              land here; a business profile is the owner saying what they
 *              run. An edition a person CHOSE (`edition_source: 'chosen'`,
 *              the settings or admin switcher) stays: deleting and re-making
 *              a profile can't undo an admin's switch. Call it on the
 *              profile's first write, not on every update.
 *
 * Pass a SERVICE client (both writers need one). Never throws: setting up a
 * business must not fail on its words. Returns whether the workspace is now on
 * the business edition.
 */
export async function adoptBusinessEdition(
  supabase: SupabaseClient,
  workspaceId: string,
  how: BusinessAdoption,
): Promise<boolean> {
  try {
    if (how === 'signup') {
      const stamp = await stampWorkspaceEdition(supabase, workspaceId, BUSINESS_EDITION_ID)
      if (stamp.stamped) return true
      if (stamp.reason === 'error') console.warn('[editions] business edition not stamped: the settings read or write failed')
      // Already claimed: on the business edition already counts.
      return stamp.reason === 'already-set' && (await resolveWorkspaceEditionId(supabase, workspaceId)) === BUSINESS_EDITION_ID
    }
    const { data, error } = await supabase.from('workspace').select('settings').eq('id', workspaceId).maybeSingle()
    if (error) {
      console.warn('[editions] business edition not set:', error.message)
      return false
    }
    const settings = (data?.settings ?? {}) as Record<string, unknown>
    if (isEditionId(settings.edition) && settings.edition === BUSINESS_EDITION_ID) return true
    if (settings[EDITION_SOURCE_KEY] === 'chosen') return false
    const set = await setWorkspaceEdition(supabase, workspaceId, BUSINESS_EDITION_ID, { source: 'business' })
    if (!set.ok) console.warn('[editions] business edition not set:', set.error)
    return set.ok
  } catch (err) {
    console.warn('[editions] business edition not set:', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * UNCONDITIONAL overwrite — the settings switcher's writer. Normalizes first, so
 * a bad client can only ever write a valid edition id (never garbage) into the
 * jsonb. Read-modify-writes the settings blob to preserve every other key.
 *
 * Unlike the reader and the stamp, this one PROPAGATES its error string: the
 * caller is a user-facing PATCH that must be able to say "that didn't save".
 *
 * Pass a SERVICE client. The workspace UPDATE policy is owner-only, so an
 * RLS-bound admin's client silently updates 0 rows; the caller's role gate is
 * the authorization boundary. The row-count assertion below makes that failure
 * loud rather than invisible if a caller ever passes the wrong client.
 *
 * Records who set it (`edition_source`): 'chosen' unless the caller says
 * otherwise, so a business profile never replaces a person's pick
 * (adoptBusinessEdition).
 */
export async function setWorkspaceEdition(
  supabase: SupabaseClient,
  workspaceId: string,
  edition: unknown,
  opts: { source?: EditionSource } = {},
): Promise<{ ok: true; edition: EditionId } | { ok: false; error: string }> {
  const id = normalizeEditionId(edition)
  const { data, error } = await supabase
    .from('workspace')
    .select('settings')
    .eq('id', workspaceId)
    .maybeSingle()
  if (error) return { ok: false, error: error.message }

  const settings = (data?.settings ?? {}) as Record<string, unknown>
  // `.select('id')` makes the write ASSERT its effect — see stampWorkspaceEdition
  // for why. The workspace UPDATE policy is owner-only, so an RLS-bound client
  // belonging to a non-owner would update 0 rows and report no error at all;
  // callers must pass a service client (post-gate) and this catches it if they
  // stop.
  const { data: updated, error: writeErr } = await supabase
    .from('workspace')
    .update({ settings: { ...settings, edition: id, [EDITION_SOURCE_KEY]: opts.source ?? 'chosen' } })
    .eq('id', workspaceId)
    .select('id')
  if (writeErr) return { ok: false, error: writeErr.message }
  if (!updated || updated.length === 0) {
    return { ok: false, error: 'Workspace edition update affected no rows' }
  }

  return { ok: true, edition: id }
}
