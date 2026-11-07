/**
 * An edition's AI tool ceiling.
 *
 * Kept in the editions module (rather than tool-discovery) so tool-discovery
 * stays edition-agnostic: it exposes the ceiling primitives, editions decide
 * what to feed them.
 */

// Deliberately ./tool-ceiling-core, NOT ./tool-discovery: this module is
// reachable from `@/lib/editions`, which the nav rail, tab context and
// calendar pull into the CLIENT bundle. tool-discovery imports the `ai` SDK
// and `zod`; importing it here put both on the dashboard's first-load path.
import { CORE_TOOL_NAMES, computeToolCeiling } from '@/lib/ai/tool-ceiling-core'
import { ALL_CATEGORY_IDS, getToolNamesForCategories } from '@/lib/ai/tool-registry'
import {
  FEATURES,
  FEATURE_KEYS,
  NON_DEFAULT_FEATURE_TOOL_CATEGORIES,
  isFeatureEnabled,
  type EditionDefinition,
  type FeatureOverrides,
} from './manifest'

/**
 * The set of tool names an edition permits, or `null` for "no limit" ('full').
 *
 * `null` is the same inherit-all signal pickPermittedTools / createPrepareStep
 * already understand, so an edition ceiling composes with the agent ceiling
 * without either side needing a special case.
 */
export function computeEditionToolCeiling(edition: EditionDefinition): Set<string> | null {
  if (edition.toolCategories === 'all') {
    // `'all'` means every category a DEFAULT-ON feature contributes, so a
    // non-default (hidden or opt-in) feature's categories have to be subtracted
    // here rather than inherited. When a non-default feature IS on,
    // `effectiveFeatureKeys` has already collapsed to an explicit list, so this
    // branch never sees one enabled.
    if (NON_DEFAULT_FEATURE_TOOL_CATEGORIES.length === 0) return null
    return computeToolCeiling(
      ALL_CATEGORY_IDS.filter((id) => !NON_DEFAULT_FEATURE_TOOL_CATEGORIES.includes(id)),
      undefined,
    )
  }
  return computeToolCeiling([...edition.toolCategories], undefined)
}

/**
 * Tool names belonging to a feature that is OFF for this workspace.
 *
 * MCP registers its catalog unconditionally rather than through the edition
 * ceiling, so it needs this deny set instead: the tools of every feature the
 * workspace has switched off (and of a hidden or opt-in feature it has not
 * switched on). A category an enabled feature also contributes stays, and so
 * do the core tools, which every ceiling keeps (computeToolCeiling). Empty for
 * a workspace with nothing switched off, which since every feature went on for
 * everyone (manifest invariant 5) is every workspace that never touched the
 * Features card.
 */
export function offFeatureDeniedToolNames(resolved: {
  edition: EditionDefinition
  overrides: FeatureOverrides
}): Set<string> {
  const onCategories = new Set<string>()
  const offCategories = new Set<string>()
  for (const key of FEATURE_KEYS) {
    const target = isFeatureEnabled(resolved, key) ? onCategories : offCategories
    for (const id of FEATURES[key].toolCategories) target.add(id)
  }
  const denied = new Set<string>()
  for (const name of getToolNamesForCategories([...offCategories].filter((id) => !onCategories.has(id)))) {
    if (!CORE_TOOL_NAMES.includes(name)) denied.add(name)
  }
  return denied
}

/**
 * Combine two independent ceilings. Each is `null` for "imposes no limit", so
 * the result is the INTERSECTION when both are real sets — a tool must clear
 * BOTH the workspace's edition and the active agent's allowlist — and simply
 * the other side when one is null.
 *
 * Intersection (not union) is the only safe composition: an edition that hides
 * projects must not have that undone by an agent whose allowlist includes them,
 * and an agent narrowed to captures must not be widened by a 'full' workspace.
 */
export function intersectCeilings(
  a: Set<string> | null | undefined,
  b: Set<string> | null | undefined,
): Set<string> | null {
  if (!a) return b ?? null
  if (!b) return a
  const out = new Set<string>()
  for (const name of a) if (b.has(name)) out.add(name)
  return out
}
