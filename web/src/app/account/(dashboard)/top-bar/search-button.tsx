'use client'

/**
 * The top bar's search (Liam, 10-20), on a phone only since the app rail
 * (Liam, 11-09: from `md` up the rail's Search is the one): a round pill of
 * its own beside For you's Home, opening the `/` palette as `/` or ⌘K do (docs/plans/slash-search.md),
 * to search everything and open it. Pressed, the button is seen to travel:
 * it lifts off and the palette grows out of it in the middle of the page,
 * the flight For you's Reply takes into the composer (open-search.ts,
 * card-reply-flight.ts).
 */
import { useRef } from 'react'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useModKeyLabel } from '@/lib/hotkeys'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { openSearch } from '@/lib/chat/open-search'
import { TOP_BAR_PILL, TOP_BAR_TIP } from './pill-style'

export function SearchButton() {
  const ref = useRef<HTMLButtonElement>(null)
  const shortcut = useModKeyLabel('K')
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          data-search-button=""
          aria-label="Search"
          aria-keyshortcuts="Meta+K Control+K"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => openSearch(ref.current)}
          className={cn(TOP_BAR_PILL, 'w-9 justify-center px-0')}
        >
          <Search className="h-4 w-4" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom" sideOffset={6} collisionPadding={8} avoidCollisions={false} className={TOP_BAR_TIP}>
        <span>Search</span>
        <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-[4px] border bg-muted/60 px-1 text-[10px] font-medium text-muted-foreground">{shortcut}</kbd>
      </TooltipContent>
    </Tooltip>
  )
}
