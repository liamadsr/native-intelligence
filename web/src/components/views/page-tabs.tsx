'use client'

/**
 * A page's tabs, one look everywhere (Liam, 11-23: "make it look really nice
 * and clean like linear does"): a list's saved views (view-tabs.tsx) and a
 * detail page's sections (a project's Overview / Actions / Captures, a pull
 * request's Description / Files changed / Checks, a contact's, an action's).
 * Quiet 28px pills on a soft fill, the chosen one a shade lighter; the same
 * weight either way, so no tab moves when another is picked.
 *
 * A detail page's sections are its first row (DETAIL_TAB_ROW), as a list's
 * view tabs are its toolbar's (view-toolbar.tsx alignToContent), whatever
 * column the page's content keeps below it (Liam, 11-23: "it should start to
 * the far left even though the page content is indented"). In a card too: the
 * card's header holds no sections (it did for a day, #260).
 *
 * The row's pills sit in the card's corner (PAGE_TAB_INSET), 10px from its
 * top and from its side alike: the card's 24px corner less the pill's 14px
 * radius, so the two curves run side by side. At 18px from the side and 10px
 * from the top they read as indented under the header's pill, which stands
 * flush with the card's edge (Liam, 11-23: "why does it feel like visually
 * they don't start at the same spot like the pages are more indented").
 */
import * as React from 'react'
import { cn } from '@/lib/utils'

/** A page tab's pill: 28px, round, 13px words. */
export const PAGE_TAB =
  'inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40'
/** The chosen tab: a shade lighter. */
export const PAGE_TAB_ON = 'border-foreground/[0.08] bg-foreground/[0.1] text-foreground'
/** The others: a soft fill, quieter words. */
export const PAGE_TAB_OFF = 'border-foreground/[0.06] bg-foreground/[0.03] text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground'

export function pageTabClass(active: boolean): string {
  return cn(PAGE_TAB, active ? PAGE_TAB_ON : PAGE_TAB_OFF)
}

/** A tab's count beside its words (Cases 4): quieter than the words. */
export const PAGE_TAB_COUNT = 'tabular-nums opacity-60'

/** The "+" beside a list's views: round, the tabs' height. */
export const PAGE_TAB_ADD =
  'inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground'

/** A page tab row's sides: in the card's corner, 10px in, as the row's 48px height leaves 10px over the 28px pills. */
export const PAGE_TAB_INSET = 'px-2.5'

/**
 * A detail page's first row: its sections from the left, the page's own
 * buttons (WindowActions) at the end; 48px tall, as a list's toolbar row.
 */
export const DETAIL_TAB_ROW = `flex h-12 w-full shrink-0 items-center gap-2 ${PAGE_TAB_INSET}`

export interface DetailTab<T extends string> {
  id: T
  label: React.ReactNode
  /** Shown after the label, quieter (Actions 8). Nothing when null, undefined or 0. */
  count?: number | null
  /** The label's words for a tooltip and assistive tech, when `label` is not plain text. */
  title?: string
  /** The page's own data attributes for this tab (data-reviews-tab, data-action-mac-tab), for its tests and hooks. */
  data?: { [attr: `data-${string}`]: string }
}

/**
 * A detail page's sections, for its first row. On a narrow page (the live
 * capture's notepad, a card in the chat) they scroll sideways, never pushing
 * the row's buttons out.
 */
export function DetailTabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  wrap = false,
  ...data
}: {
  tabs: ReadonlyArray<DetailTab<T>>
  value: T
  onChange: (id: T) => void
  /** The tablist's name for assistive tech ("Project", "Pull request"). */
  label: string
  /** Onto a second line, not sideways, where every tab must stay in reach (the Inbox's beside an open item). */
  wrap?: boolean
} & { [attr: `data-${string}`]: string }) {
  return (
    <div
      role="tablist"
      aria-label={label}
      data-detail-tablist=""
      {...data}
      className={
        wrap
          ? 'flex min-w-0 shrink flex-wrap items-center gap-1'
          : '-my-1 flex min-w-0 shrink items-center gap-1 overflow-x-auto py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden'
      }
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
          className={pageTabClass(value === t.id)}
        >
          {t.label}
          {!!t.count && <span className={PAGE_TAB_COUNT}>{t.count}</span>}
        </button>
      ))}
    </div>
  )
}
