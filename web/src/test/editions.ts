/**
 * Fixtures for "a workspace with some features off".
 *
 * Every shipped edition now has every feature (src/lib/editions/manifest.ts,
 * invariant 5), so `EDITIONS.sales` / `notes` / `brain` no longer make a
 * feature off. Gating code still has to be tested, two ways:
 *
 *   - Code that takes an `EditionDefinition` (the manifest functions, ceilings,
 *     isViewAllowed): pass `scopedEdition([...])`, or one of the `SCOPED`
 *     presets, which are the old preset lists kept as fixtures.
 *   - Code that reads `workspace.settings` (resolve, the features routes, the
 *     DB doubles): store `feature_overrides` instead, e.g.
 *     `offOverrides(['projects', 'flows'])`, the only way a feature is off on a
 *     real workspace now.
 *
 * Usage:
 *   import { SCOPED, offOverrides } from '@/test/editions'
 *   computeEditionToolCeiling(SCOPED.sales)
 *   settings: { edition: 'full', feature_overrides: offOverrides(['crm']) }
 */
import {
  EDITIONS,
  composeSurface,
  type EditionDefinition,
  type EditionId,
  type FeatureKey,
  type FeatureOverrides,
} from '@/lib/editions/manifest'

/** An edition whose preset is a feature LIST rather than `'all'`, with the
 *  surface composed from it the same way the manifest composes its own. */
export function scopedEdition(
  features: readonly FeatureKey[],
  base: EditionId = 'full',
): EditionDefinition {
  return { ...EDITIONS[base], features, ...composeSurface(features) }
}

/** The presets sales, notes and brain had before every edition got every
 *  feature, as fixtures for tests that need several features off at once. */
export const SCOPED = {
  sales: scopedEdition(['docs', 'knowledge', 'email', 'crm', 'sequences'], 'sales'),
  notes: scopedEdition(['docs', 'boards'], 'notes'),
  brain: scopedEdition(['docs', 'knowledge', 'flows'], 'brain'),
} as const

/** `feature_overrides` that switch exactly these features off. */
export function offOverrides(features: readonly FeatureKey[]): FeatureOverrides {
  return Object.fromEntries(features.map((f) => [f, 'off'])) as FeatureOverrides
}
