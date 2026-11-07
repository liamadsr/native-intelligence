'use client'

import { Button } from '@/components/ui/button'
import { Plus } from 'lucide-react'
import { ExpandableSearch } from './expandable-search'
import { ThinkingOrb } from 'thinking-orbs'

/**
 * The search (and optional create) controls that sit at the FAR RIGHT of a
 * list page's header — Documents, the CRM, Knowledge.
 *
 * Placement and styling live here rather than in each page so every list
 * header reads the same. It used to live inside tab-content.tsx and was
 * therefore reachable only from there; Knowledge wanted the identical control
 * from its own component, which is what moved it out.
 *
 * THE SEARCH IS CONTROLLED BY THE PAGE, not by the list. Passing `searchValue`
 * down to `UnifiedViewLayout` is what makes the layout hide its own in-list
 * search bar — so a page that renders this control and forgets to pass the
 * value down gets TWO search boxes, and a page that passes the value down
 * without rendering this gets none.
 */
export interface ListHeaderControlsProps {
  searchValue: string
  onSearchChange: (value: string) => void
  searchPlaceholder: string
  searchLabel: string
  /**
   * The "+" button. OPTIONAL, because not every collection is authored: a
   * claim is extracted from a meeting or a document, so Knowledge has search
   * and nothing to create. Omitting both leaves the search box alone rather
   * than rendering a button that could only ever be a no-op.
   */
  onCreate?: () => void
  createLabel?: string
  creating?: boolean
}

export function ListHeaderControls({
  searchValue,
  onSearchChange,
  searchPlaceholder,
  searchLabel,
  onCreate,
  createLabel,
  creating = false,
}: ListHeaderControlsProps) {
  return (
    <div className="flex items-center gap-1.5">
      <ExpandableSearch
        value={searchValue}
        onChange={onSearchChange}
        placeholder={searchPlaceholder}
        label={searchLabel}
      />
      {onCreate && createLabel && (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-foreground"
          onClick={onCreate}
          disabled={creating}
          title={createLabel}
          aria-label={createLabel}
        >
          {creating ? (
            <ThinkingOrb state="working" size={20} theme="auto" />
          ) : (
            <Plus className="h-4 w-4" />
          )}
        </Button>
      )}
    </div>
  )
}
