'use client'

import { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import type { LabelGroup, LabelWithScope } from '@/lib/labels/utils'

/** More labels than this and the picker opens with a filter box on top. */
export const LABEL_FILTER_THRESHOLD = 10

/** The groups with only the labels whose name holds `query` (any case); empty groups dropped. Pure. */
export function filterLabelGroups(grouped: LabelGroup[], query: string): LabelGroup[] {
  const q = query.trim().toLowerCase()
  if (!q) return grouped
  return grouped
    .map((g) => ({ ...g, labels: g.labels.filter((l) => l.name.toLowerCase().includes(q)) }))
    .filter((g) => g.labels.length > 0)
}

interface LabelPickerContentProps {
  /** Labels organized by group */
  grouped: LabelGroup[]
  /** IDs of currently selected/attached labels */
  selectedIds: string[]
  /** Called when a label is toggled. isAttached=true means it's currently selected. */
  onToggle: (labelId: string, isAttached: boolean) => void
  /** Whether labels are loading */
  loading?: boolean
}

/**
 * Shared label picker content with group headers.
 * Used inside popovers across action detail, initiative detail,
 * email thread detail, create dialogs, and filter value picker.
 */
export function LabelPickerContent({
  grouped,
  selectedIds,
  onToggle,
  loading,
}: LabelPickerContentProps) {
  const [query, setQuery] = useState('')
  const shown = useMemo(() => filterLabelGroups(grouped, query), [grouped, query])

  if (loading) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">Loading...</p>
  }

  const totalLabels = grouped.reduce((sum, g) => sum + g.labels.length, 0)

  if (totalLabels === 0) {
    return <p className="px-2 py-1 text-xs text-muted-foreground">No labels yet.</p>
  }

  const hasNamedGroups = grouped.some((g) => g.groupName !== null)
  const filterable = totalLabels > LABEL_FILTER_THRESHOLD

  return (
    <div className="space-y-1">
      {filterable && (
        // Stays at the top of the popover while the list scrolls under it.
        <div className="sticky top-0 z-10 bg-popover pb-1">
          <div className="flex items-center gap-1.5 rounded-md border border-border/70 px-2 py-1">
            <Search className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                // Enter picks the one label left; Escape still closes the popover.
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const only = shown.flatMap((g) => g.labels)
                  if (only.length === 1) onToggle(only[0].id, selectedIds.includes(only[0].id))
                }
              }}
              placeholder="Filter labels…"
              aria-label="Filter labels"
              data-label-filter=""
              className="w-full min-w-0 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
            />
          </div>
        </div>
      )}
      {filterable && shown.length === 0 && (
        <p className="px-2 py-1 text-xs text-muted-foreground">No labels match.</p>
      )}
      {shown.map((group) => (
        <div key={group.groupName ?? '__ungrouped'}>
          {hasNamedGroups && (
            <p className="px-2 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              {group.groupName ?? 'Other'}
            </p>
          )}
          {group.labels.map((label) => {
            const isAttached = selectedIds.includes(label.id)
            return (
              <div
                key={label.id}
                role="button"
                tabIndex={0}
                onClick={() => onToggle(label.id, isAttached)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onToggle(label.id, isAttached)
                  }
                }}
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-muted/50"
              >
                <Checkbox
                  checked={isAttached}
                  className="h-3.5 w-3.5 pointer-events-none"
                  tabIndex={-1}
                />
                <span
                  className="inline-block h-2 w-2 rounded-full shrink-0"
                  style={{ backgroundColor: label.color }}
                />
                <span className="truncate">{label.name}</span>
              </div>
            )
          })}
        </div>
      ))}
    </div>
  )
}

/**
 * Flattens grouped labels back to a flat array.
 * Useful when you need the flat list for lookups alongside the grouped structure.
 */
export function flattenGroups(grouped: LabelGroup[]): LabelWithScope[] {
  return grouped.flatMap((g) => g.labels)
}
