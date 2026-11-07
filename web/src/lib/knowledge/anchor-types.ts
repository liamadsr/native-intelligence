/**
 * Which entity types a workspace ANCHORS its knowledge to.
 *
 * "Anchors are configuration": the weaver used to link every claim to a
 * project and nothing else, which is right for an engineering workspace and
 * useless for a sales one — there, a claim is about a COMPANY. So the anchor
 * set is per-workspace, derived from the workspace's effective FEATURES (a
 * workspace with CRM on anchors to companies) and overridable by an explicit
 * `settings.weaver.anchor_types` list.
 *
 * Storage is `workspace.settings.weaver` (jsonb) — the same column and the
 * same fail-open shape as `settings.ai_models` (model-defaults.ts) and
 * `settings.edition` (editions/resolve.ts): a pure `normalize*` half that
 * turns whatever garbage is in the blob into a fully-defaulted value and
 * never throws, plus an async half doing ONE read and falling back to the
 * defaults on any error.
 *
 * `contact` is deliberately NOT here. Contact anchoring is separate machinery
 * (the `committed_to` relation, written at extraction time); adding it to a
 * workspace's anchor set would make the weaver write a second, different kind
 * of contact edge.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  ANCHOR_ENTITY_TYPES,
  type EntityType,
} from '@/lib/knowledge/entity-registry'
import { resolveWorkspaceEditionFromSettings } from '@/lib/editions/resolve'
import { effectiveFeatureKeys } from '@/lib/editions/manifest'

/** An entity type the weaver may anchor claims to. */
export type AnchorType = (typeof ANCHOR_ENTITY_TYPES)[number]

/**
 * FEATURE → ANCHOR. The whole mapping, as data: turning a feature on gives a
 * workspace that anchor type by default, with no code change anywhere.
 *
 * `campaigns` is listed ahead of the feature itself (the campaign entity lands
 * in a later slice). An unknown feature key simply never matches
 * `effectiveFeatureKeys`' output, so the row is inert until the feature
 * exists — which is the point: slice 2b appends the feature, not this file.
 */
export const FEATURE_ANCHOR_TYPES: ReadonlyArray<{
  feature: string
  anchor: string
}> = [
  { feature: 'projects', anchor: 'project' },
  { feature: 'crm', anchor: 'company' },
  { feature: 'campaigns', anchor: 'campaign' },
]

/** Anchor types that are always on, whatever the features say. None today. */
const ALWAYS_ON: readonly AnchorType[] = []

const REGISTERED = new Set<string>(ANCHOR_ENTITY_TYPES)

/** Registry order, so a resolved set is stable and comparable. */
function ordered(types: Iterable<string>): AnchorType[] {
  const want = new Set(types)
  return (ANCHOR_ENTITY_TYPES as readonly AnchorType[]).filter((t) => want.has(t))
}

/**
 * The anchor set a workspace gets from its FEATURES alone — the default when
 * `settings.weaver.anchor_types` says nothing.
 *
 * A registry entry with no anchor descriptor can never be returned (the
 * mapping's values are checked against `ANCHOR_ENTITY_TYPES`), so a feature
 * mapped to a type that is not yet an anchor yields nothing rather than a
 * type the weaver has no embed text for.
 */
export function anchorTypesFromSettings(settings: unknown): AnchorType[] {
  const edition = resolveWorkspaceEditionFromSettings(settings)
  const features = effectiveFeatureKeys(edition.edition, edition.overrides)
  const on = (feature: string) => features === 'all' || (features as string[]).includes(feature)

  const derived = new Set<string>(ALWAYS_ON)
  for (const { feature, anchor } of FEATURE_ANCHOR_TYPES) {
    if (on(feature) && REGISTERED.has(anchor)) derived.add(anchor)
  }

  const explicit = explicitAnchorTypes(settings)
  return ordered(explicit ?? derived)
}

/**
 * The workspace's explicitly configured anchor types, or null when it has
 * expressed no valid choice. Anything unusable — a non-array, an array whose
 * entries are not registered anchor types, an array that ends up empty — is
 * treated as "nothing said", so the caller falls back to the feature-derived
 * default rather than to an empty set (an empty set would silently switch
 * anchoring off for the whole workspace, which no garbage value should be
 * able to do).
 */
function explicitAnchorTypes(settings: unknown): Set<string> | null {
  if (!settings || typeof settings !== 'object') return null
  const weaver = (settings as Record<string, unknown>).weaver
  if (!weaver || typeof weaver !== 'object') return null
  const raw = (weaver as Record<string, unknown>).anchor_types
  if (!Array.isArray(raw)) return null
  const valid = new Set(
    raw.filter((t): t is string => typeof t === 'string' && REGISTERED.has(t)),
  )
  return valid.size > 0 ? valid : null
}

/** Everything the weaver reads out of `workspace.settings.weaver` in one go. */
export interface WeaverSettings {
  /** The LLM judge kill switch (`settings.weaver.llm_judge`), default on. */
  llmJudge: boolean
  /** The workspace's anchor set, in registry order. */
  anchorTypes: AnchorType[]
}

/** The pure half — given an already-read settings blob, never throws. */
export function normalizeWeaverSettings(settings: unknown): WeaverSettings {
  const weaver =
    settings && typeof settings === 'object'
      ? ((settings as Record<string, unknown>).weaver as Record<string, unknown> | undefined)
      : undefined
  return {
    // Default ON: only an explicit `false` switches the judge off.
    llmJudge: weaver?.llm_judge !== false,
    anchorTypes: anchorTypesFromSettings(settings),
  }
}

/**
 * Read a workspace's weaver settings. ONE query; fail-open — any error
 * (missing row, RLS, network) yields the same shape a settings-less workspace
 * gets, so callers need no try/catch.
 */
export async function resolveWeaverSettings(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<WeaverSettings> {
  try {
    const { data } = await supabase
      .from('workspace')
      .select('settings')
      .eq('id', workspaceId)
      .maybeSingle()
    return normalizeWeaverSettings(data?.settings)
  } catch {
    return normalizeWeaverSettings(undefined)
  }
}

/** Narrow a raw string to a registered anchor type. */
export function isAnchorType(raw: unknown): raw is AnchorType {
  return typeof raw === 'string' && REGISTERED.has(raw)
}

/** Convenience for callers that only want the anchor set. */
export async function resolveWorkspaceAnchorTypes(
  supabase: SupabaseClient,
  workspaceId: string,
): Promise<AnchorType[]> {
  return (await resolveWeaverSettings(supabase, workspaceId)).anchorTypes
}

/** Re-exported so weaver code can type an anchor id without a second import. */
export type { EntityType }
