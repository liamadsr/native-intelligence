'use client'

/**
 * The Knowledge graph's filter bar, shared by both renderers.
 *
 * THIS IS THE LEGACY BAR. The current Knowledge page filters through the shared
 * views toolbar — saved views, the full filter vocabulary, chips — and this
 * five-control bar survives only for the `react-force-graph-2d` fallback, which
 * holds the whole workspace payload client-side and filters it in memory. It is
 * deleted with that renderer.
 *
 * `filterStateActive` and `countBadgeText` are pure and live here rather than in
 * the view so they can be unit-tested without mounting React. `countBadgeText`
 * outlives the bar: the WebGL map draws the same badge.
 */

import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { Package } from 'lucide-react'
import type { ClaimType } from '@/lib/knowledge/graph-map/types'

// ─── Filter state ─────────────────────────────────────────────────────────────

/** `'all'` / `'any'` are the SELECT sentinels for "no constraint" — Radix
 *  Select cannot hold an empty-string value, which is why they exist. */
export interface KnowledgeFilterState {
  project: string
  types: Set<ClaimType>
  confirmation: 'all' | 'confirmed' | 'suggested'
  confidence: 'any' | '0.5' | '0.7' | '0.85'
  since: 'all' | '30' | '90'
}

export const EMPTY_FILTER_STATE: KnowledgeFilterState = {
  project: 'all',
  types: new Set(),
  confirmation: 'all',
  confidence: 'any',
  since: 'all',
}

export function filterStateActive(f: KnowledgeFilterState): boolean {
  return (
    f.project !== 'all' ||
    f.types.size > 0 ||
    f.confirmation !== 'all' ||
    f.confidence !== 'any' ||
    f.since !== 'all'
  )
}

// ─── Count badge ──────────────────────────────────────────────────────────────

/**
 * The badge over the canvas. In the new path both numbers are computed on the
 * server over the FILTERED set, so the badge and what is drawn always agree —
 * the failure mode B1 called out (a truthful badge over a masked canvas).
 */
export function countBadgeText(
  nodes: number,
  links: number,
  filtersActive: boolean,
): string {
  return `${nodes.toLocaleString()} nodes · ${links.toLocaleString()} links${
    filtersActive ? ' · filtered' : ''
  }`
}

// ─── The bar ──────────────────────────────────────────────────────────────────

const TYPE_FILTER_OPTIONS: Array<{ value: ClaimType; label: string }> = [
  { value: 'fact', label: 'Facts' },
  { value: 'decision_summary', label: 'Decisions' },
  { value: 'open_question', label: 'Questions' },
  { value: 'inference', label: 'Inferences' },
]

export interface KnowledgeFilterBarProps {
  value: KnowledgeFilterState
  onChange: (next: KnowledgeFilterState) => void
  projects: Array<{ id: string; label: string }>
  /** Promote is disabled when the filtered set is empty. */
  canPromote: boolean
  onPromote: () => void
}

export function KnowledgeFilterBar({
  value,
  onChange,
  projects,
  canPromote,
  onPromote,
}: KnowledgeFilterBarProps) {
  const active = filterStateActive(value)

  const toggleType = (t: ClaimType) => {
    const types = new Set(value.types)
    if (types.has(t)) types.delete(t)
    else types.add(t)
    onChange({ ...value, types })
  }

  return (
    <div className="border-border flex shrink-0 flex-wrap items-center gap-2 border-b px-5 py-2">
      <Select
        value={value.project}
        onValueChange={(project) => onChange({ ...value, project })}
      >
        <SelectTrigger className="h-7 w-44 text-xs">
          <SelectValue placeholder="All projects" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All projects</SelectItem>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <div className="flex items-center gap-1">
        {TYPE_FILTER_OPTIONS.map((t) => (
          <button
            key={t.value}
            type="button"
            onClick={() => toggleType(t.value)}
            aria-pressed={value.types.has(t.value)}
            className={cn(
              'rounded-full border px-2 py-0.5 text-[11px] transition-colors',
              value.types.has(t.value)
                ? 'border-foreground/50 bg-accent text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <Select
        value={value.confirmation}
        onValueChange={(v) =>
          onChange({ ...value, confirmation: v as KnowledgeFilterState['confirmation'] })
        }
      >
        <SelectTrigger className="h-7 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">Any status</SelectItem>
          <SelectItem value="confirmed">Confirmed</SelectItem>
          <SelectItem value="suggested">Suggested</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={value.confidence}
        onValueChange={(v) =>
          onChange({ ...value, confidence: v as KnowledgeFilterState['confidence'] })
        }
      >
        <SelectTrigger className="h-7 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="any">Any confidence</SelectItem>
          <SelectItem value="0.5">≥ 50%</SelectItem>
          <SelectItem value="0.7">≥ 70%</SelectItem>
          <SelectItem value="0.85">≥ 85%</SelectItem>
        </SelectContent>
      </Select>

      <Select
        value={value.since}
        onValueChange={(v) => onChange({ ...value, since: v as KnowledgeFilterState['since'] })}
      >
        <SelectTrigger className="h-7 w-32 text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="all">All time</SelectItem>
          <SelectItem value="30">Last 30 days</SelectItem>
          <SelectItem value="90">Last 90 days</SelectItem>
        </SelectContent>
      </Select>

      {active && (
        <button
          type="button"
          onClick={() => onChange({ ...EMPTY_FILTER_STATE, types: new Set() })}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          Clear
        </button>
      )}

      <div className="ml-auto">
        <Button
          variant="outline"
          size="sm"
          className="h-7 gap-1 text-xs"
          disabled={!canPromote}
          onClick={onPromote}
          title="Create a gated, shareable package from the current view"
        >
          <Package className="h-3 w-3" />
          Promote{active ? ' filter' : ''}
        </Button>
      </div>
    </div>
  )
}
