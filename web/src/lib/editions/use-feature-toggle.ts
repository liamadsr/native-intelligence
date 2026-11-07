'use client'

import { useCallback, useState } from 'react'
import { usePostHog } from 'posthog-js/react'
import {
  EDITIONS,
  FEATURES,
  STANDARD_FEATURE_KEYS,
  TOGGLEABLE_FEATURE_KEYS,
  effectiveFeatureKeys,
  type EditionId,
  type FeatureKey,
  type FeatureOverrides,
} from '@/lib/editions'

/**
 * The features currently in effect, as a set.
 *
 * `'all'` expands to STANDARD_FEATURE_KEYS, NOT to the full feature list:
 * `'all'` means "every DEFAULT-ON feature", and the list includes OPT-IN ones
 * (Evals) that no edition grants. Expanding to the list would show every
 * opt-in feature as on for every `full` workspace.
 *
 * `effectiveFeatureKeys` already closes under `requires`, so otherwise this is
 * a plain shape change (list → Set) for membership tests.
 */
export function effectiveFeatureSet(
  edition: EditionId,
  overrides: FeatureOverrides,
): Set<FeatureKey> {
  const keys = effectiveFeatureKeys(EDITIONS[edition], overrides)
  if (keys === 'all') return new Set(STANDARD_FEATURE_KEYS)
  return new Set(keys)
}

/** Features that require `key` — the ones that must go off when it does. */
export function dependentsOf(key: FeatureKey): FeatureKey[] {
  return TOGGLEABLE_FEATURE_KEYS.filter((k) => FEATURES[k].requires.includes(key))
}

/** "CRM", or "CRM and Sequences", or "CRM, Sequences, and Email". */
export function listFeatureLabels(keys: readonly FeatureKey[]): string {
  const labels = keys.map((k) => FEATURES[k].label)
  if (labels.length <= 1) return labels[0] ?? ''
  if (labels.length === 2) return `${labels[0]} and ${labels[1]}`
  return `${labels.slice(0, -1).join(', ')}, and ${labels[labels.length - 1]}`
}

/**
 * Toggling a workspace feature, with the requires-cascade and the write
 * ordering that makes it land.
 *
 * Extracted from the workspace settings Features card so the nav rail's
 * quick-toggle popover drives the SAME semantics. The rules below are subtle
 * enough that a second hand-rolled copy would drift:
 *
 *  • A feature is a coherent BUNDLE, so the ON direction carries its
 *    requirements with it — turning Sequences on also turns CRM on (outreach
 *    with no contacts to enrol is a half-state).
 *  • REQUIREMENTS ARE WRITTEN FIRST, then the feature. The route prunes
 *    overrides that change nothing, and under off-wins a `sequences: 'on'`
 *    written while CRM is still off changes nothing — it would be pruned and
 *    the gesture would half-land. Enabling the requirement first makes the
 *    second write load-bearing.
 *  • The OFF direction needs no cascade: `effectiveFeatureKeys` gives an
 *    explicit `off` precedence over `requires` and takes every dependent down
 *    with it, so switching CRM off already switches Sequences off everywhere
 *    the effective set is read. PATCHing `sequences: 'off'` on top would store
 *    a key the route prunes as a no-op.
 *  • The workspace cache is refreshed ONCE, after the whole chain — refreshing
 *    per PATCH would refetch twice for one gesture and let the nav rail paint
 *    an intermediate state (Sequences on, CRM not yet) that was never a choice.
 *
 * `onOverrides` receives every optimistic and settled value so the caller can
 * hold the state wherever it already does; `refreshCache` is the workspace
 * cache invalidation (surface-rendering components read from it, so without it
 * a toggle saves but the nav stays stale until a reload).
 */
export function useFeatureToggle({
  overrides,
  edition,
  onOverrides,
  refreshCache,
}: {
  overrides: FeatureOverrides
  edition: EditionId
  onOverrides: (next: FeatureOverrides) => void
  refreshCache: () => Promise<unknown>
}) {
  const posthog = usePostHog()
  const [busy, setBusy] = useState<FeatureKey | null>(null)
  const [error, setError] = useState('')

  const patchFeature = useCallback(
    async (
      feature: FeatureKey,
      state: 'on' | 'off' | 'default',
      base: FeatureOverrides,
    ): Promise<FeatureOverrides> => {
      const res = await fetch('/api/account/workspace/features', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ feature, state }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        throw new Error(data.error ?? 'Failed to update feature')
      }
      const data = await res.json()
      posthog?.capture('feature_toggled', { feature, state, edition })
      return (data.overrides && typeof data.overrides === 'object'
        ? data.overrides
        : base) as FeatureOverrides
    },
    [posthog, edition],
  )

  const toggleFeature = useCallback(
    async (feature: FeatureKey, next: boolean) => {
      const previous = overrides
      const effective = effectiveFeatureSet(edition, previous)
      const cascade = next
        ? FEATURES[feature].requires.filter((k) => !effective.has(k))
        : []

      // Optimistic local apply for the whole bundle at once — the switches
      // move together, which is the point.
      const optimistic: FeatureOverrides = { ...previous }
      for (const key of [...cascade, feature]) optimistic[key] = next ? 'on' : 'off'
      onOverrides(optimistic)
      setBusy(feature)
      setError('')

      try {
        let latest = previous
        for (const key of [...cascade, feature]) {
          latest = await patchFeature(key, next ? 'on' : 'off', latest)
        }
        onOverrides(latest)
        await refreshCache()
      } catch (err) {
        onOverrides(previous)
        setError(err instanceof Error ? err.message : 'Failed to update feature')
      } finally {
        setBusy(null)
      }
    },
    [overrides, edition, onOverrides, patchFeature, refreshCache],
  )

  /** Drop the override so the feature follows the edition preset again. */
  const resetFeature = useCallback(
    async (feature: FeatureKey) => {
      const previous = overrides
      const optimistic = { ...previous }
      delete optimistic[feature]
      onOverrides(optimistic)
      setBusy(feature)
      setError('')
      try {
        onOverrides(await patchFeature(feature, 'default', previous))
        await refreshCache()
      } catch (err) {
        onOverrides(previous)
        setError(err instanceof Error ? err.message : 'Failed to reset feature')
      } finally {
        setBusy(null)
      }
    },
    [overrides, onOverrides, patchFeature, refreshCache],
  )

  return { toggleFeature, resetFeature, patchFeature, busy, error, setError }
}
