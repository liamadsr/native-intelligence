import { useCallback, useEffect, useState } from 'react'

/**
 * Drives a detail panel's active inner tab ("section") from the navigation
 * history entry, so Back/Forward restore the exact sub-tab and switching tabs
 * pushes its own history step.
 *
 * The panel is effectively controlled by the `section` prop (which comes from
 * `detailPanel.section` in the history entry). We keep a local mirror so the tab
 * highlights instantly on click — before the dispatch round-trips — and re-sync
 * whenever the prop changes (e.g. on a Back navigation that restores a different
 * section). The panel is NOT remounted on a section change (its key is the entity
 * id), so reading from the prop is what keeps it in lock-step with history.
 *
 * Usage in a panel:
 *   const [activeTab, setActiveTab] = usePanelSection(section, onSectionChange, 'overview')
 *   // ...render tabs, onClick={() => setActiveTab('actions')}
 */
export function usePanelSection<T extends string>(
  section: string | undefined,
  onSectionChange: ((section: string) => void) | undefined,
  defaultSection: T,
  validSections?: readonly T[],
): [T, (next: T) => void] {
  // Clamp an unknown/stale persisted section (e.g. a tab that was renamed or
  // removed in a later build) back to the default so the panel never renders a
  // blank body with no tab selected.
  const candidate = (section as T) ?? defaultSection
  const resolved =
    validSections && !validSections.includes(candidate) ? defaultSection : candidate
  const [active, setActive] = useState<T>(resolved)

  // Re-sync when history restores a different section (Back/Forward), or when
  // the entry seeds a section after mount.
  useEffect(() => {
    setActive(resolved)
  }, [resolved])

  const set = useCallback(
    (next: T) => {
      // Clicking the already-active tab (including the implicit default) is a
      // no-op — don't push a phantom history step that costs an extra Back press.
      if (next === active) return
      setActive(next) // optimistic: reflect immediately
      onSectionChange?.(next) // push a history step for the tab switch
    },
    [active, onSectionChange],
  )

  return [active, set]
}
