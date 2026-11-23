'use client'

/**
 * A detail page's sections (a project's Overview / Actions / Captures, a pull
 * request's Description / Files changed / Checks, a contact's, a company's,
 * an initiative's, an action's): in a card, a capsule of 24px segments in the
 * card's header, beside its other controls (Liam, 11-23: "these details view
 * pages … that show the different pages at the top … feel out of place"; the
 * list pages' saved views stay in their toolbar). Outside a card the page's
 * own row of pills, as before, drawn by the page through `renderInline`.
 *
 * One tablist either way: role tab, aria-selected, the chosen one lifted.
 */
import * as React from 'react'
import { CardHeaderSlot, useCardHeaderSlots } from './card-header-slot'
import { cn } from '@/lib/utils'
import { CARD_HEADER_CAPSULE, CARD_HEADER_SEGMENT } from './card-header-button'

export interface DetailTab<T extends string> {
  id: T
  label: React.ReactNode
  /** Shown after the label, quieter (Actions 8). Nothing when null, undefined or 0. */
  count?: number | null
  /** The label's words for a tooltip and assistive tech, when `label` is not plain text. */
  title?: string
  /** The page's own data attributes for this tab (data-reviews-tab, data-action-mac-tab), so its tests and hooks find it in either place. */
  data?: { [attr: `data-${string}`]: string }
}

/** Whether a detail page is drawn in a card, whose header takes its sections. */
export function useDetailTabsInHeader(): boolean {
  return useCardHeaderSlots() !== null
}

/**
 * The sections in the card's header. Draws nothing outside a card: there the
 * page keeps its own row (check `useDetailTabsInHeader()` to decide which).
 */
export function DetailTabsInHeader<T extends string>({
  tabs,
  value,
  onChange,
  label,
  ...data
}: {
  tabs: ReadonlyArray<DetailTab<T>>
  value: T
  onChange: (id: T) => void
  /** The tablist's name for assistive tech ("Project", "Pull request"). */
  label: string
} & { [attr: `data-${string}`]: string }) {
  const inCard = useDetailTabsInHeader()
  if (!inCard) return null
  return (
    <CardHeaderSlot side="right">
      {/* It gives way first in a narrow header (the live capture's notepad, a card in the chat), scrolling
          sideways as the page's own row did, so the header's other controls (Full screen, Properties,
          Minimize) always stay in the card (a review, 11-23). */}
      <div
        role="tablist"
        aria-label={label}
        data-detail-tabs="header"
        {...data}
        className={cn(CARD_HEADER_CAPSULE, 'min-w-0 shrink overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden')}
      >
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={value === t.id}
            data-detail-tab={t.id}
            title={t.title}
            {...t.data}
            onClick={() => onChange(t.id)}
            className={cn(CARD_HEADER_SEGMENT, 'shrink-0')}
          >
            {t.label}
            {!!t.count && <span className="ml-1 tabular-nums opacity-60">{t.count}</span>}
          </button>
        ))}
      </div>
    </CardHeaderSlot>
  )
}
